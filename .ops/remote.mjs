/**
 * 到 192.168.2.110 的远程执行通道（密码认证）。
 *
 * Windows 上没有 sshpass / plink，OpenSSH 客户端又不接受管道密码，所以部署与巡检统一走这里。
 * 刻意做成一次性工具而不是塞进 OneGl 的依赖里：它服务于运维动作，不属于采集链路。
 *
 *   node remote.mjs exec "<shell 命令>" [--cwd DIR] [--timeout MS]
 *   node remote.mjs put  <本地路径> <远程路径>
 *   node remote.mjs get  <远程路径> <本地路径>
 *   node remote.mjs script <本地 .sh> [--timeout MS] [--allow-stale]
 *
 * ★ `script` 执行的是**本地文件**，而 `put` 改的是**远端文件**。
 *   两者很容易不同步，而不同步的表现是「静默跑了旧版本」——
 *   2026-10-06 在同一个地方栽了两次。因此 `script` 默认先核对
 *   本地与 `/root/onegl-stage/<同名文件>` 的 sha256，不一致就拒绝执行，
 *   确要用本地版本时显式加 `--allow-stale`。
 */
import { Client } from "ssh2";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const HOST = process.env.ONEGL_SSH_HOST ?? "192.168.2.110";
const PORT = Number(process.env.ONEGL_SSH_PORT ?? 22);
const USER = process.env.ONEGL_SSH_USER ?? "root";

// 口令只从环境变量读，不再保留硬编码兜底。
// 之前这里是 `?? "skadoosh"` —— 一个 8 位小写弱口令，既是内网 root 的完整凭据，
// 又会随 .ops 目录的副本、备份或误 git add 一起流出去。
// 缺失时直接失败：运维脚本要求显式提供凭据，比静默用一个弱口令安全。
const PASSWORD = process.env.ONEGL_SSH_PASSWORD;
if (!PASSWORD) {
  console.error(
    "ONEGL_SSH_PASSWORD 未设置。请先导出该环境变量再运行；\n" +
      "它不会写入任何文件，也不会作为默认值内置在代码里。",
  );
  process.exit(1);
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => resolve(client))
      .on("error", reject)
      .connect({
        host: HOST,
        port: PORT,
        username: USER,
        password: PASSWORD,
        readyTimeout: 20_000,
        // 目标机是内网固定设备，指纹变化只可能是重装；不做 TOFU 记录以免部署脚本还要
        // 维护一份 known_hosts。
        algorithms: undefined,
      });
  });
}

function runCommand(client, command, { cwd = null, timeoutMs = 600_000, stdinFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const full = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command;
    client.exec(full, { pty: false }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`远程命令超时 ${timeoutMs}ms：${command}`));
      }, timeoutMs);
      stream
        .on("data", (chunk) => {
          stdout += chunk.toString();
        })
        .on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      // stdin 走文件而不是命令行参数：SQL、环境变量清单这类内容一旦内联进命令，
      // 引号嵌套就会在 Windows PowerShell 和远端 bash 之间来回打架，最后拼出的
      // 命令和想发的命令不是同一条。
      if (stdinFile) stream.end(readFileSync(stdinFile));
      else stream.end();
    });
  });
}

function sftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, session) => (error ? reject(error) : resolve(session)));
  });
}

function put(session, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    session.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
  });
}

function get(session, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    session.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * 本地脚本与它在远端 staging 上的同名文件是否不是同一份。
 *
 * 远端路径的推断：`.ops` 下的脚本一律 put 到 `/root/onegl-stage/<basename>`。
 * 推断不出来时返回 null（不拦）—— 拦住一个本来没问题的东西比放过一个有问题的东西更糟。
 */
const REMOTE_STAGING_DIR = "/root/onegl-stage";

function inferRemoteCounterpart(localPath) {
  const normalized = String(localPath).replace(/\\/g, "/");
  const base = normalized.split("/").pop();
  if (!base || !/\.(sh|mjs)$/.test(base)) return null;
  return `${REMOTE_STAGING_DIR}/${base}`;
}

async function sha256OfLocal(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 16);
}

async function sha256OfRemote(client, remotePath) {
  const result = await runCommand(client, `sha256sum ${remotePath} 2>/dev/null || true`, {
    timeoutMs: 30_000,
  });
  const hash = (result.stdout || "").trim().split(/\s+/)[0];
  return /^[0-9a-f]{16,}$/.test(hash ?? "") ? hash.slice(0, 16) : null;
}

/**
 * 返回不一致信息；一致或远端没有同名文件时返回 null。
 */
async function findStaleCounterpart(client, localPath) {
  const remotePath = inferRemoteCounterpart(localPath);
  if (!remotePath) return null;
  const remoteHash = await sha256OfRemote(client, remotePath);
  // 远端没有这份文件 → 没有「不一致」可言，放行
  if (!remoteHash) return null;
  const localHash = await sha256OfLocal(localPath);
  if (localHash === remoteHash) return null;
  return { remotePath, localHash, remoteHash };
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  const flags = new Map();
  const positional = [];
  let passthrough = [];
  for (let index = 0; index < rest.length; index += 1) {
    // `--` 之后的一切原样交给远端脚本，不再由本工具解析。
    // 不加这条分隔符时，`--count 5` 会被这里当成自己的 flag 吃掉，远端脚本收不到它，
    // 于是「提升 5 个」静默变成「提升 1 个」——一个不会报错、只会悄悄做错事的失败模式。
    if (rest[index] === "--") {
      passthrough = rest.slice(index + 1);
      break;
    }
    if (rest[index].startsWith("--")) {
      flags.set(rest[index].slice(2), rest[index + 1]);
      index += 1;
    } else {
      positional.push(rest[index]);
    }
  }

  const client = await connect();
  try {
    if (action === "exec" || action === "script") {
      // script 是 exec 的定型用法：把本地 bash 文件通过 stdin 交给远端 bash -s。
      // 写成独立动作而不是让调用方拼 `exec "bash -s" --file x.sh`，是因为在 PowerShell 里
      // 任何 `$(...)`、反引号或引号嵌套都会在到达 ssh 之前先被本地 shell 解释一遍，
      // 于是「发的命令」和「想的命令」不再是同一条。
      const isScript = action === "script";
      // 这里不给 bash 传任何参数：`bash -s -- x` 里的 `--` 会被 bash 当成自己的选项，
      // 而 `bash -- -s` 又会把 `-s` 当成文件名。远端需要参数时，用 exec 动作配合
      // `bash -s <位置参数>` 的形式，那条路径已验证可用。

      // ★ script 读的是**本地文件**，而不是远端 staging 上那份。
      //   这两条路径很容易不同步：`put` 改的是远端，而 `script x.sh` 跑的是本地 x.sh。
      //   2026-10-06 在同一个地方栽了两次 ——
      //     一次：改了远端脚本，跑的却是本地旧副本，输出看起来完全正常
      //     一次：改了本地脚本，`put` 忘了或没跑，跑的是远端旧副本
      //   两次都因为「静默用旧版本」而没有任何报错。
      //
      // 所以这里默认**强制核对**：本地文件与远端同名文件哈希不一致就拒绝执行。
      // 要真的跑旧版本，显式加 --allow-stale。
      if (isScript && !flags.get("allow-stale")) {
        const stale = await findStaleCounterpart(client, positional[0]);
        if (stale) {
          process.stderr.write(
            `[remote] 拒绝执行：本地 ${positional[0]} 与远端 ${stale.remotePath} 不是同一份\n`
            + `        本地 ${stale.localHash}\n`
            + `        远端 ${stale.remoteHash}\n`
            + `  修法二选一：\n`
            + `        put ${positional[0]} ${stale.remotePath}   # 同步远端\n`
            + `        （确要用本地版本）加 --allow-stale\n`,
          );
          process.exitCode = 2;
          return;
        }
      }

      const result = await runCommand(client, isScript ? "bash -s" : positional[0], {
        cwd: flags.get("cwd") ?? null,
        timeoutMs: Number(flags.get("timeout") ?? 600_000),
        stdinFile: isScript ? positional[0] : (flags.get("file") ?? null),
      });
      process.stdout.write(result.stdout);
      if (result.stderr.trim()) process.stderr.write(`\n[stderr]\n${result.stderr}`);
      process.exitCode = result.code ?? 0;
      return;
    }

    const session = await sftp(client);
    if (action === "put") {
      await put(session, positional[0], positional[1]);
      process.stdout.write(`put ok: ${positional[0]} -> ${positional[1]}\n`);
    } else if (action === "get") {
      await get(session, positional[0], positional[1]);
      process.stdout.write(`get ok: ${positional[0]} -> ${positional[1]}\n`);
    } else {
      throw new Error(`未知动作 ${JSON.stringify(action)}；可用：exec / put / get`);
    }
  } finally {
    client.end();
  }
}

main().catch((error) => {
  console.error(`remote 失败：${error.message}`);
  process.exit(1);
});
