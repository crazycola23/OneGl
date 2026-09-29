// 部署前的依赖体检：src 里出现的每个包名都必须在 package.json 里声明过。
//
// 为什么要单独查：`npm ci` 只按 package.json 装包，而 node 的解析是按代码里
// 实际写的 specifier。两者一旦不一致，报错只会在服务器启动那一刻才炸 —
// 本地跑过 npm install 就不一定炸，因为 node_modules 里可能还留着旧的包。
// 这种故障只有在干净环境重建镜像时才暴露，所以要提前拦。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { builtinModules } from "node:module";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
const builtins = new Set(builtinModules);

// .mjs 也要扫：项目是 ESM，探针/临时脚本写错扩展名就绕过检查的情况最隐蔽。
const SCANNED = [".js", ".mjs", ".cjs"];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (SCANNED.some((ext) => p.endsWith(ext))) files.push(p);
  }
})("src");

/**
 * 去掉注释与模板串，否则注释里一句 `from "risk control"` 会被当成 import。
 * 这不是洁癖：真实代码里就有这么一句注释，先让检查器误报一次、
 * 再靠人肉排除，比一开始就不误报要贵得多。
 */
function stripCommentsAndTemplates(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  let quote = null;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      if (ch === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 取 import/export ... from "x" 与 require("x") 里的 specifier。 */
function specifiers(source) {
  const out = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)[\s\S]{0,400}?\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) out.push(m[1]);
  }
  return out;
}

function packageNameOf(spec) {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function relativeTargetExists(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec);
  return (
    existsSync(base) ||
    existsSync(`${base}.js`) ||
    existsSync(`${base}.mjs`) ||
    existsSync(join(base, "index.js")) ||
    existsSync(join(base, "index.mjs"))
  );
}

const problems = [];
for (const file of files) {
  const source = stripCommentsAndTemplates(readFileSync(file, "utf8"));
  for (const spec of specifiers(source)) {
    if (spec.startsWith("node:")) continue;

    if (spec.startsWith(".") || spec.startsWith("/")) {
      // 相对路径：解析不到就是真死链，比未声明的包更容易在运行时炸
      if (!relativeTargetExists(spec, file)) {
        problems.push({ kind: "unresolved-relative", spec, file });
      }
      continue;
    }

    if (builtins.has(spec) || builtins.has(spec.replace(/^node:/, ""))) continue;

    const name = packageNameOf(spec);
    if (!declared.has(name)) {
      problems.push({ kind: "undeclared", spec, name, file });
    }
  }
}

if (problems.length === 0) {
  console.log(`OK: ${files.length} 个文件，包引用全部可解析（已声明依赖 ${declared.size} 个）`);
  process.exit(0);
}

const byKind = new Map();
for (const p of problems) {
  if (!byKind.has(p.kind)) byKind.set(p.kind, []);
  byKind.get(p.kind).push(p);
}
for (const [kind, list] of byKind) {
  console.log(`\n[${kind}] ${list.length} 处`);
  for (const p of list.slice(0, 40)) {
    console.log(`  ${p.spec}  ← ${p.file}`);
  }
  if (list.length > 40) console.log(`  … 还有 ${list.length - 40} 处`);
}
process.exit(1);
