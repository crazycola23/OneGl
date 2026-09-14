import { evaluationBrowserBundle } from "../report/evaluation.js";
import { htmlReportBrowserBundle } from "../report/html-report.js";

function browserBootstrapSource() {
  return `${evaluationBrowserBundle()}\n${htmlReportBrowserBundle()}\n
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

  function renderEvaluation(detail){
    const evaluation = evaluateBatchDetail(detail);
    const metrics = evaluation.metrics;
    const existing = document.getElementById('batch-professional-evaluation');
    if (existing) existing.remove();

    const section = document.createElement('section');
    section.className = 'card';
    section.id = 'batch-professional-evaluation';
    const recommendations = evaluation.recommendations.slice(0, 4).map(function(item){
      return '<div class="eval-reco"><div><span class="eval-priority">' + safeText(item.level) + '</span><strong>' + safeText(item.title) + '</strong></div>' +
        '<div class="hint" style="margin-top:5px">' + safeText(item.evidence) + '</div>' +
        '<div style="margin-top:5px">' + safeText(item.direction) + '</div></div>';
    }).join('');

    section.innerHTML = '<div class="card-head"><strong>专业评估与建议方向</strong><span>OneGl 内部评估模型，不代表豆包官方评分</span></div>' +
      '<div class="card-body">' +
      '<div class="stats" style="margin:14px">' +
      scoreCard('数据质量', metrics.dataQualityScore, '等级 ' + metrics.dataQualityGrade + ' · 样本信心 ' + metrics.sampleConfidence) +
      scoreCard('品牌可见度', metrics.visibilityIndex, 'PROMPT 覆盖 ' + reportPct(metrics.promptCoverage)) +
      scoreCard('来源多样性', metrics.source.diversityScore, metrics.source.concentrationLabel) +
      scoreCard('综合准备度', metrics.readinessIndex, '等级 ' + metrics.readinessGrade) +
      '</div>' +
      '<div style="border-top:1px solid var(--border-solid)">' + recommendations + '</div>' +
      '<div class="hint" style="padding:12px 14px;margin:0">建议优先处理 P0/P1，并用固定 Prompt、固定种子做下一批对照实验；不要把单批次相关性直接解释成平台排序因果。</div>' +
      '</div>';

    const head = document.querySelector('.page-head');
    if (head && head.parentNode) head.insertAdjacentElement('afterend', section);
    return evaluation;
  }

  function downloadHtml(detail){
    const evaluation = evaluateBatchDetail(detail);
    const html = buildHtmlReport(detail, evaluation, { generatedAt: new Date().toISOString() });
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
    const html = buildHtmlReport(detail, evaluation, { generatedAt: new Date().toISOString() });
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
    console.warn('[OneGl] professional evaluation unavailable', error);
  });
})();`;
}

export function reportExportBootstrap(active) {
  if (active !== "batches") return "";
  return `<script>${browserBootstrapSource()}</script>`;
}
