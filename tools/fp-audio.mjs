import { loadConfig } from "../src/config.js";
import { launchBrowserSession } from "../src/browser.js";

/**
 * 专测音频噪声是否真的生效。
 *
 * 第一轮审计里我用 AudioContext + AnalyserNode 实时读取，拿到的是全 -Infinity ——
 * 那是测量方式有问题（AnalyserNode 需要音频图真正跑起来，而 headless 下
 * 没有音频设备，且 startRendering 前读数无效），不能据此判断「音频指纹没换」。
 *
 * 这里换三种测法互相印证：
 *   A. OfflineAudioContext 渲染一段已知波形，取 buffer 样本（同步可测）
 *   B. 挂到 destination 之前用 ScriptProcessor 取实时样本
 *   C. 直接读配置里的 audio:seed 与页面上是否有一致的噪声表现
 *
 * 结论要靠「同进程内多次渲染是否一致」+「跨会话是否不同」两个维度一起判断：
 *   - 同进程内都一致 → 测量有效，可以看跨会话差异
 *   - 同进程内就不一致 → 测量无效，换测法
 */
const ROUNDS = Number(process.argv[2] || 3);

async function measureAudio(page) {
  return page.evaluate(async () => {
    // A. OfflineAudioContext：渲染已知波形，取样本
    const offline = async () => {
      const ctx = new OfflineAudioContext(1, 4096, 44100);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      const buf = await ctx.startRendering();
      // Firefox Xray 下 AudioBuffer.getChannelData() 的 TypedArray 被隔离：
      // 下标、Array.from、整体返回全抛 "Accessing TypedArray data over Xrays"。
      //
      // 但这本身是个信号：普通页面的 TypedArray 不会被 Xray 包裹，只有**特权
      // （chrome）代码创建/改写的对象才会。Camoufox 的音频噪声正是在C++ 层
      // 注入的 —— 所以「读不到」恰恰可能说明噪声层已经就位。
      //
      // 用 TypedArray 自身的方法（reduce）做摘要，绕开元素访问与边界复制：
      let sum = null;
      let err = null;
      try {
        sum = buf.getChannelData(0).reduce((a, b) => a + b, 0);
      } catch (e) {
        err = String(e.message).slice(0, 70);
      }
      return { channelSum: sum, error: err, length: buf.length, channels: buf.numberOfChannels };
    };

    // B. 实时：Oscillator -> Analyser，延时后读
    const realtime = async () => {
      try {
        const actx = new AudioContext();
        const osc = actx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = 10000;
        const comp = actx.createDynamicsCompressor();
        const an = actx.createAnalyser();
        an.fftSize = 256;
        osc.connect(comp);
        comp.connect(an);
        osc.connect(actx.destination);
        osc.start();
        await new Promise((r) => setTimeout(r, 120));
        const bufT = new Float32Array(an.fftSize);
        const bufF = new Float32Array(an.frequencyBinCount);
        // 同样受 Xray 限制：先在页面侧转成普通数组再返回
        an.getFloatTimeDomainData(bufT);
        an.getFloatFrequencyData(bufF);
        osc.stop();
        await actx.close();
        return {
          time: Array.from(bufT).slice(0, 5).map((v) => Number(v.toFixed(8))),
          freq: Array.from(bufF).slice(0, 5).map((v) => Number(v.toFixed(4))),
        };
      } catch (e) {
        return { error: String(e.message).slice(0, 60) };
      }
    };

    const a1 = await offline();
    const a2 = await offline();
    const b1 = await realtime();
    return {
      offlineSample: a1,
      offlineStableWithinSession: JSON.stringify(a1) === JSON.stringify(a2),
      realtime: b1,
      ctxSampleRate: new OfflineAudioContext(1, 1, 44100).sampleRate,
      destMaxChannelCount: new AudioContext().destination.maxChannelCount,
    };
  });
}

const config = loadConfig({ accountKey: null, provider: "doubao" });
const rows = [];

for (let round = 1; round <= ROUNDS; round += 1) {
  const session = await launchBrowserSession(config);
  try {
    const m = await measureAudio(session.page);
    const cfg = session.camoufoxFingerprintConfig;
    rows.push({ m, audioSeed: cfg?.["audio:seed"] });
    console.log(`\n[round ${round}] cfg audio:seed=${cfg?.["audio:seed"]}`);
    console.log(`  offline 摘要      ${JSON.stringify(m.offlineSample).slice(0, 96)}`);
    console.log(`  同进程内两次一致? ${m.offlineStableWithinSession}`);
    console.log(`  realtime time     ${JSON.stringify(m.realtime?.time ?? m.realtime?.error).slice(0, 60)}`);
    console.log(`  sampleRate=${m.ctxSampleRate} destMaxCh=${m.destMaxChannelCount}`);
  } finally {
    await session.close();
  }
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n================ 音频指纹判定 ================`);
const withinStable = rows.filter((r) => r.m.offlineStableWithinSession).length;
console.log(
  `  测量有效性（同进程内可复现）: ${withinStable}/${rows.length}` +
    `${withinStable === rows.length ? "✓ 测法有效" : "✗ 测法无效，跨会话差异不可信"}`,
);
const offlineVals = new Set(rows.map((r) => JSON.stringify(r.m.offlineSample)));
console.log(
  `  跨会话 offline 样本取值数: ${offlineVals.size}/${rows.length}` +
    `${offlineVals.size === rows.length ? "✓ 每会话不同" : offlineVals.size === 1 ? "✗ 完全相同" : "~ 有重复"}`,
);
const seedVals = new Set(rows.map((r) => r.audioSeed));
console.log(
  `  跨会话 cfg audio:seed 取值数: ${seedVals.size}/${rows.length}` +
    `${seedVals.size === rows.length ? "✓ 每会话不同" : "✗ 相同"}`,
);