import { evaluationBrowserBundle } from "../report/evaluation.js";
import { htmlReportWithFactorsBrowserBundle } from "../report/html-report-factors.js";

function browserBootstrapSource() {
  return `${evaluationBrowserBundle()}\n${htmlReportWithFactorsBrowserBundle()}\n
(function(){
  const match = window.location.pathname.match(/^\\/batches\\/(\\d+)$/);
  if (!match) return;
  const batchId = Number(match[1]);
  if (!Number.isFinite(batchId)) return;

  let detailPromise = null;
  function loadDetail(){
    if (!detailPromise) {
      detailPromise = fetch('/api/batches/' + batchId, { cache: 'no-store' })
        .then(function(response){
          if (!response.ok) throw new Error('读取批次报告数据失败：HTTP ' + response.status);
          return response.json();
        });
    }
    return detailPromise;
  }

  function safeText(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function tone(score){
    if (Number(score) >= 80) return 'good';
    if (Number(score) >= 60) return 'warn';
    return 'bad';
  }

  function scoreCard(label, score, hint){
    return '<div class="stat"><div class="label">' + safeText(label) + '</div>' +
      '<div class="eval-score ' + tone(score) + '">' + Number(score || 0).toFixed(0) + '</div>' +
      '<div class="hint">' + safeText(hint) + '</div></div>';
  }

  function statusCard(label, value, hint, toneName){
    return '<div class="stat"><div class="label">' + safeText(label) + '</div>' +
      '<div class="eval-score ' + safeText(toneName || 'warn') + '" style="font-size:20px;line-height:1.25">' + safeText(value) + '</div>' +
      '<div class="hint">' + safeText(hint) + '</div></div>';
  }

  function pctOrNA(value){
    return value == null ? 'N/A' : reportPct(value);
  }

  function renderEvaluation(detail){
    const evaluation = evaluateBatchDetail(detail);
    const metrics = evaluation.metrics;
    const summary = optimizationSummaryData(detail, evaluation);
    const existing = document.getElementById('batch-professional-evaluation');
    if (existing) existing.remove();

    const section = document.createElement('section');
    section.className = 'card';
    section.id = 'batch-professional-evaluation';

    const recommendations = evaluation.recommendations.slice(0, 4).map(function(item){
      return '<div class="eval-reco"><div><span class="eval-priority">' + safeText(item.level) + '</span><strong>' + safeText(item.title) + '</strong></div>' +
        '<div class="hint" style="margin-top:5px">' + safeText(item.evidence) + '</div>' +
        '<div style="margin-top:5px">' + safeText(item.direction) + '</div>' +
        '<div class="hint" style="margin-top:5px"><b>下一轮验证：</b>' + safeText(item.metric) + '</div></div>';
    }).join('');

    const factor = metrics.factorEvidence || {};
    const weakest = summary.weakest;
    const weakestValue = weakest ? weakest.category : '暂无分类';
    const weakestHint = weakest
      ? '提及率 ' + reportPct(weakest.mentionRate) + ' · ' + Number(weakest.mentioned || 0) + '/' + Number(weakest.validRuns || 0) + ' Run'
      : '需要先给 Prompt 配置问题分类';
    const trackedValue = summary.trackedConfigured ? pctOrNA(summary.trackedRate) : 'N/A';
    const trackedHint = summary.trackedConfigured
      ? Number(summary.trackedCited || 0) + ' / ' + Number(summary.trackedTotal || 0) + ' 篇目标文章'
      : '未配置目标文章，不计为 0%';
    const topSourceHint = metrics.source && metrics.source.topDomainShare != null
      ? 'Top1 ' + reportPct(metrics.source.topDomainShare) + ' · ' + metrics.source.concentrationLabel
      : '暂无可见引用来源';
    const factorHint = factor.available
      ? (factor.evidenceLabel + ' · 页面覆盖 ' + pctOrNA(factor.pageEvidenceRate))
      : (factor.reason || '暂无候选→引用因子数据');

    const primaryAction = summary.primaryAction;
    const actionBlock = primaryAction
      ? '<div class="eval-reco" style="border-left:4px solid var(--accent);margin:14px">' +
          '<div><span class="eval-priority">' + safeText(primaryAction.level) + '</span><strong>下一轮优先：' + safeText(primaryAction.title) + '</strong></div>' +
          '<div style="margin-top:6px">' + safeText(primaryAction.direction) + '</div>' +
          '<div class="hint" style="margin-top:6px"><b>验证：</b>' + safeText(primaryAction.metric) + '</div>' +
        '</div>'
      : '<div class="hint" style="padding:14px">保持固定 Prompt 池、种子和时间窗继续扩样，先建立可重复基线。</div>';

    section.innerHTML = '<div class="card-head"><strong>GEO 调优摘要</strong><span>先看瓶颈和可行动性，综合分只做趋势参考</span></div>' +
      '<div class="card-body">' +
      '<div style="margin:14px;padding:14px 16px;border:1px solid var(--border-solid);border-left:4px solid var(--accent);border-radius:10px">' +
        '<div class="hint">当前首要瓶颈</div>' +
        '<div style="font-size:22px;font-weight:750;margin-top:3px">' + safeText(summary.bottleneck) + '</div>' +
        '<div class="hint" style="margin-top:6px">' + safeText(summary.bottleneckEvidence) + '</div>' +
      '</div>' +

      '<div class="hint" style="margin:16px 14px 6px"><b>Outcome · 实际结果</b> — 回答“现在表现怎样”，不解释原因。</div>' +
      '<div class="stats" style="margin:0 14px 14px">' +
        statusCard('PROMPT 提及覆盖', pctOrNA(metrics.promptCoverage), '去重问题中有多少能看到品牌', metrics.promptCoverage != null && metrics.promptCoverage >= 0.5 ? 'good' : 'warn') +
        statusCard('RUN 提及率', pctOrNA(metrics.runMentionRate), '有效 Run 中出现品牌的比例', metrics.runMentionRate != null && metrics.runMentionRate >= 0.5 ? 'good' : 'warn') +
        statusCard('自有内容引用', trackedValue, trackedHint, summary.trackedConfigured && Number(summary.trackedRate) >= 0.25 ? 'good' : 'warn') +
      '</div>' +

      '<div class="hint" style="margin:16px 14px 6px"><b>Diagnostic · 损失定位</b> — 回答“最可能卡在哪一层”。</div>' +
      '<div class="stats" style="margin:0 14px 14px">' +
        statusCard('最弱问题意图', weakestValue, weakestHint, weakest && Number(weakest.mentionRate) < 0.4 ? 'bad' : 'warn') +
        statusCard('来源结构', metrics.source ? metrics.source.concentrationLabel : '暂无数据', topSourceHint, metrics.source && metrics.source.topDomainShare >= 0.5 ? 'warn' : 'good') +
        statusCard('样本信心', metrics.sampleConfidence || '未知', Number(metrics.valid || 0) + ' / ' + Number(metrics.assignments || 0) + ' Run 有效', ['高','中高'].includes(metrics.sampleConfidence) ? 'good' : 'warn') +
      '</div>' +

      '<div class="hint" style="margin:16px 14px 6px"><b>Evidence · 能不能据此改内容</b> — 缺失数据不按 0 分处理。</div>' +
      '<div class="stats" style="margin:0 14px 14px">' +
        scoreCard('数据质量', metrics.dataQualityScore, '等级 ' + metrics.dataQualityGrade + ' · 引用解析/有效 Run 综合') +
        statusCard('证据可行动性', summary.actionability, summary.actionabilityHint, summary.actionabilityTone) +
        statusCard('页面因子证据', factor.available ? factor.evidenceLabel : 'N/A', factorHint, factor.available && factor.evidenceScore >= 60 ? 'good' : 'warn') +
      '</div>' +

      actionBlock +
      '<details style="margin:14px"><summary style="cursor:pointer;font-weight:650">内部趋势评分（辅助）</summary>' +
        '<div class="stats" style="margin-top:10px">' +
          scoreCard('品牌可见度', metrics.visibilityIndex, '用于同项目批次趋势') +
          scoreCard('来源多样性', metrics.source.diversityScore, metrics.source.concentrationLabel) +
          scoreCard('综合准备度', metrics.readinessIndex, '等级 ' + metrics.readinessGrade + ' · 不作为改版指令') +
        '</div>' +
      '</details>' +
      '<div style="border-top:1px solid var(--border-solid)">' + recommendations + '</div>' +
      '<div class="hint" style="padding:12px 14px;margin:0">解释顺序固定为 Outcome → Diagnostic → Evidence → Action。不要把总引用数、综合准备度或单批次相关性直接当成页面改版依据。</div>' +
      '</div>';

    const head = document.querySelector('.page-head');
    if (head && head.parentNode) head.insertAdjacentElement('afterend', section);
    return evaluation;
  }

  function downloadHtml(detail){
    const evaluation = evaluateBatchDetail(detail);
    const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: new Date().toISOString() });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'onegl-batch-' + batchId + '-report.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  function previewHtml(detail){
    const evaluation = evaluateBatchDetail(detail);
    const html = buildHtmlReportWithFactors(detail, evaluation, { generatedAt: new Date().toISOString() });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
  }

  function ensureActions(){
    const row = document.querySelector('.page-title-row');
    if (!row) return null;
    let actions = row.querySelector('.page-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'page-actions';
      row.appendChild(actions);
    }
    if (!document.getElementById('onegl-generate-html-report')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'onegl-generate-html-report';
      button.textContent = '生成 HTML 报告';
      button.addEventListener('click', function(){
        button.disabled = true;
        button.textContent = '正在生成…';
        loadDetail().then(downloadHtml).catch(function(error){
          window.alert(error && error.message ? error.message : String(error));
        }).finally(function(){
          button.disabled = false;
          button.textContent = '生成 HTML 报告';
        });
      });
      actions.appendChild(button);

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'ghost';
      preview.textContent = '预览报告';
      preview.addEventListener('click', function(){
        loadDetail().then(previewHtml).catch(function(error){
          window.alert(error && error.message ? error.message : String(error));
        });
      });
      actions.appendChild(preview);
    }
    return actions;
  }

  ensureActions();
  loadDetail().then(renderEvaluation).catch(function(error){
    console.warn('[OneGl] optimization evaluation unavailable', error);
  });
})();`;
}

export function reportExportBootstrap(active) {
  if (active !== "batches") return "";
  return `<script>${browserBootstrapSource()}</script>`;
}
