/* RadarX Build 224 — server-driven Adaptive Trader UI.
   Uses the DHDTech backend worker as the source of truth; no simulated learning state. */
(function () {
  'use strict';

  var API = String(window.RADARX_BUILD224_API_BASE || 'https://radarx-backend.dhdtech.site').replace(/\/+$/, '');
  var state = { status: null, busy: false, lastError: '', polling: false };
  var styleId = 'rxAdaptiveTraderStyles';
  var panelId = 'rxAdaptiveTraderPanel';

  function byId(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function num(value, digits) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US', {
      maximumFractionDigits: Number.isInteger(digits) ? digits : 2,
      minimumFractionDigits: 0
    }) : '—';
  }
  function pct(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function when(value) {
    if (!value) return 'لم تُسجّل دورة بعد';
    var d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
  }
  function sleep(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }
  function setText(id, value) {
    var node = byId(id);
    if (node) node.textContent = String(value === undefined || value === null ? '—' : value);
  }
  function addStyles() {
    if (byId(styleId)) return;
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      '#rxAdaptiveTraderPanel{margin-top:12px;padding:14px;border:1px solid #294653;border-radius:16px;background:linear-gradient(145deg,#0a171e,#071118);color:#dbeaf0;font:12px/1.6 system-ui,sans-serif}' +
      '#rxAdaptiveTraderPanel *{box-sizing:border-box}' +
      '#rxAdaptiveTraderPanel .rxat-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}' +
      '#rxAdaptiveTraderPanel .rxat-title{font-size:15px;font-weight:900;margin:0 0 4px}' +
      '#rxAdaptiveTraderPanel .rxat-sub{color:#8aa6b1;font-size:11px;margin:0;line-height:1.7}' +
      '#rxAdaptiveTraderPanel .rxat-pill{display:inline-block;padding:4px 8px;border:1px solid #2b4a57;border-radius:999px;color:#9dd3e1;background:#09171e;font-size:10px;font-weight:800;white-space:nowrap}' +
      '#rxAdaptiveTraderPanel .rxat-actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}' +
      '#rxAdaptiveTraderPanel .rxat-btn{padding:8px 11px;border-radius:9px;border:1px solid #315564;background:#102832;color:#e8f7fb;font-weight:800;font-size:11px;cursor:pointer}' +
      '#rxAdaptiveTraderPanel .rxat-btn.primary{background:#163e37;border-color:#2e6f5d;color:#b7f5dc}' +
      '#rxAdaptiveTraderPanel .rxat-btn:disabled{opacity:.55;cursor:wait}' +
      '#rxAdaptiveTraderPanel .rxat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}' +
      '#rxAdaptiveTraderPanel .rxat-kpi{padding:9px;border:1px solid #1c333d;border-radius:10px;background:#09141a;min-width:0}' +
      '#rxAdaptiveTraderPanel .rxat-kpi span{display:block;color:#7896a1;font-size:9px}' +
      '#rxAdaptiveTraderPanel .rxat-kpi b{display:block;margin-top:4px;font-size:15px;overflow-wrap:anywhere}' +
      '#rxAdaptiveTraderPanel .rxat-note{margin-top:9px;padding:9px 10px;background:#09141a;border:1px solid #1d333d;border-radius:10px;color:#9cb5bf;font-size:10px;white-space:pre-wrap;overflow-wrap:anywhere}' +
      '#rxAdaptiveTraderPanel .rxat-note.bad{border-color:#5a343b;color:#ffb0b7}' +
      '#rxAdaptiveTraderPanel .rxat-section{margin-top:12px}' +
      '#rxAdaptiveTraderPanel .rxat-section h3{font-size:12px;margin:0 0 7px;color:#c7e8f0}' +
      '#rxAdaptiveTraderPanel .rxat-row{display:grid;grid-template-columns:1.15fr .75fr .9fr 1.4fr;gap:7px;align-items:center;padding:9px;border:1px solid #1b3039;border-radius:10px;background:#09141a;margin-top:6px;min-width:0}' +
      '#rxAdaptiveTraderPanel .rxat-row b{font-size:11px;overflow-wrap:anywhere}' +
      '#rxAdaptiveTraderPanel .rxat-row small{display:block;color:#76929d;font-size:9px;overflow-wrap:anywhere}' +
      '#rxAdaptiveTraderPanel .rxat-chip{display:inline-block;margin:3px 3px 0 0;padding:2px 5px;border-radius:6px;border:1px solid #25414c;color:#8eb8c5;font-size:8px}' +
      '#rxAdaptiveTraderPanel .rxat-empty{padding:12px;border:1px dashed #29434e;border-radius:10px;color:#819da8;font-size:10px}' +
      '#rxAdaptiveTraderPanel .rxat-foot{margin-top:10px;color:#728d99;font-size:9px;line-height:1.7}' +
      '@media(max-width:650px){#rxAdaptiveTraderPanel .rxat-head{flex-direction:column}#rxAdaptiveTraderPanel .rxat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#rxAdaptiveTraderPanel .rxat-row{grid-template-columns:1fr 1fr}#rxAdaptiveTraderPanel .rxat-row .rxat-reasons{grid-column:1/-1}}';
    document.head.appendChild(style);
  }

  function makePanel() {
    if (byId(panelId)) return;
    var anchor = byId('smartOpportunityOutput');
    if (!anchor || !anchor.parentNode) return;
    addStyles();
    // The legacy UI result box is fed by a browser-only scanner. Hide it so that
    // the visible Smart Trader result comes from the Build 224 server worker below.
    anchor.style.display = 'none';
    var panel = document.createElement('section');
    panel.id = panelId;
    panel.innerHTML =
      '<div class="rxat-head"><div><h3 class="rxat-title">المتداول الذكي · محرك الخادم Build 224</h3>' +
      '<p class="rxat-sub">نتائج Binance Spot من العامل الخلفي، وذاكرة التعلّم، وتدقيق العملات التي ارتفعت بعد آخر رصد.</p></div>' +
      '<span id="rxatState" class="rxat-pill">جارٍ الاتصال…</span></div>' +
      '<div class="rxat-actions"><button type="button" class="rxat-btn primary" id="rxatRun">🔎 افحص السوق وسجّل دورة تعلّم</button>' +
      '<button type="button" class="rxat-btn" id="rxatRefresh">تحديث الحالة</button></div>' +
      '<div class="rxat-grid">' +
      '<div class="rxat-kpi"><span>دورات الفحص الناجحة</span><b id="rxatScans">—</b></div>' +
      '<div class="rxat-kpi"><span>النتائج المكتملة للتعلّم</span><b id="rxatLearning">—</b></div>' +
      '<div class="rxat-kpi"><span>فرص صعود تحتاج مراجعة</span><b id="rxatMissed">—</b></div>' +
      '<div class="rxat-kpi"><span>قناة الإشعارات</span><b id="rxatPush">—</b></div></div>' +
      '<div id="rxatNote" class="rxat-note">يجري الاتصال بخادم DHDTech…</div>' +
      '<div class="rxat-section"><h3>أفضل نتائج آخر دورة خادمية</h3><div id="rxatCandidates" class="rxat-empty">لم تُقرأ النتائج بعد.</div></div>' +
      '<div class="rxat-section"><h3>العملات التي تحركت بعد الرصد — تدقيق الفائت</h3><div id="rxatMissedRows" class="rxat-empty">لم تُقرأ سجلات الفائت بعد.</div></div>' +
      '<div class="rxat-section"><h3>حركات ممتدة لا تُعامل كفرص دخول</h3><div id="rxatLateRows" class="rxat-empty">لا توجد مراجعة متاحة بعد.</div></div>' +
      '<div class="rxat-foot">SPOT فقط · شموع مغلقة · محاكاة فقط · التنفيذ الحقيقي للطلبات متوقف دائمًا. التعلّم هنا معايرة ترتيب بعد اكتمال النتائج، وليس ضمانًا للربح. حالة مزوّد الإشعارات لا تثبت وصول إشعار إلى هاتف فعلي.</div>';
    anchor.insertAdjacentElement('afterend', panel);
    byId('rxatRun').addEventListener('click', runScan);
    byId('rxatRefresh').addEventListener('click', function () { refreshStatus(true); });
  }

  async function request(path, options, timeoutMs) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    try {
      var init = Object.assign({ method: 'GET', cache: 'no-store', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: controller.signal }, options || {});
      var response = await fetch(API + path, init);
      var body = {};
      try { body = await response.json(); } catch (_) {}
      if (!response.ok) {
        var error = new Error(body.error || body.message || ('HTTP_' + response.status));
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setNote(message, bad) {
    var node = byId('rxatNote');
    if (!node) return;
    node.textContent = String(message || '');
    node.classList.toggle('bad', !!bad);
  }

  function decisionLabel(row) {
    var td = row && row.trade_decision;
    if (td && td.label_ar) return td.label_ar;
    if (row && row.tier === 'EARLY_SETUP') return 'إعداد مبكر — راجع الأدلة';
    if (row && row.tier === 'LATE_MOVE') return 'حركة ممتدة — لا تطارد السعر';
    if (row && row.tier === 'WATCH') return 'مراقبة — الشروط غير مكتملة';
    return String((td && td.decision) || (row && row.tier) || 'غير مصنّف');
  }

  function candidateRows(rows) {
    rows = Array.isArray(rows) ? rows.slice(0, 8) : [];
    if (!rows.length) return '<div class="rxat-empty">لا توجد مرشحات صالحة في آخر دورة خادمية. هذا لا يعني أن السوق خالٍ من الفرص؛ راجع أخطاء البيانات والتغطية.</div>';
    return rows.map(function (row, i) {
      var reasons = Array.isArray(row.reason_codes) ? row.reason_codes.slice(0, 3) : [];
      var price = row.price === undefined || row.price === null ? '—' : num(row.price, 8);
      return '<div class="rxat-row"><div><b>' + (i + 1) + '. ' + esc(row.symbol) + '</b><small>' +
        esc(row.tier || '—') + '</small></div><div><b>Score ' + esc(num(row.score, 1)) + '</b><small>' +
        esc(pct(row.change_24h_pct)) + '</small></div><div><b>' + esc(price) + '</b><small>حجم 24h: ' +
        esc(num(row.quote_volume_24h, 0)) + ' USDT</small></div><div class="rxat-reasons"><b>' +
        esc(decisionLabel(row)) + '</b><small>' + esc((row.trade_decision && row.trade_decision.next_step_ar) || '') + '</small>' +
        reasons.map(function (reason) { return '<span class="rxat-chip">' + esc(reason) + '</span>'; }).join('') +
        '</div></div>';
    }).join('');
  }

  function missedRows(rows) {
    rows = Array.isArray(rows) ? rows.slice(0, 8) : [];
    if (!rows.length) return '<div class="rxat-empty">لا توجد حركة فائتة مسجلة بعد. يلزم مرور وقت كافٍ حتى تتكون مقارنة بين سعر الرصد والسعر اللاحق.</div>';
    var labels = {
      POTENTIAL_MISSED_MOVER: 'فرصة محتملة فاتت',
      UNASSESSED_MOVE: 'تحركت ولم تُحلّل بعمق',
      FOLLOW_UP_MOVE: 'كانت مرصودة وتحتاج متابعة'
    };
    return rows.map(function (row) {
      var reasons = Array.isArray(row.baseline_reason_codes) ? row.baseline_reason_codes.slice(0, 3).join(' · ') : '';
      return '<div class="rxat-row"><div><b>' + esc(row.symbol) + '</b><small>' +
        esc(labels[row.classification] || row.classification || 'مراجعة') + '</small></div>' +
        '<div><b>' + esc(pct(row.move_pct)) + '</b><small>من سعر الرصد</small></div>' +
        '<div><b>' + esc(row.baseline_tier || 'غير محلّل') + '</b><small>' + esc(when(row.baseline_at)) + '</small></div>' +
        '<div class="rxat-reasons"><b>سبب المراجعة</b><small>' +
        esc(reasons || row.reason || 'لا يتوفر سبب تفصيلي محفوظ لهذه العينة.') + '</small></div></div>';
    }).join('');
  }

  function lateRows(rows) {
    rows = Array.isArray(rows) ? rows.slice(0, 6) : [];
    if (!rows.length) return '<div class="rxat-empty">لا توجد حركات ممتدة في ملخص آخر دورة.</div>';
    return rows.map(function (row) {
      return '<div class="rxat-row"><div><b>' + esc(row.symbol) + '</b><small>تدقيق فقط</small></div>' +
        '<div><b>' + esc(pct(row.change_24h_pct)) + '</b><small>تغير 24h</small></div>' +
        '<div><b>Score ' + esc(num(row.score, 1)) + '</b><small>حجم 24h ' + esc(num(row.quote_volume_24h, 0)) + '</small></div>' +
        '<div class="rxat-reasons"><b>لا تُعامل كإشارة دخول</b><small>' +
        esc((Array.isArray(row.reason_codes) ? row.reason_codes.slice(0, 3) : []).join(' · ') || 'حركة ممتدة') +
        '</small></div></div>';
    }).join('');
  }

  function render(status, message) {
    if (!status || !byId(panelId)) return;
    state.status = status;
    var profile = status.learning_profile || {};
    var memory = status.memory || {};
    var capture = status.learning_capture || {};
    var transport = status.notification_transport || {};
    setText('rxatState', status.in_flight ? 'SCANNING' : (status.status || 'UNKNOWN'));
    setText('rxatScans', num(status.successful_scans, 0) + ' / ' + num(status.scan_count, 0));
    setText('rxatLearning', num(profile.resolved_samples || memory.resolved_samples || 0, 0) + ' / ' + num(profile.required_samples || 60, 0) +
      (profile.ready ? ' · جاهز' : ' · قيد الجمع'));
    setText('rxatMissed', num(memory.potential_missed_movers || (status.missed_movers || []).filter(function (row) {
      return row.classification === 'POTENTIAL_MISSED_MOVER';
    }).length, 0));
    var provider = String(transport.provider || 'unknown').toUpperCase();
    setText('rxatPush', provider + (transport.enabled ? ' · مفعّل' : ' · غير مفعّل'));
    var summary = status.last_summary || null;
    var candidates = summary && (Array.isArray(summary.top_candidates) ? summary.top_candidates : summary.candidates);
    setText('rxatState', status.in_flight ? 'SCANNING' : (status.status || 'UNKNOWN'));
    var note = message || (status.last_error ? 'آخر خطأ في دورة الخادم: ' + status.last_error :
      'آخر فحص خادمي: ' + when(status.last_scan_at) + '. الحالة: ' + (status.last_scan_at ? 'تم تسجيل دورة' : 'لم تكتمل دورة بعد') + '.');
    if (profile.ready !== true) {
      note += '\nالتعلّم لم يصل إلى حد المعايرة بعد؛ لا تُطبّق تعديلات ترتيب حتى تكتمل النتائج وتغطية العوامل.';
    } else {
      note += '\nمعايرة ترتيب جاهزة على نتائج مكتملة؛ هذا تحسن إحصائي محدود وليس ضمانًا للتنبؤ أو الربح.';
    }
    note += '\nلقطات جديدة: تاريخي ' + num(capture.new_historical_samples || 0, 0) +
      ' · سوق واسع ' + num(capture.new_market_wide_samples || 0, 0) +
      ' · مرشحون عميقون ' + num(capture.new_deep_candidate_samples || 0, 0) + '.';
    note += '\nالإشعارات: ' + provider + '؛ الأجهزة المشتركة مع المزوّد: ' + num(transport.provider_subscriptions || 0, 0) +
      '. وصول الهاتف الفعلي: ' + (transport.physical_device_delivery_verified === true ? 'تم التحقق' : 'غير مُثبت حتى الآن') + '.';
    setNote(note, !!status.last_error || !status.last_scan_at);
    var candidateNode = byId('rxatCandidates');
    if (candidateNode) candidateNode.innerHTML = candidateRows(candidates);
    var missNode = byId('rxatMissedRows');
    if (missNode) missNode.innerHTML = missedRows(status.missed_movers);
    var lateNode = byId('rxatLateRows');
    if (lateNode) lateNode.innerHTML = lateRows(summary && summary.mover_audit);
  }

  async function refreshStatus(quiet) {
    try {
      var status = await request('/api/adaptive-trader/status', null, 15000);
      state.lastError = '';
      render(status, quiet ? '' : undefined);
      return status;
    } catch (error) {
      state.lastError = String(error.message || error);
      if (state.status) render(state.status, 'تعذّر تحديث حالة عامل Build 224: ' + state.lastError +
        '\nالمعروض أدناه آخر حالة نجح جلبها، وليس تأكيدًا أن الخادم يعمل الآن.');
      else setNote('تعذّر الاتصال بخادم DHDTech (' + API + '): ' + state.lastError, true);
      var pill = byId('rxatState');
      if (pill && !state.status) pill.textContent = 'UNAVAILABLE';
      return null;
    }
  }

  async function runScan() {
    if (state.busy) return;
    state.busy = true;
    var runButton = byId('rxatRun');
    if (runButton) runButton.disabled = true;
    var before = state.status && Number(state.status.successful_scans) || 0;
    setNote('أُرسل طلب فحص إلى عامل الخادم. ستُحدَّث النتائج بعد اكتمال دورة الفحص وتسجيل عينات التعلّم.', false);
    try {
      var response = await request('/api/adaptive-trader/scan', { method: 'POST' }, 15000);
      await refreshStatus(true);
      if (response.status === 'SCANNING') {
        setNote('الفحص جارٍ بالفعل؛ أتابع الدورة الحالية بدل بدء دورة مكررة.', false);
      }
      state.polling = true;
      var finished = false;
      for (var i = 0; i < 24; i++) {
        await sleep(4000);
        var latest = await refreshStatus(true);
        if (latest && latest.in_flight === false &&
            (Number(latest.successful_scans || 0) > before || latest.last_error)) {
          finished = true;
          break;
        }
      }
      if (!finished) {
        setNote('ما زال انتظار اكتمال الفحص قائمًا. لن أعتبر الدورة ناجحة قبل أن تظهر حالة العامل ووقت آخر فحص.', false);
      } else if (state.status && state.status.last_error) {
        setNote('اكتملت محاولة الفحص لكنها سجلت خطأ: ' + state.status.last_error, true);
      } else {
        setNote('اكتملت دورة الخادم أو تم تحديث آخر دورة. تُعرض أدناه النتائج وسجلات التعلم المحفوظة.', false);
      }
    } catch (error) {
      var body = error.body || {};
      if (error.status === 429 && body.error === 'ADAPTIVE_TRADER_SCAN_COOLDOWN') {
        setNote('حماية الخادم من تكرار الفحص: انتظر نحو ' + Math.ceil(Number(body.retry_after_ms || 0) / 1000) +
          ' ثانية قبل طلب دورة جديدة. لم يبدأ فحص إضافي.', true);
      } else {
        setNote('لم يبدأ الفحص: ' + String(error.message || error) +
          '. تحقّق من تشغيل عامل المتداول الذكي واتصال خادم DHDTech.', true);
      }
      await refreshStatus(true);
    } finally {
      state.busy = false;
      state.polling = false;
      if (runButton) runButton.disabled = false;
    }
  }

  function attachLegacyButtons() {
    // Replace the older browser-only scanner click path with the persisted server worker.
    ['smartScanBtn', 'quickScan'].forEach(function (id) {
      var button = byId(id);
      if (!button) return;
      button.onclick = function (event) {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        runScan();
      };
    });
  }

  function boot() {
    makePanel();
    if (!byId(panelId)) return;
    attachLegacyButtons();
    // The legacy app can register its handlers during startup; re-apply after its init.
    window.setTimeout(attachLegacyButtons, 1000);
    window.setTimeout(attachLegacyButtons, 2500);
    refreshStatus(false);
    window.setInterval(function () {
      if (document.visibilityState !== 'hidden' && !state.busy) refreshStatus(true);
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.RadarXAdaptiveTrader = { refresh: function () { return refreshStatus(false); }, runNow: runScan };
})();