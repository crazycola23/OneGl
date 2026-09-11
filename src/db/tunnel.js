import "dotenv/config";
import { spawn } from "node:child_process";

/**
 * 打开 SSH 隧道，把服务器上只监听回环地址的 PostgreSQL / Redis 映射到本机。
 *
 * 采集程序始终跑在本机（要开真实浏览器，用本机已登录的豆包会话），
 * 数据库只发布在服务器的 127.0.0.1 上，所以本机要靠这条隧道访问，
 * 全程不需要开放任何防火墙端口。
 *
 * 用法：
 *   npm run db:tunnel
 * 保持这个窗口开着，然后 DATABASE_URL / REDIS_URL 指向本机的隧道端口。
 * 首次连接会提示输入服务器密码（ssh 不支持从环境变量读取密码）。
 */
const target = process.env.ONEGL_SSH_TARGET;

const forwards = [
  {
    label: "postgres",
    enabled: process.env.ONEGL_TUNNEL_DB !== "0",
    localPort: Number(process.env.ONEGL_DB_TUNNEL_PORT ?? 15432),
    remoteHost: process.env.ONEGL_DB_REMOTE_HOST ?? "127.0.0.1",
    remotePort: Number(process.env.ONEGL_DB_REMOTE_PORT ?? 5432),
  },
  {
    label: "redis",
    enabled: process.env.ONEGL_TUNNEL_REDIS !== "0",
    localPort: Number(process.env.ONEGL_REDIS_TUNNEL_PORT ?? 16380),
    remoteHost: process.env.ONEGL_REDIS_REMOTE_HOST ?? "127.0.0.1",
    remotePort: Number(process.env.ONEGL_REDIS_REMOTE_PORT ?? 6380),
  },
].filter((item) => item.enabled);

if (!target) {
  console.error(
    "ONEGL_SSH_TARGET 未设置。例如：ONEGL_SSH_TARGET=root@10.0.0.5 npm run db:tunnel",
  );
  process.exit(1);
}

if (forwards.length === 0) {
  console.error("数据库与 Redis 隧道都被 ONEGL_TUNNEL_DB=0 / ONEGL_TUNNEL_REDIS=0 关掉了。");
  process.exit(1);
}

console.log(`隧道目标 ${target}`);
for (const item of forwards) {
  console.log(
    `  ${item.label.padEnd(8)} 127.0.0.1:${item.localPort} -> ${item.remoteHost}:${item.remotePort}`,
  );
}
console.log("保持本进程运行，然后让 DATABASE_URL / REDIS_URL 指向上面的本地端口。");

const args = [
  "-N",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];

for (const item of forwards) {
  args.push("-L", `${item.localPort}:${item.remoteHost}:${item.remotePort}`);
}

args.push(target);

const child = spawn("ssh", args, { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`无法启动 ssh：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`ssh 隧道被 ${signal} 终止`);
  process.exitCode = code ?? 0;
});
