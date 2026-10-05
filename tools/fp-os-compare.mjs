import { execFileSync } from "node:child_process";

/**
 * 核实两个不自洽项是不是我们配置引起的：
 *   1. navigator.userAgentData 不存在（Chromium 专有 API，真实 Chrome 都有）
 *   2. UA 说 Firefox，但 navigator.plugins 是 Chrome 那套 PDF 插件名
 *
 * 做法：对windows / macos / linux 三种 os 各生成一次配置，看
 *   - navigator.userAgent 变成什么
 *   - 配置里有没有 pluginsData / userAgentData 相关键
 * 若三种 os 都一样，说明与 os 选择无关，是 Camoufox 自身的行为。
 */
function gen(os) {
  const payload = {
    headless: true,
    os,
    locale: "zh-CN",
    window: [1440, 900],
    screen_size: { width: 1440, height: 900 },
  };
  const py = `
import json, os
from camoufox.utils import launch_options
from camoufox.addons import DefaultAddons
from browserforge.fingerprints import Screen
p = json.loads(os.environ["ONEGL_CAMOUFOX_PAYLOAD"]); p.pop("screen_size", None)
p["screen"] = Screen(min_width=1440, max_width=1440, min_height=900, max_height=900)
p["exclude_addons"] = list(DefaultAddons); p["addons"] = ["/opt/onegl-addons/ublock"]
o = launch_options(**p)
cfg = json.loads(o["env"]["CAMOU_CONFIG_1"])
out = {
  "ua": cfg.get("navigator.userAgent", ""),
  "platform": cfg.get("navigator.platform"),
  "oscpu": cfg.get("navigator.oscpu"),
  "pluginKeys": [k for k in cfg if "lugin" in k or "userAgentData" in k or "chrome" in k.lower()],
  "allKeys": sorted(cfg.keys()),
}
print(json.dumps(out))
`;
  const stdout = execFileSync("/opt/camoufox/bin/python", ["-c", py], {
    env: { ...process.env, ONEGL_CAMOUFOX_PAYLOAD: JSON.stringify(payload) },
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim());
}

for (const os of ["windows", "macos", "linux"]) {
  const r = gen(os);
  console.log(`\n[os=${os}]`);
  console.log(`  ua        ${r.ua.slice(0, 74)}`);
  console.log(`  platform  ${r.platform}    oscpu ${r.oscpu}`);
  console.log(`  插件/UAData 相关键  ${JSON.stringify(r.pluginKeys)}`);
}

console.log(`\n=== 第一次生成的完整键集 ===`);
console.log(gen("windows").allKeys.join("\n"));