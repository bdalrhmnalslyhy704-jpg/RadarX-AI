import {getMarketRadar} from './radarx-backend-client.mjs';
import {
  normalizeMarketRadarResponse,
  classifyMarketRadarResponse,
  filterCandidates,
  sortCandidates,
  getStrategyOptions,
  isCandidateFresh,
  candidateReason,
  normalizeStrategyRows,
  fetchMarketRadarWithRetry
} from './radarx-market-radar-ui.mjs';

const STYLE_ID = 'radarx-market-radar-style';
const STATUS_LABELS = Object.freeze({
  FETCHING: 'FETCHING',
  RETRY: 'RETRY',
  LIVE_DATA: 'LIVE DATA',
  DATA_STALE: 'DATA_STALE',
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
  NO_CANDIDATES: 'NO_CANDIDATES',
  OFFLINE: 'Offline'
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
function num(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: digits}) : 'UNKNOWN';
}
function time(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Intl.DateTimeFormat('ar', {dateStyle:'medium', timeStyle:'medium'}).format(new Date(n)) : 'UNKNOWN';
}
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? num(n * 100, 0) + '%' : 'UNKNOWN';
}
function isRetryableResponse(response) {
  return !response || response.status === 0 || response.status === 429 || response.status >= 500;
}

export function validateMarketRadarContract(response) {
  const n = normalizeMarketRadarResponse(response);
  if (!n.ok || n.status !== 200) return {valid:false, reason:'HTTP_ERROR', strategiesPerCandidate:0};
  if (!n.paperTrading || !n.realOrderExecution || !n.confidenceScore) {
    return {valid:false, reason:'PAPER_ONLY_CONTRACT_INVALID', strategiesPerCandidate:0};
  }
  const counts = n.candidates.map(candidate => Array.isArray(candidate?.strategies) ? candidate.strategies.length : 0);
  if (counts.some(count => count !== 10)) {
    return {valid:false, reason:'STRATEGY_COUNT_NOT_10', strategiesPerCandidate: Math.max(0, ...counts)};
  }
  return {valid:true, reason:null, strategiesPerCandidate:10};
}

export function buildCandidateMarkup(candidate, index) {
  const fresh = isCandidateFresh(candidate);
  const state = candidate?.signal_state || 'UNKNOWN';
  const score = Number.isFinite(Number(candidate?.overall_score)) ? num(candidate.overall_score, 2) : 'UNKNOWN';
  const coverage = candidate?.coverage?.ratio !== undefined ? pct(candidate.coverage.ratio) : 'UNKNOWN';
  return '<article class="rxmr-candidate" data-index="' + index + '">' +
    '<div class="rxmr-head"><div><strong>' + esc(candidate.symbol) + '</strong><span class="rxmr-muted"> ' + esc(candidateReason(candidate)) + '</span></div><b>' + esc(num(candidate.last_price, 8)) + '</b></div>' +
    '<div class="rxmr-grid">' +
      '<div><span>24h</span><b>' + esc(num(candidate.price_change_24h, 2)) + '%</b></div>' +
      '<div><span>Quote volume</span><b>' + esc(num(candidate.quote_volume_24h, 0)) + '</b></div>' +
      '<div><span>Liquidity</span><b>' + esc(num(candidate.liquidity_quality, 1)) + '</b></div>' +
      '<div><span>Data quality</span><b>' + esc(num(candidate.data_quality, 1)) + '</b></div>' +
      '<div><span>Overall score</span><b>' + esc(score) + '</b></div>' +
      '<div><span>Coverage</span><b>' + esc(coverage) + '</b></div>' +
      '<div><span>Best strategy</span><b>' + esc(candidate.best_strategy || 'UNKNOWN') + '</b></div>' +
      '<div><span>Direction</span><b>' + esc(candidate.direction || 'NONE') + '</b></div>' +
    '</div>' +
    '<div class="rxmr-chips"><span>' + esc(state) + '</span><span>' + (fresh ? 'FRESH' : 'DATA_STALE') + '</span></div>' +
    '<div class="rxmr-muted">سبب الظهور: ' + esc(candidateReason(candidate)) + '</div>' +
    '<div class="rxmr-muted">المخاطر: ' + esc((candidate.risk_flags || []).join(' · ') || 'لا توجد') + '</div>' +
    '<div class="rxmr-muted">الإبطال: ' + esc((candidate.invalidation || []).join(' · ') || 'لا توجد') + '</div>' +
    '<button type="button" class="rxmr-button rxmr-detail" data-detail-index="' + index + '">تفاصيل Candidate</button>' +
  '</article>';
}

export function buildCandidateDetailMarkup(candidate) {
  const rows = normalizeStrategyRows(candidate);
  const accepted = rows.filter(s => s.state === 'CONFIRMED' || s.state === 'CANDIDATE');
  const rejected = rows.filter(s => s.state === 'REJECTED');
  const insufficient = rows.filter(s => s.state === 'INSUFFICIENT_DATA');
  const evidence = Object.entries(candidate?.evidence || {}).map(([key, value]) =>
    '<div><code>' + esc(key) + '</code>: ' + esc(typeof value === 'object' ? JSON.stringify(value) : value) + '</div>'
  ).join('');
  const strategyHtml = rows.map(s => {
    const ev = Object.entries(s.evidence || {}).map(([key, value]) =>
      '<div><code>' + esc(key) + '</code>: ' + esc(typeof value === 'object' ? JSON.stringify(value) : value) + '</div>'
    ).join('') || '<div>لا توجد evidence</div>';
    return '<article class="rxmr-strategy">' +
      '<div class="rxmr-head"><strong>' + esc(s.id) + '</strong><b>' + esc(s.state) + '</b></div>' +
      '<div class="rxmr-muted">Direction: ' + esc(s.direction) + ' · Score: ' + esc(num(s.score, 2)) + ' · Coverage: ' + esc(s.coverage === null ? 'UNKNOWN' : pct(s.coverage)) + '</div>' +
      '<div class="rxmr-muted">Hard gates: ' + esc(s.hardGatesPassed ? 'PASS' : 'FAIL') + ' · confidence_score: UNKNOWN</div>' +
      '<div class="rxmr-muted">reason_codes: ' + esc(s.reasonCodes.join(' · ') || '—') + '</div>' +
      '<div class="rxmr-muted">required_data: ' + esc(s.requiredData.join(', ') || '—') + '</div>' +
      '<div class="rxmr-muted rxmr-bad">missing: ' + esc(s.missingRequiredData.join(', ') || '—') + '</div>' +
      '<div class="rxmr-evidence"><b>evidence</b>' + ev + '</div>' +
      '<div class="rxmr-muted">invalidation: ' + esc(s.invalidation.join(' · ') || '—') + '</div>' +
    '</article>';
  }).join('');
  return '<div class="rxmr-summary-grid">' +
    '<div><span>accepted</span><b>' + accepted.length + '</b></div>' +
    '<div><span>rejected</span><b>' + rejected.length + '</b></div>' +
    '<div><span>insufficient</span><b>' + insufficient.length + '</b></div>' +
    '<div><span>strategies</span><b>' + rows.length + '</b></div>' +
  '</div>' +
  '<div class="rxmr-muted">Data freshness: ' + esc(candidate?.data_status?.data_stale === true ? 'DATA_STALE' : 'FRESH') +
    ' · fetch_age_ms: ' + esc(num(candidate?.data_status?.fetch_age_ms, 0)) +
    ' · source: ' + esc(candidate?.data_status?.source || 'UNKNOWN') + '</div>' +
  '<div class="rxmr-muted">accepted_strategies: ' + esc((candidate?.accepted_strategies || []).join(', ') || '—') + '</div>' +
  '<div class="rxmr-muted">rejected_strategies: ' + esc(rejected.map(s => s.id + ' [' + s.reasonCodes.join(', ') + ']').join(' · ') || '—') + '</div>' +
  '<div class="rxmr-muted">INSUFFICIENT_DATA: ' + esc(insufficient.map(s => s.id + ' [' + s.missingRequiredData.join(', ') + ']').join(' · ') || '—') + '</div>' +
  '<div class="rxmr-muted">risk_flags: ' + esc((candidate?.risk_flags || []).join(' · ') || '—') + '</div>' +
  '<div class="rxmr-muted">invalidation: ' + esc((candidate?.invalidation || []).join(' · ') || '—') + '</div>' +
  '<div class="rxmr-evidence"><b>Candidate evidence</b>' + (evidence || '<div>لا توجد evidence</div>') + '</div>' +
  '<div class="rxmr-strategies">' + strategyHtml + '</div>';
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = '.rxmr-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.rxmr-title{font-size:18px;font-weight:950}.rxmr-status{border:1px solid #2a4c58;border-radius:999px;padding:7px 10px;font-size:10px;font-weight:950}.rxmr-live{color:#b5f5da;border-color:#268c68}.rxmr-warn{color:#ffe0a0;border-color:#90713a}.rxmr-bad,.rxmr-offline{color:#ffc4ca}.rxmr-grid,.rxmr-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.rxmr-grid div,.rxmr-summary-grid div{background:#08131a;border:1px solid #17313a;border-radius:10px;padding:9px}.rxmr-grid span,.rxmr-summary-grid span{display:block;color:#8da7b1;font-size:10px}.rxmr-grid b,.rxmr-summary-grid b{display:block;margin-top:3px}.rxmr-candidate,.rxmr-strategy{background:#08131a;border:1px solid #17313a;border-radius:13px;padding:11px}.rxmr-list{display:grid;gap:9px;margin-top:11px}.rxmr-muted{color:#8da7b1;font-size:11px;line-height:1.5;margin-top:7px}.rxmr-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.rxmr-chips span{border:1px solid #2a4c58;border-radius:999px;padding:4px 7px;font-size:10px}.rxmr-button{width:100%;min-height:44px;border:1px solid #2a4c58;border-radius:11px;background:#0a161d;color:#fff;font:inherit;font-weight:900;margin-top:9px}.rxmr-controls{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.rxmr-select{width:100%;min-height:44px;border:1px solid #2a4c58;border-radius:10px;background:#08131a;color:#fff;padding:0 10px}.rxmr-detail-panel{margin-top:11px;border:1px solid #31515f;border-radius:13px;padding:11px}.rxmr-evidence{margin-top:8px;padding:8px;border-radius:10px;background:#061016;font-size:10px}.rxmr-strategies{display:grid;gap:8px;margin-top:10px}@media(max-width:760px){.rxmr-grid,.rxmr-summary-grid{grid-template-columns:repeat(2,1fr)}.rxmr-controls{grid-template-columns:repeat(2,1fr)}}@media(max-width:470px){.rxmr-grid,.rxmr-summary-grid,.rxmr-controls{grid-template-columns:1fr}}';
  document.head.appendChild(style);
}

function skeleton(root) {
  root.innerHTML = '<div class="rxmr-head"><div><div class="rxmr-title">Market Radar</div><div class="rxmr-muted">Spot read-only via Backend</div></div><span class="rxmr-status rxmr-warn" data-rx-status>FETCHING</span></div>' +
    '<div class="rxmr-summary-grid"><div><span>آخر تحديث</span><b data-rx-updated>UNKNOWN</b></div><div><span>المطلوب</span><b data-rx-requested>20</b></div><div><span>المفحوص</span><b data-rx-scanned>0</b></div><div><span>المرشحون</span><b data-rx-count>0</b></div><div><span>Backend</span><b data-rx-backend>FETCHING</b></div><div><span>confidence</span><b>UNKNOWN</b></div></div>' +
    '<div class="rxmr-controls"><select class="rxmr-select" data-rx-sort><option value="strongest">الأقوى</option><option value="liquidity">أعلى سيولة</option><option value="volume">أعلى حجم</option></select><select class="rxmr-select" data-rx-direction><option value="ALL">كل الاتجاهات</option><option value="LONG">LONG</option><option value="BEARISH">BEARISH</option></select><select class="rxmr-select" data-rx-state><option value="ALL">كل الحالات</option><option value="CONFIRMED">CONFIRMED</option><option value="CANDIDATE">CANDIDATE</option><option value="NO_SIGNAL">NO_SIGNAL</option><option value="REJECTED">REJECTED</option><option value="INSUFFICIENT_DATA">INSUFFICIENT_DATA</option></select><select class="rxmr-select" data-rx-strategy><option value="ALL">كل الاستراتيجيات</option></select></div>' +
    '<button type="button" class="rxmr-button" data-rx-refresh>تحديث Market Radar</button><div class="rxmr-list" data-rx-list></div><div class="rxmr-detail-panel" data-rx-detail hidden></div>';
}

export function mountMarketRadarScreen(root, options = {}) {
  if (!root || typeof document === 'undefined') return {destroy(){}};
  injectStyle();
  skeleton(root);

  const client = options.client || {getMarketRadar};
  const state = {candidates: [], response:null, lastUpdate:null, destroyed:false};

  const nodes = {
    status: root.querySelector('[data-rx-status]'),
    updated: root.querySelector('[data-rx-updated]'),
    requested: root.querySelector('[data-rx-requested]'),
    scanned: root.querySelector('[data-rx-scanned]'),
    count: root.querySelector('[data-rx-count]'),
    backend: root.querySelector('[data-rx-backend]'),
    sort: root.querySelector('[data-rx-sort]'),
    direction: root.querySelector('[data-rx-direction]'),
    signalState: root.querySelector('[data-rx-state]'),
    strategy: root.querySelector('[data-rx-strategy]'),
    refresh: root.querySelector('[data-rx-refresh]'),
    list: root.querySelector('[data-rx-list]'),
    detail: root.querySelector('[data-rx-detail]')
  };

  function setStatus(mode) {
    nodes.status.textContent = STATUS_LABELS[mode] || mode;
    nodes.status.className = 'rxmr-status ' + (mode === 'LIVE_DATA' ? 'rxmr-live' : mode === 'DATA_STALE' || mode === 'DATA_UNAVAILABLE' || mode === 'NO_CANDIDATES' ? 'rxmr-warn' : 'rxmr-offline');
    nodes.backend.textContent = mode === 'LIVE_DATA' || mode === 'DATA_STALE' || mode === 'NO_CANDIDATES' ? 'Connected' : mode;
  }
  function renderList() {
    const filtered = filterCandidates(state.candidates, {
      direction: nodes.direction.value,
      strategy: nodes.strategy.value,
      signalState: nodes.signalState.value
    });
    const sorted = sortCandidates(filtered, nodes.sort.value);
    if (!sorted.length) {
      nodes.list.innerHTML = '<div class="rxmr-candidate"><b>NO_CANDIDATES</b><div class="rxmr-muted">لا توجد Candidates مطابقة للفلترة الحالية.</div></div>';
      return;
    }
    nodes.list.innerHTML = sorted.map(candidate => buildCandidateMarkup(candidate, state.candidates.indexOf(candidate))).join('');
    root.querySelectorAll('[data-detail-index]').forEach(button => {
      button.addEventListener('click', () => {
        const candidate = state.candidates[Number(button.dataset.detailIndex)];
        if (!candidate) return;
        nodes.detail.hidden = false;
        nodes.detail.innerHTML = '<div class="rxmr-head"><b>' + esc(candidate.symbol) + ' • Candidate Detail</b><button type="button" class="rxmr-button" data-rx-close style="width:auto;padding:0 14px;margin:0">إغلاق</button></div>' + buildCandidateDetailMarkup(candidate);
        const close = nodes.detail.querySelector('[data-rx-close]');
        if (close) close.addEventListener('click', () => { nodes.detail.hidden = true; });
      });
    });
  }
  function renderFilters() {
    const current = nodes.strategy.value;
    const options = getStrategyOptions(state.candidates);
    nodes.strategy.innerHTML = '<option value="ALL">كل الاستراتيجيات</option>' + options.map(id => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
    nodes.strategy.value = options.includes(current) ? current : 'ALL';
  }
  function fail(mode, detail) {
    setStatus(mode);
    state.candidates = [];
    nodes.updated.textContent = 'UNKNOWN';
    nodes.count.textContent = '0';
    nodes.list.innerHTML = '<div class="rxmr-candidate"><b>' + esc(STATUS_LABELS[mode] || mode) + '</b><div class="rxmr-muted">' + esc(detail || 'لا توجد بيانات قابلة للعرض.') + '</div><button type="button" class="rxmr-button" data-rx-retry>إعادة المحاولة</button></div>';
    const retry = nodes.list.querySelector('[data-rx-retry]');
    if (retry) retry.addEventListener('click', load);
  }
  async function load() {
    if (state.destroyed) return;
    if (!navigator.onLine) { fail('OFFLINE', 'لا يوجد اتصال بالإنترنت.'); return; }
    setStatus('FETCHING');
    nodes.updated.textContent = 'UNKNOWN';
    try {
      const result = await fetchMarketRadarWithRetry(client, {
      quote: 'USDT',
      limit: 20,
      attempts: 2,
      sleepFn: async ms => { setStatus('RETRY'); await new Promise(resolve => setTimeout(resolve, ms)); }
    });
    if (state.destroyed) return;
    const response = result.response;
    let mode = classifyMarketRadarResponse(response, navigator.onLine);
    const normalized = normalizeMarketRadarResponse(response, 20);
    if (mode === 'RETRY') {
      mode = navigator.onLine ? 'DATA_UNAVAILABLE' : 'OFFLINE';
    }
    if (mode === 'LIVE_DATA') {
      const contract = validateMarketRadarContract(response);
      if (!contract.valid) { fail('DATA_UNAVAILABLE', contract.reason); return; }
      state.candidates = normalized.candidates;
      state.response = response;
      state.lastUpdate = normalized.updatedAt || new Date().toISOString();
      nodes.updated.textContent = time(state.lastUpdate);
      nodes.requested.textContent = String(normalized.requestedPairs);
      nodes.scanned.textContent = String(normalized.scannedPairs);
      nodes.count.textContent = String(normalized.candidateCount);
      renderFilters();
      renderList();
      setStatus('LIVE_DATA');
      return;
    }
    if (mode === 'NO_CANDIDATES') {
      nodes.requested.textContent = String(normalized.requestedPairs);
      nodes.scanned.textContent = String(normalized.scannedPairs);
      fail('NO_CANDIDATES', 'Backend متصل لكن لم يتم إرجاع Candidates.');
      return;
    }
      fail(mode, response?.error || 'تعذر الحصول على Market Radar.');
    } catch (error) {
    console.error('RadarX Market Radar UI error:', error);
    fail(navigator.onLine ? 'DATA_UNAVAILABLE' : 'OFFLINE', String(error?.message || error || 'UNKNOWN_ERROR'));
    }
  }

  nodes.refresh.addEventListener('click', load);
  [nodes.sort, nodes.direction, nodes.signalState, nodes.strategy].forEach(node => node.addEventListener('change', renderList));
  const online = () => load();
  const offline = () => fail('OFFLINE', 'لا يوجد اتصال بالإنترنت. لا يتم عرض بيانات stale كـLIVE.');
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  load();

  return {
    refresh: load,
    destroy() {
      state.destroyed = true;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      if (root) root.innerHTML = '';
    },
    getState() {
      return {...state, candidates: [...state.candidates]};
    }
  };
}
