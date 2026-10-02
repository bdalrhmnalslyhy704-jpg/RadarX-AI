import {getMarketRadar} from './radarx-backend-client.mjs';
import {
  normalizeMarketRadarResponse,
  classifyMarketRadarResponse,
  filterCandidates,
  sortCandidates,
  splitCandidates,
  getStrategyOptions,
  isCandidateEligible,
  candidateDataState,
  normalizeStrategyRows,
  fetchMarketRadarWithRetry
} from './radarx-market-radar-ui.mjs';

const STYLE_ID = 'radarx-dashboard-style';

const STATUS_LABELS = Object.freeze({
  FETCHING: 'جاري الفحص',
  RETRY: 'إعادة المحاولة',
  LIVE_DATA: 'LIVE DATA',
  PARTIAL_DATA: 'PARTIAL DATA',
  DATA_STALE: 'DATA STALE',
  DATA_UNAVAILABLE: 'DATA UNAVAILABLE',
  NO_VALID_CANDIDATES: 'لا يوجد مرشح صالح',
  OFFLINE: 'OFFLINE'
});

const STRATEGY_AR = Object.freeze({
  MTF_TREND: 'تتبّع الاتجاه متعدد الأطر',
  CONFIRMED_BREAKOUT: 'اختراق مؤكد',
  MEAN_REVERSION: 'ارتداد من مناطق التشبع',
  EMA_RIBBON_ALIGNMENT: 'توافق المتوسطات',
  ADX_TREND_STRENGTH: 'قوة الاتجاه',
  MACD_TREND_CONTINUATION: 'استمرار الزخم',
  BOLLINGER_BAND_REVERSION: 'ارتداد بولينجر',
  VWAP_REVERSION: 'ارتداد VWAP',
  RELATIVE_VOLUME_SURGE: 'اندفاع الحجم',
  ATR_EXPANSION: 'اتساع التذبذب',
  PRE_BREAKOUT_FINGERPRINT: 'بصمة ما قبل الاختراق',
  BOLLINGER_BAND_COMPRESSION: 'ضغط بولينجر',
  VWAP_POSITION: 'موقع VWAP',
  RELATIVE_VOLUME_AWAKENING: 'استيقاظ الحجم',
  VCP_PRE_BREAKOUT: 'نمط انكماش التذبذب VCP',
  FRACTAL_MA_BOTTOM_REVERSAL: 'انعكاس القاع Fractal + EMA',
  FRACTAL_MA_BREAKOUT: 'اختراق Fractal + EMA',
  FRACTAL_MA_TREND_SHIFT: 'تحول الاتجاه Fractal + EMA',
  SUPPORT_RESISTANCE_CONFIRMATION: 'تأكيد الدعم والمقاومة'
});

const REASON_AR = Object.freeze({
  TREND_CONFLUENCE_NOT_MET: 'لم يكتمل توافق الاتجاه',
  BREAKOUT_CONFIRMATION_NOT_MET: 'لم يكتمل تأكيد الاختراق',
  MEAN_REVERSION_FILTER_NOT_MET: 'شروط الارتداد غير مكتملة',
  FUTURE_DATA: 'البيانات الزمنية غير صالحة',
  STALE_DATA: 'البيانات قديمة',
  LIQUIDITY_GATE_FAILED: 'شرط السيولة غير مكتمل',
  LOW_LIQUIDITY: 'جودة السيولة منخفضة',
  MISSING_REQUIRED_DATA: 'بيانات مطلوبة غير متوفرة',
  INSUFFICIENT_DATA: 'البيانات غير كافية',
  FALSE_BREAKOUT: 'اشتباه باختراق كاذب',
  STRATEGY_HARD_GATE_FAILED: 'لم تجتز الاستراتيجية بواباتها',
  HL_EMERGING: 'قاع أعلى بدأ بالتكوّن HL',
  COMPRESSION: 'ضغط/تجميع وتضييق في النطاق',
  VOLUME_AWAKENING: 'استيقاظ وتسارع الحجم',
  RELATIVE_POWER_INCREASING: 'القوة النسبية تتحسن مقابل BTC',
  SELL_PRESSURE_DECLINING: 'ضغط البيع يتراجع',
  BOS_CONFIRMED: 'كسر هيكل مؤكد BOS',
  RETEST_HOLDING: 'إعادة الاختبار محافظة على المستوى',
  FALSE_BREAKOUT_RISK: 'خطر اختراق كاذب',
  FINGERPRINT_TRAP_RISK_HIGH: 'خطر المصيدة في البصمة مرتفع',
  FINGERPRINT_GATE_NOT_MET: 'لم تكتمل بصمة ما قبل الاختراق',
  FRACTAL_MA_BOTTOM_NOT_CONFIRMED: 'لم يتأكد انعكاس القاع عبر Fractal + EMA',
  FRACTAL_BREAKOUT_NOT_CONFIRMED: 'لم يتأكد اختراق Fractal + EMA',
  FRACTAL_MA_TREND_SHIFT_NOT_CONFIRMED: 'لم يكتمل تحول الاتجاه متعدد الأطر',
  SUPPORT_RESISTANCE_NOT_CONFIRMED: 'لم يتأكد ارتداد الدعم أو اختراق المقاومة',
  SUPPORT_BOUNCE_CONFIRMATION: 'تأكيد ارتداد الدعم',
  RESISTANCE_BREAKOUT: 'اختراق المقاومة',
  EMA20_EMA50_ALIGNMENT: 'توافق EMA20 وEMA50',
  RVOL_BOUNCE_SUPPORT: 'الحجم يدعم الارتداد',
  RVOL_BREAKOUT_CONFIRMATION: 'الحجم يؤكد الاختراق',
  BULLISH_CANDLE_CONFIRMATION: 'شمعة صاعدة مؤكدة'
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
function safeNum(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: digits}) : 'غير متاح';
}
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) + '%' : 'غير متاح';
}
function time(value) {
  const n = Date.parse(value);
  return Number.isFinite(n)
    ? new Intl.DateTimeFormat('ar', {dateStyle:'medium', timeStyle:'short'}).format(new Date(n))
    : 'غير متاح';
}
function friendlyStrategy(id) {
  return STRATEGY_AR[id] || id || 'غير متاح';
}
function friendlyReason(code) {
  return REASON_AR[code] || String(code || 'لا يوجد سبب محدد');
}
function stateClass(state) {
  return ({
    LIVE_DATA:'is-live',
    PARTIAL_DATA:'is-warn',
    DATA_STALE:'is-danger',
    DATA_UNAVAILABLE:'is-danger',
    NO_VALID_CANDIDATES:'is-warn',
    OFFLINE:'is-danger',
    RETRY:'is-info',
    FETCHING:'is-info'
  })[state] || 'is-info';
}
function signalStateLabel(state) {
  return state === 'CONFIRMED' ? 'مؤكد' : state === 'CANDIDATE' ? 'مرشح' : state === 'NO_SIGNAL' ? 'لا توجد إشارة' : 'غير متاح';
}
function directionLabel(direction) {
  return direction === 'LONG' ? 'صاعد' : direction === 'BEARISH' ? 'هابط' : 'غير متاح';
}

export function validateMarketRadarContract(response) {
  const body = response?.body;
  if (!response || response.status !== 200 || response.ok !== true || !body || typeof body !== 'object') {
    return {valid:false, reason:'HTTP_ERROR', strategiesPerCandidate:0};
  }
  if (body.meta?.paper_trading !== true ||
      body.meta?.real_order_execution !== false ||
      body.meta?.confidence_score !== 'UNKNOWN') {
    return {valid:false, reason:'PAPER_ONLY_CONTRACT_INVALID', strategiesPerCandidate:0};
  }
  const counts = Array.isArray(body.candidates)
    ? body.candidates.map(candidate => Array.isArray(candidate?.strategies) ? candidate.strategies.length : 0)
    : [];
  const supportedCounts = new Set([14, 15]);
  const invalidCount = counts.find(count => !supportedCounts.has(count));
  if (invalidCount !== undefined) {
    return {
      valid:false,
      reason:'STRATEGY_COUNT_UNSUPPORTED',
      strategiesPerCandidate:Math.max(0, ...counts)
    };
  }
  const distinctCounts = [...new Set(counts)];
  return {
    valid:true,
    reason:null,
    strategiesPerCandidate:distinctCounts.length === 1 ? distinctCounts[0] : null,
    supportedStrategyCounts:distinctCounts
  };
}

function fingerprintBadgeMarkup(candidate) {
  const fp = candidate?.pre_breakout_fingerprint;
  if (!fp || typeof fp !== 'object') return '';
  const score = Number(fp.score);
  const trap = Number(fp.trapRisk);
  const evidence = Number(fp.evidenceCount);
  const stage = String(fp.stage || 'NORMAL');
  const detected = fp.detected === true;
  const cls = stage === 'FALSE_BREAKOUT' ? 'is-danger' : detected ? 'is-live' : 'is-warn';
  const reasons = Array.isArray(fp.reasonCodes) ? fp.reasonCodes.slice(0,4).map(friendlyReason).join(' · ') : '';
  return '<div class="rx-fingerprint" style="margin-top:10px;padding:11px;border:1px solid #31515f;border-radius:13px;background:#08131a">' +
    '<div class="rx-meta-row"><span class="rx-chip ' + cls + '">🟡 ' + esc(stage.replace(/-/g,' ')) + '</span>' +
    '<span class="rx-chip is-info">Fingerprint ' + esc(Number.isFinite(score) ? safeNum(score,1) : '—') + '</span>' +
    '<span class="rx-chip ' + (trap <= 30 ? 'is-live' : trap <= 55 ? 'is-warn' : 'is-danger') + '">Trap ' + esc(Number.isFinite(trap) ? safeNum(trap,0) + '%' : '—') + '</span></div>' +
    '<div class="rx-grid rx-grid--3" style="margin-top:8px">' +
      '<div><span>Evidence</span><b>' + esc(Number.isFinite(evidence) ? evidence + ' / 8' : '—') + '</b></div>' +
      '<div><span>Structure</span><b>' + esc(fp.evidence?.structure?.status || 'UNKNOWN') + '</b></div>' +
      '<div><span>Volume</span><b>' + esc(fp.evidence?.volume?.status || 'UNKNOWN') + '</b></div>' +
    '</div>' +
    '<div class="rx-muted" style="margin-top:8px">' + esc(reasons || 'تتبع البصمة السلوكية قبل الحركة.') + '</div>' +
  '</div>';
}

function fingerprintDetailMarkup(candidate) {
  const fp = candidate?.pre_breakout_fingerprint;
  if (!fp || typeof fp !== 'object') {
    return '<section class="rx-section"><h4>🟡 Pre-Breakout Fingerprint</h4><div class="rx-empty-inline">لا تتوفر بصمة ما قبل الاختراق لهذه النتيجة.</div></section>';
  }
  const e = fp.evidence || {};
  const row = (label, data, extra='') =>
    '<div class="rx-evidence-row"><span>' + esc(label) + '</span><b>' + esc(String(data ?? 'غير متاح')) + '</b>' + (extra ? '<div class="rx-muted" style="margin-top:3px">' + esc(extra) + '</div>' : '') + '</div>';
  const evidenceHtml = [
    row('Structure', e.structure?.status, 'Score: ' + safeNum(e.structure?.score,0)),
    row('Compression', e.compression?.status, 'ATR ratio: ' + safeNum(e.compression?.atr_ratio,2) + ' · BB width ratio: ' + safeNum(e.compression?.bb_width_ratio,2)),
    row('Volume', e.volume?.status, 'RVOL: ' + safeNum(e.volume?.rvol,2) + ' · acceleration: ' + safeNum(e.volume?.acceleration,2)),
    row('Relative Power', e.relative_power?.status, 'Excess 20: ' + safeNum(e.relative_power?.excess_20,2) + '% · Excess 40: ' + safeNum(e.relative_power?.excess_40,2) + '%'),
    row('Resistance', e.resistance?.status, 'Tests: ' + safeNum(e.resistance?.tests,0) + ' · remaining: ' + safeNum(fp.resistance?.remainingTests,0)),
    row('Order Flow', e.order_flow?.status, 'OBI: ' + safeNum(e.order_flow?.obi,2) + ' · taker buy: ' + (Number.isFinite(Number(e.order_flow?.taker_buy_ratio)) ? safeNum(Number(e.order_flow.taker_buy_ratio)*100,1) + '%' : 'غير متاح')),
    row('BTC / Market Regime', e.regime?.status, 'Regime score: ' + safeNum(e.regime?.score,0)),
    row('Trigger', e.trigger?.status, 'BOS: ' + (fp.context?.breakout ? 'YES' : 'NO') + ' · Retest: ' + (fp.context?.retest ? 'YES' : 'NO'))
  ].join('');
  const journey = Array.isArray(fp.journey) && fp.journey.length
    ? fp.journey.map(x => '<span class="rx-chip is-info" style="margin:3px">' + esc(String(x.stage || '').replace(/-/g,' ')) + '</span>').join(' → ')
    : '<span class="rx-muted">لا توجد انتقالات تاريخية كافية.</span>';
  const analogs = Array.isArray(fp.historical?.analogs) && fp.historical.analogs.length
    ? fp.historical.analogs.map(a =>
        '<div class="rx-evidence-row"><span>' + esc(time(new Date(Number(a.at)).toISOString())) + '</span><b>Similarity ' + safeNum(a.similarity,1) + '%</b><div class="rx-muted" style="margin-top:3px">Forward max: ' + safeNum(a.forwardMaxReturnPct,2) + '% · Drawdown: ' + safeNum(a.forwardMaxDrawdownPct,2) + '% · ' + (a.successful ? 'Historical follow-through' : 'No follow-through') + '</div></div>'
      ).join('')
    : '<div class="rx-empty-inline">لا توجد analogs تاريخية مشابهة داخل البيانات المحمّلة.</div>';
  return '<section class="rx-section" open>' +
    '<div class="rx-section__title"><h4>🟡 Pre-Breakout Fingerprint</h4><span class="rx-chip is-warn">' + esc(fp.stage || 'NORMAL') + '</span></div>' +
    '<div class="rx-grid rx-grid--3">' +
      '<div><span>Fingerprint Score</span><b>' + safeNum(fp.score,1) + '</b></div>' +
      '<div><span>Trap Risk</span><b>' + safeNum(fp.trapRisk,0) + '%</b></div>' +
      '<div><span>Evidence</span><b>' + safeNum(fp.evidenceCount,0) + ' / 8</b></div>' +
    '</div>' +
    '<div class="rx-evidence-stack" style="margin-top:10px">' + evidenceHtml + '</div>' +
    '<div class="rx-muted" style="margin-top:10px"><b>Journey:</b><br>' + journey + '</div>' +
    '<details class="rx-tech" style="margin-top:10px"><summary>History Engine</summary>' +
      '<div class="rx-code-line">samples: ' + esc(fp.historical?.samples ?? 0) + '</div>' +
      '<div class="rx-code-line">lookaheadBars: ' + esc(fp.historical?.lookaheadBars ?? 0) + '</div>' +
      '<div class="rx-code-line">descriptiveSuccessRatePct: ' + esc(fp.historical?.descriptiveSuccessRatePct ?? 'UNKNOWN') + '</div>' +
      '<div class="rx-code-line" style="margin-top:6px">' + analogs + '</div>' +
    '</details>' +
  '</section>';
}

export function buildCandidateMarkup(candidate, index) {
  const eligible = isCandidateEligible(candidate);
  if (!eligible) {
    const state = candidateDataState(candidate);
    return '<article class="rx-card rx-card--excluded">' +
      '<div class="rx-card__top"><div><span class="rx-symbol">' + esc(candidate?.symbol) + '</span><span class="rx-chip ' + stateClass(state) + '">' + esc(state === 'DATA_STALE' ? 'DATA STALE' : 'غير متاح') + '</span></div></div>' +
      '<div class="rx-unavailable">غير متاح بسبب جودة البيانات</div>' +
      '<div class="rx-muted">لن يظهر هذا الأصل ضمن المرشحين الأقوى حتى تصبح البيانات حديثة وصالحة.</div>' +
      '<button type="button" class="rx-btn rx-btn--secondary rx-detail-button" data-detail-index="' + index + '">التفاصيل الفنية</button>' +
    '</article>';
  }

  return '<article class="rx-card">' +
    '<div class="rx-card__top"><div><div class="rx-symbol">' + esc(candidate.symbol) + '</div><div class="rx-muted">' + esc(friendlyStrategy(candidate.best_strategy)) + '</div></div>' +
      '<div class="rx-price">' + esc(safeNum(candidate.last_price, 8)) + '</div></div>' +
    '<div class="rx-meta-row"><span class="rx-chip ' + (candidate.price_change_24h >= 0 ? 'is-live' : 'is-danger') + '">' + esc((candidate.price_change_24h >= 0 ? '+' : '') + safeNum(candidate.price_change_24h,2)) + '% 24h</span>' +
      '<span class="rx-chip ' + (candidate.direction === 'LONG' ? 'is-live' : 'is-info') + '">' + esc(directionLabel(candidate.direction)) + '</span>' +
      '<span class="rx-chip is-info">' + esc(signalStateLabel(candidate.signal_state)) + '</span></div>' +
    '<div class="rx-grid rx-grid--4">' +
      '<div><span>Score</span><b>' + esc(safeNum(candidate.overall_score, 1)) + '</b></div>' +
      '<div><span>التغطية</span><b>' + esc(pct(candidate.coverage?.ratio)) + '</b></div>' +
      '<div><span>جودة البيانات</span><b>' + esc(safeNum(candidate.data_quality, 0)) + '</b></div>' +
      '<div><span>جودة السيولة</span><b>' + esc(safeNum(candidate.liquidity_quality, 0)) + '</b></div>' +
    '</div>' +
    '<div class="rx-muted rx-volume">حجم 24h: ' + esc(safeNum(candidate.quote_volume_24h,0)) + '</div>' +
    fingerprintBadgeMarkup(candidate) +
    '<button type="button" class="rx-btn rx-btn--primary rx-detail-button" data-detail-index="' + index + '">عرض التفاصيل</button>' +
  '</article>';
}

function strategyCard(strategy) {
  const state = strategy.state;
  const stateLabel = state === 'CONFIRMED' ? 'مؤكد' : state === 'CANDIDATE' ? 'مرشح' : state === 'INSUFFICIENT_DATA' ? 'بيانات ناقصة' : 'مرفوض';
  const friendlyReasons = strategy.reasonCodes.map(friendlyReason);
  return '<article class="rx-strategy">' +
    '<div class="rx-strategy__top"><div><b>' + esc(friendlyStrategy(strategy.id)) + '</b><div class="rx-muted">' + esc(strategy.id) + '</div></div><span class="rx-chip ' + (state === 'CONFIRMED' || state === 'CANDIDATE' ? 'is-live' : state === 'INSUFFICIENT_DATA' ? 'is-warn' : 'is-danger') + '">' + esc(stateLabel) + '</span></div>' +
    '<div class="rx-grid rx-grid--3">' +
      '<div><span>الدرجة</span><b>' + esc(strategy.score === null ? 'غير متاح' : safeNum(strategy.score,1)) + '</b></div>' +
      '<div><span>التغطية</span><b>' + esc(strategy.coverage === null ? 'غير متاح' : pct(strategy.coverage)) + '</b></div>' +
      '<div><span>البوابات</span><b>' + esc(strategy.hardGatesPassed ? 'اجتازت' : 'لم تجتز') + '</b></div>' +
    '</div>' +
    '<div class="rx-muted">' + esc(friendlyReasons.slice(0,2).join(' · ') || 'لا توجد ملاحظات إضافية') + '</div>' +
    '<details class="rx-tech"><summary>التفاصيل الفنية</summary>' +
      '<div class="rx-code-line">reason_codes: ' + esc(strategy.reasonCodes.join(' · ') || '—') + '</div>' +
      '<div class="rx-code-line">required_data: ' + esc(strategy.requiredData.join(', ') || '—') + '</div>' +
      '<div class="rx-code-line">missing_required_data: ' + esc(strategy.missingRequiredData.join(', ') || '—') + '</div>' +
      '<div class="rx-code-line">invalidation: ' + esc(strategy.invalidation.join(' · ') || '—') + '</div>' +
      '<div class="rx-code-line">hard_gate_status: ' + esc(JSON.stringify(strategy.hardGateStatus)) + '</div>' +
      '<div class="rx-code-line">evidence: ' + esc(JSON.stringify(strategy.evidence)) + '</div>' +
    '</details>' +
  '</article>';
}

export function buildCandidateDetailMarkup(candidate) {
  const rows = normalizeStrategyRows(candidate);
  const accepted = rows.filter(s => s.state === 'CONFIRMED' || s.state === 'CANDIDATE');
  const rejected = rows.filter(s => s.state === 'REJECTED');
  const insufficient = rows.filter(s => s.state === 'INSUFFICIENT_DATA');
  const evidence = Object.entries(candidate?.evidence || {}).map(([key, value]) =>
    '<div class="rx-evidence-row"><span>' + esc(key) + '</span><b>' + esc(typeof value === 'object' ? JSON.stringify(value) : value) + '</b></div>'
  ).join('');

  const strategyGroup = (title, list, tone) =>
    '<section class="rx-section"><div class="rx-section__title"><h4>' + esc(title) + '</h4><span class="rx-count ' + tone + '">' + list.length + '</span></div>' +
    (list.length
      ? '<div class="rx-stack">' + list.map(strategyCard).join('') + '</div>'
      : '<div class="rx-empty-inline">لا توجد عناصر في هذا القسم.</div>') +
    '</section>';

  return '<div class="rx-detail">' +
    '<div class="rx-detail__hero"><div><div class="rx-muted">Candidate</div><h2>' + esc(candidate.symbol) + '</h2><p>' + esc(friendlyStrategy(candidate.best_strategy) || 'غير متاح') + '</p></div>' +
      '<div class="rx-detail__price">' + esc(safeNum(candidate.last_price,8)) + '</div></div>' +
    '<details class="rx-section" open><summary>الملخص</summary>' +
      '<div class="rx-grid rx-grid--3">' +
        '<div><span>الاتجاه</span><b>' + esc(directionLabel(candidate.direction)) + '</b></div>' +
        '<div><span>الحالة</span><b>' + esc(signalStateLabel(candidate.signal_state)) + '</b></div>' +
        '<div><span>أفضل استراتيجية</span><b>' + esc(friendlyStrategy(candidate.best_strategy)) + '</b></div>' +
        '<div><span>Score</span><b>' + esc(safeNum(candidate.overall_score,1)) + '</b></div>' +
        '<div><span>التغطية</span><b>' + esc(pct(candidate.coverage?.ratio)) + '</b></div>' +
        '<div><span>تغير 24h</span><b>' + esc((candidate.price_change_24h >= 0 ? '+' : '') + safeNum(candidate.price_change_24h,2)) + '%</b></div>' +
      '</div>' +
    '</details>' +
    '<details class="rx-section" open><summary>لماذا ظهر؟</summary><div class="rx-muted">ظهر بعد اجتياز بوابات البيانات والسيولة ووجود استراتيجية مقبولة. القيم المعروضة تحليلية وليست وعدًا بالنتيجة.</div>' +
      '<div class="rx-tag-list">' + (candidate.accepted_strategies || []).map(id => '<span class="rx-chip is-live">' + esc(friendlyStrategy(id)) + '</span>').join('') + '</div>' +
    '</details>' +
    fingerprintDetailMarkup(candidate) +
    strategyGroup('الاستراتيجيات المقبولة', accepted, 'is-live') +
    strategyGroup('الاستراتيجيات المرفوضة', rejected, 'is-danger') +
    strategyGroup('الاستراتيجيات ذات البيانات الناقصة', insufficient, 'is-warn') +
    '<details class="rx-section"><summary>الأدلة</summary><div class="rx-stack">' + (evidence || '<div class="rx-empty-inline">لا توجد أدلة إضافية.</div>') + '</div></details>' +
    '<details class="rx-section"><summary>المخاطر</summary><div class="rx-tag-list">' + ((candidate.risk_flags || []).map(x => '<span class="rx-chip is-danger">' + esc(friendlyReason(x)) + '</span>').join('') || '<span class="rx-muted">لا توجد مخاطر إضافية مسجلة.</span>') + '</div></details>' +
    '<details class="rx-section"><summary>شروط الإبطال</summary><div class="rx-tag-list">' + ((candidate.invalidation || []).map(x => '<span class="rx-chip is-warn">' + esc(friendlyReason(x)) + '</span>').join('') || '<span class="rx-muted">لا توجد شروط إبطال مسجلة.</span>') + '</div></details>' +
    '<details class="rx-section"><summary>جودة البيانات والسيولة</summary>' +
      '<div class="rx-grid rx-grid--3">' +
        '<div><span>جودة البيانات</span><b>' + esc(safeNum(candidate.data_quality,0)) + '</b></div>' +
        '<div><span>جودة السيولة</span><b>' + esc(safeNum(candidate.liquidity_quality,0)) + '</b></div>' +
        '<div><span>آخر تحديث</span><b>' + esc(time(candidate?.data_status?.updated_at || candidate?.data_status?.last_updated || candidate?.data_status?.source_time || candidate?.as_of)) + '</b></div>' +
      '</div>' +
    '</details>' +
    '<details class="rx-section"><summary>التفاصيل الفنية</summary>' +
      '<div class="rx-code-line">signal_state: ' + esc(candidate.signal_state) + '</div>' +
      '<div class="rx-code-line">data_status: ' + esc(JSON.stringify(candidate.data_status || {})) + '</div>' +
      '<div class="rx-code-line">reason_codes: ' + esc((candidate.reason_codes || []).join(' · ')) + '</div>' +
      '<div class="rx-code-line">source: ' + esc(candidate?.data_status?.source || 'UNKNOWN') + '</div>' +
    '</details>' +
  '</div>';
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
:root{--rx-bg:#071018;--rx-surface:#0b1720;--rx-surface2:#0f202b;--rx-border:#1d3944;--rx-text:#edf7fa;--rx-muted:#8fa8b2;--rx-green:#35d39a;--rx-yellow:#f0c768;--rx-red:#ef6f7d;--rx-blue:#60bfff}
#radarx-dashboard{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--rx-text)}
.rx-dashboard{display:grid;gap:14px}
.rx-card,.rx-section,.rx-hero,.rx-empty,.rx-statusbar{background:var(--rx-surface);border:1px solid var(--rx-border);border-radius:18px;box-shadow:0 10px 28px rgba(0,0,0,.12)}
.rx-hero{padding:16px}
.rx-brand{display:flex;align-items:center;justify-content:space-between;gap:12px}
.rx-brand__mark{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:var(--rx-surface2);border:1px solid #2d5666;font-size:22px}
.rx-brand__title{display:flex;align-items:center;gap:10px}.rx-brand h1{margin:0;font-size:24px}.rx-muted{color:var(--rx-muted);font-size:12px;line-height:1.55}
.rx-subtitle{margin:4px 0 0}.rx-statusbar{display:grid;grid-template-columns:1fr;gap:10px;padding:12px}
.rx-statusbar__main{display:flex;align-items:center;justify-content:space-between;gap:10px}
.rx-status-chip,.rx-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--rx-border);border-radius:999px;padding:6px 9px;font-size:11px;font-weight:900}
.rx-status-dot{width:9px;height:9px;border-radius:50%;background:currentColor}
.is-live{color:#b8f6df;border-color:#2c805f!important}.is-warn{color:#ffe5a1;border-color:#8a6d39!important}.is-danger{color:#ffc2ca;border-color:#914553!important}.is-info{color:#b9e5ff;border-color:#346782!important}
.rx-metric-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.rx-metric{padding:11px;border-radius:13px;background:#08131a;border:1px solid #17313a}.rx-metric span,.rx-grid span,.rx-evidence-row span{display:block;color:var(--rx-muted);font-size:10px}.rx-metric b{display:block;margin-top:4px;font-size:19px}
.rx-action-row{display:grid;grid-template-columns:1fr;gap:9px}.rx-btn{min-height:46px;width:100%;border-radius:13px;border:1px solid #2d5666;background:#0a151d;color:#fff;font:inherit;font-weight:950}.rx-btn--primary{background:#103042;border-color:#3b7f9f}.rx-btn--secondary{background:#09131a}
.rx-filterbar{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.rx-select{min-height:44px;border:1px solid #2a4c58;border-radius:11px;background:#08131a;color:#fff;padding:0 10px;font:inherit}
.rx-list{display:grid;gap:10px}.rx-card{padding:14px}.rx-card--excluded{background:#0b151b;border-color:#384148}.rx-card__top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.rx-symbol{font-size:18px;font-weight:950;letter-spacing:.3px}.rx-price{font-size:20px;font-weight:950}.rx-unavailable{margin-top:12px;font-size:15px;font-weight:900}.rx-meta-row,.rx-tag-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.rx-grid{display:grid;gap:8px;margin-top:11px}.rx-grid--4{grid-template-columns:repeat(2,1fr)}.rx-grid--3{grid-template-columns:repeat(2,1fr)}.rx-grid>div{padding:9px;border-radius:11px;background:#08131a;border:1px solid #17313a}.rx-grid b{display:block;margin-top:4px}.rx-volume{margin-top:9px}.rx-empty{padding:22px;text-align:center}.rx-section{padding:13px}.rx-section summary{cursor:pointer;font-weight:950;list-style:none}.rx-section summary::-webkit-details-marker{display:none}.rx-section summary:after{content:"＋";float:left;color:var(--rx-muted)}.rx-section[open] summary:after{content:"−"}.rx-section__title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.rx-section__title h4{margin:0;font-size:15px}.rx-count{border:1px solid var(--rx-border);border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900}.rx-stack{display:grid;gap:8px;margin-top:10px}.rx-strategy{padding:11px;border-radius:14px;background:#08131a;border:1px solid #17313a}.rx-strategy__top{display:flex;justify-content:space-between;gap:10px}.rx-tech{margin-top:8px}.rx-tech summary{font-size:11px}.rx-code-line{margin-top:6px;padding:7px 9px;border-radius:9px;background:#051016;color:#b4cad2;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;word-break:break-word}.rx-empty-inline{padding:10px;border-radius:10px;background:#08131a;color:var(--rx-muted)}.rx-detail{display:grid;gap:10px}.rx-detail__hero{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:14px;background:var(--rx-surface2);border-radius:16px}.rx-detail__hero h2{margin:2px 0;font-size:24px}.rx-detail__hero p{margin:0;color:#bfd3da}.rx-detail__price{font-size:20px;font-weight:950}.rx-evidence-row{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #18323c}.rx-evidence-row:last-child{border-bottom:0}
.rx-section--groups{padding:0;background:transparent;border:0;box-shadow:none}
.rx-banner{padding:12px;border-radius:14px;border:1px solid #294756;background:#081820}.rx-banner strong{display:block;margin-bottom:3px}
.rx-spinner{display:inline-block;width:15px;height:15px;border-radius:50%;border:2px solid #2d5666;border-top-color:#60bfff;animation:rxspin .8s linear infinite;vertical-align:-3px;margin-left:7px}@keyframes rxspin{to{transform:rotate(360deg)}}
.rx-scrolltop{min-height:42px;width:100%;border:1px dashed #365766;border-radius:11px;background:transparent;color:#c8dbe1;font:inherit;font-weight:800}
@media(min-width:700px){.rx-statusbar{grid-template-columns:1.2fr 1fr}.rx-metric-grid{grid-template-columns:repeat(4,1fr)}.rx-action-row{grid-template-columns:minmax(0,1fr) 180px}.rx-filterbar{grid-template-columns:repeat(4,1fr)}.rx-grid--4{grid-template-columns:repeat(4,1fr)}.rx-grid--3{grid-template-columns:repeat(3,1fr)}.rx-list{grid-template-columns:repeat(2,1fr)}}
`;
  document.head.appendChild(style);
}

export function buildDashboardShell() {
  return '<div class="rx-dashboard" id="radarx-dashboard">' +
    '<section class="rx-hero"><div class="rx-brand"><div class="rx-brand__title"><div class="rx-brand__mark" aria-hidden="true">R</div><div><h1>RadarX</h1><div class="rx-muted rx-subtitle">رادار السوق — تحليل واضح باللغة العربية</div></div></div><span class="rx-chip is-info">SPOT</span></div></section>' +
    '<section class="rx-statusbar" aria-live="polite"><div><div class="rx-statusbar__main"><div><span class="rx-muted">حالة السوق</span><div data-rx-status-text><span class="rx-spinner"></span>جاري الفحص</div></div><span class="rx-status-chip is-info" data-rx-status-chip><span class="rx-status-dot"></span>جاري الفحص</span></div><div class="rx-muted" data-rx-status-help>يتم فحص البيانات الحية عبر Backend فقط.</div></div>' +
      '<div class="rx-metric-grid"><div class="rx-metric"><span>آخر تحديث</span><b data-rx-updated>غير متاح</b></div><div class="rx-metric"><span>العملات المفحوصة</span><b data-rx-scanned>0</b></div><div class="rx-metric"><span>المرشحون الصالحون</span><b data-rx-valid-count>0</b></div><div class="rx-metric"><span>المستبعدة</span><b data-rx-excluded-count>0</b></div></div>' +
    '</section>' +
    '<section class="rx-action-row"><button type="button" class="rx-btn rx-btn--primary" data-rx-refresh>فحص السوق الآن</button><button type="button" class="rx-scrolltop" data-rx-top>أعلى الصفحة</button></section>' +
    '<section class="rx-banner"><strong>تحليل تعليمي — Paper Trading فقط — لا توجد أوامر حقيقية.</strong><span class="rx-muted">لا توجد نسبة نجاح أو وعود بالأرباح. النتائج المعروضة مبنية على بيانات السوق المتاحة وقت الفحص.</span></section>' +
    '<section class="rx-section"><div class="rx-section__title"><h3 style="margin:0">المرشحون الصالحون</h3><span class="rx-count is-live" data-rx-valid-label>0</span></div>' +
      '<div class="rx-filterbar"><select class="rx-select" data-rx-sort><option value="strongest">الأقوى</option><option value="liquidity">أعلى سيولة</option><option value="volume">أعلى حجم</option></select><select class="rx-select" data-rx-direction><option value="ALL">كل الاتجاهات</option><option value="LONG">الصاعد</option><option value="BEARISH">الهابط</option></select><select class="rx-select" data-rx-state><option value="ALL">كل الحالات</option><option value="CONFIRMED">مؤكد</option><option value="CANDIDATE">مرشح</option></select><select class="rx-select" data-rx-strategy><option value="ALL">كل الاستراتيجيات</option></select></div>' +
      '<div class="rx-list" data-rx-valid-list></div>' +
    '</section>' +
    '<details class="rx-section"><summary>المستبعدة أو غير الصالحة</summary><div class="rx-muted">هذه العناصر لا تدخل في ترتيب الأقوى، ولا تُعرض كإشارات.</div><div class="rx-list" data-rx-excluded-list></div></details>' +
    '<section class="rx-section" data-rx-detail-wrap hidden><div class="rx-action-row"><button type="button" class="rx-btn rx-btn--secondary" data-rx-back>العودة للوحة الرئيسية</button></div><div data-rx-detail-content style="margin-top:10px"></div></section>' +
  '</div>';
}

export function mountMarketRadarScreen(root, options = {}) {
  if (!root || typeof document === 'undefined') return {destroy(){}};
  injectStyle();
  root.innerHTML = buildDashboardShell();

  const client = options.client || {getMarketRadar};
  const state = {candidates: [], response:null, lastUpdate:null, mode:'FETCHING', destroyed:false};

  const nodes = {
    statusText: root.querySelector('[data-rx-status-text]'),
    statusChip: root.querySelector('[data-rx-status-chip]'),
    statusHelp: root.querySelector('[data-rx-status-help]'),
    updated: root.querySelector('[data-rx-updated]'),
    scanned: root.querySelector('[data-rx-scanned]'),
    validCount: root.querySelector('[data-rx-valid-count]'),
    excludedCount: root.querySelector('[data-rx-excluded-count]'),
    validLabel: root.querySelector('[data-rx-valid-label]'),
    sort: root.querySelector('[data-rx-sort]'),
    direction: root.querySelector('[data-rx-direction]'),
    signalState: root.querySelector('[data-rx-state]'),
    strategy: root.querySelector('[data-rx-strategy]'),
    refresh: root.querySelector('[data-rx-refresh]'),
    top: root.querySelector('[data-rx-top]'),
    validList: root.querySelector('[data-rx-valid-list]'),
    excludedList: root.querySelector('[data-rx-excluded-list]'),
    detailWrap: root.querySelector('[data-rx-detail-wrap]'),
    detailContent: root.querySelector('[data-rx-detail-content]'),
    back: root.querySelector('[data-rx-back]')
  };

  function setStatus(mode, help = '') {
    state.mode = mode;
    const label = STATUS_LABELS[mode] || mode;
    nodes.statusText.innerHTML = mode === 'FETCHING' ? '<span class="rx-spinner"></span>' + esc(label) : esc(label);
    nodes.statusChip.className = 'rx-status-chip ' + stateClass(mode);
    nodes.statusChip.innerHTML = '<span class="rx-status-dot"></span>' + esc(label);
    nodes.statusHelp.textContent = help;
    nodes.refresh.disabled = mode === 'FETCHING';
  }

  function renderFilters() {
    const current = nodes.strategy.value;
    const options = getStrategyOptions(state.candidates);
    nodes.strategy.innerHTML = '<option value="ALL">كل الاستراتيجيات</option>' + options.map(id => '<option value="' + esc(id) + '">' + esc(friendlyStrategy(id)) + '</option>').join('');
    nodes.strategy.value = options.includes(current) ? current : 'ALL';
  }

  function renderLists() {
    const split = splitCandidates(state.candidates);
    const filtered = filterCandidates(split.valid, {
      direction: nodes.direction.value,
      strategy: nodes.strategy.value,
      signalState: nodes.signalState.value
    });
    const sorted = sortCandidates(filtered, nodes.sort.value);
    nodes.validList.innerHTML = sorted.length
      ? sorted.map((candidate) => buildCandidateMarkup(candidate, state.candidates.indexOf(candidate))).join('')
      : '<div class="rx-empty"><b>لا توجد نتائج صالحة مطابقة</b><div class="rx-muted" style="margin-top:5px">جرّب تغيير الفلترة أو أعد الفحص.</div></div>';

    const excluded = split.excluded;
    nodes.excludedList.innerHTML = excluded.length
      ? excluded.map((candidate) => buildCandidateMarkup(candidate, state.candidates.indexOf(candidate))).join('')
      : '<div class="rx-empty-inline">لا توجد عناصر مستبعدة في الاستجابة الحالية.</div>';

    renderButtons();
  }

  function renderButtons() {
    root.querySelectorAll('[data-detail-index]').forEach(button => {
      button.addEventListener('click', () => {
        const candidate = state.candidates[Number(button.dataset.detailIndex)];
        if (!candidate) return;
        nodes.detailWrap.hidden = false;
        nodes.detailContent.innerHTML = buildCandidateDetailMarkup(candidate);
        nodes.validList.closest('.rx-section')?.setAttribute('hidden','');
        nodes.excludedList.closest('.rx-section')?.setAttribute('hidden','');
        nodes.refresh.closest('.rx-action-row')?.setAttribute('hidden','');
        nodes.detailWrap.scrollIntoView?.({behavior:'smooth',block:'start'});
      });
    });
  }

  function closeDetail() {
    nodes.detailWrap.hidden = true;
    nodes.detailContent.innerHTML = '';
    nodes.validList.closest('.rx-section')?.removeAttribute('hidden');
    nodes.excludedList.closest('.rx-section')?.removeAttribute('hidden');
    nodes.refresh.closest('.rx-action-row')?.removeAttribute('hidden');
  }

  function applyResponse(response) {
    const contract = validateMarketRadarContract(response);
    if (!contract.valid) {
      fail('DATA_UNAVAILABLE', contract.reason);
      return;
    }
    const normalized = normalizeMarketRadarResponse(response, 20);
    const mode = classifyMarketRadarResponse(response, navigator.onLine);
    state.candidates = normalized.candidates;
    state.response = response;
    state.lastUpdate = normalized.updatedAt || new Date().toISOString();
    const split = splitCandidates(state.candidates);
    nodes.updated.textContent = time(state.lastUpdate);
    nodes.scanned.textContent = String(normalized.scannedPairs);
    nodes.validCount.textContent = String(split.valid.length);
    nodes.excludedCount.textContent = String(split.excluded.length);
    nodes.validLabel.textContent = String(split.valid.length);
    renderFilters();
    renderLists();

    if (mode === 'NO_VALID_CANDIDATES') {
      setStatus(mode, 'المصدر استجاب، لكن لا يوجد مرشح حديث وصالح للعرض.');
      nodes.validList.innerHTML = '<div class="rx-empty"><b>لا يوجد مرشح صالح</b><div class="rx-muted" style="margin-top:6px">غير متاح بسبب جودة البيانات أو عدم اجتياز الشروط.</div><button type="button" class="rx-btn rx-btn--secondary" data-rx-inline-retry style="margin-top:10px">إعادة الفحص</button></div>';
      bindInlineRetry();
      return;
    }

    if (mode === 'DATA_STALE') {
      setStatus(mode, 'لا يوجد مرشح صالح حديث يمكن عرضه كبيانات حية.');
    } else if (mode === 'PARTIAL_DATA') {
      setStatus(mode, 'توجد نتائج صالحة، وبعض النتائج الأخرى مستبعدة بسبب جودة البيانات أو freshness.');
    } else {
      setStatus(mode, mode === 'LIVE_DATA' ? 'النتائج المعروضة حديثة وصالحة واجتازت شروط العرض.' : 'تم استلام استجابة قابلة للعرض.');
    }
  }

  function bindInlineRetry() {
    root.querySelector('[data-rx-inline-retry]')?.addEventListener('click', load, {once:true});
  }

  function fail(mode, detail) {
    state.candidates = [];
    state.response = null;
    nodes.updated.textContent = 'غير متاح';
    nodes.scanned.textContent = '0';
    nodes.validCount.textContent = '0';
    nodes.excludedCount.textContent = '0';
    nodes.validLabel.textContent = '0';
    setStatus(mode, mode === 'OFFLINE' ? 'لا يوجد اتصال بالإنترنت.' : detail || 'تعذر الحصول على بيانات قابلة للعرض.');
    const retryLabel = mode === 'OFFLINE' ? 'أعد الاتصال بالإنترنت ثم أعد الفحص.' : 'يمكن إعادة المحاولة دون تغيير إعدادات Backend.';
    nodes.validList.innerHTML = '<div class="rx-empty"><b>' + esc(STATUS_LABELS[mode] || mode) + '</b><div class="rx-muted" style="margin-top:6px">' + esc(retryLabel) + '</div><button type="button" class="rx-btn rx-btn--secondary" data-rx-inline-retry style="margin-top:10px">إعادة المحاولة</button></div>';
    nodes.excludedList.innerHTML = '';
    bindInlineRetry();
  }

  async function load() {
    if (state.destroyed) return;
    if (!navigator.onLine) {
      fail('OFFLINE');
      return;
    }
    closeDetail();
    setStatus('FETCHING', 'يتم جلب البيانات من Backend؛ الشمعة غير المغلقة لا تدخل التحليل.');
    try {
      const result = await fetchMarketRadarWithRetry(client, {
        quote: 'USDT',
        limit: 20,
        attempts: 2,
        sleepFn: async ms => {
          setStatus('RETRY', 'تتم إعادة المحاولة تلقائيًا عند فشل الاستجابة.');
          await new Promise(resolve => setTimeout(resolve, ms));
          if (state.destroyed) return;
          setStatus('FETCHING', 'إعادة جلب البيانات.');
        }
      });
      if (state.destroyed) return;
      const response = result.response;
      const mode = classifyMarketRadarResponse(response, navigator.onLine);
      if (mode === 'RETRY') {
        fail(navigator.onLine ? 'DATA_UNAVAILABLE' : 'OFFLINE', response?.error || 'RETRY_EXHAUSTED');
        return;
      }
      if (mode === 'OFFLINE') {
        fail('OFFLINE');
        return;
      }
      if (mode === 'DATA_UNAVAILABLE') {
        fail('DATA_UNAVAILABLE', response?.error || response?.body?.error || 'تعذر الوصول إلى Market Radar.');
        return;
      }
      applyResponse(response);
    } catch (error) {
      console.error('RadarX Dashboard error:', error);
      fail(navigator.onLine ? 'DATA_UNAVAILABLE' : 'OFFLINE', String(error?.message || error || 'UNKNOWN_ERROR'));
    } finally {
      if (window.RadarXSmoke) {
        window.RadarXSmoke.state('SCAN_COMPLETE');
      }
      if (state.mode === 'FETCHING') setStatus('DATA_UNAVAILABLE', 'انتهى الفحص دون نتيجة قابلة للعرض.');
    }
  }

  nodes.refresh.addEventListener('click', load);
  nodes.back.addEventListener('click', closeDetail);
  nodes.top.addEventListener('click', () => root.scrollIntoView?.({behavior:'smooth',block:'start'}));
  [nodes.sort, nodes.direction, nodes.signalState, nodes.strategy].forEach(node => node.addEventListener('change', renderLists));

  const online = () => load();
  const offline = () => {
    fail('OFFLINE');
    if (window.RadarXSmoke) window.RadarXSmoke.state('BACKEND_DISCONNECTED');
  };
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
      const split = splitCandidates(state.candidates);
      return {...state, candidates:[...state.candidates], validCandidates:[...split.valid], excludedCandidates:[...split.excluded]};
    }
  };
}
