(() => {
  'use strict';

  // RadarX Ultimate 5.12 — High-Performance Live Radar Edition
  // No /api routes, no backend URLs, no client-side secrets.

  const $ = (id) => document.getElementById(id);
  const els = (sel) => [...document.querySelectorAll(sel)];
  const num = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, num(x)));
  const fmt = (x, max = 6) => {
    const v = num(x);
    if (!v) return '—';
    if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(v) >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: max });
    return v.toPrecision(Math.min(7, Math.max(3, max + 1)));
  };
  const pct = (x) => `${num(x) >= 0 ? '+' : ''}${num(x).toFixed(2)}%`;
  const esc = (x) => String(x ?? '').replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const KEYS = {
    settings: 'radarx2_settings',
    alerts: 'radarx2_alerts',
    profile: 'radarx2_profile',
    membership: 'radarx2_membership',
    community: 'radarx2_community',
    watch: 'radarx2_watch',
    psychology: 'radarx41_psychology',
    paper: 'radarx41_paper',
    events: 'radarx45_events',
    currentSymbol: 'radarx45_currentSymbol',
    backgroundAlerts: 'radarx411_background_alerts'
  };

  const I18N = {
    ar: {
      localConnected:'متصل محلياً', waiting:'بانتظار البيانات', offline:'غير متصل', mtfConsensusTitle:'توافق الأطر الزمنية', mtfAgreement:'نسبة التوافق', mtfWeights:'الأوزان: 1m 10% · 5m 20% · 15m 30% · 1h 40%', sentimentTitle:'مؤشر مشاعر السوق', extremeFear:'خوف شديد', neutral:'محايد', extremeGreed:'طمع شديد', breadth:'اتساع السوق', structureTitle:'رادار الهيكلة السعرية', structureBias:'التحيز', lastStructure:'آخر حدث', swingLevels:'القمم/القيعان', structureHint:'شغّل الفحص لبناء هيكل السوق تلقائياً.', toolSimulator:'محاكي الصفقة', toolSimulatorDesc:'جرّب الإشارة بدون أموال حقيقية', toolStructure:'هيكلة السوق', toolStructureDesc:'BOS + CHoCH + Swing levels', toolCalendar:'مفكرة المخاطر', toolCalendarDesc:'أخبار عالية التأثير + نافذة خطر', trapNav:'كاشف الفخاخ', trapTitle:'رادار الفخاخ والكسر الكاذب', trapShort:'Trap', trapLow:'خطر منخفض', trapMedium:'خطر متوسط', trapHigh:'خطر مرتفع', trapScore:'Trap Risk', trapVerdict:'الحكم', trapEvidence:'الأدلة', trapHint:'يفحص سحب السيولة، الإغلاق، الحجم، التدفق وإعادة الاختبار. لا يمكن للخوارزمية معرفة نية صانع السوق يقينًا.', fakeBreakout:'كسر كاذب محتمل', confirmedBreakout:'اختراق مدعوم', rejection:'رفض سعري', weakVolume:'حجم ضعيف', flowConflict:'تعارض في التدفق', retestRisk:'خطر فشل إعادة الاختبار', structureConflict:'تعارض هيكلي', psychologyNav:'حارس الصحة النفسية', psychologyTitle:'حارس الصحة النفسية وإدارة المخاطر', psychologyHealthy:'الحالة مستقرة', psychologyCaution:'تنبيه سلوكي', psychologyCooldown:'فترة تهدئة', consecutiveLosses:'خسائر متتالية', dailyLoss:'خسارة اليوم', rapidReentries:'إعادات دخول سريعة', cooldownText:'تم تشغيل فترة تهدئة لحماية رأس المال من التداول الانفعالي.', guardianHint:'هذا الحارس يراقب صفقات التطبيق الورقية والتجربة المحلية فقط؛ لا يرى صفقات حسابات المنصات.', guardianReset:'إعادة العدادات', briefingNav:'الملخص الصباحي', briefingTitle:'الملخص الصباحي الذكي للسوق', briefingFresh:'آخر تحديث', briefingRegime:'نظام السوق', briefingTop:'أبرز المرشحين', briefingWatch:'ماذا نراقب', briefingAvoid:'ماذا نتجنب', briefingHint:'ملخص محلي قابل للتفسير يُبنى فور فتح التطبيق من آخر لقطة للسوق.', briefingUpdated:'تم تحديث الملخص', paperNav:'متسابق المحفظة الوهمية', paperTitle:'Paper Trading & Leaderboard', paperBalance:'الرصيد الافتراضي', paperEquity:'قيمة المحفظة', paperPnL:'PnL المحقق', paperOpen:'مفتوحة', paperClosed:'مغلقة', paperTrade:'نفّذ صفقة وهمية', paperClose:'إغلاق', paperRefresh:'تحديث الأسعار', paperWallet:'المحفظة', leaderboard:'لوحة المتصدرين', leaderYou:'أنت', leaderDemo:'متصدر تجريبي', openPositions:'الصفقات المفتوحة', closedTrades:'الصفقات المغلقة', paperAmount:'حجم الصفقة USDT', paperHint:'المتصدرون هنا تجريبيون ومحليون؛ لا يتم رفع بياناتك إلى خادم.', paperHintShort:'محفظة افتراضية + متصدرين', virtualOnly:'افتراضي بالكامل • Spot فقط • بدون رافعة', guardBlocked:'الحارس منع الدخول مؤقتاً بسبب نمط تداول انفعالي. حاول بعد انتهاء التهدئة.', paperOpened:'تم فتح صفقة ورقية.', paperClosed:'تم إغلاق الصفقة الورقية.', paperInsufficient:'الرصيد الافتراضي غير كافٍ.', paperNoSignal:'حلل إشارة أولاً.', paperReset:'تمت إعادة المحفظة الافتراضية.', trapSignal:'إشارة الفخ', sentimentNav:'مشاعر السوق', simulatorNav:'محاكي الصفقات', structureNav:'هيكلة السوق', calendarNav:'مفكرة المخاطر', simulatorTitle:'محاكي الصفقة التفاعلي', startSim:'ابدأ التجربة', pauseSim:'إيقاف مؤقت', resetSim:'إعادة ضبط', simPrice:'السعر المحاكي', simPnl:'PnL وهمي', simProgress:'تقدم السيناريو', simStatus:'الحالة', simWaiting:'بانتظار البدء', simRunning:'التجربة تعمل', simHitSL:'وصل وقف الخسارة', simHitTP1:'وصل TP1', simHitTP2:'وصل TP2', simReset:'تمت إعادة التجربة', structureTitle2:'BOS / CHoCH Detector', structureBias2:'تحيز الهيكل', bullishBos:'BULLISH BOS', bearishBos:'BEARISH BOS', bullishChoch:'BULLISH CHoCH', bearishChoch:'BEARISH CHoCH', noStructureEvent:'لا يوجد كسر هيكلي جديد', calendarTitle:'مفكرة المخاطر والأخبار', refreshCalendar:'تحديث المفكرة', riskNow:'نافذة خطر الآن', nextEvent:'الحدث القادم', noEvents:'لا توجد أحداث مؤثرة في النافذة الحالية.', highImpact:'HIGH', mediumImpact:'MEDIUM', pastEvent:'منتهٍ', inMinutes:'بعد {n} دقيقة', sourceCalendar:'مصدر اقتصادي عام: FairEconomy/ForexFactory feed؛ للاستخدام التجاري تحقق من شروط المصدر أو استبدله بمصدر مرخّص.', simulatorNote:'التجربة افتراضية بالكامل ولا ترسل أي أمر إلى منصة تداول.', navDashboard:'الرئيسية', navRadar:'الرادار', navMarkets:'السوق', navSignals:'الإشارات', navFlow:'السيولة', navAccount:'الحساب', navMore:'المزيد',
      heroEyebrow:'EARLY-MOVE INTELLIGENCE', heroTitle:'رادار الحركة قبل الزحام', heroText:'يفحص السوق على مرحلتين: فرز واسع ثم تحليل عميق للمرشحين. النتيجة توضح الأدلة والمخاطر ولا تدّعي يقيناً بالمستقبل.', scanNow:'افحص الآن', viewSignals:'الإشارات الحالية', kpiUniverse:'الكون السوقي', kpiCandidates:'مرشحون', kpiEarly:'تنبيهات مبكرة', kpiTop:'أعلى فرصة', bestSetup:'BEST SETUP', marketPulse:'MARKET PULSE', marketRegime:'حالة السوق', runScanHint:'شغّل الفحص لرؤية أفضل إعداد.', quickTools:'QUICK TOOLS', toolsTitle:'الوصول السريع', toolRadar:'الرادار الشامل', toolRadarDesc:'Volume + Momentum + Breakout', toolSignals:'الإشارات', toolSignalsDesc:'Entry • SL • TP1 • TP2', toolFlow:'Order Flow', toolFlowDesc:'Book • CVD • Buy/Sell', toolLab:'المختبر', toolLabDesc:'Backtest + Risk',
      radarTitle:'الفحص الشامل', radarDesc:'فرز واسع أولاً، ثم تحليل عميق لأقوى المرشحين.', exchange:'المنصة', timeframe:'الإطار', minVolume:'أقل حجم 24h', candidateCount:'عمق الفحص', signalMin:'أقل Score', autoMode:'مراقبة كل دقيقة', readyToScan:'جاهز للفحص', scanHint:'اضغط «افحص الآن» لعرض النتائج فوراً.',
      marketsTitle:'خريطة السوق', marketsDesc:'رتّب العملات حسب النشاط أو الزخم أو السيولة.', activity:'النشاط', gainers:'الأعلى', volume:'الحجم', multiRadarTitle:'لوحة المراقبة المتعددة الذكية', multiRadarSubtitle:'أقوى 5–10 عملات نشطة الآن، مرتبة تلقائياً من السيولة والزخم والتدفق الذكي. اضغط أي بطاقة لتحويلها فوراً إلى العملة النشطة.', multiRadarLive:'رادار حي', multiRadarCountLabel:'عدد البطاقات', multiRadarRefresh:'تحديث الرادار', multiRadarScan:'حلّل الأقوى', multiRadarUniverse:'من الكون الحي', multiRadarUpdated:'آخر تحديث', multiRadar1h:'ساعة', multiRadar24h:'24 ساعة', multiRadarLiquidity:'السيولة', multiRadarMomentum:'الزخم', multiRadarFlow:'التدفق', multiRadarTrap:'الفخ', multiRadarScore:'الدرجة', multiRadarWatch:'متابعة', multiRadarActive:'نشطة الآن', multiRadarBuyFlow:'ضغط شراء', multiRadarSellFlow:'ضغط بيع', multiRadarBalanced:'تدفق متوازن', multiRadarDeep:'تحليل عميق', multiRadarNoData:'لا توجد بيانات حية كافية الآن؛ سيحاول الرادار REST ثم آخر لقطة محفوظة تلقائياً.', multiRadarFoot:'التصنيف لحظي واستدلالي: السيولة والزخم والتدفق تُقاس من بيانات السوق العامة المتاحة. لا يعني ترتيب البطاقة ضماناً لحركة السعر، ولا يتم إنشاء بيانات اصطناعية عند غياب السوق الحي.', multiRadarRest:'REST مباشر', multiRadarWs:'WebSocket مباشر', multiRadarCached:'بيانات محفوظة', multiRadarOffline:'غير متصل', multiRadarModeGainers:'الارتفاع الحالي', multiRadarModeBreakout:'الانفجار الوشيك', multiRadarGainersHint:'أعلى العملات ارتفاعًا الآن حسب تغير السعر خلال 24 ساعة من تدفق Binance الحي.', multiRadarBreakoutHint:'رادار زخم مبكر يعتمد على حركة الثواني/الدقائق وتسارع الحجم والاقتراب من القمة المحلية؛ لا يعني أنه يعرف المستقبل أو يضمن انفجارًا.', multiRadarShortMomentum:'زخم قصير', multiRadarVolumeSpike:'Spike الحجم', multiRadarProximity:'قرب القمة', multiRadarBreakoutScore:'اختراق', multiRadarNoBreakout:'لا توجد الآن إشارة انفجار مكتملة؛ سيعرض الرادار مرشحين مدعومين ببيانات الحجم الفعلية عند توفرها.', multiRadarModeLabel:'وضع الرادار', multiRadarLiveNote:'السعر والتغير 24h من Binance WebSocket. Breakout Radar يستخدم Kline 1m للحجم الحقيقي؛ عند بطء البث يملأ الرادار من REST ثم آخر لقطة محفوظة، مع وسم المصدر.',
      signalsTitle:'الإشارات والتحليل', signalsDesc:'محرك قابل للتفسير يجمع الاتجاه والزخم والحجم والبنية والسيولة والمخاطر.', fullAnalysis:'تحليل كامل', searchPlaceholder:'ابحث: BTC أو SUI أو WAXP...', symbol:'الرمز', analysisHint:'اختر عملة أو استخدم BTCUSDT ثم اضغط تحليل كامل.',
      flowTitle:'السيولة والتدفق', flowDesc:'دفتر أوامر + صفقات حديثة + CVD مشتق من تدفق الصفقات الحقيقية. لا تُعرض بيانات وهمية.', scanFlow:'حلل السيولة', flowHint:'اضغط «حلل السيولة» لعرض Bid/Ask/Imbalance/CVD.', whaleEyebrow:'WHALE FLOW RADAR', whaleTitle:'رادار الحيتان والسيولة', scanWhales:'فحص الحيتان', whaleMin:'أقل قيمة للأمر الكبير (USDT)', whaleWindow:'عدد الصفقات', whaleDepth:'عمق الدفتر', whaleHint:'اضغط «فحص الحيتان» لرؤية الأوامر الكبيرة واتجاه التدفق.', bigBuys:'شراء كبير', bigSells:'بيع كبير', whaleNet:'صافي تدفق الحيتان', whaleScore:'Whale Score', biggest:'أكبر صفقة', buyPressure:'ضغط شراء', sellPressure:'ضغط بيع', whaleReason:'النتيجة تعتمد على قيمة الصفقات الكبيرة مقارنة بالتوزيع المعتاد ودفتر الأوامر.', bidLiquidity:'سيولة الشراء', askLiquidity:'سيولة البيع', imbalance:'اختلال الدفتر', buySell:'شراء/بيع', cvdLabel:'CVD', orderFlowBalance:'توازن التدفق', threshold:'الحد', side:'الجهة', notional:'القيمة الاسمية', rank:'الترتيب', perWeek:'/ أسبوع', perMonth:'/ شهر', perYear:'/ سنة',
      accountTitle:'حسابي واشتراكي', accountDesc:'الحساب والاشتراك يعملان محلياً داخل الملف. الدفع الحقيقي لا يتم تزويره؛ عند النشر تربط متجر التطبيق أو بوابة ويب آمنة.', trialRemaining:'المتبقي في التجربة', weekly:'أسبوعي', monthly:'شهري', yearly:'سنوي', featureRadar:'الرادار الشامل', featureSignals:'الإشارات + Entry/SL/TP', featureFlow:'Order Flow', popular:'الأكثر استخداماً', choosePlan:'اختيار', commerceTitle:'الدفع الآمن', commerceText:'هذه النسخة المحلية لا تنفذ دفعاً حقيقياً من JavaScript. تستطيع اختبار تجربة المستخدم والاشتراك محلياً. في الإنتاج استخدم Google Play Billing داخل Android أو مزود ويب يدعم بلدك، مع تحقق خادمي للمشتريات.', demoUpgrade:'تجربة تفعيل Premium', manageSub:'إدارة الاشتراك', profileSettings:'بيانات الحساب', name:'الاسم', save:'حفظ', reset:'إعادة ضبط الحساب المحلي',
      moreTitle:'المزيد', moreDesc:'أدوات إضافية للحساب والاختبار وإدارة التنبيهات.', compare:'مقارنة المنصات', news:'الأخبار', alerts:'التنبيهات', lab:'المختبر', chart:'تحليل الشارت', settings:'الإعدادات', community:'المجتمع',
      signalEarly:'EARLY ALERT', signalWatch:'WATCH', signalNo:'NO SIGNAL', modeLive:'بيانات مباشرة', modeCached:'آخر بيانات حية مؤكدة', modeOffline:'بيانات السوق غير متاحة', modeWaiting:'بانتظار بيانات Binance الحية', entry:'دخول', entryZone:'منطقة الدخول', sl:'وقف الخسارة', tp1:'TP1', tp2:'TP2', rr:'RR', quality:'جودة', strength:'قوة الإشارة', horizon:'نافذة المراقبة', reasons:'لماذا؟', indicators:'المؤشرات', trend:'الاتجاه', momentum:'الزخم', vol:'الحجم', breakout:'الاختراق', compression:'التجميع', flow:'التدفق', risk:'المخاطر',
      bull:'صاعد', bear:'هابط', neutral:'محايد', improving:'يتحسن', weakening:'يضعف', live:'مباشر', noData:'لا توجد بيانات كافية', refresh:'تحديث', enableNotify:'فعّل التنبيهات', permissionGranted:'التنبيهات مفعّلة', permissionBlocked:'المتصفح منع الإشعارات', noConflict:'لا تعارض بارز في أعلى إعداد', bidStrong:'جانب الشراء أقوى.', askStrong:'جانب البيع أقوى.', balancedBook:'دفتر الأوامر متوازن نسبيًا.', cvdNote:'CVD محسوب من الصفقات التي استطاع المتصفح قراءتها.', signalsCount:'الإشارات', wins:'الفوز', losses:'الخسائر', hitRate:'نسبة الإصابة', approxResult:'نتيجة تاريخية تقريبية', conservativeRule:'عند وصول TP وSL داخل نفس الشمعة تُحسب المحافظه كخسارة.',
      backtestTitle:'Backtest', riskTitle:'إدارة المخاطر', fee:'الرسوم %', slip:'الانزلاق %', tpRR:'TP RR', run:'تشغيل', capital:'رأس المال', riskPct:'المخاطرة %', slPct:'SL %', calc:'احسب', chartUpload:'اختر صورة الشارت', localOnly:'محلي بالكامل', sources:'المصادر', clear:'مسح', noAlerts:'لا توجد تنبيهات محفوظة.', communityHint:'منشورات محلية تجريبية — لا يتم رفعها إلى أي خادم.', post:'نشر', message:'اكتب منشوراً مختصراً...',
      liveFailed:'تعذر الوصول المباشر إلى Binance حالياً. ستبقى آخر بيانات حية مؤكدة إن وُجدت، بدون اختلاق بيانات.', liveUpdated:'تم تحديث النتائج ببيانات مباشرة.', scanReady:'يجري الآن جلب لقطة السوق الحقيقية من Binance.', selected:'تم اختيار', searchNo:'لم أعثر على تطابق محلي.', profileSaved:'تم حفظ الحساب المحلي.', demoPremium:'تم تفعيل Premium تجريبياً محلياً.', subReset:'تمت إعادة الحساب إلى Trial المحلي.', noApi:'Binance Public API غير متاح من هذا المتصفح حالياً.',
      autopilotTitle:'وضع المتداول الذكي / Auto-Pilot Scanner', autopilotSubtitle:'زر واحد للمبتدئ: يمسح جميع أزواج Binance المتاحة حيًا ثم يتحقق من 3 بوابات صارمة: السيولة والحجم المفاجئ، الزخم الصعودي، وخطر الفخ المنخفض.', autopilotBadge:'تصفية Binance الحية', smartScanBtn:'افحص السوق واقترح أفضل صفقة فورية', smartGate1:'سيولة 24h مرتفعة', smartGate2:'Volume Spike ≥ 1.8×', smartGate3:'زخم صعودي قوي', smartGate4:'Trap Risk < 35', smartReady:'جاهز — لا يتم عرض فرصة ذهبية قبل تحقق الشروط الحية.', smartScanningUniverse:'مسح الكون الحي: {n} زوجًا', smartGateFiltering:'البوابة الأولى: تصفية السيولة والزخم — {n} مرشحًا', smartKlineStage:'البوابة الثانية: تحقق شموع وحجم لحظي — {n} عملة', smartDeepStage:'البوابة الثالثة: تحليل تدفق وفخ للمرشحين الأقوى', smartComplete:'اكتمل الفحص: {u} زوجًا → {g} اجتازوا البوابة → {d} تحققوا بعمق → {w} فرصة ذهبية', smartNoOpportunity:'لم توجد عملة تطابق البوابات الثلاث الآن. هذا أفضل من اختلاق صفقة للمبتدئ. جرّب الفحص مرة أخرى بعد تغير السوق.', smartNetworkFail:'تعذر الوصول إلى Binance مباشرة. لم يتم توليد فرصة وهمية.', goldenOpportunity:'GOLDEN OPPORTUNITY', goldenBest:'الأفضل حاليًا', goldenWhy:'لماذا ظهرت؟', goldenLiquidity:'السيولة', goldenVolumeSpike:'الحجم المفاجئ', goldenMomentum:'الزخم', goldenTrap:'خطر الفخ', goldenEntry:'الدخول المقترح', goldenSL:'وقف الخسارة', goldenTP:'الهدف المحافظ', goldenTP2:'الهدف الثاني', goldenRR:'المخاطرة/العائد', goldenOpenAnalysis:'تحليل جنائي كامل', goldenPaper:'محاكاة ورقية', goldenExplain:'السيولة والحجم تحركا بقوة، والزخم صعودي، وفلتر الفخ منخفض. هذه فرصة مشروطة بالبيانات الحالية وليست ضمانًا للارتفاع.', goldenNoChase:'لا تطارد السعر إذا ابتعد عن منطقة الدخول.', smartUniverse:'الكون', smartStage1:'مرشحون أوليون', smartDeep:'تحقق عميق', smartGold:'ذهبية', smartLiveOnly:'Live only · Spot', deepDiveNav:'التحليل الجنائي', deepDiveTitle:'محرك التحليل العميق والجنائي', deepDiveSubtitle:'تفكيك سبب الحركة، مصدر السيولة، الهيكلة، الكسر، وخطة المخاطر في تقرير واحد.', deepDiveVerdict:'النتيجة التحليلية', deepDiveEvidence:'سلسلة الأدلة', deepDiveLiquidity:'لماذا ارتفعت السيولة هنا؟', deepDiveLiquidityZone:'منطقة السيولة / Order Block', estimatedWhaleEntry:'السعر المرجّح لتدفق الكبار', zoneConfidence:'ثقة المنطقة', zoneRange:'نطاق المنطقة', whyBreakout:'لماذا قد تنفجر الحركة؟', executionPlan:'خطة الصفقة', entryPrice:'سعر الدخول', entryZone:'منطقة الدخول', stopLoss:'وقف الخسارة', target1:'الهدف الأول', target2:'الهدف الثاني', riskReward:'المخاطرة إلى العائد', invalidation:'إبطال الفكرة', evidenceCoverage:'تغطية الأدلة', liquidityDriver:'محرك السيولة', flowDriver:'محرك التدفق', volumeDriver:'محرك الحجم', structureDriver:'محرك الهيكلة', momentumDriver:'محرك الزخم', candleEvidence:'قراءة الشموع', structureEvidence:'قراءة الهيكلة', moneyFlowEvidence:'قراءة تدفق الأموال', orderBlockDemand:'منطقة طلب محتملة', orderBlockSupply:'منطقة عرض محتملة', orderBlockNeutral:'منطقة توازن', breakoutConfirmed:'اختراق مدعوم بإغلاق وحجم', breakoutPressure:'ضغط سعري قرب المقاومة', breakoutFailed:'اختراق فشل وأغلق داخل النطاق', noBreakout:'لا يوجد اختراق فعّال بعد', conditionalBull:'سيناريو صاعد مشروط', conditionalBear:'سيناريو هابط مشروط', neutralVerdict:'مراقبة فقط', avoidVerdict:'تجنّب حتى تتغير الأدلة', exactEntryCaveat:'هذا تقدير كمي لمنطقة السيولة وليس كشفاً لمحفظة بعينها أو سعراً سرياً لصانع السوق.', modelLimit:'المحرك استدلالي قابل للتفسير؛ لا يعرف هوية المحافظ ولا يضمن الحركة المستقبلية.', forensicConfidence:'ثقة جودة الأدلة', forensicScore:'درجة التحليل الجنائي', securityNote:'لا تضع مفاتيح API السرية أو مفاتيح الدفع داخل هذه الصفحة.', liveWs:'WebSocket مباشر', liveRest:'REST مباشر', liveCached:'آخر بيانات حية محفوظة', liveOffline:'بيانات السوق غير متاحة حالياً', appHealthy:'المحرك يعمل', wsReconnect:'إعادة اتصال WebSocket', dataAge:'عمر البيانات', neverFake:'لا يتم إنشاء أسعار أو أحجام وهمية', liveSource:'المصدر: Binance Spot Public Market Data', liveTape:'شريط السوق الحي', change:'التغير', avoidChasing:'لا تحوّل السرعة إلى مطاردة.', resultsTitle:'النتائج والإشعارات الذكية', totalTrades:'إجمالي الصفقات', winningTrades:'الصفقات الرابحة', losingTrades:'الصفقات الخاسرة', successRate:'نسبة النجاح', notificationLog:'سجل الإشعارات', noEvents:'لا توجد نتائج أو إشعارات بعد.', recommendationEvent:'توصية جديدة', profitSecureEvent:'تم تأمين جزء من الربح', breakEvenEvent:'إغلاق على التعادل', profitCloseEvent:'إغلاق على ربح', lossCloseEvent:'إغلاق على خسارة', copied:'تم نسخ السعر', activeAsset:'العملة النشطة', selectedFrom:'مصدر الاختيار', multiTpTitle:'خطة الأهداف المتعددة', multiTpSubtitle:'أهداف متدرجة مع نسبة مخاطرة/عائد مستقلة لكل هدف.', confidence:'الثقة', tradeType:'نوع الصفقة', shortType:'قصيرة المدى', mediumType:'متوسطة المدى', copy:'نسخ', smcTitle:'التفاصيل الجنائية وSMC', liquiditySweep:'سحب سيولة', doubleSweep:'سحب سيولة مزدوج', smcDemand:'منطقة طلب', smcSupply:'منطقة عرض', smcBalance:'منطقة توازن', bullishFvg:'FVG صاعد', bearishFvg:'FVG هابط', noFvg:'لا يوجد FVG واضح', structureState:'بنية السوق', eventState:'حدث الهيكلة', liveSelection:'التحليل يتبع العملة التي اخترتها الآن.', resultsPaperOnly:'إحصائيات النتائج تخص الصفقات الورقية داخل RadarX فقط ولا تقرأ حساب Binance الخارجي.', disclaimer:'RadarX أداة تحليل ومراقبة. لا توجد إشارة مضمونة ولا تنفذ أوامر تداول.'
    },
    en: {
      localConnected:'Connected locally', waiting:'Waiting for data', offline:'Offline', mtfConsensusTitle:'MTF Consensus', mtfAgreement:'Agreement', mtfWeights:'Weights: 1m 10% · 5m 20% · 15m 30% · 1h 40%', sentimentTitle:'Market Sentiment Meter', extremeFear:'Extreme fear', neutral:'Neutral', extremeGreed:'Extreme greed', breadth:'Market breadth', structureTitle:'Market Structure Radar', structureBias:'Bias', lastStructure:'Last event', swingLevels:'Swings', structureHint:'Run a scan to build market structure automatically.', toolSimulator:'Trade simulator', toolSimulatorDesc:'Test a signal without real money', toolStructure:'Market structure', toolStructureDesc:'BOS + CHoCH + Swing levels', toolCalendar:'Risk calendar', toolCalendarDesc:'High-impact news + risk window', trapNav:'Trap detector', trapTitle:'Fakeout & trap radar', trapShort:'Trap', trapLow:'Low trap risk', trapMedium:'Medium trap risk', trapHigh:'High trap risk', trapScore:'Trap Risk', trapVerdict:'Verdict', trapEvidence:'Evidence', trapHint:'Checks liquidity sweeps, close quality, volume, flow and retest context. It cannot know a market maker’s intent with certainty.', fakeBreakout:'Potential fake breakout', confirmedBreakout:'Supported breakout', rejection:'Price rejection', weakVolume:'Weak volume', flowConflict:'Flow conflict', retestRisk:'Retest failure risk', structureConflict:'Structure conflict', psychologyNav:'Psychology Guardian', psychologyTitle:'Psychology Guardian & Risk Control', psychologyHealthy:'Stable behavior', psychologyCaution:'Behavior caution', psychologyCooldown:'Cooldown active', consecutiveLosses:'Consecutive losses', dailyLoss:'Daily loss', rapidReentries:'Rapid re-entries', cooldownText:'A cooldown was activated to reduce emotionally driven overtrading.', guardianHint:'This guardian observes only paper/simulator actions inside the app; it cannot see external exchange trades.', guardianReset:'Reset counters', briefingNav:'Daily briefing', briefingTitle:'AI Daily Market Briefing', briefingFresh:'Last update', briefingRegime:'Market regime', briefingTop:'Top candidates', briefingWatch:'What to watch', briefingAvoid:'What to avoid', briefingHint:'A fast local, explainable briefing built from the latest market snapshot when the app opens.', briefingUpdated:'Briefing updated', paperNav:'Paper leaderboard', paperTitle:'Paper Trading & Leaderboard', paperBalance:'Virtual balance', paperEquity:'Portfolio equity', paperPnL:'Realized PnL', paperOpen:'Open', paperClosed:'Closed', paperTrade:'Open paper trade', paperClose:'Close', paperRefresh:'Refresh prices', paperWallet:'Wallet', leaderboard:'Leaderboard', leaderYou:'You', leaderDemo:'Demo leader', openPositions:'Open positions', closedTrades:'Closed trades', paperAmount:'Trade size USDT', paperHint:'Leaderboard entries are local/demo only; your data is not uploaded.', paperHintShort:'Virtual wallet + leaderboard', virtualOnly:'Fully virtual • Spot only • no leverage', guardBlocked:'Guardian temporarily blocked the entry because of an emotional-trading pattern. Try again after cooldown.', paperOpened:'Paper trade opened.', paperClosed:'Paper trade closed.', paperInsufficient:'Virtual balance is insufficient.', paperNoSignal:'Analyze a signal first.', paperReset:'Virtual wallet reset.', trapSignal:'Trap signal', sentimentNav:'Market sentiment', simulatorNav:'Trade simulator', structureNav:'Market structure', calendarNav:'Risk calendar', simulatorTitle:'Interactive trade simulator', startSim:'Start simulation', pauseSim:'Pause', resetSim:'Reset', simPrice:'Simulated price', simPnl:'Paper PnL', simProgress:'Scenario progress', simStatus:'Status', simWaiting:'Waiting', simRunning:'Simulation running', simHitSL:'Stop loss reached', simHitTP1:'TP1 reached', simHitTP2:'TP2 reached', simReset:'Simulation reset', structureTitle2:'BOS / CHoCH Detector', structureBias2:'Structure bias', bullishBos:'BULLISH BOS', bearishBos:'BEARISH BOS', bullishChoch:'BULLISH CHoCH', bearishChoch:'BEARISH CHoCH', noStructureEvent:'No new structure break', calendarTitle:'Risk & news calendar', refreshCalendar:'Refresh calendar', riskNow:'Risk window now', nextEvent:'Next event', noEvents:'No impactful events in the current window.', highImpact:'HIGH', mediumImpact:'MEDIUM', pastEvent:'Past', inMinutes:'in {n} min', sourceCalendar:'Public economic feed: FairEconomy/ForexFactory; for commercial use verify source terms or replace with a licensed provider.', simulatorNote:'Simulation is fully virtual and never sends an order to an exchange.', navDashboard:'Home', navRadar:'Radar', navMarkets:'Markets', navSignals:'Signals', navFlow:'Flow', navAccount:'Account', navMore:'More',
      heroEyebrow:'EARLY-MOVE INTELLIGENCE', heroTitle:'See momentum before the crowd', heroText:'Two-stage market scanning: broad screening, then deep analysis of the strongest candidates. Every result shows evidence and risk instead of claiming certainty.', scanNow:'Scan now', viewSignals:'Current signals', kpiUniverse:'Market universe', kpiCandidates:'Candidates', kpiEarly:'Early alerts', kpiTop:'Top setup', bestSetup:'BEST SETUP', marketPulse:'MARKET PULSE', marketRegime:'Market regime', runScanHint:'Run a scan to see the strongest setup.', quickTools:'QUICK TOOLS', toolsTitle:'Quick access', toolRadar:'Full scanner', toolRadarDesc:'Volume + Momentum + Breakout', toolSignals:'Signals', toolSignalsDesc:'Entry • SL • TP1 • TP2', toolFlow:'Order Flow', toolFlowDesc:'Book • CVD • Buy/Sell', toolLab:'Lab', toolLabDesc:'Backtest + Risk',
      radarTitle:'Market Scanner', radarDesc:'Broad screening first, deep analysis second.', exchange:'Exchange', timeframe:'Timeframe', minVolume:'Minimum 24h volume', candidateCount:'Deep scan', signalMin:'Minimum Score', autoMode:'Scan every minute', readyToScan:'Ready to scan', scanHint:'Press “Scan now” to render results immediately.',
      marketsTitle:'Market map', marketsDesc:'Sort assets by activity, momentum or liquidity.', activity:'Activity', gainers:'Gainers', volume:'Volume', multiRadarTitle:'Multi-Symbol Live Radar Dashboard', multiRadarSubtitle:'The strongest 5–10 active assets right now, ranked from liquidity, momentum and smart-flow evidence. Tap any card to make it the active asset instantly.', multiRadarLive:'LIVE RADAR', multiRadarCountLabel:'Cards', multiRadarRefresh:'Refresh radar', multiRadarScan:'Analyze leaders', multiRadarUniverse:'from live universe', multiRadarUpdated:'Last update', multiRadar1h:'1h', multiRadar24h:'24h', multiRadarLiquidity:'Liquidity', multiRadarMomentum:'Momentum', multiRadarFlow:'Flow', multiRadarTrap:'Trap', multiRadarScore:'Score', multiRadarWatch:'Follow', multiRadarActive:'Active now', multiRadarBuyFlow:'Buy pressure', multiRadarSellFlow:'Sell pressure', multiRadarBalanced:'Balanced flow', multiRadarDeep:'Deep analysis', multiRadarNoData:'Not enough live market data to build the multi-radar yet.', multiRadarFoot:'Ranking is live and inferential: liquidity, momentum and flow come from available public market data. Rank is not a guarantee of future price movement, and no synthetic market data is created when live data is unavailable.', multiRadarRest:'LIVE REST', multiRadarWs:'LIVE WebSocket', multiRadarCached:'CACHED', multiRadarOffline:'OFFLINE', multiRadarModeGainers:'Top Gainers', multiRadarModeBreakout:'Breakout Radar', multiRadarGainersHint:'Top symbols by current 24h price change from Binance live ticker data.', multiRadarBreakoutHint:'Early-momentum radar built from short-window price acceleration, volume acceleration and local high proximity; it is not a promise of a future breakout.', multiRadarShortMomentum:'Short momentum', multiRadarVolumeSpike:'Volume spike', multiRadarProximity:'High proximity', multiRadarBreakoutScore:'Breakout', multiRadarNoBreakout:'No symbol currently has enough early-momentum and volume evidence for the radar. More live ticks are needed.', multiRadarModeLabel:'Radar mode', multiRadarLiveNote:'Price and 24h change come from the Binance WebSocket. Breakout Radar uses real 1m Kline volume; no synthetic data is created when live feed is unavailable.',
      signalsTitle:'Signals & analysis', signalsDesc:'Explainable engine combining trend, momentum, volume, structure, liquidity and risk.', fullAnalysis:'Full analysis', searchPlaceholder:'Search: BTC, SUI, WAXP...', symbol:'Symbol', analysisHint:'Choose an asset or use BTCUSDT, then press Full analysis.',
      flowTitle:'Liquidity & Order Flow', flowDesc:'Order book + recent trades + live-derived CVD. No synthetic market data is displayed.', scanFlow:'Analyze flow', flowHint:'Press “Analyze flow” to show Bid/Ask/Imbalance/CVD.', whaleEyebrow:'WHALE FLOW RADAR', whaleTitle:'Whale & liquidity radar', scanWhales:'Scan whales', whaleMin:'Minimum large-trade value (USDT)', whaleWindow:'Trade count', whaleDepth:'Book depth', whaleHint:'Press “Scan whales” to detect large trades and flow direction.', bigBuys:'Large buys', bigSells:'Large sells', whaleNet:'Whale net flow', whaleScore:'Whale Score', biggest:'Largest trade', buyPressure:'Buy pressure', sellPressure:'Sell pressure', whaleReason:'The result compares large-trade value with its local distribution and order-book liquidity.', bidLiquidity:'Bid liquidity', askLiquidity:'Ask liquidity', imbalance:'Book imbalance', buySell:'Buy/Sell', cvdLabel:'CVD', orderFlowBalance:'Order-flow balance', threshold:'Threshold', side:'Side', notional:'Notional', rank:'Rank', perWeek:'/ week', perMonth:'/ month', perYear:'/ year',
      accountTitle:'Account & membership', accountDesc:'Account and membership run locally in this file. Real payments are never faked; production should connect app-store billing or a secure web checkout.', trialRemaining:'Trial remaining', weekly:'Weekly', monthly:'Monthly', yearly:'Yearly', featureRadar:'Full scanner', featureSignals:'Signals + Entry/SL/TP', featureFlow:'Order Flow', popular:'MOST USED', choosePlan:'Choose', commerceTitle:'Secure payments', commerceText:'This local edition does not execute real payments from JavaScript. You can test the UX and membership locally. For production use Google Play Billing on Android or a compliant web provider, with server-side verification.', demoUpgrade:'Demo Premium', manageSub:'Manage subscription', profileSettings:'Profile', name:'Name', save:'Save', reset:'Reset local account',
      moreTitle:'More', moreDesc:'Extra tools for research, testing and alert management.', compare:'Exchange compare', news:'News', alerts:'Alerts', lab:'Lab', chart:'Chart analysis', settings:'Settings', community:'Community',
      signalEarly:'EARLY ALERT', signalWatch:'WATCH', signalNo:'NO SIGNAL', modeLive:'LIVE DATA', modeCached:'LAST CONFIRMED LIVE', modeOffline:'MARKET DATA UNAVAILABLE', modeWaiting:'WAITING FOR LIVE BINANCE DATA', entry:'Entry', entryZone:'Entry zone', sl:'Stop loss', tp1:'TP1', tp2:'TP2', rr:'RR', quality:'Quality', strength:'Signal strength', horizon:'Watch window', reasons:'Why?', indicators:'Indicators', trend:'Trend', momentum:'Momentum', vol:'Volume', breakout:'Breakout', compression:'Compression', flow:'Flow', risk:'Risk',
      bull:'Bullish', bear:'Bearish', neutral:'Neutral', improving:'Improving', weakening:'Weakening', live:'Live', noData:'Not enough data', refresh:'Refresh', enableNotify:'Enable alerts', permissionGranted:'Alerts enabled', permissionBlocked:'Browser blocked notifications', noConflict:'No major conflict in the top setup', bidStrong:'Bid side is stronger.', askStrong:'Ask side is stronger.', balancedBook:'The order book is relatively balanced.', cvdNote:'CVD is calculated from trades this browser could read.', signalsCount:'Signals', wins:'Wins', losses:'Losses', hitRate:'Hit rate', approxResult:'Approx. historical result', conservativeRule:'When TP and SL occur inside the same candle, the conservative assumption is a loss.',
      backtestTitle:'Backtest', riskTitle:'Risk management', fee:'Fee %', slip:'Slippage %', tpRR:'TP RR', run:'Run', capital:'Capital', riskPct:'Risk %', slPct:'SL %', calc:'Calculate', chartUpload:'Choose chart image', localOnly:'Fully local', sources:'Sources', clear:'Clear', noAlerts:'No saved alerts.', communityHint:'Local demo posts — nothing is uploaded.', post:'Post', message:'Write a short post...',
      liveFailed:'Direct Binance API is unavailable right now. The app keeps the last confirmed live snapshot when available and never invents market data.', liveUpdated:'Results updated with live data.', scanReady:'Fetching the real Binance market snapshot now.', selected:'Selected', searchNo:'No local match found.', profileSaved:'Local profile saved.', demoPremium:'Premium demo activated locally.', subReset:'Local account reset to Trial.', noApi:'Binance Public API is currently unavailable from this browser.',
      autopilotTitle:'Smart Trader Mode / Auto-Pilot Scanner', autopilotSubtitle:'One beginner-friendly button: scan the live Binance universe, then enforce three strict gates — high liquidity and volume spike, strong bullish momentum, and low trap risk.', autopilotBadge:'LIVE BINANCE FILTER', smartScanBtn:'Scan the market and suggest the best immediate setup', smartGate1:'High 24h liquidity', smartGate2:'Volume Spike ≥ 1.8×', smartGate3:'Strong bullish momentum', smartGate4:'Trap Risk < 35', smartReady:'Ready — no golden setup is shown until the live gates are met.', smartScanningUniverse:'Scanning live universe: {n} pairs', smartGateFiltering:'Gate 1: liquidity + momentum filter — {n} candidates', smartKlineStage:'Gate 2: candle + live-volume verification — {n} assets', smartDeepStage:'Gate 3: flow + trap verification on the strongest candidates', smartComplete:'Scan complete: {u} pairs → {g} passed the gate → {d} deep-verified → {w} golden setup(s)', smartNoOpportunity:'No asset matches all three gates right now. That is safer than inventing a setup for a beginner. Scan again after the market changes.', smartNetworkFail:'Binance direct access is unavailable. No synthetic opportunity was generated.', goldenOpportunity:'GOLDEN OPPORTUNITY', goldenBest:'Best now', goldenWhy:'Why it appeared', goldenLiquidity:'Liquidity', goldenVolumeSpike:'Volume spike', goldenMomentum:'Momentum', goldenTrap:'Trap risk', goldenEntry:'Suggested entry', goldenSL:'Stop loss', goldenTP:'Conservative target', goldenTP2:'Second target', goldenRR:'Risk / Reward', goldenOpenAnalysis:'Open full forensic analysis', goldenPaper:'Paper simulate', goldenExplain:'Liquidity and volume expanded strongly, momentum is bullish, and the trap filter is low. This is a conditional setup from current data, not a guarantee of upside.', goldenNoChase:'Do not chase if price moves away from the entry zone.', smartUniverse:'Universe', smartStage1:'Initial candidates', smartDeep:'Deep verified', smartGold:'Golden', smartLiveOnly:'Live only · Spot', deepDiveNav:'Forensic Analysis', deepDiveTitle:'Deep-Dive Forensic Analysis Engine', deepDiveSubtitle:'One explainable report for the move, liquidity source, structure, breakout, and risk plan.', deepDiveVerdict:'Analytical Verdict', deepDiveEvidence:'Evidence Chain', deepDiveLiquidity:'Why did liquidity rise here?', deepDiveLiquidityZone:'Liquidity Pool / Order Block', estimatedWhaleEntry:'Weighted large-flow price', zoneConfidence:'Zone confidence', zoneRange:'Zone range', whyBreakout:'Why could the move expand?', executionPlan:'Execution Plan', entryPrice:'Entry price', entryZone:'Entry zone', stopLoss:'Stop loss', target1:'Target 1', target2:'Target 2', riskReward:'Risk / Reward', invalidation:'Invalidation', evidenceCoverage:'Evidence coverage', liquidityDriver:'Liquidity driver', flowDriver:'Flow driver', volumeDriver:'Volume driver', structureDriver:'Structure driver', momentumDriver:'Momentum driver', candleEvidence:'Candle read', structureEvidence:'Structure read', moneyFlowEvidence:'Money-flow read', orderBlockDemand:'Potential demand zone', orderBlockSupply:'Potential supply zone', orderBlockNeutral:'Balance zone', breakoutConfirmed:'Breakout supported by close + volume', breakoutPressure:'Price pressure near resistance', breakoutFailed:'Breakout failed back inside range', noBreakout:'No active breakout yet', conditionalBull:'Conditional bullish scenario', conditionalBear:'Conditional bearish scenario', neutralVerdict:'Monitor only', avoidVerdict:'Avoid until evidence changes', exactEntryCaveat:'This is a quantitative liquidity-zone estimate, not an identified wallet or a secret market-maker entry price.', modelLimit:'The engine is explainable and inferential; it does not know wallet identities or guarantee future moves.', forensicConfidence:'Evidence-quality confidence', forensicScore:'Forensic score', securityNote:'Never put exchange or payment secrets inside this page.', liveWs:'Live WebSocket', liveRest:'Live REST', liveCached:'Last confirmed live snapshot', liveOffline:'Market data unavailable', appHealthy:'Engine healthy', wsReconnect:'WebSocket reconnecting', dataAge:'Data age', neverFake:'No synthetic price or volume is generated', liveSource:'Source: Binance Spot Public Market Data', liveTape:'Live market tape', change:'Change', avoidChasing:'Do not turn speed into chasing.', resultsTitle:'Results & Notifications Center', backgroundRadarTitle:'Continuous Background Radar', backgroundRadarRunning:'Continuous engine running', backgroundRadarWaiting:'Waiting for live Binance data', backgroundRadarOffline:'Live feed unavailable — no synthetic data is generated', backgroundRadarLast:'Last scan', backgroundRadarAlerts:'Automatic alerts', backgroundGolden:'Golden opportunity', backgroundMomentum:'Momentum', backgroundVolumeSpike:'Volume spike', backgroundTrap:'Trap Risk', backgroundEngineHint:'Uses Binance public live market data while the page/PWA is active; browser suspension can pause timers.', backgroundRadarTitle:'Continuous Background Radar', backgroundRadarRunning:'Continuous engine running', backgroundRadarWaiting:'Waiting for live Binance data', backgroundRadarOffline:'Live feed unavailable — no synthetic data is generated', backgroundRadarLast:'Last scan', backgroundRadarAlerts:'Automatic alerts', backgroundGolden:'Golden opportunity', backgroundMomentum:'Momentum', backgroundVolumeSpike:'Volume spike', backgroundTrap:'Trap Risk', backgroundEngineHint:'Runs from Binance public live market data while the page/PWA is active; browser suspension can pause timers.', totalTrades:'Total trades', winningTrades:'Winning trades', losingTrades:'Losing trades', successRate:'Success rate', notificationLog:'Notification log', noEvents:'No results or notifications yet.', recommendationEvent:'New recommendation', profitSecureEvent:'Profit protection', breakEvenEvent:'Closed at break-even', profitCloseEvent:'Closed in profit', lossCloseEvent:'Closed at a loss', copied:'Price copied', activeAsset:'Active asset', selectedFrom:'Selected from', multiTpTitle:'Multi-Target Plan', multiTpSubtitle:'Staggered targets with an independent risk/reward level for each target.', confidence:'Confidence', tradeType:'Trade type', shortType:'Short-term', mediumType:'Medium-term', copy:'Copy', smcTitle:'Forensic & SMC Details', liquiditySweep:'Liquidity sweep', doubleSweep:'Double liquidity sweep', smcDemand:'Demand zone', smcSupply:'Supply zone', smcBalance:'Balance zone', bullishFvg:'Bullish FVG', bearishFvg:'Bearish FVG', noFvg:'No clear FVG', structureState:'Market structure', eventState:'Structure event', liveSelection:'Analysis follows the asset you selected.', resultsPaperOnly:'Results statistics cover RadarX paper trades only; the app does not read your external Binance account.', disclaimer:'RadarX is an analysis/monitoring tool. No signal is guaranteed and no trade orders are executed.'
    }
  };

  /*
   * Production entitlement configuration.
   * IMPORTANT: This client file must never contain Google service-account keys,
   * payment secrets, or any value that can authorize a purchase by itself.
   * In production, set RADARX_CONFIG.subscriptionVerificationEndpoint to your
   * HTTPS backend endpoint. The backend verifies the Google Play purchaseToken
   * with Google Play Developer API and returns the current entitlement.
   */
  const SUBSCRIPTION_CONFIG = {
    trialDays: 3,
    verificationEndpoint: (window.RADARX_CONFIG && typeof window.RADARX_CONFIG.subscriptionVerificationEndpoint === 'string')
      ? window.RADARX_CONFIG.subscriptionVerificationEndpoint.trim() : '',
    requestTimeout: 5000,
    remoteCheckEveryMs: 5 * 60 * 1000,
    plans: {weekly:{days:7,price:3,productId:'radarx_weekly'},monthly:{days:30,price:10,productId:'radarx_monthly'},yearly:{days:365,price:100,productId:'radarx_yearly'}}
  };
  const PRICING = {weekly:3,monthly:10,yearly:100};

  const PROVIDERS = {
    binance:{name:'Binance',quote:'USDT'}, okx:{name:'OKX',quote:'USDT'}, bybit:{name:'Bybit',quote:'USDT'}, gate:{name:'Gate',quote:'USDT'}, coinbase:{name:'Coinbase',quote:'USD'}
  };
  const SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','SUIUSDT','XLMUSDT','STXUSDT','SANDUSDT','WAXPUSDT','LINKUSDT','ADAUSDT','AVAXUSDT','APTUSDT','SEIUSDT','INJUSDT','ARBUSDT','OPUSDT','TIAUSDT','NEARUSDT','ATOMUSDT','DOGEUSDT','PEPEUSDT','TRXUSDT','AAVEUSDT','UNIUSDT','FILUSDT','ICPUSDT','HBARUSDT','ALGOUSDT','GRTUSDT','RUNEUSDT','JUPUSDT','PYTHUSDT','ONDOUSDT','ENAUSDT','RENDERUSDT','TAOUSDT','FETUSDT','THETAUSDT','IMXUSDT','LDOUSDT','JASMYUSDT','MKRUSDT','RLCUSDT','COMPUSDT','CRVUSDT','KASUSDT','TONUSDT','ETCUSDT'];

  const state = {
    lang: 'ar', busy:false, selectionToken:0, scanTimer:null, markets:[], deepRows:[], selected:null, lastFlow:null, deferredInstall:null, sort:'activity', live:false,
    settings:{theme:'dark'}, sentiment:{score:null,label:null,source:'waiting',fg:null,breadth:null,bthPrice:null,updatedAt:0}, structure:null, fakeout:null, briefing:null, simulator:{running:false,step:0,price:0,outcome:'WAITING',timer:null,logs:[]}, calendar:[], marketsBySymbol:{}, klinesCache:{}, streamTrades:{}, selectedStream:null, ws:{ticker:null,symbol:null,attempt:0,reconnectTimer:null,staleTimer:null,lastMessage:0,mode:'offline',paintTimer:null,lastPersist:0,generation:0}, profile:{name:'Guest Trader',email:'guest@radarx.local'}, membership:{status:'TRIAL', trialStart:Date.now(), trialGrantedAt:Date.now(), plan:null, expiresAt:null, source:'local', userId:null, demo:false, lastVerifiedAt:0}, psychology:{lossStreak:0,dailyLossPct:0,rapidEntries:0,status:'HEALTHY',cooldownUntil:0}, paper:{balance:10000,equity:10000,realized:0,unrealized:0,positions:[],history:[],nextId:1,updatedAt:0}, deepDive:null, currentSymbol:null, smartScan:{running:false,results:[],universe:0,stage1:0,deepVerified:0,startedAt:0,error:'',lastUpdated:0}, multiRadar:{count:8,mode:'gainers',leaders:[],lastUpdated:0,running:false,error:'',pollTimer:null,pulseTimer:null,renderKey:'',dirty:false,ws:null,wsAttempt:0,wsReconnectTimer:null,wsLastMessage:0,wsOpenedAt:0,wsGeneration:0,restLastSuccess:0,restFailures:0,paintTimer:null,lastPaintPrice:new Map(),cacheAt:0,klineWs:null,klineWsAttempt:0,klineWsReconnectTimer:null,klineWsLastMessage:0,klineWsGeneration:0,klineSymbols:[],klineBars:new Map(),klineBaselineAt:0,klineRefreshTimer:null}, briefingRefreshTimer:null, selectedPaintTimer:null, selectedLiveRecomputeTimer:null, selectedLiveRecomputePending:false, lastMarketDomPaint:0, subscriptionGate:{status:'TRIAL',locked:false,reason:'init',lastCheckedAt:0,checking:false,remote:false}, continuous:{enabled:true,cycleMs:3500,restRefreshMs:15000,cycleBusy:false,lastCycleAt:0,lastLiveTickAt:0,lastRestAt:0,lastError:'',mode:'starting',worker:null,timer:null,watchdogTimer:null,tape:new Map(),pending:new Set(),lastDeepAt:new Map(),lastAlertAt:new Map(),alertCount:0,lastGolden:null}
  };

  function readJSON(key, fallback){ try { const v=JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } }
  function writeJSON(key,val){ try { localStorage.setItem(key,JSON.stringify(val)); } catch {} }
  function t(k){ return I18N[state.lang][k] ?? k; }
  function toast(message){ const el=$('toast'); el.textContent=message; el.style.display='block'; clearTimeout(window.__rxToast); window.__rxToast=setTimeout(()=>el.style.display='none',3000); }
  function setConnection(text, ok=true){ const el=$('connText'),dot=$('connDot'); if(el)el.textContent=text; if(dot)dot.className=`dot ${ok?'ok':''}`; }
  function setDataMode(mode, detail=''){ const el=$('dataMode'); if(!el)return; const m=String(mode||'waiting').toLowerCase(); state.live=m==='live_ws'||m==='live_rest'; el.textContent=m==='live_ws'?t('modeLive'):m==='live_rest'?t('modeLive'):m==='cached'?t('modeCached'):m==='offline'?t('modeOffline'):t('modeWaiting'); el.className=`mini-badge ${m==='live_ws'||m==='live_rest'?'':'muted'}`; if(detail)el.title=detail; }
  function appHealthy(){ setConnection(t('appHealthy'),true); }
  function markLiveData(kind,detail=''){ state.ws.mode=kind; state.ws.lastStatusAt=Date.now(); setDataMode(kind,detail); if(kind==='live_ws'||kind==='live_rest'){ $('liveBadge').textContent=kind==='live_ws'?t('liveWs'):t('liveRest'); $('liveBadge').className='mini-badge'; } else if(kind==='cached'){ $('liveBadge').textContent=t('liveCached'); $('liveBadge').className='mini-badge muted'; } else { $('liveBadge').textContent=t('liveOffline'); $('liveBadge').className='mini-badge muted'; } }
  function formatDataAge(ts){ if(!ts)return '—'; const sec=Math.max(0,Math.floor((Date.now()-ts)/1000)); return sec<60?`${sec}s`:sec<3600?`${Math.floor(sec/60)}m`: `${Math.floor(sec/3600)}h`; }
  function applyLanguage(){
    document.documentElement.lang=state.lang; document.documentElement.dir=state.lang==='ar'?'rtl':'ltr';
    els('[data-i18n]').forEach(el=>{ el.textContent=t(el.dataset.i18n); });
    els('[data-i18n-placeholder]').forEach(el=>{ el.placeholder=t(el.dataset.i18nPlaceholder); });
    $('langToggle').textContent=state.lang==='ar'?'EN':'AR';
    $('connText').textContent=t('localConnected'); renderDataHealth();
    renderMembership(); const currentSub=$('subcontent')?.dataset.kind; if(currentSub) renderSub(currentSub); else renderMore(); renderAlerts(); renderResultsCenter();
    if(state.deepRows.length) renderRadarTable(state.deepRows); renderMultiRadar(); renderSymbolSelectionHighlights();
    renderSentiment(); renderStructurePanel(state.structure||null); renderBriefing(); renderPsychologyGuardian(); if(state.currentSymbol) renderActiveAssetHeader(state.currentSymbol,'language'); if(state.smartScan.lastUpdated || state.smartScan.error || state.smartScan.running) renderSmartOutput(state.smartScan.results,state.smartScan); if($('calendarPreview'))renderRiskCalendar(state.calendar||[]); if(state.selected) { $('analysisOutput').innerHTML=analysisHTML(state.selected); drawChart(state.selected.rows); const sw=$('analysisSim');if(sw)renderSimulatorInto('analysisSim',state.selected); const sb=$('analysisSimBtn');if(sb)sb.onclick=()=>{goTab('more');renderSub('simulator');}; const pb=$('analysisPaperBtn');if(pb)pb.onclick=()=>openPaperTrade(state.selected); }
  }

  function getOrCreateLocalUserId(){
    const saved=readJSON('radarx411_local_user_id',null);
    if(saved&&typeof saved==='string'&&saved.length>=12)return saved;
    let id='';
    try{id=crypto.randomUUID();}catch{ id='rx-'+Date.now().toString(36)+'-'+String(performance?.now?.()||0).replace(/\./g,''); }
    writeJSON('radarx411_local_user_id',id);
    return id;
  }
  function normalizeMembership(raw){
    const now=Date.now();
    const m=(raw&&typeof raw==='object')?{...raw}:{};
    m.userId=typeof m.userId==='string'&&m.userId?m.userId:getOrCreateLocalUserId();
    if(!Number.isFinite(Number(m.trialStart))||Number(m.trialStart)<=0){m.trialStart=now;m.trialGrantedAt=now;}
    m.trialStart=Number(m.trialStart);m.trialGrantedAt=Number(m.trialGrantedAt)||m.trialStart;
    m.expiresAt=Number.isFinite(Number(m.expiresAt))?Number(m.expiresAt):null;
    m.lastVerifiedAt=Number.isFinite(Number(m.lastVerifiedAt))?Number(m.lastVerifiedAt):0;
    m.status=['TRIAL','ACTIVE','EXPIRED'].includes(m.status)?m.status:'TRIAL';
    m.source=m.source||'local';m.demo=!!m.demo;
    return m;
  }
  function loadState(){
    state.lang=readJSON(KEYS.settings,{lang:'ar'}).lang==='en'?'en':'ar';
    state.profile={...state.profile,...readJSON(KEYS.profile,{})};
    const savedMembership=readJSON(KEYS.membership,null);
    if(savedMembership){
      state.membership=normalizeMembership(savedMembership);
    }else{
      const now=Date.now();
      state.membership=normalizeMembership({status:'TRIAL',trialStart:now,trialGrantedAt:now,plan:null,expiresAt:null,source:'local',demo:false});
      writeJSON(KEYS.membership,state.membership);
    }
    state.profile.name=String(state.profile.name||'Guest Trader');
    state.profile.email=String(state.profile.email||'guest@radarx.local');
    if(!state.membership.userId)state.membership.userId=getOrCreateLocalUserId();
    writeJSON(KEYS.membership,state.membership);
  }

  function renderProfile(){
    $('profileName').textContent=state.profile.name.split(' ')[0] || 'Guest';
    $('profileAvatar').textContent=(state.profile.name.trim()[0]||'R').toUpperCase();
    $('accountName').textContent=state.profile.name; $('accountEmail').textContent=state.profile.email;
    $('accountAvatar').textContent=(state.profile.name.trim()[0]||'R').toUpperCase();
    $('nameInput').value=state.profile.name; $('emailInput').value=state.profile.email;
  }

  function membershipState(){
    const m=state.membership;
    if(!m||typeof m!=='object')return 'EXPIRED';
    const now=Date.now();
    if(m.status==='ACTIVE'){
      if(Number.isFinite(m.expiresAt)&&m.expiresAt>now)return 'ACTIVE';
      m.status='EXPIRED';m.expiresAt=Number(m.expiresAt)||now;m.source=m.source||'local';writeJSON(KEYS.membership,m);return 'EXPIRED';
    }
    if(m.status==='TRIAL'){
      const end=(Number(m.trialStart)||now)+SUBSCRIPTION_CONFIG.trialDays*24*3600e3;
      if(now>=end){m.status='EXPIRED';m.source='local';m.demo=false;writeJSON(KEYS.membership,m);return 'EXPIRED';}
      return 'TRIAL';
    }
    return 'EXPIRED';
  }
  function fmtDuration(ms){
    const s=Math.max(0,Math.floor(ms/1000)), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60;
    return d>0?`${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`:`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }
  function premiumIsUnlocked(){const st=membershipState();return st==='TRIAL'||st==='ACTIVE';}
  function paywallLabel(){return state.lang==='ar'?'الاشتراك مطلوب للوصول إلى RadarX Premium':'A RadarX Premium subscription is required.';}
  function renderSubscriptionPaywall(status,reason='expired'){
    let host=$('rxSubscriptionPaywall');
    if(!host){host=document.createElement('div');host.id='rxSubscriptionPaywall';host.className='rx-paywall';document.body.appendChild(host);}
    const isExpired=status==='EXPIRED';
    const title=state.lang==='ar'?(isExpired?'انتهت صلاحية الوصول':'التحقق من الاشتراك'):isExpired?'Access expired':'Subscription verification';
    const sub=state.lang==='ar'?(isExpired?'انتهت النسخة التجريبية أو الاشتراك. اختر باقة للمتابعة.':'جاري التحقق من حالة الوصول…'):(isExpired?'Your trial or subscription has expired. Choose a plan to continue.':'Checking your access status…');
    host.innerHTML=`<div class="rx-paywall-card" role="dialog" aria-modal="true" aria-labelledby="rxPaywallTitle"><div class="rx-paywall-badge">RADARX PREMIUM</div><h2 id="rxPaywallTitle">${esc(title)}</h2><p class="rx-paywall-sub">${esc(sub)}</p><div class="rx-paywall-status">${esc(paywallLabel())}${reason?`<span>· ${esc(reason)}</span>`:''}</div><div class="rx-paywall-plans"><button class="rx-paywall-plan" data-rx-plan="weekly"><b>$3</b><span>${state.lang==='ar'?'أسبوع':'Week'}</span></button><button class="rx-paywall-plan featured" data-rx-plan="monthly"><b>$10</b><span>${state.lang==='ar'?'شهر':'Month'}</span></button><button class="rx-paywall-plan" data-rx-plan="yearly"><b>$100</b><span>${state.lang==='ar'?'سنة':'Year'}</span></button></div><button class="rx-paywall-demo" id="rxPaywallDemo">🧪 ${esc(t('demoUpgrade'))}</button><p class="rx-paywall-note">${state.lang==='ar'?'المحاكاة لا تسحب أموالاً. في Android ستُربط هذه الأزرار بـ Google Play Billing مع تحقق خادمي.':'Demo mode does not charge money. In Android, connect these plans to Google Play Billing with server-side verification.'}</p><div class="rx-paywall-meta">User: ${esc(state.membership.userId||'local')} · ${esc(membershipState())}</div></div>`;
    host.style.display='grid';
    host.setAttribute('data-reason',reason);
    host.querySelectorAll('[data-rx-plan]').forEach(btn=>btn.onclick=()=>openPayment(btn.dataset.rxPlan));
    const demo=host.querySelector('#rxPaywallDemo'); if(demo)demo.onclick=()=>{activateDemo('monthly');};
  }
  function hideSubscriptionPaywall(){const host=$('rxSubscriptionPaywall');if(host)host.style.display='none';document.body.classList.remove('rx-subscription-locked');}
  function pausePremiumEngines(){
    try{clearInterval(state.scanTimer);state.scanTimer=null;}catch{}
    try{stopContinuousRadar(false);}catch{}
    try{stopMultiRadar();}catch{}
    try{closeSelectedWS();}catch{}
    try{if(state.ws?.ticker){state.ws.ticker.close(1000,'subscription-locked');state.ws.ticker=null;}}catch{}
  }
  function resumePremiumEngines(){
    if(!premiumIsUnlocked())return;
    document.body.classList.remove('rx-subscription-locked');
    try{startMultiRadar();}catch{}
    try{startContinuousRadar();}catch{}
    try{if($('exchangeSelect')?.value==='binance' && !state.ws.ticker)openTickerWS(0);}catch{}
  }
  function applySubscriptionGate(status,reason='runtime'){
    const locked=status==='EXPIRED';
    const changed=state.subscriptionGate.locked!==locked || state.subscriptionGate.status!==status;
    state.subscriptionGate={...state.subscriptionGate,status,locked,reason,lastCheckedAt:Date.now(),remote:state.subscriptionGate.remote||false};
    document.body.classList.toggle('rx-subscription-locked',locked);
    if(locked){
      const host=$('rxSubscriptionPaywall');
      const visible=!!host&&getComputedStyle(host).display!=='none';
      const sameReason=!!host&&host.getAttribute('data-reason')===reason;
      if(!visible||changed||!sameReason)renderSubscriptionPaywall('EXPIRED',reason);
      pausePremiumEngines();
    }else{
      hideSubscriptionPaywall();
      if(changed)resumePremiumEngines();
    }
    return locked;
  }
  function renderMembership(){
    const st=membershipState(); const mini=$('trialMini'); const badge=$('planBadge'); const end=st==='TRIAL'?(state.membership.trialStart+SUBSCRIPTION_CONFIG.trialDays*24*3600e3):state.membership.expiresAt;
    if(st==='TRIAL'){
      mini.textContent=state.lang==='ar'?'تجربة • 3 أيام':'TRIAL • 3 DAYS'; badge.textContent='TRIAL'; $('trialCountdown').textContent=fmtDuration(end-Date.now()); $('trialFill').style.width=`${clamp((end-Date.now())/(SUBSCRIPTION_CONFIG.trialDays*24*3600e3)*100,0,100)}%`;
    } else if(st==='ACTIVE'){
      mini.textContent=`PRO • ${state.membership.plan||'PLAN'}`; badge.textContent=(state.membership.plan||'PRO').toUpperCase(); $('trialCountdown').textContent=fmtDuration(end-Date.now()); $('trialFill').style.width='100%';
    } else {
      mini.textContent=state.lang==='ar'?'الوصول مغلق':'ACCESS LOCKED'; badge.textContent='EXPIRED'; $('trialCountdown').textContent='00:00:00'; $('trialFill').style.width='0%';
    }
    applySubscriptionGate(st,st==='EXPIRED'?'expired':'active');
  }
  async function verifyRemoteSubscription(){
    const endpoint=SUBSCRIPTION_CONFIG.verificationEndpoint;
    if(!endpoint||!/^https:\/\//i.test(endpoint))return null;
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),SUBSCRIPTION_CONFIG.requestTimeout);
    try{
      const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({userId:state.membership.userId,platform:'web',localStatus:membershipState(),localExpiresAt:state.membership.expiresAt||null}) ,signal:ctrl.signal,credentials:'omit',cache:'no-store'});
      if(!res.ok)throw new Error(`VERIFY_HTTP_${res.status}`);
      const data=await res.json();
      if(!data||!['TRIAL','ACTIVE','EXPIRED'].includes(data.status))return null;
      if(data.status==='ACTIVE'){
        const expires=Number(data.expiresAt);if(!Number.isFinite(expires)||expires<=Date.now())return {status:'EXPIRED',source:'remote'};
        state.membership={...state.membership,status:'ACTIVE',plan:String(data.plan||state.membership.plan||'PRO'),expiresAt:expires,source:'remote',lastVerifiedAt:Date.now(),demo:false};
      }else if(data.status==='EXPIRED'){
        state.membership={...state.membership,status:'EXPIRED',source:'remote',lastVerifiedAt:Date.now(),demo:false};
      }else if(data.status==='TRIAL'){
        // Server-trusted trial is allowed only when server explicitly says TRIAL.
        const trialEnd=Number(data.expiresAt);if(Number.isFinite(trialEnd)&&trialEnd>Date.now())state.membership={...state.membership,status:'TRIAL',trialStart:trialEnd-SUBSCRIPTION_CONFIG.trialDays*24*3600e3,source:'remote',lastVerifiedAt:Date.now()};
      }
      writeJSON(KEYS.membership,state.membership);state.subscriptionGate.remote=true;return {status:membershipState(),source:'remote'};
    }catch{return null}finally{clearTimeout(timer);}
  }
  async function checkSubscriptionStatus(source='startup'){
    if(state.subscriptionGate.checking)return membershipState();
    state.subscriptionGate.checking=true;
    try{
      const local=membershipState();
      applySubscriptionGate(local,source);
      const remote=await verifyRemoteSubscription();
      const finalStatus=remote?.status||membershipState();
      state.subscriptionGate.lastCheckedAt=Date.now();
      applySubscriptionGate(finalStatus,remote?'remote-verified':source);
      renderMembershipCardsOnly();
      return finalStatus;
    }finally{state.subscriptionGate.checking=false;}
  }
  function renderMembershipCardsOnly(){
    const st=membershipState();
    const buttons=els('.plan-btn');buttons.forEach(b=>b.disabled=false);
    if($('demoUpgrade'))$('demoUpgrade').disabled=false;
    const c=$('trialCountdown'),f=$('trialFill');
    if(st==='TRIAL'){
      const end=state.membership.trialStart+SUBSCRIPTION_CONFIG.trialDays*24*3600e3;
      if(c)c.textContent=fmtDuration(end-Date.now());if(f)f.style.width=`${clamp((end-Date.now())/(SUBSCRIPTION_CONFIG.trialDays*24*3600e3)*100,0,100)}%`;
    }
  }
  function activateDemo(plan='monthly'){
    const cfg=SUBSCRIPTION_CONFIG.plans[plan]||SUBSCRIPTION_CONFIG.plans.monthly;
    state.membership={...state.membership,status:'ACTIVE',plan,expiresAt:Date.now()+cfg.days*24*3600e3,source:'demo',demo:true,lastVerifiedAt:Date.now()};
    writeJSON(KEYS.membership,state.membership);
    renderMembership();
    applySubscriptionGate('ACTIVE','demo-activated');
    renderAccountLock();
    toast(t('demoPremium'));
  }
  function resetMembership(){
    // Security rule: account reset MUST NOT re-grant the one-time local trial.
    state.membership={...state.membership,status:'EXPIRED',plan:null,expiresAt:null,source:'local-reset',demo:false};
    writeJSON(KEYS.membership,state.membership);
    renderMembership();renderAccountLock();toast(t('subReset'));
  }
  function renderAccountLock(){
    const st=membershipState();
    $('upgradeMini').classList.toggle('hidden',st!=='EXPIRED');
    applySubscriptionGate(st,st==='EXPIRED'?'expired':'account');
  }

  // Android / Google Play Billing bridge (future integration point):
  // 1) Android uses BillingClient.queryPurchasesAsync() / purchase updates.
  // 2) Send the purchaseToken to a secure backend.
  // 3) Backend verifies the token with Google Play Developer API (Subscriptions v2),
  //    stores entitlement, and returns only the verified status/expiresAt.
  // 4) Backend acknowledges the purchase after entitlement is granted.
  // Never place service-account credentials in this HTML/JS.
  async function consumeNativeEntitlement(){
    try{
      const fn=window.RadarXNative?.getSubscriptionStatus;
      if(typeof fn!=='function')return null;
      const data=await fn();
      if(!data||!['TRIAL','ACTIVE','EXPIRED'].includes(data.status))return null;
      if(data.status==='ACTIVE'&&Number(data.expiresAt)>Date.now()){
        state.membership={...state.membership,status:'ACTIVE',plan:String(data.plan||'PRO'),expiresAt:Number(data.expiresAt),source:'native',lastVerifiedAt:Date.now(),demo:false};
      }else if(data.status==='EXPIRED')state.membership={...state.membership,status:'EXPIRED',source:'native',lastVerifiedAt:Date.now(),demo:false};
      writeJSON(KEYS.membership,state.membership);return membershipState();
    }catch{return null}
  }
  window.RadarXSubscription={checkSubscriptionStatus,activateDemo,openPayment,consumeNativeEntitlement,getStatus:()=>membershipState()};

  function symbolFor(provider,symbol){
    const s=String(symbol||'BTCUSDT').toUpperCase().replace(/[\s\/_-]/g,'');
    if(provider==='okx') return s.endsWith('USDT')?`${s.slice(0,-4)}-USDT`:s.endsWith('USD')?`${s.slice(0,-3)}-USD`:s;
    if(provider==='coinbase') return s.endsWith('USDT')?`${s.slice(0,-4)}-USD`:s.endsWith('USD')?`${s.slice(0,-3)}-USD`:s.endsWith('USDC')?`${s.slice(0,-4)}-USDC`:s;
    if(provider==='gate') return s.endsWith('USDT')?`${s.slice(0,-4)}_USDT`:s.endsWith('USD')?`${s.slice(0,-3)}_USD`:s;
    return s;
  }
  function intervalFor(provider,tf){
    if(provider==='okx') return tf==='1m'?'1m':tf==='5m'?'5m':tf==='15m'?'15m':tf==='1h'?'1H':tf;
    if(provider==='bybit') return tf==='1h'?'60':tf.replace('m','');
    return tf;
  }
  async function fetchJSON(url,{timeout=6000,retries=1,backoff=450}={}){
    const isAbsolute=/^https:\/\//i.test(url);
    const isInternalRoute=typeof url==='string' && url.startsWith('/api/');
    if(!isAbsolute && !isInternalRoute) throw new Error('Only HTTPS URLs or same-origin RadarX API routes are allowed');
    const requestUrl=isAbsolute?url:new URL(url,location.href).toString();
    const proxiedUrl=(()=>{try{
      const u=new URL(requestUrl,location.href),h=u.hostname,p=u.pathname+u.search;
      if(new URL(requestUrl,location.href).origin===location.origin && u.pathname.startsWith('/api/')) return requestUrl;
      const map=h==='www.okx.com'?'okx':h==='api.bybit.com'?'bybit':(h==='api.gateio.ws'||h==='api.gate.us')?'gate':h==='api.exchange.coinbase.com'?'coinbase':h==='api.coingecko.com'?'coingecko':h==='fapi.binance.com'?'binanceFutures':null;
      return map?('/api/market?provider='+encodeURIComponent(map)+'&path='+encodeURIComponent(p)):requestUrl;
    }catch{return requestUrl;}})();
    if(navigator.onLine===false) throw new Error('OFFLINE');
    let last=null;
    for(let attempt=0; attempt<=Math.max(0,retries); attempt++){
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),timeout);
      const started=performance.now();
      try{
        const r=await fetch(proxiedUrl,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'follow',signal:ctrl.signal});
        const latency=Math.round(performance.now()-started); if($('apiLatency'))$('apiLatency').textContent=`${latency} ms`;
        if(r.status===429) throw new Error('RATE_LIMIT_429');
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      }catch(e){
        last=e;
        if(attempt<retries) await sleep(backoff*Math.pow(2,attempt));
      }finally{clearTimeout(timer);}
    }
    throw last||new Error('API unavailable');
  }
  async function firstJSON(urls,{timeout=6000,retries=1,maxUrls=3}={}){
    const list=(urls||[]).slice(0,Math.max(1,maxUrls));
    let last=null;
    for(const u of list){
      try{
        const data=await fetchJSON(u,{timeout,retries});
        try{const origin=new URL(u).origin;const idx=BINANCE_REST_BASES.indexOf(origin);if(idx>=0)binanceRestPreferred=idx;}catch{}
        return data;
      }catch(e){last=e;}
    }
    throw last||new Error('API unavailable');
  }
  // Network-resilient fallback: try several Binance REST origins in parallel and
  // keep the first valid response. This prevents one dead DNS route from blocking
  // the whole radar behind a long sequential timeout.
  async function firstJSONRace(urls,{timeout=4500,retries=0,maxUrls=3}={}){
    const list=(urls||[]).slice(0,Math.max(1,maxUrls));
    if(!list.length)throw new Error('API unavailable');
    let settled=false;
    const controllers=[];
    const jobs=list.map((u,i)=>new Promise((resolve,reject)=>{
      const ctrl=new AbortController();controllers.push(ctrl);
      const timer=setTimeout(()=>ctrl.abort(),timeout);
      const started=performance.now();
      fetch(u,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'follow',signal:ctrl.signal})
        .then(async r=>{
          if(r.status===429)throw new Error('RATE_LIMIT_429');
          if(!r.ok)throw new Error(`HTTP ${r.status}`);
          const data=await r.json();
          const latency=Math.round(performance.now()-started);if($('apiLatency'))$('apiLatency').textContent=`${latency} ms`;
          resolve({data,url:u,index:i});
        })
        .catch(reject)
        .finally(()=>clearTimeout(timer));
    }));
    try{
      const winner=await Promise.any(jobs);
      settled=true;
      controllers.forEach((c,i)=>{if(i!==winner.index)try{c.abort()}catch{}});
      try{const origin=new URL(winner.url).origin;const idx=BINANCE_REST_BASES.indexOf(origin);if(idx>=0)binanceRestPreferred=idx;}catch{}
      return winner.data;
    }catch(e){
      settled=true;
      throw new AggregateError(e?.errors||[e],'All Binance REST routes failed');
    }finally{if(!settled)controllers.forEach(c=>{try{c.abort()}catch{}});}
  }


  const BINANCE_REST_BASES=['https://data-api.binance.vision','https://api.binance.com','https://api-gcp.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com']; let binanceRestPreferred=0;
  const BINANCE_WS_BASES=['wss://data-stream.binance.vision/stream','wss://stream.binance.com:9443/stream','wss://stream.binance.com/stream'];
  function binanceProxyUrl(path){return '/api/binance?path='+encodeURIComponent(path);}
  function binanceUrls(path){const preferred=BINANCE_REST_BASES[binanceRestPreferred]||BINANCE_REST_BASES[0];return [binanceProxyUrl(path),preferred,...BINANCE_REST_BASES.filter((_,i)=>i!==binanceRestPreferred)].map(base=>base.startsWith('/api/binance?')?base:base+path);}
  function saveLiveSnapshot(){ try{const items=Object.values(state.marketsBySymbol||{}).filter(x=>x&&x.symbol).sort((a,b)=>(b.quoteVolume||0)-(a.quoteVolume||0)).slice(0,3000);if(items.length){const ts=Date.now();state.multiRadar.cacheAt=ts;writeJSON('radarx_live_snapshot_v55',{ts,items});}}catch{} }
  function loadLiveSnapshot(){ try{const d=readJSON('radarx_live_snapshot_v55',null);if(!d?.items?.length)return false;const age=Date.now()-num(d.ts,0);if(age<0||age>RADAR_FILTERS.cachedMarketMaxAgeMs)return false;const cachedAt=num(d.ts,Date.now());state.multiRadar.cacheAt=cachedAt;state.marketsBySymbol={};d.items.forEach(raw=>{const x={...raw,receivedAt:num(raw.receivedAt,cachedAt),dataSource:'cache'};if(x.symbol)state.marketsBySymbol[x.symbol]=x;});state.markets=Object.values(state.marketsBySymbol);markLiveData('cached',`${t('liveCached')} · ${formatDataAge(cachedAt)}`);return true;}catch{return false;} }
  function normalizeTicker(x, provider){
    const s=String(x.symbol||x.instId||x.currency_pair||'').replace(/[-_]/g,'').toUpperCase();
    const receivedAt=Date.now();
    const eventTime=num(x.eventTime??x.E??x.closeTime??x.C??x.ts??x.timestamp,receivedAt);
    return {symbol:s,last:num(x.last??x.lastPrice??x.c),priceChangePercent:num(x.priceChangePercent??(x.price24hPcnt!=null?num(x.price24hPcnt)*100:undefined)??x.change_percentage??x.P??(x.sodUtc0&&x.last?((num(x.last)/num(x.sodUtc0)-1)*100):0)),quoteVolume:num(x.quoteVolume??x.quote_volume??x.volCcy24h??x.turnover24h??x.q),baseAsset:s.replace(/USDT$|USDC$|USD$/,''),quoteAsset:provider==='coinbase'?'USD':'USDT',provider,bidPrice:num(x.bidPrice??x.b),askPrice:num(x.askPrice??x.a),bidQty:num(x.bidQty??x.B),askQty:num(x.askQty??x.A),eventTime,receivedAt,dataSource:provider==='binance'?'market':'market',open:num(x.open??x.o),high:num(x.high??x.h),low:num(x.low??x.l),baseVolume:num(x.volume??x.v)};
  }
  function normalizeBinanceTicker(x){return normalizeTicker({symbol:x.s,lastPrice:x.c,priceChangePercent:x.P,quoteVolume:x.q,b:x.b,a:x.a,B:x.B,A:x.A,E:x.E,o:x.o,h:x.h,l:x.l,v:x.v},'binance');}
  async function fetchAllTickers(provider){
    if(provider==='binance'){
      const d=await firstJSONRace(binanceUrls('/api/v3/ticker/24hr'),{timeout:4500,retries:0,maxUrls:4});
      return (Array.isArray(d)?d:[]).map(x=>normalizeTicker(x,provider));
    }
    if(provider==='okx'){ const d=await fetchJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT'); return (d.data||[]).map(x=>normalizeTicker(x,provider)); }
    if(provider==='bybit'){ const d=await fetchJSON('https://api.bybit.com/v5/market/tickers?category=spot'); return (d.result?.list||[]).map(x=>normalizeTicker(x,provider)); }
    if(provider==='gate'){ const d=await fetchJSON('https://api.gateio.ws/api/v4/spot/tickers'); return (d||[]).map(x=>normalizeTicker(x,provider)); }
    if(provider==='coinbase'){ const products=await fetchJSON('https://api.exchange.coinbase.com/products'); return (products||[]).filter(x=>x.status==='online' && x.quote_currency==='USD').slice(0,160).map(x=>({symbol:x.id.replace('-',''),last:0,priceChangePercent:0,quoteVolume:0,baseAsset:x.base_currency,quoteAsset:'USD',providerId:x.id}));}
    throw new Error('Unsupported exchange');
  }
  async function fetchTicker(provider,symbol){
    const sym=symbolFor(provider,symbol);
    if(provider==='binance'){const d=await firstJSONRace(binanceUrls(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`),{timeout:4500,retries:0,maxUrls:4});return normalizeTicker(d,provider);}
    if(provider==='okx'){const d=await fetchJSON(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(sym)}`);return d.data?.[0]?normalizeTicker(d.data[0],provider):null}
    if(provider==='bybit'){const d=await fetchJSON(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`);return d.result?.list?.[0]?normalizeTicker(d.result.list[0],provider):null}
    if(provider==='gate'){const d=await fetchJSON(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(sym)}`);return d?.[0]?normalizeTicker(d[0],provider):null}
    if(provider==='coinbase'){const d=await fetchJSON(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/ticker`);return {symbol, last:num(d.price), priceChangePercent:0, quoteVolume:0, baseAsset:symbol.replace(/USDT|USD$/,''), quoteAsset:'USD'};}
  }
  function candleIntervalMs(tf){return (tf==='1m'?1:tf==='3m'?3:tf==='5m'?5:tf==='15m'?15:tf==='30m'?30:tf==='1h'?60:tf==='2h'?120:tf==='4h'?240:tf==='6h'?360:tf==='8h'?480:tf==='12h'?720:tf==='1d'?1440:5)*60000;}
  function candleClosedAt(ts,tf){const t0=num(ts,0),dur=candleIntervalMs(tf);return t0>0&&dur>0&&t0+dur<=Date.now();}
  function validateCandleRows(rows,tf){
    const valid=(rows||[]).filter(r=>{
      const t0=num(r?.t,0),o=num(r?.o,0),h=num(r?.h,0),l=num(r?.l,0),cl=num(r?.c,0),v=num(r?.v,0),q=num(r?.q,0);
      return t0>0&&o>0&&h>0&&l>0&&cl>0&&h>=Math.max(o,cl)&&l<=Math.min(o,cl)&&h>=l&&v>=0&&q>=0;
    }).sort((a,b)=>a.t-b.t);
    if(valid.length<Math.min(3,(rows||[]).length))throw new Error('INVALID_CANDLE_DATA');
    return valid;
  }
  function parseBinanceKlines(rows){return (rows||[]).map(r=>({t:num(r[0]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),v:num(r[5]),q:num(r[7]),trades:num(r[8]),tb:num(r[9]),closed:num(r[6],0)<=Date.now()}));}
  function validateDepthBook(d){
    const bids=(d?.bids||[]).map(r=>[num(r[0]),num(r[1])]).filter(r=>r[0]>0&&r[1]>0).sort((a,b)=>b[0]-a[0]);
    const asks=(d?.asks||[]).map(r=>[num(r[0]),num(r[1])]).filter(r=>r[0]>0&&r[1]>0).sort((a,b)=>a[0]-b[0]);
    if(!bids.length||!asks.length||bids[0][0]>=asks[0][0])throw new Error('INVALID_ORDERBOOK');
    return {...d,bids,asks};
  }
  function validateTrades(rows){
    const out=(rows||[]).map(x=>({id:x.id,price:num(x.price),amount:num(x.amount),buy:!!x.buy,t:num(x.t)})).filter(x=>x.price>0&&x.amount>0&&x.t>0);
    if(out.length<Math.min(3,(rows||[]).length))throw new Error('INVALID_TRADE_DATA');
    return out;
  }
  async function fetchKlines(provider,symbol,tf,limit=180){
    const sym=symbolFor(provider,symbol), iv=intervalFor(provider,tf);
    if(provider==='binance') return validateCandleRows(parseBinanceKlines(await firstJSONRace(binanceUrls(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(iv)}&limit=${Math.min(1000,limit)}`),{timeout:4500,retries:0,maxUrls:4})),tf);
    if(provider==='okx'){const d=await fetchJSON(`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(sym)}&bar=${encodeURIComponent(iv)}&limit=${Math.min(300,limit)}`);return validateCandleRows((d.data||[]).reverse().map(r=>({t:num(r[0]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),v:num(r[5]),q:num(r[6]),closed:candleClosedAt(r[0],tf)})),tf);}
    if(provider==='bybit'){const d=await fetchJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(iv)}&limit=${Math.min(1000,limit)}`);return validateCandleRows((d.result?.list||[]).reverse().map(r=>({t:num(r[0]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),v:num(r[5]),q:num(r[6]),closed:candleClosedAt(r[0],tf)})),tf);}
    if(provider==='gate'){const d=await fetchJSON(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(sym)}&interval=${encodeURIComponent(tf)}&limit=${Math.min(1000,limit)}`);return validateCandleRows((d||[]).reverse().map(r=>({t:num(r[0])*1000,v:num(r[1]),c:num(r[2]),h:num(r[3]),l:num(r[4]),o:num(r[5]),q:num(r[1])*num(r[2]),closed:candleClosedAt(num(r[0])*1000,tf)})),tf);}
    if(provider==='coinbase'){const gran={'1m':60,'5m':300,'15m':900,'1h':3600}[tf]||300;const d=await fetchJSON(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/candles?granularity=${gran}`);return validateCandleRows((d||[]).reverse().map(r=>({t:num(r[0])*1000,l:num(r[1]),h:num(r[2]),o:num(r[3]),c:num(r[4]),v:num(r[5]),q:num(r[4])*num(r[5]),closed:candleClosedAt(num(r[0])*1000,tf)})),tf);}
    throw new Error('Klines unavailable');
  }
  async function fetchDepth(provider,symbol,limit=50){
    const sym=symbolFor(provider,symbol);
    if(provider==='binance') return validateDepthBook(await firstJSONRace(binanceUrls(`/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(1000,limit)}`),{timeout:4500,retries:0,maxUrls:4}));
    if(provider==='okx'){const d=await fetchJSON(`https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(sym)}&sz=${Math.min(60,limit)}`),x=d.data?.[0]||{};return validateDepthBook({bids:(x.bids||[]).map(r=>[r[0],r[1]]),asks:(x.asks||[]).map(r=>[r[0],r[1]])});}
    if(provider==='bybit'){const d=await fetchJSON(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(symbol)}&limit=${Math.min(50,limit)}`),x=d.result||{};return validateDepthBook({bids:x.b||[],asks:x.a||[]});}
    throw new Error('Depth unavailable');
  }
  async function fetchTrades(provider,symbol,limit=100){
    const sym=symbolFor(provider,symbol);
    if(provider==='binance'){const d=await firstJSONRace(binanceUrls(`/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(1000,limit)}`),{timeout:4500,retries:0,maxUrls:4});return validateTrades((d||[]).map(x=>({id:num(x.a),price:num(x.p),amount:num(x.q),buy:!x.m,t:num(x.T)})));}
    if(provider==='okx'){const d=await fetchJSON(`https://www.okx.com/api/v5/market/trades?instId=${encodeURIComponent(sym)}&limit=${Math.min(100,limit)}`);return validateTrades((d.data||[]).map(x=>({id:x.tradeId,price:num(x.px),amount:num(x.sz),buy:x.side==='buy',t:num(x.ts)})));}
    if(provider==='bybit'){const d=await fetchJSON(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${encodeURIComponent(symbol)}&limit=${Math.min(60,limit)}`);return validateTrades((d.result?.list||[]).map(x=>({id:x.execId,price:num(x.price),amount:num(x.size),buy:x.side==='Buy',t:num(x.time)})));}
    throw new Error('Trades unavailable');
  }

  // ---------- Resilient multi-provider data layer ----------
  const PROVIDER_ORDER=['binance','okx','bybit','gate'];
  const providerHealthStats=Object.fromEntries(PROVIDER_ORDER.map(p=>[p,{ok:0,fail:0,lastOk:0,lastFail:0,latency:0,streak:0}]));
  function noteProvider(provider,ok,latency=0){
    const h=providerHealthStats[provider]||(providerHealthStats[provider]={ok:0,fail:0,lastOk:0,lastFail:0,latency:0,streak:0});
    if(ok){h.ok++;h.lastOk=Date.now();h.latency=latency||h.latency;h.streak=Math.min(20,h.streak+1);}
    else{h.fail++;h.lastFail=Date.now();h.streak=Math.max(-20,h.streak-2);}
  }
  function providerRank(){
    return [...PROVIDER_ORDER].sort((a,b)=>{
      const A=providerHealthStats[a],B=providerHealthStats[b];
      const sa=A.streak*20+(A.lastOk?Math.max(0,30000-(Date.now()-A.lastOk))/1000:0)-(A.latency||0)/100;
      const sb=B.streak*20+(B.lastOk?Math.max(0,30000-(Date.now()-B.lastOk))/1000:0)-(B.latency||0)/100;
      return sb-sa;
    });
  }
  async function resilientTickers(preferred='binance'){
    const order=[preferred,...providerRank().filter(p=>p!==preferred)];
    let lastErr=null;
    for(const p of order){
      const t0=performance.now();
      try{const rows=await fetchAllTickers(p);if(Array.isArray(rows)&&rows.length){noteProvider(p,true,performance.now()-t0);return {rows,provider:p};}}
      catch(e){lastErr=e;noteProvider(p,false,performance.now()-t0);}
    }
    throw lastErr||new Error('No market provider available');
  }
  function dataFresh(ts,maxAge=20000){return Number.isFinite(Number(ts))&&Date.now()-Number(ts)>=0&&Date.now()-Number(ts)<=maxAge;}
  function exposeProviderHealth(){
    try{window.RadarXDataHealth={providers:JSON.parse(JSON.stringify(providerHealthStats)),rank:providerRank(),at:Date.now()};}catch{}
  }
  exposeProviderHealth();
  setInterval(exposeProviderHealth,5000);

  // ---------- Binance live WebSocket engine ----------
  function mergeTicker(t){ if(!t?.symbol||!(t.last>0))return; state.marketsBySymbol[t.symbol]={...(state.marketsBySymbol[t.symbol]||{}),...t,eventTime:t.eventTime||Date.now(),receivedAt:num(t.receivedAt,Date.now()),dataSource:t.dataSource||'market'}; recordContinuousTicker(state.marketsBySymbol[t.symbol]); }
  function patchVisibleMarketCards(){
    const grid=$('marketGrid'); if(!grid)return;
    const cards=grid.querySelectorAll('[data-symbol]');
    cards.forEach(card=>{
      const s=card.dataset.symbol, x=state.marketsBySymbol?.[s]; if(!x)return;
      const price=card.querySelector('.asset-price'); if(price)price.textContent=fmt(x.last);
      const delta=card.querySelector('.asset-top span'); if(delta){delta.textContent=pct(x.priceChangePercent);delta.className=x.priceChangePercent>=0?'gain':'loss';}
      const vol=card.querySelector('.asset-meta span'); if(vol)vol.textContent=`${t('volume')}: ${fmt(x.quoteVolume)}`;
    });
  }
  function rebuildMarketsFromWS(force=false){
    const now=Date.now();
    // Keep ticker values instant without re-sorting/rebuilding thousands of objects every 350ms.
    if(now-state.lastMarketDomPaint<1200 && !force){ patchVisibleMarketCards(); return; }
    const arr=Object.values(state.marketsBySymbol).filter(x=>x?.symbol&&x.last>0&&x.quoteAsset==='USDT'&&x.quoteVolume>=0);
    arr.sort((a,b)=>b.quoteVolume-a.quoteVolume); state.markets=arr;
    if(arr.length){
      state.multiRadar.lastUpdated=now;
      markLiveData('live_ws',`${t('liveWs')} · ${arr.length.toLocaleString('en-US')} symbols`);
      if(now-state.ws.lastPersist>30000){state.ws.lastPersist=now;saveLiveSnapshot();}
      renderMarkets(); state.lastMarketDomPaint=now;
      if(state.deepRows.length){
        state.deepRows=state.deepRows.map(x=>{const z=state.marketsBySymbol[x.symbol];return z?{...x,price:z.last,priceChangePercent:z.priceChangePercent,quoteVolume:z.quoteVolume,eventTime:z.eventTime||now}:x});
        updatePaperFromMarkets(state.markets);
        if(force || now-num(state.lastDeepMetricsPaintAt,0)>=2500){
          state.lastDeepMetricsPaintAt=now;
          renderRadarMetrics(state.markets.length,state.deepRows);
        }
      }
    }
  }
  function scheduleTickerPaint(force=false){
    clearTimeout(state.ws.paintTimer); state.ws.paintTimer=setTimeout(()=>{state.ws.paintTimer=null;rebuildMarketsFromWS(force);},force?0:280); }
  function consumeTickerPayload(payload){
    const list=Array.isArray(payload)?payload:[payload];
    let touchedSelected=false;
    for(const x of list){
      if(!x||typeof x!=='object')continue;
      const d=x.data&&x.stream?x.data:x;
      if(!d?.s)continue;
      const tk=normalizeBinanceTicker(d);
      mergeTicker(tk);
      if(state.currentSymbol===tk.symbol&&state.selected?.symbol===tk.symbol&&tk.last>0){
        state.selected={...state.selected,price:tk.last,priceChangePercent:tk.priceChangePercent,quoteVolume:tk.quoteVolume,bidPrice:tk.bidPrice,askPrice:tk.askPrice,bidQty:tk.bidQty,askQty:tk.askQty,eventTime:tk.eventTime||Date.now(),liveAt:tk.eventTime||Date.now()};
        if(state.selected.last)state.selected.last.c=tk.last;
        renderActiveAssetHeader(tk.symbol,'global-live');
        renderStructurePanel(state.structure||null);
        scheduleSelectedLivePaint(220);
        touchedSelected=true;
      }
    }
    if(touchedSelected)scheduleBriefingRefresh(450);
    if(list.length)scheduleTickerPaint();
  }
  function wsUrl(stream){return `${stream.base}?streams=${encodeURIComponent(stream.name)}`;}
  function openTickerWS(attempt=0){
    if(state.ws.ticker&&state.ws.ticker.readyState===1&&attempt===0)return;
    if(state.ws.ticker){try{state.ws.ticker.close(1000,'reconnect')}catch{}}
    const baseIndex=Math.min(attempt, BINANCE_WS_BASES.length-1); const bases=[BINANCE_WS_BASES[baseIndex],...BINANCE_WS_BASES.filter((_,i)=>i!==baseIndex)];
    const streamName='!ticker@arr';
    let i=0;
    const connectNext=()=>{ if(i>=bases.length){ scheduleTickerReconnect(); return; } const base=bases[i++]; let ws; try{ws=new WebSocket(`${base}?streams=${encodeURIComponent(streamName)}`);}catch{connectNext();return;} state.ws.ticker=ws;
      ws.onopen=()=>{state.ws.attempt=0;state.ws.lastMessage=Date.now();markLiveData('live_ws',t('liveSource'));appHealthy();};
      ws.onmessage=e=>{state.ws.lastMessage=Date.now();try{consumeTickerPayload(JSON.parse(e.data));}catch{}};
      ws.onerror=()=>{};
      ws.onclose=()=>{if(state.ws.ticker===ws){state.ws.ticker=null;scheduleTickerReconnect();}};
    };
    connectNext();
  }
  function scheduleTickerReconnect(){clearTimeout(state.ws.reconnectTimer); const delay=Math.min(60000,Math.max(2500,Math.pow(2,state.ws.attempt||1)*1000));state.ws.attempt=Math.min((state.ws.attempt||0)+1,6);markLiveData('offline',t('wsReconnect'));state.ws.reconnectTimer=setTimeout(()=>openTickerWS(state.ws.attempt),delay);}
  function startWSStaleMonitor(){clearInterval(state.ws.staleTimer);state.ws.staleTimer=setInterval(()=>{if(!state.ws.lastMessage)return;const age=Date.now()-state.ws.lastMessage;if(age>15000){markLiveData(state.markets.length?'cached':'offline',`${t('dataAge')}: ${formatDataAge(state.ws.lastMessage)}`);if(state.ws.ticker&&state.ws.ticker.readyState===1)try{state.ws.ticker.close();}catch{}}},5000);}
  function selectedWsUrl(symbol,tf,base){const streams=[`${symbol.toLowerCase()}@ticker`,`${symbol.toLowerCase()}@kline_${tf}`,`${symbol.toLowerCase()}@depth20@100ms`,`${symbol.toLowerCase()}@aggTrade`].join('/');return `${base}?streams=${encodeURIComponent(streams)}`;}
  function closeSelectedWS(){if(state.ws.symbol){try{state.ws.symbol.close(1000,'replace')}catch{}state.ws.symbol=null;}}
  function connectSelectedWS(symbol,tf){
    closeSelectedWS(); state.selectedStream={symbol,tf}; const streamBases=[...BINANCE_WS_BASES]; let idx=0; const connect=()=>{if(idx>=streamBases.length)return;const base=streamBases[idx++];let ws;try{ws=new WebSocket(selectedWsUrl(symbol,tf,base));}catch{connect();return;}state.ws.symbol=ws;
      ws.onopen=()=>{appHealthy();};
      ws.onmessage=e=>{try{const msg=JSON.parse(e.data),d=msg.data&&msg.stream?msg.data:msg;if(d?.e==='24hrTicker')handleSelectedTicker(normalizeBinanceTicker(d)); else if(d?.e==='kline')handleSelectedKline(d.k); else if(d?.e==='depthUpdate')handleSelectedDepth(d); else if(d?.e==='aggTrade')handleSelectedTrade(d);}catch{}};
      ws.onerror=()=>{}; ws.onclose=()=>{if(state.ws.symbol===ws){state.ws.symbol=null;if(state.selectedStream?.symbol===symbol){setTimeout(()=>connect(),3500);}}};
    }; connect();
  }
  function handleSelectedTicker(tk){mergeTicker(tk);if(state.selected&&state.selected.symbol===tk.symbol){state.selected.price=tk.last;state.selected.last.c=tk.last;state.selected.priceChangePercent=tk.priceChangePercent;state.selected.quoteVolume=tk.quoteVolume;state.selected.bidPrice=tk.bidPrice;state.selected.askPrice=tk.askPrice;state.selected.bidQty=tk.bidQty;state.selected.askQty=tk.askQty;state.selected.eventTime=tk.eventTime||Date.now();state.selected.liveAt=tk.eventTime||Date.now();updatePaperFromMarkets(state.markets);scheduleSelectedLivePaint(160);}}
  function handleSelectedKline(k){const s=state.selectedStream?.symbol||String(k.s||'').toUpperCase();const tf=k.i||state.selectedStream?.tf||'5m';if(tf==='1m')updateLiveMinuteKline(k);const row={t:num(k.t),o:num(k.o),h:num(k.h),l:num(k.l),c:num(k.c),v:num(k.v),q:num(k.q),trades:num(k.n),tb:num(k.V),closed:!!k.x};state.klinesCache[s]=state.klinesCache[s]||{};state.klinesCache[s][tf]=state.klinesCache[s][tf]||[];const arr=state.klinesCache[s][tf];const idx=arr.findIndex(x=>x.t===row.t);if(idx>=0)arr[idx]=row;else arr.push(row);state.klinesCache[s][tf]=arr.slice(-250);if(state.selected&&state.selected.symbol===s&&state.selected.timeframe===tf){scheduleSelectedLiveRecompute(650);}}
  function handleSelectedDepth(d){if(!state.selected)return;const bids=d.bids||d.b||[],asks=d.asks||d.a||[];if(!bids.length&&!asks.length)return;state.selected.liveDepth={bids,asks,lastUpdateId:num(d.lastUpdateId||d.u),eventTime:num(d.E)||Date.now()};const trades=state.streamTrades[state.selected.symbol]||[];if(trades.length){state.selected.flow=flowFromData(state.selected.liveDepth,trades);state.selected.flowWhales=state.selected.flow.whales;}scheduleSelectedLiveRecompute(650);}
  function handleSelectedTrade(d){const s=String(d.s||state.selected?.symbol||'').toUpperCase();const tr={id:num(d.a),price:num(d.p),amount:num(d.q),buy:!d.m,t:num(d.T)};const arr=state.streamTrades[s]=state.streamTrades[s]||[];if(tr.id && arr.some(x=>x.id===tr.id))return;arr.push(tr);state.streamTrades[s]=arr.slice(-300);if(state.selected&&state.selected.symbol===s){state.selected.flow=flowFromData(state.selected.liveDepth||{bids:[],asks:[]},state.streamTrades[s]);state.selected.flowWhales=state.selected.flow.whales;scheduleSelectedLiveRecompute(650);}}
  function scheduleSelectedLivePaint(delay=250){
    clearTimeout(state.selectedPaintTimer);
    state.selectedPaintTimer=setTimeout(()=>{state.selectedPaintTimer=null;if(state.selected)renderSelectedLive();},Math.max(80,delay));
  }
  function scheduleSelectedLiveRecompute(delay=650){
    state.selectedLiveRecomputePending=true;
    if(state.selectedLiveRecomputeTimer)return;
    state.selectedLiveRecomputeTimer=setTimeout(()=>{
      state.selectedLiveRecomputeTimer=null;
      if(!state.selectedLiveRecomputePending)return;
      state.selectedLiveRecomputePending=false;
      recomputeSelectedFromLive();
    },Math.max(180,delay));
  }
  function recomputeSelectedFromLive(){
    if(!state.selected)return;
    const s=state.selected.symbol,tf=state.selected.timeframe;
    const rows=state.klinesCache[s]?.[tf]||state.selected.rows;
    if(!rows?.length)return;
    const f=coreFeatures(rows),structure=detectStructure(rows),flow=state.selected.flow||null,fakeout=detectFakeout(rows,f,flow,structure),deepVisible=$('signal')?.classList.contains('active'),forensic=deepVisible?deepDiveAnalysis(rows,f,flow,structure,fakeout):(state.selected.forensic||null),score=scoreFeatures(f,flow,structure,fakeout,forensic);
    const liveTicker=state.marketsBySymbol?.[s];
    const livePrice=Number(liveTicker?.last)>0?Number(liveTicker.last):(Number(state.selected.price)>0?Number(state.selected.price):f.last.c);
    state.selected={...state.selected,...f,...score,rows,structure,flow,fakeout,forensic,price:livePrice,priceChangePercent:num(liveTicker?.priceChangePercent,state.selected.priceChangePercent||0),quoteVolume:num(liveTicker?.quoteVolume,state.selected.quoteVolume||0),bidPrice:num(liveTicker?.bidPrice,state.selected.bidPrice||0),askPrice:num(liveTicker?.askPrice,state.selected.askPrice||0),bidQty:num(liveTicker?.bidQty,state.selected.bidQty||0),askQty:num(liveTicker?.askQty,state.selected.askQty||0),eventTime:num(liveTicker?.eventTime,Date.now()),liveAt:num(liveTicker?.eventTime,Date.now()),mode:'live_ws'};
    const idx=state.deepRows.findIndex(x=>x.symbol===s);
    if(idx>=0)state.deepRows[idx]={...state.deepRows[idx],...state.selected};
    else state.deepRows=[state.selected,...state.deepRows].slice(0,24);
    state.structure=structure;state.fakeout=fakeout;state.deepDive=forensic;
    renderStructurePanel(structure);
    renderSelectedLive({full:deepVisible});
    if(deepVisible)scheduleBriefingRefresh(500);
  }
  function renderSelectedLive(opts={}){
    if(!state.selected)return;
    const full=opts.full===true;
    if(state.currentSymbol!==state.selected.symbol){state.currentSymbol=state.selected.symbol;writeJSON(KEYS.currentSymbol,state.currentSymbol);}
    renderActiveAssetHeader(state.currentSymbol,'live-selection');
    if(!full)return;
    state.structure=state.selected.structure||((state.selected.rows?.length>=8)?detectStructure(state.selected.rows):state.structure);
    renderStructurePanel(state.structure||null);
    const out=$('analysisOutput');
    if(out&&$('signal')?.classList.contains('active')){out.innerHTML=analysisHTML(state.selected);drawChart(state.selected.rows);wireAnalysisActions(state.selected);}
    if($('subcontent')?.dataset.kind==='deepdive')renderSub('deepdive');
    if($('subcontent')?.dataset.kind==='trap')renderSub('trap');
    if($('subcontent')?.dataset.kind==='structure')renderSub('structure');
    if($('paperOutput'))renderPaper();
    renderRadarTable(state.deepRows);
    scheduleBriefingRefresh(500);
    renderSentiment();
  }
  function wireAnalysisActions(x){const simWrap=$('analysisSim');if(simWrap)renderSimulatorInto('analysisSim',x);const simBtn=$('analysisSimBtn');if(simBtn)simBtn.onclick=()=>{goTab('more');renderSub('simulator');};const paperBtn=$('analysisPaperBtn');if(paperBtn)paperBtn.onclick=()=>openPaperTrade(x);}

  // ---------- Indicators / signal engine ----------
  // ---------- Indicators / signal engine ----------
  function ema(vals,p){ if(!vals.length)return 0; const k=2/(p+1); let e=vals[0]; for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k); return e; }
  function sma(vals,p){ const a=vals.slice(-p); return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
  function stdev(vals){if(!vals.length)return 0;const m=sma(vals,vals.length);return Math.sqrt(vals.reduce((a,v)=>a+(v-m)*(v-m),0)/vals.length);}
  function trueRanges(rows){let out=[];for(let i=1;i<rows.length;i++)out.push(Math.max(rows[i].h-rows[i].l,Math.abs(rows[i].h-rows[i-1].c),Math.abs(rows[i].l-rows[i-1].c)));return out;}
  function atr(rows,p=14){const a=trueRanges(rows).slice(-p);return a.length?sma(a,a.length):0;}
  function rsi(vals,p=14){ if(vals.length<p+1)return 50; let g=0,l=0;for(let i=vals.length-p;i<vals.length;i++){const d=vals[i]-vals[i-1];if(d>=0)g+=d;else l-=d;}const rs=l?g/l:99;return 100-(100/(1+rs)); }
  function obv(rows){let v=0,out=[];for(let i=1;i<rows.length;i++){if(rows[i].c>rows[i-1].c)v+=rows[i].v;else if(rows[i].c<rows[i-1].c)v-=rows[i].v;out.push(v);}return out;}
  function linearSlope(vals){ if(vals.length<2)return 0; const n=vals.length,m=sma(vals,n);let nume=0,den=0;for(let i=0;i<n;i++){const x=i-(n-1)/2;nume+=x*(vals[i]-m);den+=x*x;}return den?nume/den:0; }
  function candlePatterns(rows){
    const a=rows.at(-1)||{}, b=rows.at(-2)||{}; const body=Math.abs(a.c-a.o), range=Math.max(a.h-a.l,1e-12), upper=a.h-Math.max(a.o,a.c), lower=Math.min(a.o,a.c)-a.l;
    const bullishEngulf=b.c<b.o && a.c>a.o && a.o<=b.c && a.c>=b.o;
    const hammer=lower>=body*2 && upper<=body*0.7 && a.c>=a.o;
    const inside=a.h<=b.h && a.l>=b.l;
    const strong=body/range>=.65;
    return {bullishEngulf,hammer,inside,strong};
  }
  function quantile(a,q){const x=[...a].sort((m,n)=>m-n);if(!x.length)return 0;const pos=(x.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(pos-lo);}
  function detectWhales(depth,trades,minNotional=25000){
    const ts=(trades||[]).map(x=>({...x,notional:num(x.price)*num(x.amount)})).filter(x=>x.notional>0);
    const ns=ts.map(x=>x.notional), median=quantile(ns,.5)||0,q90=quantile(ns,.9)||0,q95=quantile(ns,.95)||0;
    const threshold=Math.max(num(minNotional,25000),q90*1.8,median*8);
    const big=ts.filter(x=>x.notional>=threshold).sort((a,b)=>b.notional-a.notional);
    const buys=big.filter(x=>x.buy),sells=big.filter(x=>!x.buy);
    const buyValue=buys.reduce((a,x)=>a+x.notional,0),sellValue=sells.reduce((a,x)=>a+x.notional,0),total=buyValue+sellValue||1;
    const allBuy=ts.filter(x=>x.buy).reduce((a,x)=>a+x.notional,0),allSell=ts.filter(x=>!x.buy).reduce((a,x)=>a+x.notional,0);
    const bidLevels=(depth?.bids||[]).map(x=>num(x[0])*num(x[1])).filter(Boolean),askLevels=(depth?.asks||[]).map(x=>num(x[0])*num(x[1])).filter(Boolean);
    const wallBid=Math.max(0,...bidLevels),wallAsk=Math.max(0,...askLevels);
    const wallBase=Math.max(quantile([...bidLevels,...askLevels],.5)||1,1);
    const whaleBias=(buyValue-sellValue)/total*100;
    const tradePressure=(allBuy-allSell)/(allBuy+allSell||1)*100;
    const wallBias=(wallBid-wallAsk)/(wallBid+wallAsk||1)*100;
    const score=clamp(50+whaleBias*.35+tradePressure*.18+wallBias*.16+Math.min(18,big.length*2.2));
    const direction=score>=62?'BUY_PRESSURE':score<=38?'SELL_PRESSURE':'BALANCED';
    const biggest=big[0]||null;
    return {threshold,bigCount:big.length,bigBuys:buys.length,bigSells:sells.length,buyValue,sellValue,net:buyValue-sellValue,buyPressure:buyValue/total*100,sellPressure:sellValue/total*100,whaleBias,tradePressure,wallBid,wallAsk,wallBidMultiple:wallBid/wallBase,wallAskMultiple:wallAsk/wallBase,score,direction,biggest,top:big.slice(0,12)};
  }
  function flowFromData(depth,trades){
    const bid=(depth.bids||[]).reduce((a,x)=>a+num(x[0])*num(x[1]),0); const ask=(depth.asks||[]).reduce((a,x)=>a+num(x[0])*num(x[1]),0); const denom=bid+ask||1;
    const buys=(trades||[]).filter(x=>x.buy).reduce((a,x)=>a+x.price*x.amount,0); const sells=(trades||[]).filter(x=>!x.buy).reduce((a,x)=>a+x.price*x.amount,0); const tden=buys+sells||1;
    const whales=detectWhales(depth,trades);
    return {bid,ask,imbalance:(bid-ask)/denom*100,buySell:sells?buys/sells:0,cvd:(buys-sells)/tden*100,whales};
  }

  // ---------- Market structure / sentiment / risk calendar ----------
  function detectStructure(rows,left=3,right=3){
    if(!rows||rows.length<left+right+8) return {bias:'NEUTRAL',event:null,highs:[],lows:[],lastHigh:null,lastLow:null,score:50,note:'Not enough swings'};
    const highs=[],lows=[];
    for(let i=left;i<rows.length-right;i++){
      const h=rows[i].h,l=rows[i].l; let isH=true,isL=true;
      for(let j=1;j<=left;j++){isH&&=h>=rows[i-j].h;isL&&=l<=rows[i-j].l;}
      for(let j=1;j<=right;j++){isH&&=h>=rows[i+j].h;isL&&=l<=rows[i+j].l;}
      if(isH) highs.push({i,price:h,t:rows[i].t});
      if(isL) lows.push({i,price:l,t:rows[i].t});
    }
    const h2=highs.slice(-4),l2=lows.slice(-4),last=rows.at(-1),prev=rows.at(-2)||last;
    const hLast=h2.at(-1),hPrev=h2.at(-2),lLast=l2.at(-1),lPrev=l2.at(-2);
    const higherHigh=!!(hLast&&hPrev&&hLast.price>hPrev.price), higherLow=!!(lLast&&lPrev&&lLast.price>lPrev.price);
    const lowerHigh=!!(hLast&&hPrev&&hLast.price<hPrev.price), lowerLow=!!(lLast&&lPrev&&lLast.price<lPrev.price);
    let bias=(higherHigh&&higherLow)?'BULLISH':(lowerHigh&&lowerLow)?'BEARISH':'NEUTRAL';
    let event=null;
    const recentBars=6;
    if(hLast&&last.c>hLast.price&&prev.c<=hLast.price){
      const priorBias=lowerHigh&&lowerLow?'BEARISH':bias==='BULLISH'?'BULLISH':'NEUTRAL';
      event={type:priorBias==='BEARISH'?'CHOCH':'BOS',direction:'BULLISH',price:hLast.price,i:rows.length-1,barsAgo:0};
    } else if(lLast&&last.c<lLast.price&&prev.c>=lLast.price){
      const priorBias=higherHigh&&higherLow?'BULLISH':bias==='BEARISH'?'BEARISH':'NEUTRAL';
      event={type:priorBias==='BULLISH'?'CHOCH':'BOS',direction:'BEARISH',price:lLast.price,i:rows.length-1,barsAgo:0};
    }
    // Look back a few bars for the latest break using closes.
    if(!event){
      for(let b=1;b<=recentBars;b++){
        const idx=rows.length-1-b,bar=rows[idx],after=rows[idx+1];
        if(!bar||!after)continue;
        const hh=highs.filter(x=>x.i<idx).at(-1),ll=lows.filter(x=>x.i<idx).at(-1);
        if(hh&&after.c>hh.price&&bar.c<=hh.price){event={type:(lowerHigh&&lowerLow)?'CHOCH':'BOS',direction:'BULLISH',price:hh.price,i:idx+1,barsAgo:b};break;}
        if(ll&&after.c<ll.price&&bar.c>=ll.price){event={type:(higherHigh&&higherLow)?'CHOCH':'BOS',direction:'BEARISH',price:ll.price,i:idx+1,barsAgo:b};break;}
      }
    }
    const score=bias==='BULLISH'?72:bias==='BEARISH'?28:50;
    const note=event?(event.direction==='BULLISH'?`${event.type} bullish at ${fmt(event.price)}`:`${event.type} bearish at ${fmt(event.price)}`):bias==='BULLISH'?'Higher highs + higher lows':bias==='BEARISH'?'Lower highs + lower lows':'Mixed swing structure';
    return {bias,event,highs:h2,lows:l2,lastHigh:hLast?.price||null,lastLow:lLast?.price||null,score,note};
  }
  function detectFakeout(rows,f=null,flow=null,structure=null){
    if(!rows?.length) return {score:50,level:'MEDIUM',direction:'NONE',type:'NONE',reasons:[],evidence:[],action:'WAIT'};
    const last=rows.at(-1), prev=rows.at(-2)||last, look=rows.slice(-26,-1); const hi=Math.max(...look.map(x=>x.h)), lo=Math.min(...look.map(x=>x.l));
    const range=Math.max(last.h-last.l,1e-12), body=Math.abs(last.c-last.o), closePos=(last.c-last.l)/range;
    const upperWick=(last.h-Math.max(last.o,last.c))/range, lowerWick=(Math.min(last.o,last.c)-last.l)/range;
    const vr=f?.volumeRatio||1, upSweep=last.h>hi && last.c<hi, downSweep=last.l<lo && last.c>lo;
    let score=18,reasons=[],evidence=[],direction='NONE',type='NONE';
    const add=(r,e)=>{reasons.push(r);evidence.push(e||r)};
    if(upSweep){score+=42;direction='BEARISH';type='BULL_TRAP';add(t('fakeBreakout'),'السعر تجاوز قمة مرجعية ثم أغلق دونها');}
    if(downSweep){score+=42;direction='BULLISH';type='BEAR_TRAP';add(t('fakeBreakout'),'السعر كسر قاعاً مرجعياً ثم أغلق فوقه');}
    if(upSweep&&upperWick>.28){score+=14;add(t('rejection'),'ذيل علوي واضح بعد السحب');}
    if(downSweep&&lowerWick>.28){score+=14;add(t('rejection'),'ذيل سفلي واضح بعد السحب');}
    if((upSweep&&!f)||(upSweep&&vr<1.15)){score+=10;add(t('weakVolume'),'لا يوجد تأكيد حجم كافٍ للكسر');}
    if(downSweep&&vr<1.15){score+=10;add(t('weakVolume'),'لا يوجد تأكيد حجم كافٍ للكسر');}
    if(f?.breakout>=0 && last.c<last.o && closePos<.42){score+=12;direction=direction==='NONE'?'BEARISH':direction;type=type==='NONE'?'BULL_TRAP':type;add(t('weakVolume'),'إغلاق ضعيف قرب قاع الشمعة بعد الاقتراب من القمة');}
    if(f?.breakout<-.05 && last.c>last.o && closePos>.58){score+=10;direction=direction==='NONE'?'BULLISH':direction;type=type==='NONE'?'BEAR_TRAP':type;add(t('rejection'),'رفض سعري عند القيعان');}
    if(flow){
      if(direction==='BEARISH'&&flow.cvd>5) {score+=9;add(t('flowConflict'),'السعر ضعيف بينما CVD يميل للشراء');}
      if(direction==='BULLISH'&&flow.cvd<-5) {score+=9;add(t('flowConflict'),'السعر يرتد بينما CVD يميل للبيع');}
      if(direction==='BEARISH'&&flow.imbalance>8){score+=7;add(t('flowConflict'),'دفتر الأوامر ما زال داعماً للشراء');}
      if(direction==='BULLISH'&&flow.imbalance<-8){score+=7;add(t('flowConflict'),'دفتر الأوامر ما زال ضاغطاً بالبيع');}
    }
    if(structure?.event){
      if(direction==='BEARISH'&&structure.event.direction==='BULLISH'){score+=8;add(t('structureConflict'),'الكسر السعري الجديد يناقض الهيكل الصاعد');}
      if(direction==='BULLISH'&&structure.event.direction==='BEARISH'){score+=8;add(t('structureConflict'),'الارتداد يناقض الهيكل الهابط');}
    }
    if(upSweep||downSweep){
      const next=rows.at(-1),pclose=prev.c;
      const failedRetest=(direction==='BEARISH'&&next.c>hi*1.001)||(direction==='BULLISH'&&next.c<lo*.999);
      if(failedRetest){score+=8;add(t('retestRisk'),'إعادة الاختبار لم تثبت بعد');}
    }
    score=clamp(score);
    const level=score>=72?'HIGH':score>=48?'MEDIUM':'LOW';
    const verdict=level==='HIGH'?'TRAP':level==='MEDIUM'?'CAUTION':'CLEAR';
    if(type==='NONE'&&level==='LOW')reasons.push(t('confirmedBreakout'));
    return {score,level,direction,type,reasons,evidence,verdict,action:level==='HIGH'?'WAIT FOR CONFIRMATION':level==='MEDIUM'?'REQUIRE CLOSE + VOLUME':'NORMAL MONITORING',price:last.c,hi,lo};
  }


  function pctSafe(x){ const v=num(x,0); return `${v>=0?'+':''}${v.toFixed(2)}%`; }
  function candleRead(rows,f){
    const a=rows.at(-1)||{}, range=Math.max(a.h-a.l,1e-12), body=Math.abs(a.c-a.o), closePos=(a.c-a.l)/range;
    const upper=(a.h-Math.max(a.o,a.c))/range, lower=(Math.min(a.o,a.c)-a.l)/range;
    let label = a.c>=a.o ? 'Bullish candle' : 'Bearish candle';
    let ar = a.c>=a.o ? 'شمعة صاعدة' : 'شمعة هابطة';
    if(f.patterns?.bullishEngulf){ label='Bullish engulfing'; ar='ابتلاع شرائي صاعد'; }
    else if(f.patterns?.hammer){ label='Hammer / rejection'; ar='Hammer / رفض سعري'; }
    else if(f.patterns?.inside){ label='Inside bar'; ar='Inside bar / انكماش'; }
    const close = closePos>.76 ? 'Strong close near high' : closePos<.28 ? 'Weak close near low' : 'Mid-range close';
    const closeAr = closePos>.76 ? 'إغلاق قوي قرب القمة' : closePos<.28 ? 'إغلاق ضعيف قرب القاع' : 'إغلاق داخل منتصف النطاق';
    const wick = upper>.28 ? 'Upper-wick rejection' : lower>.28 ? 'Lower-wick rejection' : 'Balanced wick';
    const wickAr = upper>.28 ? 'رفض بذيل علوي' : lower>.28 ? 'رفض بذيل سفلي' : 'الذيول متوازنة';
    const strength = body/range>=.68 ? 'Expansion body' : body/range<=.25 ? 'Compression body' : 'Normal body';
    const strengthAr = body/range>=.68 ? 'جسم توسعي قوي' : body/range<=.25 ? 'جسم منكمش' : 'جسم طبيعي';
    return {label,ar,close,closeAr,wick,wickAr,strength,strengthAr,closePos,upper,lower,bodyRatio:body/range};
  }
  function inferOrderBlock(rows, flow, structure, f){
    const look=rows.slice(-55); if(look.length<8) return {type:'NEUTRAL',low:f.lo,high:f.hi,level:f.last.c,confidence:35,basis:'fallback'};
    const vols=look.map(x=>x.v), med=quantile(vols,.5)||1, q80=quantile(vols,.8)||med;
    const avgR=sma(look.map(x=>x.h-x.l),Math.min(20,look.length))||1;
    const bullContext=(structure?.bias==='BULLISH'||structure?.event?.direction==='BULLISH'||flow?.cvd>4);
    const bearContext=(structure?.bias==='BEARISH'||structure?.event?.direction==='BEARISH'||flow?.cvd<-4);
    const candidates=[];
    for(let i=1;i<look.length-1;i++){
      const c=look[i],n=look[i+1],range=Math.max(c.h-c.l,1e-12);
      const expansion=(n.h-n.l)>avgR*1.25 && Math.abs(n.c-n.o)/Math.max(n.h-n.l,1e-12)>.45;
      const vBoost=c.v/med, nBoost=n.v/med;
      if(!expansion || Math.max(vBoost,nBoost)<1.35) continue;
      if(n.c>n.o && c.c<c.o) candidates.push({type:'DEMAND',low:c.l,high:c.h,level:(c.o+c.c)/2,score:45+Math.min(22,vBoost*7)+Math.min(18,nBoost*5)+(bullContext?10:0),i:i});
      if(n.c<n.o && c.c>c.o) candidates.push({type:'SUPPLY',low:c.l,high:c.h,level:(c.o+c.c)/2,score:45+Math.min(22,vBoost*7)+Math.min(18,nBoost*5)+(bearContext?10:0),i:i});
    }
    if(!candidates.length){
      const top=look.map((c,i)=>({c,i,score:(c.v/med)*12+Math.abs(c.c-c.o)/Math.max(c.h-c.l,1e-12)*8})).sort((a,b)=>b.score-a.score)[0];
      const c=top.c, type=c.c>=c.o?'DEMAND':'SUPPLY';
      return {type,low:c.l,high:c.h,level:(c.o+c.c)/2,confidence:Math.round(clamp(42+Math.min(35,c.v/q80*12)+(bullContext||bearContext?8:0),35,82)),basis:'high-volume candle cluster',sourceIndex:top.i};
    }
    candidates.sort((a,b)=>(b.score + b.i*.35)-(a.score + a.i*.35));
    const best=candidates[0];
    const touches=look.filter((c,idx)=>idx!==best.i&&c.l<=best.high*1.002&&c.h>=best.low*.998).length;
    const confidence=clamp(best.score+Math.min(12,touches*2.5),35,96);
    return {...best,confidence:Math.round(confidence),basis:'volume expansion + opposite candle + follow-through',touches};
  }
  function estimateWhaleEntry(flow, block, f){
    const whales=flow?.whales; const top=whales?.top||[];
    const side=whales?.direction==='SELL_PRESSURE'?'SELL':'BUY';
    const selected=top.filter(x=> side==='BUY'?x.buy:!x.buy);
    if(selected.length){
      const v=selected.reduce((a,x)=>a+x.notional,0)||1;
      const p=selected.reduce((a,x)=>a+(x.price*x.notional),0)/v;
      return {price:p,method:side==='BUY'?'large-buy weighted price':'large-sell weighted price',count:selected.length,confidence:Math.round(clamp(48+selected.length*6+(whales.score>68?14:whales.score<32?8:4),40,94))};
    }
    return {price:block?.level||f.last.c,method:'order-block midpoint',count:0,confidence:Math.round(clamp(block?.confidence||42,30,82))};
  }
  function deepDiveAnalysis(rows,f,flow,structure,fakeout=null){
    if(!rows?.length) return {score:0,confidence:0,verdict:'NO_DATA',verdictAr:'لا بيانات'};
    const candle=candleRead(rows,f);
    const block=inferOrderBlock(rows,flow,structure,f);
    const whale=estimateWhaleEntry(flow,block,f);
    const resistance=Math.max(...rows.slice(-21,-1).map(x=>x.h));
    const support=Math.min(...rows.slice(-21,-1).map(x=>x.l));
    const breakoutPct=f.last.c?((f.last.c/resistance)-1)*100:0;
    const acceptance=f.last.c>resistance && candle.closePos>.62 && f.volumeRatio>=1.35;
    const failed=f.last.h>resistance && f.last.c<resistance && candle.upper>.23;
    const pressure=Math.abs(breakoutPct)<.65 && f.last.c>resistance*.985;
    const breakoutStatus=failed?'FAILED':acceptance?'CONFIRMED':pressure?'PRESSURE':'NONE';
    const demandQuality=block.type==='DEMAND'?block.confidence:100-block.confidence*.35;
    const flowScore=clamp(50+(flow?.cvd||0)*1.2+(flow?.imbalance||0)*.35+((flow?.whales?.score==null?0:flow.whales.score-50))*.35);
    const volumeScore=clamp(35+Math.min(45,(f.volumeRatio||1)*16)+(f.compression>30?8:0));
    const structureScore=structure?.event?.direction==='BULLISH'?88:structure?.event?.direction==='BEARISH'?20:structure?.bias==='BULLISH'?72:structure?.bias==='BEARISH'?28:50;
    const momentumScore=clamp(50+f.ret5*6+f.ret15*2.5+f.momentum*80);
    const candleScore=clamp(50+candle.bodyRatio*28+(candle.closePos-.5)*30-(candle.upper*.7*30));
    const breakoutScore=breakoutStatus==='CONFIRMED'?90:breakoutStatus==='PRESSURE'?68:breakoutStatus==='FAILED'?24:50;
    const trapPenalty=fakeout?.level==='HIGH'?28:fakeout?.level==='MEDIUM'?14:0;
    const components=[
      {key:'volume',score:volumeScore,ar:'الحجم',en:'Volume',why:f.volumeRatio>=1.8?`Spike ${f.volumeRatio.toFixed(2)}x average`:`${f.volumeRatio.toFixed(2)}x average volume`},
      {key:'flow',score:flowScore,ar:'التدفق',en:'Flow',why:`CVD ${pctSafe(flow?.cvd||0)} · Imbalance ${pctSafe(flow?.imbalance||0)}`},
      {key:'structure',score:structureScore,ar:'الهيكلة',en:'Structure',why:structure?.event?`${structure.event.type} ${structure.event.direction}`:structure?.bias||'NEUTRAL'},
      {key:'momentum',score:momentumScore,ar:'الزخم',en:'Momentum',why:`5m ${pctSafe(f.ret5)} · 15m ${pctSafe(f.ret15)}`},
      {key:'candles',score:candleScore,ar:'الشموع',en:'Candles',why:`${candle.label} · ${(candle.closePos*100).toFixed(0)}% close position`},
      {key:'breakout',score:breakoutScore,ar:'الاختراق',en:'Breakout',why:breakoutStatus}
    ];
    const weighted=components.reduce((a,x)=>a+x.score,0)/components.length;
    const score=clamp(weighted-trapPenalty*.45 + (block.type!=='NEUTRAL'?6:0));
    const coverage=clamp(52 + components.filter(x=>x.score>=55).length*7 + (flow?12:0) + (structure?10:0) + Math.min(8,whale.count*2),0,100);
    let verdict='MONITOR', verdictAr='مراقبة فقط', direction='NEUTRAL';
    if(score>=76 && structureScore>=62 && flowScore>=58 && trapPenalty<20){verdict='CONDITIONAL_BULL';verdictAr='سيناريو صاعد مشروط';direction='BULLISH';}
    else if(score>=62 && breakoutStatus!=='FAILED' && trapPenalty<28){verdict='WATCH';verdictAr='مراقبة مشروطة';direction='BULLISH';}
    else if(score<40 || breakoutStatus==='FAILED' || trapPenalty>=28){verdict='AVOID';verdictAr='تجنّب حتى تتغير الأدلة';direction='BEARISH';}
    const ref=Math.max(whale.price,block.level||f.last.c);
    const riskBase=Math.max(f.atr,f.last.c*.006);
    let entry = direction==='BULLISH' ? (breakoutStatus==='CONFIRMED'?Math.max(f.last.c,resistance*1.001):Math.max(block.low,ref*0.997)) : f.last.c;
    const entryLow=direction==='BULLISH'?Math.max(block.low,entry-riskBase*.35):Math.max(0,entry-riskBase*.35);
    const entryHigh=direction==='BULLISH'?Math.min(Math.max(block.high,entry+riskBase*.25),entry+riskBase*.35):entry+riskBase*.25;
    const sl=direction==='BULLISH'?Math.max(1e-12,Math.min(block.low,entry-riskBase*.8)):Math.max(1e-12,entry+riskBase);
    const dist=Math.max(Math.abs(entry-sl),1e-12);
    const tp1=direction==='BULLISH'?entry+dist*1.25:entry-dist*1.25;
    const tp2=direction==='BULLISH'?entry+dist*2:entry-dist*2;
    const tp3=direction==='BULLISH'?entry+dist*2.75:entry-dist*2.75;
    const rr2=Math.abs(tp2-entry)/dist;
    const rr3=Math.abs(tp3-entry)/dist;
    const invalidation=direction==='BULLISH'?`Close below ${fmt(block.low)} + flow deterioration`: `Close above ${fmt(block.high)} + buy-side reclaim`;
    const liquidityDriver = flow?.whales?.direction==='BUY_PRESSURE' ? 'Large buy flow + bid support': flow?.whales?.direction==='SELL_PRESSURE' ? 'Large sell flow + ask pressure' : 'Mixed large-flow pressure';
    const whyLiquidityAr = flow?.whales?.direction==='BUY_PRESSURE' ? 'تدفق شراء كبير مع دعم من جانب الطلب': flow?.whales?.direction==='SELL_PRESSURE' ? 'تدفق بيع كبير مع ضغط من جانب العرض':'تدفق الكبار مختلط';
    const whyBreakout = breakoutStatus==='CONFIRMED' ? 'Price accepted above the reference high with stronger volume and a strong close.' : breakoutStatus==='PRESSURE' ? 'Price is compressing near resistance; expansion needs a decisive close and volume.' : breakoutStatus==='FAILED' ? 'Price swept the high but failed to hold it, increasing trap risk.' : 'No clean breakout yet; the setup relies on compression and flow alignment.';
    const whyBreakoutAr = breakoutStatus==='CONFIRMED' ? 'السعر قبل أعلى المقاومة مع حجم أقوى وإغلاق متماسك.' : breakoutStatus==='PRESSURE' ? 'السعر يضغط قرب المقاومة؛ يحتاج إغلاقاً حاسماً وحجماً أعلى.' : breakoutStatus==='FAILED' ? 'تم سحب القمة ثم فشل السعر في تثبيتها، ما يرفع خطر الفخ.' : 'لا يوجد اختراق نظيف بعد؛ الفكرة تعتمد على الانكماش وتوافق التدفق.';
    return {score:Math.round(score),confidence:Math.round(coverage),verdict,verdictAr,direction,components,candle,block,whale,resistance,support,breakoutPct,breakoutStatus,acceptance,failed,pressure,flowScore,volumeScore,structureScore,momentumScore,candleScore,breakoutScore,trapPenalty,liquidityDriver,whyLiquidityAr,whyBreakout,whyBreakoutAr,entry,entryLow,entryHigh,sl,tp1,tp2,tp3,rr2,rr3,invalidation,liquidityPool:{low:block.low,high:block.high,level:block.level,type:block.type,confidence:block.confidence},estimatedWhaleEntry:whale.price};
  }
  function deepDiveHTML(x){
    const d=x?.forensic||deepDiveAnalysis(x.rows,x,x.flow,x.structure,x.fakeout); state.deepDive=d;
    const cls=d.score>=75?'good':d.score>=52?'mid':'low';
    const verdict=state.lang==='ar'?d.verdictAr:({CONDITIONAL_BULL:'Conditional bullish scenario',WATCH:'Watch with confirmation',AVOID:'Avoid until evidence changes',MONITOR:'Monitor only'})[d.verdict]||d.verdict;
    const typeText=d.block.type==='DEMAND'?t('orderBlockDemand'):d.block.type==='SUPPLY'?t('orderBlockSupply'):t('orderBlockNeutral');
    const whalePrice=d.estimatedWhaleEntry||d.block.level;
    return `<div class="forensic-hero"><div class="forensic-score-box"><div class="eyebrow">RADARX FORENSIC ENGINE</div><div class="forensic-score ${cls}">${d.score}/100</div><div class="small muted">${t('forensicScore')} · ${t('forensicConfidence')}: ${d.confidence}%</div><span class="forensic-verdict ${d.direction==='BULLISH'?'bull':d.direction==='BEARISH'?'bear':'neutral'}">${esc(verdict)}</span><div class="reason-grid" style="margin-top:10px"><span class="reason">${esc(t('liquidityDriver'))}: ${esc(d.liquidityDriver)}</span><span class="reason">${esc(t('volumeDriver'))}: ${fmt(x.volumeRatio,2)}x</span><span class="reason">${esc(t('structureDriver'))}: ${esc(x.structure?.event?.type||x.structure?.bias||'NEUTRAL')}</span></div></div><div class="forensic-score-box"><div class="eyebrow">LIQUIDITY MAP</div><div class="zone-label">${esc(t('estimatedWhaleEntry'))}</div><div class="zone-price">${fmt(whalePrice)}</div><div class="zone-sub">${esc(d.whale.method)} · ${d.whale.count} large-flow prints</div><div class="zone-label" style="margin-top:12px">${esc(t('zoneConfidence'))}</div><div class="kpi-value" style="font-size:20px">${d.block.confidence}%</div><div class="zone-sub">${esc(typeText)} · ${esc(t('zoneRange'))}: ${fmt(d.block.low)} — ${fmt(d.block.high)}</div></div></div>${smcDetailsHTML(x,d)}${multiTpHTML({...x,...d})}<div class="forensic-section"><div class="forensic-title"><div><h3>${t('deepDiveLiquidity')}</h3><div class="small muted">${esc(state.lang==='ar'?d.whyLiquidityAr:d.liquidityDriver)}</div></div><span class="gateway-pill">${esc(typeText)}</span></div><div class="zone-box"><div class="zone-panel ${d.block.type==='DEMAND'?'demand':d.block.type==='SUPPLY'?'supply':'neutral'}"><div class="zone-label">${esc(t('deepDiveLiquidityZone'))}</div><div class="zone-price">${fmt(d.block.low)} — ${fmt(d.block.high)}</div><div class="zone-sub">${esc(t('estimatedWhaleEntry'))}: ${fmt(whalePrice)} · confidence ${d.block.confidence}%</div></div><div class="zone-panel"><div class="zone-label">${esc(state.lang==='ar'?'المقاومة المرجعية':'Reference resistance')}</div><div class="zone-price">${fmt(d.resistance)}</div><div class="zone-sub">${state.lang==='ar'?'الدعم المرجعي':'Reference support'}: ${fmt(d.support)} · Breakout: ${pctSafe(d.breakoutPct)}</div></div></div><div class="forensic-footnote">${t('exactEntryCaveat')} ${t('modelLimit')}</div></div><div class="forensic-section"><div class="forensic-title"><div><h3>${t('deepDiveEvidence')}</h3><div class="small muted">${t('evidenceCoverage')}: ${d.confidence}%</div></div><span class="gateway-pill">${d.components.filter(a=>a.score>=55).length}/${d.components.length} aligned</span></div><div class="evidence-list">${d.components.map(c=>`<div class="evidence-row"><span>${esc(state.lang==='ar'?c.ar:c.en)}</span><b>${esc(c.why)}</b><span class="evidence-score ${c.score>=70?'gain':c.score<42?'loss':''}">${Math.round(c.score)}/100</span></div>`).join('')}</div></div><div class="forensic-section"><div class="forensic-title"><div><h3>${t('whyBreakout')}</h3><div class="small muted">${esc(state.lang==='ar'?d.whyBreakoutAr:d.whyBreakout)}</div></div><span class="briefing-chip ${d.breakoutStatus==='CONFIRMED'?'green':d.breakoutStatus==='FAILED'?'red':'yellow'}">${d.breakoutStatus==='CONFIRMED'?t('breakoutConfirmed'):d.breakoutStatus==='FAILED'?t('breakoutFailed'):d.breakoutStatus==='PRESSURE'?t('breakoutPressure'):t('noBreakout')}</span></div><div class="reason-columns"><div class="reason-panel"><h4>${t('candleEvidence')}</h4><p>${esc(state.lang==='ar'?`${d.candle.ar} · ${d.candle.closeAr} · ${d.candle.wickAr} · ${d.candle.strengthAr}`:`${d.candle.label} · ${d.candle.close} · ${d.candle.wick} · ${d.candle.strength}`)}</p></div><div class="reason-panel"><h4>${t('structureEvidence')}</h4><p>${esc(state.lang==='ar'?(x.structure?.note||'لا يوجد حدث هيكلي جديد'):(x.structure?.event?`${x.structure.event.type} ${x.structure.event.direction} at ${fmt(x.structure.event.price)}`:(x.structure?.bias||'No fresh event')))}</p></div><div class="reason-panel"><h4>${t('moneyFlowEvidence')}</h4><p>${esc(`${state.lang==='ar'?'CVD':'CVD'} ${pctSafe(x.flow?.cvd||0)} · ${state.lang==='ar'?'Imbalance':'Imbalance'} ${pctSafe(x.flow?.imbalance||0)} · ${state.lang==='ar'?'Whale score':'Whale score'} ${Math.round(x.flow?.whales?.score||50)}/100`)}</p></div><div class="reason-panel"><h4>${t('momentumDriver')}</h4><p>${esc(`${state.lang==='ar'?'5m':'5m'} ${pctSafe(x.ret5)} · ${state.lang==='ar'?'15m':'15m'} ${pctSafe(x.ret15)} · RSI ${x.rsi.toFixed(1)}`)}</p></div></div></div><div class="forensic-section"><div class="forensic-title"><div><h3>${t('executionPlan')}</h3><div class="small muted">${esc(state.lang==='ar'?'الخطة كمية ومشروطة بالأدلة وليست أمراً حقيقياً.':'Quantitative and conditional plan; not a real order.')}</div></div><span class="gateway-pill">RR ${d.rr3.toFixed(2)}x</span></div><div class="paper-notice" style="margin-top:10px"><b>${t('riskReward')}: TP3 ${d.rr3.toFixed(2)}x</b> · <b>${t('invalidation')}:</b> ${esc(d.invalidation)}</div></div>`;
  }

  function sentimentLabel(score){return score<20?'EXTREME_FEAR':score<40?'FEAR':score<=60?'NEUTRAL':score<80?'GREED':'EXTREME_GREED';}
  function sentimentText(label){return label==='EXTREME_FEAR'?(state.lang==='ar'?'خوف شديد':'Extreme fear'):label==='FEAR'?(state.lang==='ar'?'خوف':'Fear'):label==='GREED'?(state.lang==='ar'?'طمع':'Greed'):label==='EXTREME_GREED'?(state.lang==='ar'?'طمع شديد':'Extreme greed'):(state.lang==='ar'?'محايد':'Neutral');}
  async function fetchFearGreed(){return fetchJSON('https://api.alternative.me/fng/?limit=1',{timeout:4500,retries:0});}
  function computeSentimentFromMarkets(markets,fgValue=null){
    const arr=(markets||[]).filter(x=>Number.isFinite(x.priceChangePercent));
    const breadth=arr.length?arr.filter(x=>x.priceChangePercent>0).length/arr.length*100:50;
    const btc=arr.find(x=>x.baseAsset==='BTC')||arr.find(x=>x.symbol==='BTCUSDT');
    const btcScore=btc?clamp(50+btc.priceChangePercent*7,5,95):50;
    const breadthScore=clamp(breadth,5,95);
    const raw=fgValue!=null?clamp(num(fgValue),0,100):clamp(breadthScore*.65+btcScore*.35,0,100);
    const score=fgValue!=null?clamp(raw*.55+breadthScore*.3+btcScore*.15,0,100):raw;
    return {score,breadth,bthPrice:btcScore,label:sentimentLabel(score),fg:fgValue,source:fgValue!=null?'live+market':'market',updatedAt:Date.now()};
  }
  function renderSentiment(s=state.sentiment){
    if(!$('sentimentScore'))return; if(!s||s.score==null){$('sentimentScore').textContent='—';$('sentimentLabel').textContent=t('waiting');$('sentimentPin').style.left='50%';$('sentimentNeedle').style.transform='translateX(-50%) rotate(0deg)';$('sentimentBTC').textContent='—';$('sentimentBreadth').textContent='—';$('sentimentFG').textContent='—';$('sentimentSource').textContent='WAITING';$('sentimentSourceNote').textContent=t('liveSource');return;} const v=clamp(s.score), label=sentimentText(s.label); $('sentimentScore').textContent=Math.round(v);$('sentimentLabel').textContent=label;$('sentimentPin').style.left=`${v}%`;$('sentimentNeedle').style.transform=`translateX(-50%) rotate(${(v/100)*180-90}deg)`;$('sentimentBTC').textContent=`${Math.round(s.bthPrice||50)}/100`;$('sentimentBreadth').textContent=`${Math.round(s.breadth||50)}%`;$('sentimentFG').textContent=s.fg==null?'—':`${Math.round(s.fg)}`;$('sentimentSource').textContent=(s.source||'live').toUpperCase();$('sentimentSourceNote').textContent=s.fg!=null?'Source: Alternative.me + live market breadth.':t('liveSource');
  }
  async function refreshSentiment(force=false){
    if(!state.markets.length){renderSentiment();return;} const base=computeSentimentFromMarkets(state.markets,null);state.sentiment=base;renderSentiment(base);
    try{const d=await Promise.race([fetchFearGreed(),sleep(force?5000:3500).then(()=>{throw new Error('timeout')})]);const v=num(d?.data?.[0]?.value,NaN); if(Number.isFinite(v)){state.sentiment=computeSentimentFromMarkets(state.markets,v);renderSentiment(state.sentiment);}}catch{}
  }
  function renderStructurePanel(x){
    const host=$('structureBias');
    if(!host)return;
    const rows=state.selected?.rows;
    const derived=(rows&&rows.length>=8)?detectStructure(rows):null;
    const st=x||state.structure||derived;
    const waiting=t('waiting');
    if(!st){
      $('structureBias').textContent=waiting;
      $('structureEvent').textContent=waiting;
      $('structureLevels').textContent='0 / 0';
      const ev=$('structureExplain');
      if(ev){ev.className='structure-event';ev.innerHTML=`<b>${esc(t('structureHint'))}</b>`;}
      const chip=$('structureBadge');
      if(chip){chip.textContent=waiting;chip.className='signal-chip neutral';}
      return;
    }
    state.structure=st;
    const biasText=st.bias==='BULLISH'?t('bull'):st.bias==='BEARISH'?t('bear'):t('neutral');
    $('structureBias').textContent=biasText;
    $('structureEvent').textContent=st.event?(st.event.direction==='BULLISH'?(st.event.type==='CHOCH'?t('bullishChoch'):t('bullishBos')):(st.event.type==='CHOCH'?t('bearishChoch'):t('bearishBos'))):t('noStructureEvent');
    $('structureLevels').textContent=`${st.highs?.length||0}/${st.lows?.length||0}`;
    const ev=$('structureExplain');
    if(ev){
      if(st.event){
        ev.className=`structure-event ${st.event.direction==='BULLISH'?'bull':'bear'}`;
        ev.innerHTML=`<b>${esc(st.event.type==='CHOCH'?'CHoCH':'BOS')} · ${st.event.direction}</b><div class="small muted" style="margin-top:6px">${t('lastStructure')}: ${fmt(st.event.price)} · ${st.event.barsAgo===0?'now':`${st.event.barsAgo} bars ago`}</div>`;
      }else{
        const hi=st.highs?.at(-1)?.price,lo=st.lows?.at(-1)?.price;
        ev.className='structure-event';
        ev.innerHTML=`<b>${esc(st.note||t('noStructureEvent'))}</b>${hi?`<div class="small muted" style="margin-top:6px">H: ${fmt(hi)}${lo?` · L: ${fmt(lo)}`:''}</div>`:''}`;
      }
    }
    const chip=$('structureBadge');
    if(chip){chip.textContent=biasText;chip.className=`signal-chip ${st.bias==='BULLISH'?'early':st.bias==='BEARISH'?'watch':'neutral'}`;}
  }
  function refreshActiveStructure(){
    const rows=state.selected?.rows;
    if(rows?.length>=8){state.structure=detectStructure(rows);renderStructurePanel(state.structure);}
    else renderStructurePanel(state.structure||null);
  }
  async function loadRiskCalendar(){
    const urls=['https://nfs.faireconomy.media/ff_calendar_thisweek.json','https://nfs.faireconomy.media/ff_calendar_nextweek.json']; let events=[];
    for(const u of urls){try{const d=await fetchJSON(u,{timeout:5500});if(Array.isArray(d))events=events.concat(d);}catch{}}
    if(!events.length){state.calendar=[];renderRiskCalendar([]);return;}
    const now=Date.now(),max=now+8*24*3600e3;state.calendar=events.filter(e=>{const ts=Date.parse(e.date);return Number.isFinite(ts)&&ts>=now-2*3600e3&&ts<=max&&['High','Medium'].includes(e.impact);}).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));renderRiskCalendar(state.calendar);
  }

  function calendarBadge(e){return e.impact==='High'?`<span class="impact-pill high">${t('highImpact')}</span>`:`<span class="impact-pill medium">${t('mediumImpact')}</span>`;}
  function renderRiskCalendar(events){const list=(events&&events.length)?events.slice(0,10):[];const now=Date.now();const riskNow=state.calendar.some(e=>{const ts=Date.parse(e.date);return ts>=now-30*60000&&ts<=now+30*60000&&e.impact==='High';});$('calendarPreview')&&($('calendarPreview').innerHTML=list.slice(0,4).map(e=>{const ts=Date.parse(e.date),mins=Math.round((ts-now)/60000);const when=mins<0?t('pastEvent'):t('inMinutes').replace('{n}',mins);return `<div class="event-item ${e.impact==='High'?'high':'medium'}"><div class="event-time">${new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div><div><b>${esc(e.country)} · ${esc(e.title)}</b><div class="small muted">${when} · ${esc(e.forecast||'—')} / ${esc(e.previous||'—')}</div></div>${calendarBadge(e)}</div>`;}).join(''));if($('riskNowBadge')){$('riskNowBadge').className=`radar4-badge ${riskNow?'risk-flag':''}`;$('riskNowBadge').textContent=riskNow?t('riskNow'):t('nextEvent');}}
  function calendarHTML(events){const list=(events&&events.length)?events:[];const now=Date.now();if(!list.length)return `<div class="empty-state">${t('noData')}</div><div class="source-note">${t('sourceCalendar')}</div>`;return `<div class="event-list">${list.slice(0,14).map(e=>{const ts=Date.parse(e.date),mins=Math.round((ts-now)/60000),when=mins<0?t('pastEvent'):t('inMinutes').replace('{n}',mins);return `<div class="event-item ${e.impact==='High'?'high':'medium'}"><div class="event-time">${new Date(ts).toLocaleDateString([], {month:'short',day:'numeric'})}<br>${new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div><div><b>${esc(e.country)} · ${esc(e.title)}</b><div class="small muted">${when} · Forecast ${esc(e.forecast||'—')} · Previous ${esc(e.previous||'—')}</div></div>${calendarBadge(e)}</div>`;}).join('')}</div><div class="source-note">${t('sourceCalendar')}</div>`;}

  // ---------- Interactive trade simulator ----------
  function liveSimPrice(sig){const t=state.marketsBySymbol[sig.symbol];return t?.last||sig.price||sig.entry;}
  function renderSimulatorInto(elId='simulatorOutput',x=state.selected){const out=$(elId);if(!out)return;if(!x){out.innerHTML=`<div class="empty-state">${t('analysisHint')}</div>`;return;}const sig=x;state.simulator.price=liveSimPrice(sig);const span=Math.max(sig.tp2-sig.sl,1e-9),progress=clamp((state.simulator.price-sig.sl)/span*100,0,100),pnl=(state.simulator.price/sig.entry-1)*100;out.innerHTML=`<div class="sim-grid"><div class="intel-panel"><div class="intel-head"><div><div class="eyebrow">${esc(sig.symbol)} · LIVE PAPER</div><h3>${t('simPrice')}</h3></div><span class="radar4-badge">${t('modeLive')}</span></div><div class="sim-price">${fmt(state.simulator.price)}</div><div class="sim-pnl ${pnl>=0?'gain':'loss'}">${pnl>=0?'+':''}${pnl.toFixed(2)}%</div><div class="sim-track"><div class="sim-track-fill" style="width:${progress}%"></div></div><div class="small muted" style="margin-top:7px">Entry ${fmt(sig.entry)} · SL ${fmt(sig.sl)} · TP1 ${fmt(sig.tp1)} · TP2 ${fmt(sig.tp2)}</div><div class="sim-actions"><button class="btn primary" id="simStart">${state.simulator.running?t('pauseSim'):t('startSim')}</button><button class="btn ghost" id="simReset">↺ ${t('resetSim')}</button></div></div><div class="intel-panel"><div class="section-head"><b>${t('simStatus')}</b><span class="signal-chip ${state.simulator.outcome==='WAITING'?'neutral':state.simulator.outcome.includes('TP')?'early':'watch'}">${({WAITING:t('simWaiting'),RUNNING:t('simRunning'),HIT_SL:t('simHitSL'),HIT_TP1:t('simHitTP1'),HIT_TP2:t('simHitTP2')})[state.simulator.outcome]||state.simulator.outcome}</span></div><div class="structure-grid"><div class="structure-card"><span>${t('entry')}</span><b>${fmt(sig.entry)}</b></div><div class="structure-card"><span>RR</span><b>${sig.rr.toFixed(2)}x</b></div><div class="structure-card"><span>${t('simProgress')}</span><b>${Math.round(progress)}%</b></div></div><div class="sim-log">${(state.simulator.logs||[]).slice(-12).reverse().map(l=>`<div class="sim-log-item">${esc(l.time)} · <b>${esc(l.msg)}</b></div>`).join('')}</div><div class="risk-note" style="margin-top:9px">${t('simulatorNote')}</div></div></div>`;$('simStart').onclick=()=>toggleSimulator(sig,elId);$('simReset').onclick=()=>resetSimulator(sig,elId);}
  function toggleSimulator(sig,elId='simulatorOutput'){state.simulator.running=!state.simulator.running;state.simulator.outcome=state.simulator.running?'RUNNING':'WAITING';state.simulator.logs=state.simulator.logs||[];state.simulator.logs.push({time:new Date().toLocaleTimeString(),msg:state.simulator.running?t('simRunning'):t('pauseSim')});renderSimulatorInto(elId,sig);}

  function resetSimulator(sig=state.selected,elId='simulatorOutput'){if(state.simulator.timer)clearInterval(state.simulator.timer);if(!sig||!(sig.entry>0)){state.simulator={running:false,step:0,price:0,outcome:'WAITING',timer:null,logs:[{time:new Date().toLocaleTimeString(),msg:t('noData')} ]};renderSimulatorInto(elId,null);return;}state.simulator={running:false,step:0,price:sig.entry,outcome:'WAITING',timer:null,logs:[{time:new Date().toLocaleTimeString(),msg:t('simReset')} ]};renderSimulatorInto(elId,sig);}

  function coreFeatures(rows){
    const closes=rows.map(x=>x.c), vols=rows.map(x=>x.v), last=rows.at(-1), prev=rows.at(-2)||last;
    const e20=ema(closes.slice(-100),20), e50=ema(closes.slice(-120),50), e200=ema(closes,Math.min(200,closes.length));
    const r=rsi(closes,14), a=atr(rows,14), atrPct=last.c?a/last.c*100:0;
    const ret5=closes.length>5?((last.c/closes.at(-6))-1)*100:0, ret15=closes.length>15?((last.c/closes.at(-16))-1)*100:0;
    const momFast=ema(closes.slice(-25),8), momSlow=ema(closes.slice(-25),21), momentum=last.c?((momFast-momSlow)/last.c*100):0;
    const vbase=sma(vols.slice(-31,-1),30)||1, vr=last.v/vbase;
    const range20=rows.slice(-21,-1), hi=Math.max(...range20.map(x=>x.h)),lo=Math.min(...range20.map(x=>x.l));
    const breakout=hi?((last.c/hi)-1)*100:0, rangePct=last.c?((hi-lo)/last.c)*100:0;
    const tr=trueRanges(rows), atrFast=sma(tr.slice(-10),10), atrSlow=sma(tr.slice(-30),30)||1, compression=clamp((1-atrFast/atrSlow)*100,0,100);
    const bbMid=sma(closes.slice(-20),20), bbStd=stdev(closes.slice(-20)); const bbWidth=bbMid?((bbStd*4)/bbMid)*100:0;
    const obvArr=obv(rows), obvSl=linearSlope(obvArr.slice(-20));
    const avgRange=sma(rows.slice(-30).map(x=>x.h-x.l),30)||1, bodyRatio=Math.abs(last.c-last.o)/(last.h-last.l||1);
    const upperClose=(last.c-last.l)/(last.h-last.l||1);
    const p=candlePatterns(rows);
    return {last,e20,e50,e200,rsi:r,atr:a,atrPct,ret5,ret15,momentum,volumeRatio:vr,hi,lo,breakout,rangePct,compression,bbWidth,obvSlope:obvSl,avgRange,bodyRatio,upperClose,patterns:p};
  }
  function scoreFeatures(f,flow=null,structure=null,fakeout=null,forensic=null){
    let score=42, reasons=[], conflicts=[];
    if(f.last.c>f.e20){score+=5;reasons.push('السعر فوق EMA20');}else conflicts.push('السعر تحت EMA20');
    if(f.e20>f.e50){score+=8;reasons.push('EMA20 أعلى EMA50');}else conflicts.push('EMA20 دون EMA50');
    if(f.e50>f.e200){score+=7;reasons.push('اتجاه أعلى داعم');}else score-=3;
    if(f.ret5>0.45){score+=7;reasons.push(`زخم 5m ${pct(f.ret5)}`);}else if(f.ret5<-0.55){score-=6;reasons.push(`ضغط 5m ${pct(f.ret5)}`);}
    if(f.ret15>0.8){score+=6;reasons.push(`زخم 15m ${pct(f.ret15)}`);}else if(f.ret15<-1){score-=6;}
    if(f.momentum>0.12){score+=5;reasons.push('تسارع Momentum');}else if(f.momentum<-.12){score-=4;}
    if(f.volumeRatio>=2.2){score+=12;reasons.push(`Volume spike ${f.volumeRatio.toFixed(2)}x`);}else if(f.volumeRatio>=1.45){score+=7;reasons.push(`Volume ${f.volumeRatio.toFixed(2)}x`);}else if(f.volumeRatio<.75)score-=2;
    if(f.rsi>=50&&f.rsi<=72){score+=7;reasons.push(`RSI ${f.rsi.toFixed(1)}`);}else if(f.rsi>80){score-=8;reasons.push(`RSI مرتفع ${f.rsi.toFixed(1)}`);}else if(f.rsi<38){score-=5;}
    if(f.breakout>=-.6){score+=9;reasons.push('قريب من قمة 20 شمعة');}
    if(f.compression>=35&&f.breakout>-1.2){score+=6;reasons.push('ضغط/تجميع قبل الحركة');}
    if(f.patterns.bullishEngulf){score+=6;reasons.push('Bullish engulfing');}
    if(f.patterns.hammer){score+=4;reasons.push('Hammer rejection');}
    if(f.patterns.inside&&f.bodyRatio>.55){score+=3;reasons.push('Inside-bar expansion');}
    if(f.upperClose>.72&&f.bodyRatio>.55){score+=4;reasons.push('إغلاق قوي قرب القمة');}
    if(flow){
      if(flow.imbalance>8){score+=6;reasons.push(`Bid imbalance +${flow.imbalance.toFixed(1)}%`);}else if(flow.imbalance<-8){score-=6;conflicts.push(`Ask imbalance ${flow.imbalance.toFixed(1)}%`);}
      if(flow.cvd>8){score+=5;reasons.push(`CVD +${flow.cvd.toFixed(1)}%`);}else if(flow.cvd<-8){score-=5;}
      if(flow.buySell>1.18){score+=4;reasons.push(`Buy/Sell ${flow.buySell.toFixed(2)}x`);}else if(flow.buySell&&flow.buySell<.84){score-=4;}
      if(flow.whales){
        if(flow.whales.direction==='BUY_PRESSURE'){score+=Math.min(10,flow.whales.score*.10);reasons.push(`Whale flow ${Math.round(flow.whales.score)}/100`);}
        else if(flow.whales.direction==='SELL_PRESSURE'){score-=Math.min(10,(100-flow.whales.score)*.10);conflicts.push(`Whale sell pressure ${Math.round(100-flow.whales.score)}/100`);}
      }
    }
    if(structure){ if(structure.event?.direction==='BULLISH'){score+=structure.event.type==='CHOCH'?10:8;reasons.push(`${structure.event.type} bullish`);} else if(structure.event?.direction==='BEARISH'){score-=structure.event.type==='CHOCH'?10:8;conflicts.push(`${structure.event.type} bearish`);} else if(structure.bias==='BULLISH'){score+=4;reasons.push('Higher-high / higher-low structure');} else if(structure.bias==='BEARISH'){score-=4;conflicts.push('Lower-high / lower-low structure');} }
    if(fakeout){
      if(fakeout.level==='HIGH'){score-=Math.min(22,8+fakeout.score*.18);conflicts.push(`${t('trapSignal')}: ${Math.round(fakeout.score)}/100`);}
      else if(fakeout.level==='MEDIUM'){score-=Math.min(10,4+fakeout.score*.08);conflicts.push(`${t('trapSignal')}: ${Math.round(fakeout.score)}/100`);}
      else if(f.breakout>-0.8){score+=3;reasons.push(t('confirmedBreakout'));}
    }
    if(forensic){ if(forensic.score>=78){score+=4;reasons.push(`${t('forensicScore')}: ${Math.round(forensic.score)}/100`);} else if(forensic.score<42){score-=5;conflicts.push(`${t('forensicScore')}: ${Math.round(forensic.score)}/100`);} }
    if(f.e20<f.e50&&f.ret5>1) conflicts.push('ارتداد ضد الاتجاه');
    score=clamp(score);
    const quality=clamp(55 + (f.volumeRatio>=1.4?10:0) + (f.compression>=35?7:0) + (f.breakout>-1?7:0) + (Math.abs(f.ret15)>.7?5:0) - conflicts.length*5 - (f.rsi>80?8:0),25,96);
    let signal='NO_SIGNAL'; if(score>=83&&quality>=64)signal='EARLY_ALERT'; else if(score>=72&&quality>=54)signal='WATCH';
    const risk=Math.max(f.atr,f.last.c*.006); const entry=Math.max(f.last.c, f.hi>f.last.c?f.last.c:f.hi*1.001); const sl=Math.max(1e-12,entry-risk); const tp1=entry+risk*1.25,tp2=entry+risk*2,tp3=entry+risk*2.75; const rr=1.25,rr2=2,rr3=2.75;
    const horizon=score>=86?'1–4h':score>=76?'2–8h':'monitor only';
    const tradeType=score>=78?'SHORT_TERM':'MEDIUM_TERM';
    const confidence=Math.round(clamp((quality+(forensic?.confidence||quality))*.5,25,98));
    return {score,quality,signal,reasons,conflicts,entry,entryLow:Math.max(sl,entry-risk*.35),entryHigh:entry+risk*.25,sl,tp1,tp2,tp3,rr,rr2,rr3,horizon,tradeType,confidence,fakeout};
  }
  async function deepAnalyze(provider,symbol,tf,{withFlow=true}={}){
    const requestedProvider=provider||'binance';
    const providers=typeof orderedProviders==='function'?orderedProviders(requestedProvider):[requestedProvider,'okx','bybit','gate'];
    let actualProvider=requestedProvider,rows=null,ticker=null,lastError=null;
    const cached=state.marketsBySymbol?.[symbol]||null;
    if(cached?.last>0&&(!cached.provider||cached.provider===requestedProvider)){ticker=cached;}
    for(const p of providers){
      try{
        const r=await fetchKlines(p,symbol,tf,180);
        if(Array.isArray(r)&&r.length){rows=r;actualProvider=p;break;}
      }catch(e){lastError=e;}
    }
    if(!rows)throw lastError||new Error('EMPTY_KLINES');
    if(!ticker||ticker.provider!==actualProvider){
      try{ticker=await fetchTicker(actualProvider,symbol);}catch{}
    }
    state.klinesCache[symbol]=state.klinesCache[symbol]||{}; state.klinesCache[symbol][tf]=rows.slice(-250);
    let flow=null,flowProvider=actualProvider;
    if(withFlow){
      for(const p of [actualProvider,...providers.filter(x=>x!==actualProvider)]){
        try{
          const [d,tr]=await Promise.all([fetchDepth(p,symbol,50),fetchTrades(p,symbol,180)]);
          if(d?.bids?.length&&d?.asks?.length&&Array.isArray(tr)){flow=flowFromData(d,tr);state.streamTrades[symbol]=tr.slice(-300);flowProvider=p;break;}
        }catch{}
      }
    }
    const f=coreFeatures(rows),structure=detectStructure(rows),fakeout=detectFakeout(rows,f,flow,structure),forensic=deepDiveAnalysis(rows,f,flow,structure,fakeout),score=scoreFeatures(f,flow,structure,fakeout,forensic);
    const lastPrice=num(ticker?.last,f.last.c);
    return {...f,...score,flow,flowWhales:flow?.whales||null,structure,fakeout,forensic,symbol,requestedProvider,exchange:actualProvider,flowProvider,timeframe:tf,mode:'live_rest',fallbackUsed:actualProvider!==requestedProvider,rows,price:lastPrice,priceChangePercent:num(ticker?.priceChangePercent,0),quoteVolume:num(ticker?.quoteVolume,0),bidPrice:num(ticker?.bidPrice,0),askPrice:num(ticker?.askPrice,0),bidQty:num(ticker?.bidQty,0),askQty:num(ticker?.askQty,0),eventTime:num(ticker?.eventTime,Date.now()),liveAt:Date.now()};
  }

  // ---------- Auto-Pilot Smart Scanner ----------
  const SMART_SCAN = { minQuoteVolume: 10_000_000, minVolumeRatio: 1.8, minRet5: 0.25, minRet15: 0.50, maxTrapRisk: 34, maxInitial: 18, maxDeep: 4 };
  function smartText(key, vars={}){ let s=t(key); for(const [k,v] of Object.entries(vars))s=s.replaceAll(`{${k}}`,String(v)); return s; }
  function smartStage(text, pct=0, mood='good'){
    const bar=$('smartScanProgress'), out=$('smartScanStage'); if(bar)bar.style.width=`${clamp(pct,0,100)}%`;
    if(out){out.innerHTML=`<span class="smart-pulse ${mood==='busy'?'busy':mood==='bad'?'bad':''}"></span>${esc(text)}`;}
  }
  function smartGatePassQuickTicker(x){ return x && /USDT$/.test(x.symbol) && x.last>0 && x.quoteVolume>=SMART_SCAN.minQuoteVolume && x.priceChangePercent>=0.65; }
  function smartGatePassFeatures(f,x){
    if(!f||!x) return false;
    return x.quoteVolume>=SMART_SCAN.minQuoteVolume && f.volumeRatio>=SMART_SCAN.minVolumeRatio && f.ret5>=SMART_SCAN.minRet5 && f.ret15>=SMART_SCAN.minRet15 && f.last.c>f.e20 && f.e20>f.e50 && f.rsi>=52 && f.rsi<=92;
  }
  function smartRankPre(x){
    const liq=clamp((Math.log10(Math.max(10_000,x.quoteVolume))-7)*28+50,0,100), mom=clamp(50+x.priceChangePercent*10,0,100);
    return liq*.58+mom*.42;
  }
  function smartOpportunityCard(x,index){
    const trap=Math.round(x.fakeout?.score||0), spike=Number(x.volumeRatio||0), mom5=Number(x.ret5||0), mom15=Number(x.ret15||0), d=x.forensic||{};
    const explanation=state.lang==='ar'
      ? `السيولة اليومية قوية عند ${fmt(x.quoteVolume)} USDT، والحجم الحالي أعلى من متوسطه بنحو ${spike.toFixed(2)}×. الزخم القصير ${pct(mom5)} و${pct(mom15)} على 5m/15m، بينما Trap Risk عند ${trap}/100.`
      : `24h quote liquidity is ${fmt(x.quoteVolume)} USDT and current volume is about ${spike.toFixed(2)}× its recent average. Short momentum is ${pct(mom5)} / ${pct(mom15)} on 5m/15m, while Trap Risk is ${trap}/100.`;
    return `<article class="golden-card ${index===0?'best':''}" data-symbol="${esc(x.symbol)}" role="button" tabindex="0" aria-label="${esc(x.symbol)}">
      <div class="golden-top"><div><div class="golden-label">🟡 ${esc(t('goldenOpportunity'))}${index===0?` · ${esc(t('goldenBest'))}`:''}</div><div class="golden-symbol">${esc(x.symbol)}</div></div><div class="golden-score">${Math.round(x.score)}/100</div></div>
      <div class="golden-explain"><b>${esc(t('goldenWhy'))}</b><br>${esc(explanation)}</div>
      <div class="golden-reasons"><div class="golden-reason"><span>${esc(t('goldenLiquidity'))}</span><b>${fmt(x.quoteVolume)}</b></div><div class="golden-reason"><span>${esc(t('goldenVolumeSpike'))}</span><b>${spike.toFixed(2)}×</b></div><div class="golden-reason"><span>${esc(t('goldenMomentum'))}</span><b>${pct(mom5)}</b></div><div class="golden-reason"><span>${esc(t('goldenTrap'))}</span><b class="${trap<20?'gain':''}">${trap}/100</b></div></div>
      <div class="golden-plan"><div class="golden-metric"><span>${esc(t('goldenEntry'))}</span><b>${fmt(x.entry)}</b></div><div class="golden-metric"><span>${esc(t('goldenSL'))}</span><b>${fmt(x.sl)}</b></div><div class="golden-metric"><span>${esc(t('goldenTP'))}</span><b>${fmt(x.tp1)}</b></div><div class="golden-metric"><span>${esc(t('goldenTP2'))}</span><b>${fmt(x.tp2)}</b></div><div class="golden-metric"><span>TP3</span><b>${fmt(x.tp3||x.tp2)}</b></div><div class="golden-metric"><span>${esc(t('goldenRR'))}</span><b>${Number(x.rr3||x.rr||d.rr2||0).toFixed(2)}×</b></div></div><div class="plan-meta-row"><span class="plan-meta">${esc(t('confidence'))}: <b>${Math.round(x.confidence||x.quality||0)}%</b></span><span class="plan-meta">${esc(t('tradeType'))}: <b>${x.tradeType==='SHORT_TERM'?esc(t('shortType')):esc(t('mediumType'))}</b></span></div>
      <div class="golden-actions"><button class="btn primary" data-smart-analysis="${esc(x.symbol)}">🔬 ${esc(t('goldenOpenAnalysis'))}</button><button class="btn ghost" data-smart-paper="${esc(x.symbol)}">🧪 ${esc(t('goldenPaper'))}</button></div>
      <div class="golden-note">${esc(t('goldenNoChase'))} · ${esc(t('disclaimer'))}</div>
    </article>`;
  }
  function renderSmartOutput(results=[],meta={}){
    const out=$('smartOpportunityOutput'); if(!out)return;
    const smart=results.slice(0,2);
    if(!smart.length){
      out.innerHTML=`<div class="smart-empty">🛡️ ${esc(meta.message||smartText('smartNoOpportunity'))}<div class="smart-stats"><div class="smart-stat"><span>${esc(t('smartUniverse'))}</span><b>${Number(meta.universe||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartStage1'))}</span><b>${Number(meta.stage1||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartDeep'))}</span><b>${Number(meta.deepVerified||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartGold'))}</span><b>0</b></div></div></div>`;
      return;
    }
    out.innerHTML=smart.map((x,i)=>smartOpportunityCard(x,i)).join('')+`<div class="smart-stats" style="grid-column:1/-1"><div class="smart-stat"><span>${esc(t('smartUniverse'))}</span><b>${Number(meta.universe||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartStage1'))}</span><b>${Number(meta.stage1||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartDeep'))}</span><b>${Number(meta.deepVerified||0).toLocaleString('en-US')}</b></div><div class="smart-stat"><span>${esc(t('smartGold'))}</span><b>${smart.length}</b></div></div>`;
  }
  async function fetchSmartKlines(symbol,tf='5m',provider='binance'){ return fetchKlines(provider,symbol,tf,80); }
  async function smartScan(){
    if(state.smartScan.running)return;
    state.smartScan={...state.smartScan,running:true,results:[],universe:0,stage1:0,deepVerified:0,startedAt:Date.now(),error:'',lastUpdated:0};
    const btns=[$('smartScanBtn'),$('quickScan')].filter(Boolean);btns.forEach(b=>b.disabled=true);
    $('smartOpportunityOutput').innerHTML=''; smartStage(t('smartReady'),2,'busy');
    try{
      const tickers=await fetchAllTickersResilient('binance');
      const universe=tickers.filter(x=>/USDT$/.test(x.symbol)&&x.last>0); state.smartScan.universe=universe.length; state.markets=universe.slice(); state.marketsBySymbol={}; universe.forEach(x=>state.marketsBySymbol[x.symbol]=x); renderMarkets();
      if(!universe.length)throw new Error('EMPTY_LIVE_UNIVERSE');
      smartStage(smartText('smartScanningUniverse',{n:universe.length}),12,'busy');
      const initial=universe.filter(smartGatePassQuickTicker).sort((a,b)=>smartRankPre(b)-smartRankPre(a)).slice(0,SMART_SCAN.maxInitial);
      state.smartScan.stage1=initial.length; smartStage(smartText('smartGateFiltering',{n:initial.length}),24,'busy');
      const verified=[];
      for(let i=0;i<initial.length;i+=3){
        const batch=initial.slice(i,i+3);
        const rr=await Promise.allSettled(batch.map(async x=>{const rows=await fetchSmartKlines(x.symbol,'5m',x.provider||'binance');if(!rows?.length)return null;const f=coreFeatures(rows);return smartGatePassFeatures(f,x)?{ticker:x,rows,f}:null;}));
        rr.forEach(v=>{if(v.status==='fulfilled'&&v.value)verified.push(v.value);});
        smartStage(smartText('smartKlineStage',{n:verified.length}),24+Math.round(((Math.min(i+3,initial.length)/initial.length)||1)*30),'busy');
        await sleep(70);
      }
      verified.sort((a,b)=>((b.f.volumeRatio*.45)+(b.f.ret5*7*.25)+(b.f.ret15*4*.20)+(smartRankPre(b.ticker)*.10))-((a.f.volumeRatio*.45)+(a.f.ret5*7*.25)+(a.f.ret15*4*.20)+(smartRankPre(a.ticker)*.10)));
      const top=verified.slice(0,Math.min(8,verified.length)); smartStage(t('smartDeepStage'),56,'busy');
      const deep=[];
      for(let i=0;i<top.length;i+=SMART_SCAN.maxDeep){
        const batch=top.slice(i,i+SMART_SCAN.maxDeep);
        const rr=await Promise.allSettled(batch.map(x=>deepAnalyze(x.ticker.provider||'binance',x.ticker.symbol,'5m',{withFlow:true})));
        rr.forEach(v=>{if(v.status==='fulfilled')deep.push(v.value);});
        smartStage(t('smartDeepStage'),56+Math.round(((Math.min(i+SMART_SCAN.maxDeep,top.length)/Math.max(top.length,1))||1)*38),'busy');
      }
      state.smartScan.deepVerified=deep.length;
      const eligible=deep.filter(x=>smartGatePassFeatures(x,x) && Number(x.fakeout?.score||100)<SMART_SCAN.maxTrapRisk && x.signal!=='NO_SIGNAL' && Number(x.quality||0)>=62 && Number(x.forensic?.flowScore||0)>=52).map(x=>({...x,smartEligible:true})).sort((a,b)=>((b.score*.45)+(b.forensic?.score||0)*.30+(Math.min(5,b.volumeRatio||0)*8*.15)+(Math.max(0,b.ret5||0)*4*.10))-((a.score*.45)+(a.forensic?.score||0)*.30+(Math.min(5,a.volumeRatio||0)*8*.15)+(Math.max(0,a.ret5||0)*4*.10)));
      state.smartScan.results=eligible.slice(0,2);state.smartScan.lastUpdated=Date.now();
      const msg=state.smartScan.results.length?smartText('smartComplete',{u:universe.length,g:verified.length,d:deep.length,w:state.smartScan.results.length}):smartText('smartNoOpportunity');
      smartStage(msg,100,state.smartScan.results.length?'good':'bad'); renderSmartOutput(state.smartScan.results,{universe:universe.length,stage1:initial.length,deepVerified:deep.length,message:state.smartScan.results.length?null:msg});
      if(state.smartScan.results.length){state.selected=state.smartScan.results[0];state.deepRows=[...state.smartScan.results,...state.deepRows.filter(x=>!state.smartScan.results.some(y=>y.symbol===x.symbol))].slice(0,20);renderRadarTable(state.deepRows);saveAlert(state.smartScan.results[0]);notifyUser(`${state.smartScan.results[0].symbol} · ${t('goldenOpportunity')}`,`${t('strength')}: ${Math.round(state.smartScan.results[0].score)}/100 · Trap ${Math.round(state.smartScan.results[0].fakeout?.score||0)}/100`);}
      markLiveData('live_rest',`${t('liveRest')} · Smart Scan`);appHealthy();
    }catch(e){
      state.smartScan.error=String(e?.message||e); smartStage(t('smartNetworkFail'),100,'bad'); renderSmartOutput([],{universe:state.smartScan.universe,stage1:state.smartScan.stage1,deepVerified:state.smartScan.deepVerified,message:t('smartNetworkFail')}); markLiveData('offline');
    }finally{state.smartScan.running=false;btns.forEach(b=>b.disabled=false);}
  }

  // ---------- 4.10 Multi-Symbol Live Radar Dashboard ----------
  const RADAR_FILTERS={
  // Real Binance Spot USDT filters. Keep them permissive enough to populate immediately.
  gainersMinQuoteVolume:500000,
  breakoutMinQuoteVolume:250000,
  minLastPrice:0,
  staleTickerMs:15000,
  cachedMarketMaxAgeMs:24*3600e3,
  restFreshMs:15000,
  excludeSymbols:/^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD)USDT$/,
  excludeLeveraged:/(UP|DOWN|BULL|BEAR)USDT$/
};
const MULTI_RADAR={pollMs:12000,paintMs:260,metaMs:1800,minQuoteVolume:RADAR_FILTERS.gainersMinQuoteVolume,wsStaleMs:6500,restTimeout:2800,restMaxUrls:3,
  breakoutMinScore:48,breakoutMinMove1m:0.04,breakoutMinMove3m:0.08,breakoutMinVolumeSpike:1.15,breakoutMaxHighDistance:2.00,tapeWindowMs:180000,
  volumeMonitorSymbols:18,volumeBaselineBars:20,volumeBaselineRefreshMs:45000,klineWsStaleMs:7000,initialPollDelayMs:80,
  minGainersReady:3,restKlineTimeout:2800};
  function multiRadarSetBusy(busy=false,kind='live'){
    const dot=$('multiRadarDot'),label=$('multiRadarLiveState');
    if(!dot||!label)return;
    dot.className=`multi-live-dot ${busy?'busy':kind==='offline'?'bad':''}`;
    label.textContent=kind==='offline'?t('multiRadarOffline'):kind==='cached'?t('multiRadarCached'):kind==='rest'?t('multiRadarRest'):kind==='ws'?t('multiRadarWs'):t('multiRadarLive');
  }
  function multiRadarOneHourReturn(symbol){
    const deep=state.deepRows.find(x=>x.symbol===symbol);
    if(deep&&Number.isFinite(Number(deep.ret60)))return num(deep.ret60);
    const tf=state.klinesCache[symbol]?.['5m']||state.klinesCache[symbol]?.['15m']||[];
    if(tf.length>=13){const last=tf.at(-1)?.c,old=tf.at(-13)?.c;return last&&old?((last/old)-1)*100:null;}
    return null;
  }
  function multiRadarFlowScore(x,deep){
    if(deep?.flow){
      const im=num(deep.flow.imbalance),cv=num(deep.flow.cvd),bs=num(deep.flow.buySell,1);
      return clamp(50+im*.6+cv*.35+(bs-1)*30);
    }
    const b=num(x.bidQty),a=num(x.askQty),im=(b+a)?((b-a)/(b+a))*100:0;
    return clamp(50+im*.65+num(x.priceChangePercent)*2);
  }
  function multiRadarTrap(deep){if(!deep)return null;return num(deep.fakeout?.score,null);}
  function multiRadarActivity(x,deep){
    const q=num(x.quoteVolume),liq=clamp(38+Math.log10(Math.max(q,1000000)+1)*6,0,100);
    const mom=clamp(50+num(x.priceChangePercent)*8,0,100);
    const flow=multiRadarFlowScore(x,deep);
    const smart=deep?clamp(num(deep.score,50)*.75+num(deep.quality,50)*.25,0,100):clamp(mom*.6+flow*.4,0,100);
    const trap=multiRadarTrap(deep);
    let score=liq*.30+mom*.25+flow*.18+smart*.27;
    if(trap!=null)score-=Math.max(0,trap-25)*.22;
    if(num(x.priceChangePercent)<0)score-=8;
    return {score:clamp(score),liquidity:liq,momentum:mom,flow,smart,trap};
  }
  function multiRadarFreshMarketCount(maxAge=RADAR_FILTERS.staleTickerMs){
    const now=Date.now();let n=0;
    for(const x of Object.values(state.marketsBySymbol||{})){
      const received=num(x.receivedAt||x.eventTime,0);
      if(x?.quoteAsset==='USDT'&&x?.symbol?.endsWith('USDT')&&x.last>0&&received>0&&now-received<=maxAge)n++;
    }
    return n;
  }
  function isRadarSymbolEligible(x,mode='gainers',allowCached=false){
    if(!x||x.quoteAsset!=='USDT'||!x.symbol?.endsWith('USDT')||!(num(x.last)>RADAR_FILTERS.minLastPrice))return false;
    if(RADAR_FILTERS.excludeSymbols.test(x.symbol)||RADAR_FILTERS.excludeLeveraged.test(x.symbol))return false;
    const minVol=mode==='breakout'?RADAR_FILTERS.breakoutMinQuoteVolume:RADAR_FILTERS.gainersMinQuoteVolume;
    if(num(x.quoteVolume)<minVol)return false;
    const received=num(x.receivedAt||x.eventTime,0),age=Date.now()-received;
    if(!received||age<0)return false;
    const cachedMode=allowCached&&state.multiRadar.cacheAt>0&&Date.now()-state.multiRadar.cacheAt<=RADAR_FILTERS.cachedMarketMaxAgeMs;
    if(cachedMode)return age<=RADAR_FILTERS.cachedMarketMaxAgeMs;
    return age<=RADAR_FILTERS.staleTickerMs;
  }
  function updateLiveMinuteKline(k){
    if(!k?.s||k.i!=='1m')return;
    const symbol=String(k.s).toUpperCase();
    const receivedAt=Date.now();const bar={t:num(k.t),T:num(k.T),o:num(k.o),c:num(k.c),h:num(k.h),l:num(k.l),v:num(k.v),q:num(k.q),n:num(k.n),buyQ:num(k.Q),closed:!!k.x,eventTime:receivedAt,receivedAt,dataSource:'ws'};
    let arr=state.multiRadar.klineBars.get(symbol)||[];
    const idx=arr.findIndex(b=>b.t===bar.t);
    if(idx>=0)arr[idx]=bar; else {arr.push(bar);arr.sort((a,b)=>a.t-b.t);}
    if(arr.length>MULTI_RADAR.volumeBaselineBars+3)arr=arr.slice(-(MULTI_RADAR.volumeBaselineBars+3));
    state.multiRadar.klineBars.set(symbol,arr);
    state.multiRadar.klineLastMessage=Date.now();
    const baseline=arr.filter(b=>b.closed&&b.q>0).slice(-MULTI_RADAR.volumeBaselineBars);
    state.multiRadar.klineBaselineAt=baseline.length>=8?Date.now():state.multiRadar.klineBaselineAt;
    state.multiRadar.dirty=true;
  }
  function liveMinuteVolumeSpike(symbol){
    const bars=state.multiRadar.klineBars.get(symbol)||[];
    if(bars.length<8)return null;
    const cur=bars.at(-1); if(!cur||!cur.q||cur.t<=0)return null;
    if(cur.dataSource==='ws'){if(!cur.receivedAt || Date.now()-num(cur.receivedAt,0)>MULTI_RADAR.klineWsStaleMs)return null;}
    else if(cur.dataSource==='rest'&&(!cur.receivedAt || Date.now()-num(cur.receivedAt,0)>Math.max(RADAR_FILTERS.restFreshMs,MULTI_RADAR.volumeBaselineRefreshMs+5000)))return null;
    const closed=bars.filter(b=>b.closed&&b.t!==cur.t&&b.q>0);
    if(closed.length<8)return null;
    const base=closed.slice(-MULTI_RADAR.volumeBaselineBars);
    const avgQ=base.reduce((a,b)=>a+b.q,0)/base.length;
    if(!(avgQ>0))return null;
    const elapsed=Math.max(10,Math.min(60,(Date.now()-cur.t)/1000));
    const currentRate=cur.q/(elapsed/60);
    return currentRate/avgQ;
  }
  function liveMinuteVolumeState(symbol){
    const bars=state.multiRadar.klineBars.get(symbol)||[];
    const cur=bars.at(-1), closed=bars.filter(b=>b.closed&&b.q>0).slice(-MULTI_RADAR.volumeBaselineBars);
    return {bars,cur,baselineCount:closed.length,spike:liveMinuteVolumeSpike(symbol)};
  }
  function breakoutMonitorUniverse(){
    const all=Object.values(state.marketsBySymbol||{}).filter(x=>isRadarSymbolEligible(x,'breakout',multiRadarSource()==='cached'));
    const byVolume=[...all].sort((a,b)=>num(b.quoteVolume)-num(a.quoteVolume));
    const byMove=[...all].sort((a,b)=>Math.abs(num(b.priceChangePercent))-Math.abs(num(a.priceChangePercent)));
    const set=new Set();
    const half=Math.max(10,Math.floor(MULTI_RADAR.volumeMonitorSymbols/2));
    for(const x of byVolume.slice(0,half))set.add(x.symbol);
    for(const x of byMove.slice(0,half))set.add(x.symbol);
    return [...set].slice(0,MULTI_RADAR.volumeMonitorSymbols);
  }
  async function fetchBinanceKlinesFast(symbol,limit){
    const urls=binanceUrls(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${Math.min(1000,limit)}`);
    const rows=await firstJSONRace(urls,{timeout:MULTI_RADAR.restKlineTimeout,retries:0,maxUrls:3});
    return parseBinanceKlines(rows);
  }
  async function seedBreakoutVolumeBaselines(symbols){
    const list=[...new Set((symbols||[]).filter(Boolean))];
    if(!list.length)return;
    const batch=10;
    for(let i=0;i<list.length;i+=batch){
      const group=list.slice(i,i+batch);
      await Promise.all(group.map(async symbol=>{
        try{
          const rows=await fetchBinanceKlinesFast(symbol,MULTI_RADAR.volumeBaselineBars+2);
          const receivedAt=Date.now();
          const bars=(rows||[]).map(r=>({...r,closed:true,eventTime:receivedAt,receivedAt,dataSource:'rest'})).filter(r=>r.q>0);
          if(bars.length)state.multiRadar.klineBars.set(symbol,bars.slice(-(MULTI_RADAR.volumeBaselineBars+2)));
        }catch{}
      }));
      state.multiRadar.dirty=true;
      if(i+batch<list.length)await sleep(15);
    }
    state.multiRadar.klineBaselineAt=Date.now();
    state.multiRadar.dirty=true;
  }
  function scheduleKlineMonitorReconnect(){
    clearTimeout(state.multiRadar.klineWsReconnectTimer);
    const attempt=Math.max(0,state.multiRadar.klineWsAttempt||0);
    const delay=Math.min(60000,2500+Math.min(30000,attempt*2500));
    state.multiRadar.klineWsAttempt=Math.min(attempt+1,12);
    state.multiRadar.klineWsReconnectTimer=setTimeout(()=>connectBreakoutKlineWS(),delay);
  }
  function closeBreakoutKlineWS(){
    ++state.multiRadar.klineWsGeneration;
    clearTimeout(state.multiRadar.klineWsReconnectTimer);
    if(state.multiRadar.klineWs){try{state.multiRadar.klineWs.close(1000,'replace')}catch{}state.multiRadar.klineWs=null;}
  }
  function connectBreakoutKlineWS(symbols=breakoutMonitorUniverse()){
    clearTimeout(state.multiRadar.klineWsReconnectTimer);
    const list=[...new Set(symbols)].slice(0,MULTI_RADAR.volumeMonitorSymbols);
    state.multiRadar.klineSymbols=list;
    if(!list.length||navigator.onLine===false){scheduleKlineMonitorReconnect();return;}
    closeBreakoutKlineWS();
    const generation=++state.multiRadar.klineWsGeneration;
    const streams=list.map(s=>`${s.toLowerCase()}@kline_1m`).join('/');
    const bases=[...BINANCE_WS_BASES];
    let idx=state.multiRadar.klineWsAttempt%BINANCE_WS_BASES.length;
    const openNext=()=>{
      if(generation!==state.multiRadar.klineWsGeneration)return;
      if(idx>=BINANCE_WS_BASES.length){scheduleKlineMonitorReconnect();return;}
      const base=bases[idx++];let ws;
      try{ws=new WebSocket(`${base}?streams=${encodeURIComponent(streams)}`);}catch{openNext();return;}
      state.multiRadar.klineWs=ws;
      ws.onopen=()=>{if(generation!==state.multiRadar.klineWsGeneration||state.multiRadar.klineWs!==ws)return;state.multiRadar.klineWsAttempt=0;state.multiRadar.klineWsLastMessage=Date.now();state.multiRadar.dirty=true;};
      ws.onmessage=e=>{if(generation!==state.multiRadar.klineWsGeneration||state.multiRadar.klineWs!==ws)return;state.multiRadar.klineWsLastMessage=Date.now();try{const msg=JSON.parse(e.data),d=msg.data&&msg.stream?msg.data:msg;if(d?.e==='kline')updateLiveMinuteKline(d.k);}catch{}};
      ws.onerror=()=>{};
      ws.onclose=()=>{if(generation!==state.multiRadar.klineWsGeneration||state.multiRadar.klineWs!==ws)return;state.multiRadar.klineWs=null;scheduleKlineMonitorReconnect();};
    };
    openNext();
  }
  function refreshBreakoutKlineMonitor(force=false){
    const universe=breakoutMonitorUniverse();
    const prev=[...state.multiRadar.klineSymbols].sort(),next=[...universe].sort();
    const same=prev.length===next.length&&prev.every((s,i)=>s===next[i]);
    if(force||!same){connectBreakoutKlineWS(universe);seedBreakoutVolumeBaselines(universe).catch(()=>{});return;}
    if(Date.now()-num(state.multiRadar.klineBaselineAt,0)>MULTI_RADAR.volumeBaselineRefreshMs)seedBreakoutVolumeBaselines(universe).catch(()=>{});
  }
  function multiRadarTopGainers(){
    const rows=[];
    for(const x of Object.values(state.marketsBySymbol||{})){
      if(!isRadarSymbolEligible(x,'gainers',multiRadarSource()==='cached'))continue;
      rows.push({...x,ret1h:multiRadarOneHourReturn(x.symbol)});
    }
    rows.sort((a,b)=>num(b.priceChangePercent)-num(a.priceChangePercent) || num(b.quoteVolume)-num(a.quoteVolume));
    return rows.slice(0,10).map((x)=>{
      const deep=state.deepRows.find(r=>r.symbol===x.symbol)||state.smartScan.results.find(r=>r.symbol===x.symbol)||null;
      const m=multiRadarActivity(x,deep);
      const trap=multiRadarTrap(deep);
      return {...x,...m,deep,trap,radarMode:'gainers'};
    });
  }
  function recentTapeWindow(symbol,ms=60000){
    const samples=state.continuous?.tape?.get(symbol)?.samples||[];
    if(!samples.length)return [];
    const cut=Date.now()-ms;
    return samples.filter(s=>s.ts>=cut&&s.price>0);
  }
  function pctFromSamples(samples,backMs){
    if(samples.length<2)return null;
    const last=samples.at(-1),target=last.ts-backMs;
    const base=sampleAtOrBefore(samples,target);
    return base?.price>0?((last.price/base.price)-1)*100:null;
  }
  function volumeSpikeFromSamples(samples){
    if(samples.length<6)return null;
    const last=samples.at(-1);
    const split=Math.max(3,Math.floor(samples.length*.45));
    const a=samples.slice(0,split),b=samples.slice(split);
    const a0=a[0],a1=a.at(-1),b0=b[0],b1=b.at(-1);
    const rateA=rateBetween(a0,a1),rateB=rateBetween(b0,b1);
    if(rateA<=0)return null;
    return rateB/rateA;
  }
  function multiRadarBreakoutMetrics(x,deep){
    const tape=state.continuous?.tape?.get(x.symbol)?.samples||[];
    const last=tape.at(-1);
    let move1m=null,move3m=null,move60=null,volumeSpike=null;
    if(last&&tape.length>=3){
      move1m=pctFromSamples(tape,60000);
      move3m=pctFromSamples(tape,180000);
      move60=pctFromSamples(tape,30000);
      volumeSpike=liveMinuteVolumeSpike(x.symbol);
    }
    const bars=(state.multiRadar.klineBars.get(x.symbol)||state.klinesCache[x.symbol]?.['1m']||[]);
    if((move1m==null||move3m==null||volumeSpike==null)&&bars.length>=3){
      const close=bars.at(-1)?.c||x.last;
      const b1=bars.at(-2)?.c,b3=bars.length>=4?bars.at(-4)?.c:null;
      if(move1m==null&&b1>0)move1m=(close/b1-1)*100;
      if(move3m==null&&b3>0)move3m=(close/b3-1)*100;
      if(volumeSpike==null){
        const cachedBars=state.multiRadar.klineBars.get(x.symbol)||bars;
        const cur=cachedBars.at(-1),closed=cachedBars.filter(b=>b.closed&&b.q>0&&b.t!==cur?.t).slice(-MULTI_RADAR.volumeBaselineBars);
        if(cur?.q>0&&closed.length>=8){
          const avg=closed.reduce((a,b)=>a+num(b.q),0)/closed.length;
          const curElapsed=cur.dataSource==='rest'?60:Math.max(10,Math.min(60,(Date.now()-num(cur.t,Date.now()))/1000));
          if(avg>0)volumeSpike=(num(cur.q)/(curElapsed/60))/avg;
        }
      }
      if(move60==null&&b1>0)move60=move1m||0;
    }
    const localSamples=tape.slice(-25).filter(s=>s.price>0);
    const localHigh=localSamples.length?Math.max(...localSamples.map(s=>s.price)):num(x.high,0);
    const highDistance=localHigh>0?Math.max(0,(localHigh-num(x.last))/localHigh*100):null;
    const acceleration=(num(move1m)||0)-(num(move3m)||0)/3;
    const liquidity=clamp(35+Math.log10(Math.max(num(x.quoteVolume),1e6))*7,0,100);
    const mom=clamp(50+(num(move1m)||0)*55+(num(move3m)||0)*22,0,100);
    const vol=volumeSpike==null?50:clamp(45+(volumeSpike-1)*32,0,100);
    const proximity=highDistance==null?45:clamp(100-highDistance*70,0,100);
    const flow=multiRadarFlowScore(x,deep);
    const smart=deep?clamp(num(deep.score,50)*.7+num(deep.quality,50)*.3,0,100):clamp(mom*.55+vol*.25+flow*.20,0,100);
    let score=liquidity*.16+mom*.31+vol*.28+proximity*.12+flow*.13;
    if(acceleration>0)score+=4;
    if(num(x.priceChangePercent)<-8)score-=5;
    const trap=multiRadarTrap(deep);
    if(trap!=null&&trap>=55)score-=Math.min(14,(trap-45)*.22);
    return {score:clamp(score),liquidity,momentum:mom,flow,smart,trap,ret1h:multiRadarOneHourReturn(x.symbol),move1m,move3m,move60,volumeSpike,highDistance,proximity:highDistance==null?45:clamp(100-highDistance*70,0,100),acceleration,breakoutReady:score>=MULTI_RADAR.breakoutMinScore};
  }
  function multiRadarBreakoutLeaders(){
    const rows=[];
    for(const x of Object.values(state.marketsBySymbol||{})){
      if(!isRadarSymbolEligible(x,'breakout',multiRadarSource()==='cached'))continue;
      const deep=state.deepRows.find(r=>r.symbol===x.symbol)||state.smartScan.results.find(r=>r.symbol===x.symbol)||null;
      const m=multiRadarBreakoutMetrics(x,deep);
      const hasMomentum=num(m.move1m)>=MULTI_RADAR.breakoutMinMove1m||num(m.move3m)>=MULTI_RADAR.breakoutMinMove3m;
      const hasVolume=m.volumeSpike!=null&&m.volumeSpike>=MULTI_RADAR.breakoutMinVolumeSpike;
      const nearHigh=m.highDistance!=null&&m.highDistance<=MULTI_RADAR.breakoutMaxHighDistance;
      if(!hasMomentum||!hasVolume||!nearHigh||m.score<MULTI_RADAR.breakoutMinScore)continue;
      if(m.trap!=null&&m.trap>=70)continue;
      rows.push({...x,...m,deep,radarMode:'breakout'});
    }
    rows.sort((a,b)=>b.score-a.score || num(b.volumeSpike)-num(a.volumeSpike) || num(b.move1m)-num(a.move1m));
    return rows.slice(0,10);
  }
  function multiRadarLeaders(){
    return state.multiRadar.mode==='breakout'?multiRadarBreakoutLeaders():multiRadarTopGainers();
  }
  function multiRadarSource(){
    const now=Date.now();
    const freshCount=multiRadarFreshMarketCount(MULTI_RADAR.wsStaleMs);
    const multiWsFresh=state.multiRadar.wsLastMessage&&now-state.multiRadar.wsLastMessage<MULTI_RADAR.wsStaleMs&&freshCount>0;
    if(multiWsFresh)return 'ws';
    if(state.multiRadar.restLastSuccess&&now-state.multiRadar.restLastSuccess<RADAR_FILTERS.restFreshMs&&Object.keys(state.marketsBySymbol||{}).length)return 'rest';
    if(state.multiRadar.cacheAt&&now-state.multiRadar.cacheAt<=RADAR_FILTERS.cachedMarketMaxAgeMs&&Object.keys(state.marketsBySymbol||{}).length)return 'cached';
    return 'offline';
  }
  function multiRadarCardHTML(x,index){
    const trap=x.trap==null?'—':`${Math.round(x.trap)}`;
    const flowCls=x.flow>56?'buy':x.flow<44?'sell':'';
    const flowLabel=x.flow>56?t('multiRadarBuyFlow'):x.flow<44?t('multiRadarSellFlow'):t('multiRadarBalanced');
    const scoreCls=x.score>=78?'':x.score>=62?'watch':'risk';
    const isBreakout=x.radarMode==='breakout';
    const modeTitle=isBreakout?t('multiRadarModeBreakout'):t('multiRadarModeGainers');
    const h1=x.ret1h==null?'—':pct(x.ret1h);
    const moveShort=x.move1m==null?'—':pct(x.move1m);
    const volSpike=x.volumeSpike==null?'—':`${x.volumeSpike.toFixed(2)}×`;
    const prox=x.highDistance==null?'—':`${x.highDistance.toFixed(2)}%`;
    const mode=x.deep?`DEEP · ${esc(x.deep.timeframe||'5m')}`:'TICKER';
    const isSel=x.symbol===state.currentSymbol;
    const source=multiRadarSource();
    return `<article class="multi-card ${isSel?'selected':''}" data-multi-symbol="${esc(x.symbol)}" data-symbol="${esc(x.symbol)}" data-rx-symbol="${esc(x.symbol)}" role="button" tabindex="0" aria-label="${esc(x.symbol)} ${esc(modeTitle)}">
      <div class="multi-card-top"><div><div style="display:flex;align-items:center;gap:6px"><span class="multi-rank">#${index+1}</span><span class="multi-symbol">${esc(x.symbol)}</span></div><div class="multi-sub" data-multi-source>${esc(mode)} · ${esc(source.toUpperCase())}</div></div><div><div class="multi-price" data-multi-price>${fmt(x.last)}</div><div class="multi-delta ${x.priceChangePercent>=0?'gain':'loss'}" data-multi-change>${pct(x.priceChangePercent)} / 24h</div></div></div>
      <div class="multi-mode-badge ${isBreakout?'breakout':'gainers'}" data-multi-mode-badge>${isBreakout?'🚀':'📈'} ${modeTitle}</div>
      <div class="multi-bars">
        <div class="multi-bar-row"><span>${isBreakout?t('multiRadarShortMomentum'):t('multiRadarLiquidity')}</span><div class="multi-bar"><div class="multi-bar-fill" data-multi-liquidity style="width:${isBreakout?x.momentum:x.liquidity}%"></div></div><b class="multi-bar-value" data-multi-liquidity-value>${Math.round(isBreakout?x.momentum:x.liquidity)}</b></div>
        <div class="multi-bar-row"><span>${isBreakout?t('multiRadarVolumeSpike'):t('multiRadarMomentum')}</span><div class="multi-bar"><div class="multi-bar-fill ${isBreakout?'warn':''}" data-multi-momentum style="width:${isBreakout?clamp((num(x.volumeSpike)-1)*60+45):x.momentum}%"></div></div><b class="multi-bar-value" data-multi-momentum-value>${isBreakout&&x.volumeSpike!=null?x.volumeSpike.toFixed(2)+'×':Math.round(x.momentum)}</b></div>
        <div class="multi-bar-row"><span>${isBreakout?t('multiRadarProximity'):t('multiRadarFlow')}</span><div class="multi-bar"><div class="multi-bar-fill ${flowCls==='sell'?'bad':flowCls==='buy'?'':'warn'}" data-multi-flow style="width:${isBreakout?x.proximity:x.flow}%"></div></div><b class="multi-bar-value" data-multi-flow-value>${Math.round(isBreakout?x.proximity:x.flow)}</b></div>
      </div>
      <div class="multi-metrics"><div class="multi-metric"><span>${isBreakout?t('multiRadarShortMomentum'):t('multiRadar1h')}</span><b class="${(isBreakout?x.move1m:x.ret1h)!=null&&num(isBreakout?x.move1m:x.ret1h)>=0?'gain':(isBreakout?x.move1m:x.ret1h)!=null?'loss':''}" data-multi-1h>${isBreakout?moveShort:h1}</b></div><div class="multi-metric"><span>${isBreakout?t('multiRadarVolumeSpike'):t('multiRadarTrap')}</span><b class="${isBreakout&&x.volumeSpike!=null&&x.volumeSpike>=1.35?'gain':!isBreakout&&x.trap!=null&&x.trap>=55?'loss':'gain'}" data-multi-trap>${isBreakout?volSpike:trap}</b></div><div class="multi-metric"><span>${isBreakout?t('multiRadarBreakoutScore'):t('multiRadarScore')}</span><b data-multi-score>${Math.round(x.score)}/100</b></div></div>
      <div class="multi-flow"><span class="multi-flow-badge ${flowCls}" data-multi-flow-label>◉ ${esc(flowLabel)}</span><span class="multi-score ${scoreCls}" data-multi-score-badge>${modeTitle} · ${Math.round(x.score)}</span></div>
      <div class="multi-action"><button type="button" class="btn ghost" data-follow-symbol="${esc(x.symbol)}">◎ ${t('multiRadarWatch')}</button><button type="button" class="btn primary" data-deep-symbol="${esc(x.symbol)}">🔬 ${t('multiRadarDeep')}</button></div>
    </article>`;
  }
  function multiRadarLeaderKey(leaders){return `${state.multiRadar.mode}::${leaders.map(x=>x.symbol).join('|')}`;}
  function patchMultiRadarCard(card,x,index){
    if(!card)return;
    const source=multiRadarSource(),isBreakout=state.multiRadar.mode==='breakout',modeTitle=isBreakout?t('multiRadarModeBreakout'):t('multiRadarModeGainers');
    const rank=card.querySelector('.multi-rank');if(rank)rank.textContent=`#${index+1}`;
    const price=card.querySelector('[data-multi-price]'),chg=card.querySelector('[data-multi-change]'),sub=card.querySelector('[data-multi-source]');
    if(price){const old=price.textContent;const next=fmt(x.last);price.textContent=next;if(old!==next){price.classList.remove('multi-flash');void price.offsetWidth;price.classList.add('multi-flash');}}
    if(chg){chg.textContent=`${pct(x.priceChangePercent)} / 24h`;chg.className=`multi-delta ${x.priceChangePercent>=0?'gain':'loss'}`;}
    if(sub)sub.textContent=`${x.deep?`DEEP · ${x.deep.timeframe||'5m'}`:'TICKER'} · ${source.toUpperCase()}`;
    const badge=card.querySelector('[data-multi-mode-badge]');if(badge){badge.textContent=`${isBreakout?'🚀':'📈'} ${modeTitle}`;badge.className=`multi-mode-badge ${isBreakout?'breakout':'gainers'}`;}
    const setBar=(barSel,valSel,v)=>{const b=card.querySelector(barSel),l=card.querySelector(valSel);if(b)b.style.width=`${clamp(v)}%`;if(l)l.textContent=String(Math.round(clamp(v)));};
    setBar('[data-multi-liquidity]','[data-multi-liquidity-value]',isBreakout?x.momentum:x.liquidity);
    const volumeBar=isBreakout?(x.volumeSpike==null?50:clamp((num(x.volumeSpike)-1)*60+45)):x.momentum;
    const volumeLabel=isBreakout?(x.volumeSpike==null?'—':`${x.volumeSpike.toFixed(2)}×`):String(Math.round(x.momentum));
    setBar('[data-multi-momentum]','[data-multi-momentum-value]',volumeBar);const vl=card.querySelector('[data-multi-momentum-value]');if(vl)vl.textContent=volumeLabel;
    setBar('[data-multi-flow]','[data-multi-flow-value]',isBreakout?(x.highDistance==null?50:clamp(100-num(x.highDistance)*70)):x.flow);
    const fbar=card.querySelector('[data-multi-flow]');if(fbar)fbar.className=`multi-bar-fill ${!isBreakout&&x.flow<44?'bad':isBreakout?'warn':x.flow>56?'':'warn'}`;
    const one=card.querySelector('[data-multi-1h]');if(one){const val=isBreakout?x.move1m:x.ret1h;one.textContent=val==null?'—':pct(val);one.className=val==null?'':val>=0?'gain':'loss';}
    const trap=card.querySelector('[data-multi-trap]');if(trap){trap.textContent=isBreakout?(x.volumeSpike==null?'—':`${x.volumeSpike.toFixed(2)}×`):(x.trap==null?'—':String(Math.round(x.trap)));trap.className=isBreakout?'gain':x.trap==null?'':x.trap>=55?'loss':'gain';}
    const score=card.querySelector('[data-multi-score]'),scoreBadge=card.querySelector('[data-multi-score-badge]');
    if(score)score.textContent=`${Math.round(x.score)}/100`;
    if(scoreBadge){scoreBadge.textContent=`${modeTitle} · ${Math.round(x.score)}`;scoreBadge.className=`multi-score ${x.score>=78?'':x.score>=62?'watch':'risk'}`;}
    const flowLabel=card.querySelector('[data-multi-flow-label]');if(flowLabel){flowLabel.textContent=`◉ ${x.flow>56?t('multiRadarBuyFlow'):x.flow<44?t('multiRadarSellFlow'):t('multiRadarBalanced')}`;flowLabel.className=`multi-flow-badge ${x.flow>56?'buy':x.flow<44?'sell':''}`;}
    card.classList.toggle('selected',x.symbol===state.currentSymbol);
  }
  function renderMultiRadar(forceStructure=false){
    const host=$('multiRadarGrid');if(!host)return;
    const n=Math.min(10,Math.max(5,num($('multiRadarCount')?.value,state.multiRadar.count||8)||8));state.multiRadar.count=n;
    const leaders=multiRadarLeaders().slice(0,n);state.multiRadar.leaders=leaders;
    const key=multiRadarLeaderKey(leaders),existing=host.querySelectorAll('.multi-card');
    const needsStructure=forceStructure||key!==state.multiRadar.renderKey||existing.length!==leaders.length;
    if(needsStructure){
      state.multiRadar.renderKey=key;
      host.innerHTML=leaders.length?leaders.map(multiRadarCardHTML).join(''):`<div class="multi-empty">📡<br>${state.multiRadar.mode==='breakout'?t('multiRadarNoBreakout'):t('multiRadarNoData')}</div>`;
    }else{
      leaders.forEach((x,i)=>patchMultiRadarCard(host.querySelector(`.multi-card[data-symbol="${CSS.escape(x.symbol)}"]`)||host.children[i],x,i));
    }
    const source=multiRadarSource(),updated=source==='ws'?state.multiRadar.wsLastMessage:source==='rest'?state.multiRadar.restLastSuccess:source==='cached'?state.multiRadar.cacheAt:state.multiRadar.lastUpdated,age=updated?formatDataAge(updated):'—';
    const meta=$('multiRadarMeta');
    if(meta){const modeLabel=state.multiRadar.mode==='breakout'?t('multiRadarModeBreakout'):t('multiRadarModeGainers');const hint=state.multiRadar.mode==='breakout'?t('multiRadarBreakoutHint'):t('multiRadarGainersHint');meta.textContent=`${modeLabel} · ${leaders.length} ${t('multiRadarActive')} · ${t('multiRadarUpdated')} ${age} · ${source==='ws'?t('multiRadarWs'):source==='rest'?t('multiRadarRest'):source==='cached'?t('multiRadarCached'):t('multiRadarOffline')}`;meta.title=hint;}
    multiRadarSetBusy(state.multiRadar.running,source);
    renderSymbolSelectionHighlights();state.multiRadar.dirty=false;
  }
  function scheduleMultiRadarPaint(){
    state.multiRadar.dirty=true;
    if(state.multiRadar.paintTimer)return;
    state.multiRadar.paintTimer=setTimeout(()=>{state.multiRadar.paintTimer=null;if(state.multiRadar.dirty)renderMultiRadar(false);},MULTI_RADAR.paintMs);
  }
  function multiRadarConsumeWS(data){
    const raw=data?.data&&data.stream?data.data:data;
    const list=Array.isArray(raw)?raw:[raw];
    let touchedSelected=false,accepted=0;
    for(const d of list){
      if(!d?.s)continue;
      const tk=normalizeBinanceTicker(d);
      if(!(tk.last>0))continue;
      mergeTicker(tk);accepted++;
      if(state.currentSymbol===tk.symbol&&state.selected?.symbol===tk.symbol){
        state.selected={...state.selected,price:tk.last,priceChangePercent:tk.priceChangePercent,quoteVolume:tk.quoteVolume,bidPrice:tk.bidPrice,askPrice:tk.askPrice,bidQty:tk.bidQty,askQty:tk.askQty,eventTime:tk.eventTime||Date.now(),liveAt:tk.eventTime||Date.now()};
        if(state.selected.last)state.selected.last.c=tk.last;
        scheduleSelectedLivePaint(220);
        touchedSelected=true;
      }
    }
    if(accepted){
      state.multiRadar.lastUpdated=Date.now();
      state.multiRadar.wsLastMessage=Date.now();
      state.multiRadar.restFailures=0;
      state.multiRadar.error='';
      state.multiRadar.dirty=true;
      scheduleMultiRadarPaint();
      if(touchedSelected)scheduleBriefingRefresh(1800);
    }
  }
  function scheduleMultiRadarWSReconnect(){
    clearTimeout(state.multiRadar.wsReconnectTimer);
    const attempt=Math.max(0,state.multiRadar.wsAttempt||0);
    const delay=Math.min(60000,2500+Math.min(30000,attempt*2500));
    state.multiRadar.wsAttempt=Math.min(attempt+1,12);
    state.multiRadar.wsReconnectTimer=setTimeout(()=>connectMultiRadarWS(),delay);
  }
  function connectMultiRadarWS(){
    clearTimeout(state.multiRadar.wsReconnectTimer);
    const generation=++state.multiRadar.wsGeneration;
    const current=state.multiRadar.ws;
    if(current){try{current.close(1000,'replace')}catch{}state.multiRadar.ws=null;}
    const offset=(state.multiRadar.wsAttempt||0)%BINANCE_WS_BASES.length;
    const bases=[...BINANCE_WS_BASES.slice(offset),...BINANCE_WS_BASES.slice(0,offset)];
    let idx=0;
    const openNext=()=>{
      if(generation!==state.multiRadar.wsGeneration)return;
      if(navigator.onLine===false){multiRadarSetBusy(false,'offline');scheduleMultiRadarWSReconnect();return;}
      if(idx>=bases.length){multiRadarSetBusy(false,state.markets.length?'cached':'offline');scheduleMultiRadarWSReconnect();return;}
      const base=bases[idx++];let ws;
      try{ws=new WebSocket(`${base}?streams=${encodeURIComponent('!ticker@arr')}`);}catch{openNext();return;}
      state.multiRadar.ws=ws;
      ws.onopen=()=>{
        if(generation!==state.multiRadar.wsGeneration||state.multiRadar.ws!==ws)return;
        state.multiRadar.wsAttempt=0;state.multiRadar.wsOpenedAt=Date.now();multiRadarSetBusy(false,'ws');
      };
      ws.onmessage=e=>{
        if(generation!==state.multiRadar.wsGeneration||state.multiRadar.ws!==ws)return;
        try{multiRadarConsumeWS(JSON.parse(e.data));}catch{}
      };
      ws.onerror=()=>{};
      ws.onclose=()=>{
        if(generation!==state.multiRadar.wsGeneration||state.multiRadar.ws!==ws)return;
        state.multiRadar.ws=null;state.multiRadar.wsOpenedAt=0;scheduleMultiRadarWSReconnect();
      };
    };
    openNext();
  }
  function multiRadarWatchdog(){
    const now=Date.now();
    if(state.multiRadar.ws && state.multiRadar.ws.readyState===1 && state.multiRadar.wsOpenedAt && (!state.multiRadar.wsLastMessage || now-state.multiRadar.wsLastMessage>MULTI_RADAR.wsStaleMs)){
      try{state.multiRadar.ws.close(4000,'stale-watchdog')}catch{}
      state.multiRadar.ws=null;
      state.multiRadar.wsLastMessage=0;
      scheduleMultiRadarWSReconnect();
      if(!state.multiRadar.restLastSuccess || now-state.multiRadar.restLastSuccess>10000){
        clearTimeout(state.multiRadar.pollTimer);
        state.multiRadar.pollTimer=setTimeout(multiRadarPoll,60);
      }
      multiRadarSetBusy(false,state.markets.length?'cached':'offline');
    }
    if(state.multiRadar.mode==='breakout' && state.multiRadar.klineWs && state.multiRadar.klineWs.readyState===1 && state.multiRadar.klineWsLastMessage && now-state.multiRadar.klineWsLastMessage>MULTI_RADAR.klineWsStaleMs){
      closeBreakoutKlineWS();scheduleKlineMonitorReconnect();
    }
  }
  async function fetchBinanceTickerUniverseResilient(){
    const t0=performance.now();
    try{
      const urls=binanceUrls('/api/v3/ticker/24hr').slice(0,MULTI_RADAR.restMaxUrls);
      const d=await firstJSONRace(urls,{timeout:MULTI_RADAR.restTimeout,retries:0,maxUrls:urls.length});
      noteProvider('binance',true,performance.now()-t0); return d;
    }catch(e){
      noteProvider('binance',false,performance.now()-t0);
      const r=await resilientTickers('binance');
      return (r.rows||[]).map(x=>({...x,dataSource:r.provider==='binance'?'market':'fallback-exchange',fallbackFor:r.provider==='binance'?undefined:'binance'}));
    }
  }
  async function multiRadarPoll(){
    if(state.multiRadar.running)return;
    const source=multiRadarSource();
    const freshCount=multiRadarFreshMarketCount(MULTI_RADAR.wsStaleMs);
    const leaders=state.multiRadar.mode==='gainers'?multiRadarTopGainers():multiRadarBreakoutLeaders();
    const enoughWs=source==='ws'&&(state.multiRadar.mode==='gainers'?leaders.length>=Math.min(MULTI_RADAR.minGainersReady,state.multiRadar.count):freshCount>=10);
    if(enoughWs){
      clearTimeout(state.multiRadar.pollTimer);
      state.multiRadar.pollTimer=setTimeout(multiRadarPoll,MULTI_RADAR.pollMs);
      return;
    }
    if(navigator.onLine===false){
      multiRadarSetBusy(false,multiRadarSource()==='cached'?'cached':'offline');
      renderMultiRadar(false);
      state.multiRadar.pollTimer=setTimeout(multiRadarPoll,MULTI_RADAR.pollMs);
      return;
    }
    state.multiRadar.running=true;multiRadarSetBusy(true,'rest');
    try{
      // Use the same resilient provider layer as the main scanner. Do not relabel
      // fallback rows as Binance: the actual provider must survive into deep analysis.
      const preferred=$('exchangeSelect')?.value||'binance';
      const result=await resilientTickers(preferred);
      const tickers=(result?.rows||[]).filter(x=>x?.symbol&&x.last>0);
      const actualProvider=result?.provider||preferred;
      if(!tickers.length)throw new Error('EMPTY_TICKER_RESPONSE');
      for(const x of tickers){
        if(x.symbol&&(x.quoteAsset==='USDT'||x.quoteAsset==='USD')) {
          mergeTicker({...x,provider:actualProvider,requestedProvider:preferred,actualProvider});
        }
      }
      const receivedAt=Date.now();
      state.multiRadar.lastUpdated=receivedAt;
      state.multiRadar.restLastSuccess=receivedAt;
      state.multiRadar.cacheAt=receivedAt;
      state.multiRadar.restFailures=0;
      state.multiRadar.error='';
      state.multiRadar.dirty=true;
      markLiveData('live_rest',`${t('liveRest')} · ${String(actualProvider).toUpperCase()}${actualProvider!==preferred?' fallback':''} · multi-radar`);
      saveLiveSnapshot();
      renderMarkets();
      scheduleMultiRadarPaint();
    }catch(e){
      state.multiRadar.restFailures=Math.min(99,(state.multiRadar.restFailures||0)+1);
      state.multiRadar.error=String(e?.message||e);
      const fallback=multiRadarSource();
      multiRadarSetBusy(false,fallback==='cached'?'cached':'offline');
      if(fallback==='cached')markLiveData('cached',`${t('liveCached')} · ${formatDataAge(state.multiRadar.cacheAt)}`);
    }finally{
      state.multiRadar.running=false;
      renderMultiRadar(false);
      clearTimeout(state.multiRadar.pollTimer);
      state.multiRadar.pollTimer=setTimeout(multiRadarPoll,MULTI_RADAR.pollMs);
    }
  }
  function startMultiRadar(){
    clearTimeout(state.multiRadar.pollTimer);clearTimeout(state.multiRadar.pulseTimer);clearTimeout(state.multiRadar.paintTimer);clearTimeout(state.multiRadar.wsReconnectTimer);clearTimeout(state.selectedPaintTimer);
    if(!Object.keys(state.marketsBySymbol||{}).length)loadLiveSnapshot();
    state.multiRadar.dirty=true;renderMultiRadar(true);
    connectMultiRadarWS();
    refreshBreakoutKlineMonitor(true);
    const pulse=()=>{multiRadarWatchdog();refreshBreakoutKlineMonitor(false);if(!state.multiRadar.dirty)renderMultiRadar(false);state.multiRadar.pulseTimer=setTimeout(pulse,MULTI_RADAR.metaMs);};
    state.multiRadar.pulseTimer=setTimeout(pulse,MULTI_RADAR.metaMs);
    state.multiRadar.pollTimer=setTimeout(()=>multiRadarPoll().catch(()=>{}),MULTI_RADAR.initialPollDelayMs);
  }
  function stopMultiRadar(){
    clearTimeout(state.multiRadar.pollTimer);clearTimeout(state.multiRadar.pulseTimer);clearTimeout(state.multiRadar.paintTimer);clearTimeout(state.multiRadar.wsReconnectTimer);clearTimeout(state.multiRadar.klineWsReconnectTimer);clearTimeout(state.multiRadar.klineRefreshTimer);clearTimeout(state.selectedPaintTimer);
    state.multiRadar.pollTimer=null;state.multiRadar.pulseTimer=null;state.multiRadar.paintTimer=null;state.multiRadar.wsReconnectTimer=null;
    ++state.multiRadar.wsGeneration;
    if(state.multiRadar.ws){try{state.multiRadar.ws.close(1000,'stop')}catch{}state.multiRadar.ws=null;}
    closeBreakoutKlineWS();state.multiRadar.klineSymbols=[];state.multiRadar.klineLastMessage=0;
  }

  // ---------- UI rendering ----------
  function signalMeta(signal){ if(signal==='EARLY_ALERT')return {cls:'early',text:t('signalEarly')}; if(signal==='WATCH')return {cls:'watch',text:t('signalWatch')};return {cls:'neutral',text:t('signalNo')}; }
  function scanScoreClass(score){ return score>=83?'score-high':score>=72?'score-mid':'score-low'; }
  function multiTpHTML(x){
    const entry=num(x?.entry,0), sl=num(x?.sl,0), risk=Math.max(Math.abs(entry-sl),1e-12);
    const tp1=num(x?.tp1,entry+risk*1.25), tp2=num(x?.tp2,entry+risk*2), tp3=num(x?.tp3,entry+risk*2.75);
    const rr1=Math.abs(tp1-entry)/risk,rr2=Math.abs(tp2-entry)/risk,rr3=Math.abs(tp3-entry)/risk;
    const conf=Math.round(clamp(x?.confidence ?? x?.forensic?.confidence ?? x?.quality ?? 0,0,100));
    const type=x?.tradeType==='SHORT_TERM'?t('shortType'):t('mediumType');
    return `<div class="forensic-section multi-tp-wrap"><div class="multi-tp-head"><div><h3>${t('multiTpTitle')}</h3><div class="multi-tp-sub">${t('multiTpSubtitle')}</div></div><div class="plan-meta-row"><span class="plan-meta">${t('confidence')}: <b>${conf}%</b></span><span class="plan-meta">${t('tradeType')}: <b>${type}</b></span></div></div><div class="multi-tp-grid"><div class="tp-card t1"><span class="tp-tag">TP1</span><button type="button" class="tp-copy" data-copy-price="${esc(String(tp1))}">${t('copy')}</button><div class="tp-price">${fmt(tp1)}</div><div class="tp-rr">RR ${rr1.toFixed(2)}x</div></div><div class="tp-card t2"><span class="tp-tag">TP2</span><button type="button" class="tp-copy" data-copy-price="${esc(String(tp2))}">${t('copy')}</button><div class="tp-price">${fmt(tp2)}</div><div class="tp-rr">RR ${rr2.toFixed(2)}x</div></div><div class="tp-card t3"><span class="tp-tag">TP3</span><button type="button" class="tp-copy" data-copy-price="${esc(String(tp3))}">${t('copy')}</button><div class="tp-price">${fmt(tp3)}</div><div class="tp-rr">RR ${rr3.toFixed(2)}x</div></div></div><div class="plan-meta-row"><span class="plan-meta">${t('entry')}: <b>${fmt(entry)}</b></span><span class="plan-meta">${t('sl')}: <b>${fmt(sl)}</b></span><span class="plan-meta">${t('riskReward')}: <b>1:${rr3.toFixed(2)}</b></span></div></div>`;
  }
  function smcDetailsHTML(x,d){
    const s=x?.rows||[]; const st=x?.structure||{};
    if(!s.length)return `<div class="smc-card"><b>${t('smcTitle')}</b><div class="note" style="margin-top:8px">${t('noData')}</div></div>`;
    const look=s.slice(-18,-1); const hi=Math.max(...look.map(a=>a.h)), lo=Math.min(...look.map(a=>a.l)); const last=s.at(-1);
    const upperSweep=last.h>hi && last.c<hi, lowerSweep=last.l<lo && last.c>lo;
    const sweep=upperSweep&&lowerSweep?t('doubleSweep'):upperSweep||lowerSweep?t('liquiditySweep'):(d.block.type==='DEMAND'?t('smcDemand'):d.block.type==='SUPPLY'?t('smcSupply'):t('smcBalance'));
    const ev=st.event?`${st.event.type} · ${st.event.direction}`:t('noStructureEvent');
    let fvg=t('noFvg');
    for(let i=Math.max(1,s.length-12);i<s.length-1;i++){const a=s[i-1],c=s[i+1];if(a.h<c.l){fvg=t('bullishFvg');break;}if(a.l>c.h){fvg=t('bearishFvg');break;}}
    const structure=st.bias==='BULLISH'?`${t('bull')} · ${t('smcDemand')}`:st.bias==='BEARISH'?`${t('bear')} · ${t('smcSupply')}`:t('smcBalance');
    return `<div class="smc-card"><div class="forensic-title"><div><h3>${t('smcTitle')}</h3><div class="small muted">${t('liveSelection')}</div></div><span class="gateway-pill">SMC</span></div><div class="smc-grid"><div class="smc-item"><span>${t('liquiditySweep')}</span><b>${esc(sweep)}</b></div><div class="smc-item"><span>${t('eventState')}</span><b>${esc(ev)}</b></div><div class="smc-item"><span>FVG</span><b>${esc(fvg)}</b></div><div class="smc-item"><span>${t('structureState')}</span><b>${esc(structure)}</b></div></div></div>`;
  }
  function renderActiveAssetHeader(symbol,source='list'){
    const host=$('activeAssetHome'); if(!host)return;
    const provider=state.marketsBySymbol?.[symbol]?.provider||state.selected?.exchange||$('exchangeSelect')?.value||'binance'; const px=state.marketsBySymbol?.[symbol]?.last||state.selected?.price||0;
    host.innerHTML=`<div class="active-asset-banner"><div class="active-asset-main"><span class="active-asset-dot"></span><div><b>${esc(t('activeAsset'))}: ${esc(symbol)}</b><small>${esc(t('selectedFrom'))}: ${esc(source)} · ${px?fmt(px):'—'}</small></div></div><span class="gateway-pill">${esc(provider.toUpperCase())}</span></div>`;
  }
  function renderSymbolSelectionHighlights(){
    els('#radarTable [data-symbol]').forEach(r=>r.classList.toggle('selected-row',r.dataset.symbol===state.currentSymbol));
    els('.asset-card[data-symbol]').forEach(r=>r.classList.toggle('selected',r.dataset.symbol===state.currentSymbol));
    els('#multiRadarGrid .multi-card[data-symbol]').forEach(r=>r.classList.toggle('selected',r.dataset.symbol===state.currentSymbol));
    els('#smartOpportunityOutput [data-symbol]').forEach(r=>r.classList.toggle('selected',r.dataset.symbol===state.currentSymbol));
  }
  function renderFeaturedSelection(x,{commit=true}={}){
    if(!x)return;
    if(commit){state.currentSymbol=x.symbol;writeJSON(KEYS.currentSymbol,state.currentSymbol);}
    const host=$('featuredBody'); const sm=signalMeta(x.signal);
    if($('featuredSymbol'))$('featuredSymbol').textContent=x.symbol;
    if($('featuredSignal')){$('featuredSignal').className=`signal-chip ${sm.cls}`;$('featuredSignal').textContent=sm.text;}
    if(host)host.innerHTML=compactSetupHTML(x);
    renderActiveAssetHeader(commit?x.symbol:(state.currentSymbol||x.symbol),commit?'featured':'featured-preview');
    renderSymbolSelectionHighlights();
  }
  async function selectActiveAsset(symbol,{openSignal=true,refresh=true,source='list'}={}){
    const s=String(symbol||'').trim().toUpperCase().replace(/[\s\/_-]/g,'');
    if(!s)return null;
    const token=++state.selectionToken;
    state.currentSymbol=s;
    writeJSON(KEYS.currentSymbol,s);
    const liveTicker=state.marketsBySymbol?.[s]||null;
    renderActiveAssetHeader(s,source);
    renderSymbolSelectionHighlights();
    if(openSignal){
      const analysisSymbol=$('analysisSymbol');if(analysisSymbol)analysisSymbol.value=s;
      goTab('signal');
    }
    const cached=state.deepRows.find(x=>x.symbol===s)||state.smartScan.results.find(x=>x.symbol===s)||null;
    // Immediate response: active symbol + cached/ticker snapshot first, live analysis second.
    if(cached){
      state.selected={...cached};
      state.structure=cached.structure||((cached.rows?.length>=8)?detectStructure(cached.rows):null);
      state.fakeout=cached.fakeout||null;state.deepDive=cached.forensic||cached.deepDive||null;
      renderStructurePanel(state.structure);
      if(openSignal){
        $('analysisOutput').innerHTML=analysisHTML(state.selected);
        if(state.selected.rows?.length)drawChart(state.selected.rows);
        wireAnalysisActions(state.selected);
      }
      renderFeaturedSelection(state.selected);
      scheduleBriefingRefresh(250);
    }else if(liveTicker){
      const p=num(liveTicker.last,0);
      const small={symbol:s,price:p,last:{c:p,o:num(liveTicker.open,p),h:num(liveTicker.high,p),l:num(liveTicker.low,p)},priceChangePercent:num(liveTicker.priceChangePercent),quoteVolume:num(liveTicker.quoteVolume),bidPrice:num(liveTicker.bidPrice),askPrice:num(liveTicker.askPrice),bidQty:num(liveTicker.bidQty),askQty:num(liveTicker.askQty),mode:'live_ticker',timeframe:$('analysisTf')?.value||$('scanTf')?.value||'5m',eventTime:num(liveTicker.eventTime,Date.now()),liveAt:num(liveTicker.eventTime,Date.now())};
      state.selected={...state.selected,...small, symbol:s};
      if(state.selected.rows?.length>=8)state.structure=detectStructure(state.selected.rows);
      renderStructurePanel(state.structure||null);
      renderActiveAssetHeader(s,source);renderSymbolSelectionHighlights();
      if(openSignal)$('analysisOutput').innerHTML=`<div class="panel"><div class="empty-state">${esc(s)} · ${fmt(p)}<br><span class="small muted">${t('scanReady')}</span></div></div>`;
      scheduleBriefingRefresh(250);
    }else if(openSignal){
      $('analysisOutput').innerHTML=`<div class="panel"><div class="empty-state">${esc(s)}<br><span class="small muted">${t('scanReady')}</span></div></div>`;
      renderStructurePanel(null);
    }
    if(token!==state.selectionToken)return null;
    if(!refresh && cached)return cached;
    try{
      const provider=state.marketsBySymbol?.[s]?.provider||$('exchangeSelect')?.value||$('analysisExchange')?.value||'binance';
      const tf=$('analysisTf')?.value||$('scanTf')?.value||'5m';
      const live=await deepAnalyze(provider,s,tf,{withFlow:true});
      if(token!==state.selectionToken || state.currentSymbol!==s)return null;
      state.selected=live;state.structure=live.structure||((live.rows?.length>=8)?detectStructure(live.rows):null);state.fakeout=live.fakeout;state.deepDive=live.forensic;
      state.deepRows=[live,...state.deepRows.filter(x=>x.symbol!==s)].slice(0,24);
      renderStructurePanel(state.structure);
      renderFeaturedSelection(live);
      renderSelectedLive();
      renderRadarTable(state.deepRows);
      renderRadarMetrics(Math.max(1,state.markets.length),state.deepRows);
      if(openSignal){$('analysisOutput').innerHTML=analysisHTML(live);drawChart(live.rows);wireAnalysisActions(live);}
      saveAlert(live);renderAlerts();renderResultsCenter();
      if(provider==='binance')connectSelectedWS(s,tf);
      markLiveData('live_rest',`${t('liveRest')} · ${s}`);appHealthy();
      scheduleBriefingRefresh(250);
      refreshSelectedMTF(live,token).catch(()=>{});
      return live;
    }catch(e){
      if(token!==state.selectionToken || state.currentSymbol!==s)return null;
      if(cached){
        state.selected={...cached};
        state.structure=cached.structure||((cached.rows?.length>=8)?detectStructure(cached.rows):null);
        renderStructurePanel(state.structure);
        if(openSignal){$('analysisOutput').innerHTML=analysisHTML(state.selected);if(state.selected.rows?.length)drawChart(state.selected.rows);wireAnalysisActions(state.selected);}
        renderFeaturedSelection(state.selected);
        scheduleBriefingRefresh(250);
        markLiveData(state.markets.length?'cached':'offline');
        return state.selected;
      }
      if(state.selected?.symbol===s&&liveTicker){renderSelectedLive();renderStructurePanel(state.structure||null);markLiveData(state.markets.length?'cached':'offline');return state.selected;}
      renderStructurePanel(state.structure||null);
      $('analysisOutput').innerHTML=`<div class="panel"><div class="empty-state">${t('liveFailed')}<br><span class="small muted">${t('neverFake')}</span></div></div>`;
      scheduleBriefingRefresh(250);
      markLiveData(state.markets.length?'cached':'offline');toast(t('liveFailed'));return null;
    }
  }

    function mtfDirection(sig){return sig.score>=70?'BULLISH':sig.score<=40?'BEARISH':'NEUTRAL';}
  function renderMTFConsensus(m){
    if(!m?.rows?.length)return '';
    return `<div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('mtfConsensusTitle')}</b><span class="gateway-pill">${esc(m.consensusLabel)} · ${Math.round(m.consensusScore)}/100</span></div><div class="indicator-grid" style="margin-top:9px">${m.rows.map(r=>`<div class="indicator"><span>${esc(r.tf)}</span><b class="${r.direction==='BULLISH'?'gain':r.direction==='BEARISH'?'loss':''}">${esc(r.direction)}</b><small>${Math.round(r.score)}/100</small></div>`).join('')}</div><div class="small muted" style="margin-top:8px">${t('mtfAgreement')} ${Math.round(m.agreement)}% · ${t('mtfWeights')}.</div></div>`;
  }
  async function fetchMTFConsensus(provider,symbol){
    const tfs=['1m','5m','15m','1h'],weights={"1m":0.10,"5m":0.20,"15m":0.30,"1h":0.40};
    const settled=await Promise.allSettled(tfs.map(tf=>fetchKlines(provider,symbol,tf,90)));
    const rows=[];
    settled.forEach((r,i)=>{if(r.status!=='fulfilled'||!r.value?.length)return;const f=coreFeatures(r.value);const s=scoreFeatures(f);rows.push({tf:tfs[i],score:s.score,direction:mtfDirection(s)});});
    if(!rows.length)throw new Error('MTF unavailable');
    const totalWeight=rows.reduce((a,r)=>a+(weights[r.tf]||0),0)||1;
    const consensusScore=rows.reduce((a,r)=>a+r.score*(weights[r.tf]||0),0)/totalWeight;
    const consensusLabel=mtfDirection({score:consensusScore});
    const agreement=rows.reduce((a,r)=>a+(r.direction===consensusLabel?(weights[r.tf]||0):0),0)/totalWeight*100;
    return {rows,consensusScore,agreement,consensusLabel};
  }
  async function refreshSelectedMTF(base,token){
    if(!base?.symbol||token!==state.selectionToken)return;
    const mtf=await fetchMTFConsensus(base.exchange||'binance',base.symbol);
    if(token!==state.selectionToken||state.currentSymbol!==base.symbol||!state.selected)return;
    state.selected={...state.selected,mtf};
    const out=$('analysisOutput');
    if(out&&$('signal')?.classList.contains('active')){out.innerHTML=analysisHTML(state.selected);drawChart(state.selected.rows);wireAnalysisActions(state.selected);}
  }

  async function copyPrice(value){
    const v=String(value??'').trim(); if(!v)return;
    try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(v);else{const ta=document.createElement('textarea');ta.value=v;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}toast(`${t('copied')}: ${v}`);}catch{toast(v);}
  }
  function renderRadarTable(rows){
    const filtered=rows.filter(x=>x.score>=num($('signalMin').value,60));
    if(!filtered.length){$('radarTable').innerHTML=`<div class="empty-state">${t('noData')}</div>`;return;}
    $('radarTable').innerHTML=`<table class="rx-table"><thead><tr><th>${state.lang==='ar'?'العملة':'Asset'}</th><th>${state.lang==='ar'?'السعر':'Price'}</th><th>5m</th><th>15m</th><th>${t('vol')}</th><th>RSI</th><th>${t('trapShort')}</th><th>Score</th><th>${t('strength')}</th><th>${state.lang==='ar'?'الحالة':'Signal'}</th></tr></thead><tbody>${filtered.map(x=>{const sm=signalMeta(x.signal);return `<tr class="clickable ${x.symbol===state.currentSymbol?'selected-row':''}" data-symbol="${esc(x.symbol)}" data-rx-symbol="${esc(x.symbol)}" role="button" tabindex="0" aria-label="${esc(x.symbol)}"><td class="sym-cell"><b>${esc(x.symbol)}</b><small>${esc(x.mode)}</small></td><td class="num">${fmt(x.price)}</td><td class="num ${x.ret5>=0?'gain':'loss'}">${pct(x.ret5)}</td><td class="num ${x.ret15>=0?'gain':'loss'}">${pct(x.ret15)}</td><td class="num">${x.volumeRatio.toFixed(2)}x</td><td class="num"><span class="paper-pill ${x.fakeout?.level==='HIGH'?'loss':x.fakeout?.level==='MEDIUM'?'':'win'}">${Math.round(x.fakeout?.score||0)}</span></td><td><span class="score-badge ${scanScoreClass(x.score)}">${Math.round(x.score)}</span></td><td class="num">${Math.round(x.quality)}%</td><td><span class="signal-tag ${sm.cls==='early'?'signal-early':sm.cls==='watch'?'signal-watch':'signal-no'}">${sm.text}</span></td></tr>`}).join('')}</tbody></table>`;
    renderSymbolSelectionHighlights();
  }
  function renderRadarMetrics(universe,rows){
    $('dashUniverse').textContent=universe.toLocaleString('en-US'); $('dashCandidates').textContent=rows.length; const early=rows.filter(x=>x.signal==='EARLY_ALERT').length; $('dashEarly').textContent=early; $('dashTop').textContent=rows[0]?rows[0].symbol:'—';$('dashTopFoot').textContent=rows[0]?`Score ${Math.round(rows[0].score)}`:'—'; $('dashCandidatesFoot').textContent=rows.length?`${Math.min(rows.length,12)} deep`:'Deep scan';
    const q=rows.length?rows.reduce((a,x)=>a+x.quality,0)/rows.length:0; $('dashUniverseFoot').textContent=state.live?t('modeLive'):state.markets.length?t('modeCached'):t('modeWaiting'); $('dashEarlyFoot').textContent=`Score ≥ 83 · ${Math.round(q)}% avg quality`;
    const top=rows[0]; const featured=state.currentSymbol&&rows.find(x=>x.symbol===state.currentSymbol)||top; if(featured){state.structure=featured.structure||detectStructure(featured.rows);renderStructurePanel(state.structure);renderFeaturedSelection(featured,{commit:!state.currentSymbol||state.currentSymbol===featured.symbol});}else renderStructurePanel(state.structure||null);
    const dq=els('[data-deepquick]')[0]; if(dq)dq.onclick=()=>selectActiveAsset(dq.dataset.deepquick,{openSignal:true,refresh:true,source:'featured'});
    const btc=rows.find(x=>x.symbol==='BTCUSDT'); const alt=rows.filter(x=>x.symbol!=='BTCUSDT'); const btcV=btc?btc.score:50,altV=alt.length?alt.reduce((a,x)=>a+x.score,0)/alt.length:50,regime=clamp((btcV*.55+altV*.45)); $('regimeFill').style.width=`${regime}%`; $('regimeChip').textContent=regime>=70?t('bull'):regime<=40?t('bear'):t('neutral'); $('regimeChip').className=`signal-chip ${regime>=70?'early':regime<=40?'watch':'neutral'}`; $('btcRegime').textContent=btc?`${Math.round(btc.score)}/100`:t('noData');$('altRegime').textContent=alt.length?`${Math.round(altV)}/100`:t('noData');$('marketWarnings').innerHTML=(top?.conflicts||[]).slice(0,3).map(x=>`<div class="note-item">⚠ ${esc(x)}</div>`).join('') || `<div class="note-item">✓ ${t('noConflict')}</div>`;
  }

  function compactSetupHTML(x){
    const sm=signalMeta(x.signal);return `<div class="analysis-hero"><div class="signal-box"><div class="label">${t('strength')}</div><div class="big-signal">${Math.round(x.score)}/100</div><div class="sub">${Math.round(x.quality)}% ${t('quality')} · ${Math.round(x.confidence||x.quality||0)}% ${t('confidence')} · ${esc(x.horizon)}</div></div><div class="price-grid"><div class="price-box"><span>${t('entry')}</span><b>${fmt(x.entry)}</b></div><div class="price-box"><span>${t('sl')}</span><b>${fmt(x.sl)}</b></div><div class="price-box"><span>TP1</span><b>${fmt(x.tp1)}</b></div><div class="price-box"><span>TP2</span><b>${fmt(x.tp2)}</b></div><div class="price-box"><span>TP3</span><b>${fmt(x.tp3||x.tp2)}</b></div><div class="price-box"><span>${t('rr')}</span><b>${num(x.rr3,x.rr||2.75).toFixed(2)}x</b></div></div></div>${multiTpHTML(x)}<div class="reason-grid">${x.reasons.slice(0,7).map(r=>`<span class="reason">${esc(r)}</span>`).join('')}</div><div class="paper-notice">🪤 ${t('trapScore')}: <b>${Math.round(x.fakeout?.score||0)}/100</b> · ${esc(x.fakeout?.action||'')}</div><div class="sim-actions" style="margin-top:8px"><button class="btn ghost" data-deepquick="${esc(x.symbol)}">🔬 ${t('deepDiveNav')}</button></div>`;
  }

  function sparklineHTML(symbol){const arr=state.klinesCache[symbol]?.[state.selectedStream?.tf||'5m']||[];const vals=arr.slice(-18).map(x=>x.c).filter(v=>v>0);if(vals.length<2)return '<span class="sparkline-empty">LIVE</span>';const lo=Math.min(...vals),hi=Math.max(...vals);return vals.map(v=>`<i style="height:${Math.max(8,((v-lo)/(hi-lo||1))*90)}%"></i>`).join('');}
  function renderMarkets(){
    const sort=state.sort; let arr=[...state.markets];
    if(sort==='gain')arr.sort((a,b)=>b.priceChangePercent-a.priceChangePercent); else if(sort==='volume')arr.sort((a,b)=>b.quoteVolume-a.quoteVolume); else if(sort==='score'&&state.deepRows.length){const score={};state.deepRows.forEach(x=>score[x.symbol]=x.score);arr.sort((a,b)=>(score[b.symbol]||0)-(score[a.symbol]||0));} else arr.sort((a,b)=>(Math.abs(b.priceChangePercent)*1.8+b.quoteVolume/5e6)-(Math.abs(a.priceChangePercent)*1.8+a.quoteVolume/5e6));
    $('marketGrid').innerHTML=arr.slice(0,30).map(x=>`<article class="asset-card ${x.symbol===state.currentSymbol?'selected':''}" data-symbol="${esc(x.symbol)}" role="button" tabindex="0"><div class="asset-top"><b>${esc(x.symbol.replace(/USDT$/,''))}</b><span class="${x.priceChangePercent>=0?'gain':'loss'}">${pct(x.priceChangePercent)}</span></div><div class="asset-price">${fmt(x.last)}</div><div class="sparkline">${sparklineHTML(x.symbol)}</div><div class="asset-meta"><span>${t('volume')}: ${fmt(x.quoteVolume)}</span><span>${x.provider?esc(String(x.provider).toUpperCase()):''}${x.fallbackFor?' · FALLBACK':''}</span></div></article>`).join('') || `<div class="empty-state">${t('noData')}</div>`;
    renderMultiRadar();
    renderSymbolSelectionHighlights();
  }
  function fakeoutHTML(x){const z=x||{score:50,level:'MEDIUM',direction:'NONE',type:'NONE',reasons:[],evidence:[],action:'WAIT'};const cls=z.level==='HIGH'?'high':z.level==='MEDIUM'?'med':'low';return `<div class="trap-grid"><div class="trap-card ${cls}"><span>${t('trapScore')}</span><b>${Math.round(z.score)}/100</b></div><div class="trap-card"><span>${t('trapVerdict')}</span><b>${z.verdict||'—'}</b></div><div class="trap-card"><span>${state.lang==='ar'?'النوع':'Type'}</span><b>${esc(z.type||'—')}</b></div><div class="trap-card"><span>${state.lang==='ar'?'الاتجاه':'Direction'}</span><b>${esc(z.direction||'—')}</b></div></div><div class="trap-meter"><div class="trap-meter-fill" style="width:${clamp(z.score)}%"></div></div><div class="trap-evidence">${(z.reasons||[]).slice(0,7).map(r=>`<span class="reason">${esc(r)}</span>`).join('')}</div><div class="paper-notice" style="margin-top:8px">${t('trapHint')}<br><b>${esc(z.action||'')}</b></div>`;}
  function analysisHTML(x){
    const sm=signalMeta(x.signal); const indicators=[['RSI',x.rsi.toFixed(1)],['EMA20',fmt(x.e20)],['EMA50',fmt(x.e50)],['ATR',pct(x.atrPct)],[t('vol'),x.volumeRatio.toFixed(2)+'x'],[t('breakout'),pct(x.breakout)],...(x.flow?.whales?[['Whale',Math.round(x.flow.whales.score)+'/100']]:[])];
    const reasons=x.reasons.slice(0,14).map(r=>`<span class="reason">${esc(r)}</span>`).join(''); const conflicts=x.conflicts.length?`<div class="risk-note" style="margin-top:9px">⚠ ${x.conflicts.map(esc).join(' · ')}</div>`:'';
    return `<div class="panel analysis-card"><div class="section-head"><div><div class="eyebrow">${esc(x.exchange.toUpperCase())} · ${esc(x.timeframe)}</div><h2>${esc(x.symbol)} · ${fmt(x.price)}</h2></div><span class="signal-chip ${sm.cls}">${sm.text}</span></div><div class="active-asset-banner"><div class="active-asset-main"><span class="active-asset-dot"></span><div><b>${esc(t('activeAsset'))}: ${esc(x.symbol)}</b><small>${esc(t('liveSelection'))}</small></div></div><span class="gateway-pill">${esc(x.mode||t('modeLive'))}</span></div><div class="analysis-hero" style="margin-top:12px"><div class="signal-box"><div class="label">${t('strength')}</div><div class="big-signal">${Math.round(x.score)}/100</div><div class="sub">${Math.round(x.quality)}% ${t('quality')} · ${Math.round(x.confidence||x.quality||0)}% ${t('confidence')}</div></div><div class="price-grid"><div class="price-box"><span>${t('entry')}</span><b>${fmt(x.entry)}</b></div><div class="price-box"><span>${t('entryZone')}</span><b>${fmt(x.entryLow)}–${fmt(x.entryHigh)}</b></div><div class="price-box"><span>${t('sl')}</span><b>${fmt(x.sl)}</b></div><div class="price-box"><span>TP1</span><b>${fmt(x.tp1)}</b></div><div class="price-box"><span>TP2</span><b>${fmt(x.tp2)}</b></div><div class="price-box"><span>TP3</span><b>${fmt(x.tp3||x.tp2)}</b></div></div></div>${renderMTFConsensus(x.mtf)}<div class="panel chart-card" style="margin-top:10px"><div class="section-head"><h3>${t('indicators')}</h3><span class="muted">${x.mode}</span></div><canvas id="signalCanvas" width="900" height="330"></canvas></div><div class="indicator-grid" style="margin-top:10px">${indicators.map(([a,b])=>`<div class="indicator"><span>${a}</span><b>${b}</b></div>`).join('')}</div><div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('liveTape')}</b><span class="gateway-pill">${t('liveSource')}</span></div><div class="indicator-grid" style="margin-top:9px"><div class="indicator"><span>24h ${t('volume')}</span><b>${fmt(x.quoteVolume||0)} USDT</b></div><div class="indicator"><span>24h ${t('change')}</span><b class="${x.priceChangePercent>=0?'gain':'loss'}">${pct(x.priceChangePercent||0)}</b></div><div class="indicator"><span>Bid / Ask</span><b>${fmt(x.liveDepth?.bids?.[0]?.[0]||x.bidPrice||0)} / ${fmt(x.liveDepth?.asks?.[0]?.[0]||x.askPrice||0)}</b></div><div class="indicator"><span>${t('dataAge')}</span><b>${formatDataAge(x.liveAt||x.eventTime||Date.now())}</b></div></div></div><div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('trapTitle')}</b><span class="briefing-chip ${x.fakeout?.level==='HIGH'?'red':x.fakeout?.level==='MEDIUM'?'yellow':'green'}">${t('trapScore')}: ${Math.round(x.fakeout?.score||0)}/100</span></div>${fakeoutHTML(x.fakeout)}</div><div style="margin-top:10px">${smcDetailsHTML(x,x.forensic||deepDiveAnalysis(x.rows,x,x.flow,x.structure,x.fakeout))}</div><div class="forensic-section" style="margin-top:10px">${deepDiveHTML(x)}</div><div class="panel" style="margin-top:10px"><b>${t('reasons')}</b><div class="reason-grid">${reasons}</div>${conflicts}</div><div class="panel" style="margin-top:10px"><div class="section-head"><div><b>${t('simulatorTitle')}</b><div class="small muted" style="margin-top:5px">${t('simulatorNote')}</div></div><div class="sim-actions"><button class="btn primary" id="analysisSimBtn">⚡ ${t('startSim')}</button><button class="btn ghost" id="analysisPaperBtn">🏆 ${t('paperTrade')}</button></div></div><div id="analysisSim" style="margin-top:9px"></div></div><div class="risk-note" style="margin-top:10px">${t('disclaimer')}</div></div>`;
  }

  function drawChart(rows){const c=$('signalCanvas');if(!c||!rows?.length)return;const ctx=c.getContext('2d'),w=c.width,h=c.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#071018';ctx.fillRect(0,0,w,h);const data=rows.slice(-70),hi=Math.max(...data.map(r=>r.h)),lo=Math.min(...data.map(r=>r.l)),scaleY=v=>h-25-(v-lo)/(hi-lo||1)*(h-55);ctx.strokeStyle='#142832';ctx.lineWidth=1;for(let i=1;i<5;i++){const y=20+i*(h-50)/5;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}const cw=w/data.length;data.forEach((r,i)=>{const x=i*cw+cw*.5,yo=scaleY(r.o),yc=scaleY(r.c),yh=scaleY(r.h),yl=scaleY(r.l);ctx.strokeStyle=r.c>=r.o?'#27e89a':'#ff5d6c';ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();ctx.fillStyle=r.c>=r.o?'#27e89a':'#ff5d6c';const body=Math.max(2,Math.abs(yc-yo));ctx.fillRect(x-cw*.26,Math.min(yo,yc),cw*.52,body);});}


  // ---------- Provider health + deterministic failover ----------
  const DATA_PROVIDER_ORDER=['binance','okx','bybit','gate'];
  const DATA_HEALTH_TTL=30000;
  function healthStore(){
    if(!state.dataHealth||typeof state.dataHealth!=='object')state.dataHealth={ts:0,running:false,results:{},online:0,total:0,best:null,error:'',lastGoodAt:0};
    return state.dataHealth;
  }
  function providerHealth(id){const h=healthStore().results&&healthStore().results[id];return h&&h.ok===true?(1000/Math.max(1,num(h.latencyMs,999))):-100;}
  function orderedProviders(preferred='binance'){
    const base=[preferred,...DATA_PROVIDER_ORDER.filter(x=>x!==preferred)],seen=new Set();
    return base.filter(x=>!seen.has(x)&&seen.add(x)).sort((a,b)=>{if(a===preferred&&b!==preferred)return -1;if(b===preferred&&a!==preferred)return 1;return providerHealth(b)-providerHealth(a);});
  }
  async function fetchDataHealth(force=false){
    const h=healthStore(); if(h.running)return h; if(!force&&h.ts&&Date.now()-h.ts<DATA_HEALTH_TTL)return h; h.running=true;
    try{
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),5000);
      const r=await fetch('/api/health?ts='+Date.now(),{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',signal:ctrl.signal});
      clearTimeout(timer); if(!r.ok)throw new Error('HEALTH_HTTP_'+r.status);
      const d=await r.json(),rows=Array.isArray(d.results)?d.results:[];
      h.ts=Date.now();h.total=rows.length;h.online=rows.filter(x=>x.ok).length;h.results=Object.fromEntries(rows.map(x=>[x.id,x]));
      h.best=rows.filter(x=>x.ok).sort((a,b)=>num(a.latencyMs,99999)-num(b.latencyMs,99999))[0]?.id||null;h.error='';h.lastGoodAt=Date.now();
    }catch(e){h.error=String(e?.message||e);h.ts=Date.now();}finally{h.running=false;renderDataHealth();}
    return h;
  }
  function renderDataHealth(){
    let host=$('rxDataHealth');
    if(!host){host=document.createElement('div');host.id='rxDataHealth';host.style.cssText='margin:8px 12px;padding:9px 10px;border:1px solid rgba(84,213,255,.16);border-radius:12px;background:rgba(7,16,24,.78);font:600 11px/1.45 system-ui,sans-serif;direction:rtl;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap';const strip=document.querySelector('.status-strip');if(strip?.parentNode)strip.parentNode.insertBefore(host,strip.nextSibling);else document.body.prepend(host);}
    const h=healthStore(),ar=state.lang==='ar',names={binance:'Binance',okx:'OKX',bybit:'Bybit',gate:'Gate',coinbase:'Coinbase',coingecko:'CoinGecko',binanceFutures:'Futures',yahoo:'Gold/Public'};
    const all=Object.values(h.results||{}),items=all.map(x=>{const dot=x.ok?'#27e89a':'#ff5d6c';const v=x.ok?(String(num(x.latencyMs,0))+'ms'):'DOWN';return '<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 5px 2px 0"><i style="width:7px;height:7px;border-radius:50%;background:'+dot+'"></i>'+String(names[x.id]||x.id)+'<b style="opacity:.65">'+v+'</b></span>';}).join('');
    host.innerHTML='<div><span style="opacity:.7">'+(ar?'صحة المصادر':'SOURCE HEALTH')+'</span> <b>'+h.online+'/'+h.total+'</b> · <span style="opacity:.7">'+(ar?'أفضل مسار':'best route')+':</span> <b>'+(h.best?(names[h.best]||h.best):'—')+'</b></div><div>'+(items||'<span style="opacity:.7">'+(ar?'جارٍ فحص المصادر…':'Checking providers…')+'</span>')+'</div>';
  }
  async function fetchAllTickersResilient(preferred='binance'){
    const providers=orderedProviders(preferred);let last=null;
    for(const p of providers){try{const data=await fetchAllTickers(p),usable=(data||[]).filter(x=>x?.symbol&&x.last>0);if(usable.length>=20){const fresh=usable.filter(x=>{const age=Date.now()-num(x.eventTime,Date.now());return age>=0&&age<=120000;});if(fresh.length>=20)return fresh.map(x=>({...x,requestedProvider:preferred,actualProvider:p,fallbackFor:p!==preferred?preferred:undefined,dataSource:p!==preferred?'fallback-exchange':'market',dataAgeMs:Date.now()-num(x.eventTime,Date.now())}));}}catch(e){last=e;}}
    throw last||new Error('NO_MARKET_PROVIDER');
  }
  setTimeout(()=>fetchDataHealth(true).catch(()=>{}),250);
  setInterval(()=>{if(document.visibilityState==='visible')fetchDataHealth(true).catch(()=>{});},60000);
  // ---------- Resilient live market heartbeat ----------
  let resilientPollTimer=null, resilientBusy=false;
  async function resilientMarketRefresh(){
    if(resilientBusy||document.visibilityState==='hidden')return;
    const selected=$('exchangeSelect')?.value||'binance';
    resilientBusy=true;
    try{
      const live=await fetchAllTickersResilient(selected);
      if(Array.isArray(live)&&live.length){
        const usable=live.filter(x=>x.last>0 && (x.quoteAsset==='USDT'||x.quoteAsset==='USD'));
        if(usable.length){
          state.marketsBySymbol=state.marketsBySymbol||{};
          usable.forEach(x=>{state.marketsBySymbol[x.symbol]={...(state.marketsBySymbol[x.symbol]||{}),...x,receivedAt:num(x.receivedAt,Date.now())};});
          const preferred=usable[0]?.provider||selected;
          const current=usable.slice().sort((a,b)=>num(b.quoteVolume)-num(a.quoteVolume));
          state.markets=current;
          state.exchangeLiveProvider=preferred;
          state.exchangeFallback=preferred!==selected;
          markLiveData('live_rest',t('liveRest')+' · '+String(preferred).toUpperCase()+(preferred!==selected?' fallback':'')+' · '+current.length.toLocaleString('en-US'));
          renderMarkets();
          renderSentiment(computeSentimentFromMarkets(current,null));
          renderRadarMetrics(current.length,state.deepRows||[]);
          if($('dataMode'))$('dataMode').textContent=preferred===selected?'LIVE '+String(preferred).toUpperCase():'FALLBACK '+String(preferred).toUpperCase();
          appHealthy();
        }
      }
    }catch(e){
      markLiveData(state.markets.length?'cached':'offline',state.markets.length?t('dataAge'):t('liveFailed'));
    }finally{resilientBusy=false;}
  }
  function startResilientMarketHeartbeat(){
    clearInterval(resilientPollTimer);
    resilientMarketRefresh().catch(()=>{});
    resilientPollTimer=setInterval(()=>{
      const wsFresh=state.ws?.ticker?.readyState===1 && state.ws?.lastMessage && Date.now()-num(state.ws.lastMessage,0)<=15000;
      if(!wsFresh)resilientMarketRefresh().catch(()=>{});
    },15000);
  }

  // ---------- Global Markets / Metals ----------
  const GLOBAL_ASSETS=[
    {symbol:'XAU/USD',label:'Gold',icon:'🥇'},
    {symbol:'XAG/USD',label:'Silver',icon:'🥈'},
    {symbol:'WTI/USD',label:'WTI',icon:'🛢️'},
    {symbol:'EUR/USD',label:'EUR/USD',icon:'💱'}
  ];
  async function fetchGlobalAsset(asset){
    const u='/api/metals?symbol='+encodeURIComponent(asset.symbol);
    const d=await fetchJSON(u,{timeout:6000,retries:0});
    return {...asset,...d};
  }
  function ensureGlobalMarketsPanel(){
    if($('rxGlobalMarkets'))return;
    const dash=$('dashboard');if(!dash)return;
    const wrap=document.createElement('section');wrap.id='rxGlobalMarkets';wrap.className='intel-panel';wrap.style.marginBottom='12px';
    wrap.innerHTML='<div class="intel-head"><div><div class="eyebrow">GLOBAL MARKETS DATA</div><h3>الأسواق العالمية والذهب</h3><p class="muted" style="margin:5px 0 0">البيانات تمر عبر بوابة خادم RadarX مع ختم المصدر والزمن؛ عند غياب المصدر تظهر N/A بدل رقم مصطنع.</p></div><button class="btn ghost" id="rxGlobalRefresh">↻ تحديث</button></div><div id="rxGlobalGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:10px"></div><div id="rxGlobalFoot" class="small muted" style="margin-top:8px"></div>';
    const anchor=dash.querySelector('.hero-dashboard')||dash.firstElementChild;
    if(anchor)anchor.after(wrap);else dash.prepend(wrap);
    $('rxGlobalRefresh').onclick=()=>refreshGlobalMarkets(true);
  }
  async function refreshGlobalMarkets(force=false){
    ensureGlobalMarketsPanel();
    const grid=$('rxGlobalGrid'),foot=$('rxGlobalFoot');if(!grid)return;
    if(!force&&state.globalMarkets?.ts&&Date.now()-state.globalMarkets.ts<30000)return state.globalMarkets;
    grid.innerHTML=GLOBAL_ASSETS.map(a=>'<div class="kpi"><div class="kpi-label">'+a.icon+' '+esc(a.label)+'</div><div class="kpi-value" data-global="'+esc(a.symbol)+'">—</div><div class="kpi-foot" data-global-meta="'+esc(a.symbol)+'">جارٍ التحديث…</div></div>').join('');
    const rr=await Promise.allSettled(GLOBAL_ASSETS.map(fetchGlobalAsset));
    const rows=rr.map((r,i)=>r.status==='fulfilled'?r.value:{...GLOBAL_ASSETS[i],ok:false,error:'unavailable'});
    state.globalMarkets={ts:Date.now(),rows};
    rows.forEach(x=>{
      const ps=[...document.querySelectorAll('[data-global]')].find(e=>e.getAttribute('data-global')===x.symbol);
      const ms=[...document.querySelectorAll('[data-global-meta]')].find(e=>e.getAttribute('data-global-meta')===x.symbol);
      if(ps)ps.textContent=x.ok?fmt(x.price):'N/A';
      if(ms)ms.textContent=x.ok?((x.source||'').toUpperCase()+(x.delayed?' · delayed':' · '+(x.quality==='provider-key'?'live':'indicative'))):'مصدر غير متاح';
    });
    if(foot)foot.textContent='آخر تحديث: '+new Date(state.globalMarkets.ts).toLocaleTimeString();
    return state.globalMarkets;
  }

  // ---------- Scan ----------
  async function scan(){
    if(state.busy)return; state.busy=true; appHealthy(); markLiveData('waiting'); const provider=$('exchangeSelect').value,tf=$('scanTf').value,minV=num($('minVolume').value,1e6),depthCount=Math.max(6,Math.min(20,num($('depthCount').value,12)));
    $('scanStatusText').textContent=t('scanReady');$('scanStatusSub').textContent=t('noData');$('scanProgress').style.width='8%';
    try{
      const liveResult=await resilientTickers(provider); const live=liveResult.rows; if(!live.length)throw new Error('NO_TICKERS');
      const filtered=live.filter(x=>x.baseAsset&&x.baseAsset.length>1&&(provider==='coinbase'?x.quoteAsset==='USD':x.quoteAsset==='USDT')&&x.quoteVolume>=minV&&!/(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)$/.test(x.baseAsset));
      filtered.sort((a,b)=>b.quoteVolume-a.quoteVolume); state.markets=filtered;state.marketsBySymbol={};filtered.forEach(x=>state.marketsBySymbol[x.symbol]=x);writeJSON('radarx_live_snapshot_v55',{ts:Date.now(),items:filtered.slice(0,3000)});markLiveData('live_rest',`${t('liveRest')} · ${filtered.length.toLocaleString('en-US')} pairs`);$('scanProgress').style.width='28%';renderMarkets();renderSentiment(computeSentimentFromMarkets(filtered,null));
      const actualProvider=liveResult.provider||live[0]?.provider||provider;
      const candidates=filtered.slice(0,depthCount),results=[]; for(let i=0;i<candidates.length;i+=3){const batch=candidates.slice(i,i+3);const r=await Promise.allSettled(batch.map(x=>deepAnalyze(x.provider||actualProvider,x.symbol,tf,{withFlow:true})));r.forEach(v=>{if(v.status==='fulfilled')results.push(v.value);});$('scanProgress').style.width=`${28+Math.round((Math.min(i+3,candidates.length)/candidates.length)*66)}%`;await sleep(40);}
      state.deepRows=results.sort((a,b)=>b.score-a.score);const activeScan=state.currentSymbol&&state.deepRows.find(x=>x.symbol===state.currentSymbol);state.structure=activeScan?.structure||state.deepRows[0]?.structure||null;state.fakeout=activeScan?.fakeout||state.deepRows[0]?.fakeout||null;if(activeScan){state.selected=activeScan;}renderStructurePanel(state.structure);renderRadarMetrics(filtered.length,state.deepRows);renderRadarTable(state.deepRows);renderMarkets();updatePaperFromMarkets(filtered);renderBriefing();renderPsychologyGuardian();saveLiveSnapshot();$('scanStatusText').textContent=t('liveUpdated');$('scanStatusSub').textContent=`${filtered.length.toLocaleString('en-US')} pairs · ${results.length} deep`;$('scanProgress').style.width='100%';state.deepRows.filter(x=>x.signal==='EARLY_ALERT').forEach(saveAlert);renderAlerts();toast(t('liveUpdated'));
      if(provider==='binance' && live.every(x=>x.provider==='binance'))openTickerWS(0);
    }catch(e){
      const cached=loadLiveSnapshot(); if(cached){renderMarkets();renderSentiment(computeSentimentFromMarkets(state.markets,null));renderRadarTable(state.deepRows||[]);$('scanStatusText').textContent=t('liveFailed');$('scanStatusSub').textContent=`${t('liveCached')} · ${formatDataAge(readJSON('radarx_live_snapshot_v55',{}).ts||0)}`;$('scanProgress').style.width='100%';}else{state.markets=[];state.deepRows=[];renderMarkets();renderRadarTable([]);renderSentiment();markLiveData('offline');$('scanStatusText').textContent=t('liveFailed');$('scanStatusSub').textContent=t('noApi');$('scanProgress').style.width='100%';toast(t('liveFailed'));}
    } finally {state.busy=false;renderBriefing();renderPsychologyGuardian();}
  }

  // ---------- Search & analysis ----------
  async function analyzeSelected(){
    const symbol=$('analysisSymbol').value.trim().toUpperCase().replace(/[\s\/_-]/g,''); if(!symbol)return toast('BTCUSDT');
    const provider=$('analysisExchange').value,tf=$('analysisTf').value; state.currentSymbol=symbol; writeJSON(KEYS.currentSymbol,symbol); renderActiveAssetHeader(symbol,'direct-analysis');
    return selectActiveAsset(symbol,{openSignal:true,refresh:true,source:'analysis'});
  }

  function searchAssets(){const q=$('assetSearchInput').value.trim().toUpperCase(); if(!q){$('signalMatches').innerHTML='';return;} const arr=state.markets.filter(x=>x.symbol.includes(q)||x.baseAsset.includes(q)).slice(0,10);$('signalMatches').innerHTML=arr.length?arr.map(x=>`<button class="match-item" data-symbol="${esc(x.symbol)}"><b>${esc(x.symbol)}</b><small>${fmt(x.last)} · ${pct(x.priceChangePercent)} · ${fmt(x.quoteVolume)}</small></button>`).join(''):`<div class="note">${t('searchNo')}</div>`;}

  async function analyzeFlow(){const provider=$('flowExchange').value,symbol=$('flowSymbol').value.trim().toUpperCase().replace(/[\s\/_-]/g,'');state.lastFlowSymbol=symbol;try{const [d,tdata]=await Promise.all([fetchDepth(provider,symbol,50),fetchTrades(provider,symbol,180)]);const f=flowFromData(d,tdata);state.lastFlow=f;renderFlow(f,'live');markLiveData('live_rest',`${t('liveRest')} · ${symbol}`);if(provider==='binance')connectSelectedWS(symbol,$('analysisTf').value);toast(t('liveUpdated'));}catch{renderFlow(null,'offline');markLiveData(state.markets.length?'cached':'offline');toast(t('liveFailed'));}}

  function renderFlow(f,mode){if(!f){$('flowOutput').innerHTML=`<div class="empty-state">${t('liveFailed')}<br><span class="small muted">${t('neverFake')}</span></div>`;return;}const ratio=f.buySell||0,imb=clamp(50+f.imbalance/2,0,100),side=f.imbalance>8?`✓ ${t('bidStrong')}`:f.imbalance<-8?`⚠ ${t('askStrong')}`:`• ${t('balancedBook')}`,w=f.whales||detectWhales({},[]),flowLabel=w.direction==='BUY_PRESSURE'?t('buyPressure'):w.direction==='SELL_PRESSURE'?t('sellPressure'):t('balancedBook');$('flowOutput').innerHTML=`<div class="flow-grid"><div class="flow-card"><span>${t('bidLiquidity')}</span><b class="gain">${fmt(f.bid)}</b></div><div class="flow-card"><span>${t('askLiquidity')}</span><b class="loss">${fmt(f.ask)}</b></div><div class="flow-card"><span>${t('imbalance')}</span><b>${f.imbalance.toFixed(1)}%</b></div><div class="flow-card"><span>${t('buySell')}</span><b>${ratio?ratio.toFixed(2)+'x':'—'}</b></div><div class="flow-card"><span>${t('cvdLabel')} proxy</span><b>${f.cvd.toFixed(1)}%</b></div></div><div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('orderFlowBalance')}</b><span class="muted">${mode==='live'?t('live'):t('offline')}</span></div><div class="flow-meter"><div class="fill" style="width:${imb}%"></div></div><div class="signal-flow-mini"><span class="mini-flow">${t('whaleScore')} <b>${Math.round(w.score)}</b></span><span class="mini-flow">${t('bigBuys')} <b>${w.bigBuys}</b></span><span class="mini-flow">${t('bigSells')} <b>${w.bigSells}</b></span><span class="mini-flow">${flowLabel}</span></div><div class="risk-note" style="margin-top:10px">${side} ${t('cvdNote')}</div></div>`;renderWhaleOutput(w,mode);}

  function renderWhaleOutput(w,mode){const total=(w.buyValue+w.sellValue)||1,buyPct=w.buyPressure||0,sellPct=w.sellPressure||0,top=w.top||[];const dir=w.direction==='BUY_PRESSURE'?`<span class="signal-tag signal-early">${t('buyPressure')}</span>`:w.direction==='SELL_PRESSURE'?`<span class="signal-tag signal-no">${t('sellPressure')}</span>`:`<span class="signal-tag signal-watch">${t('neutral')}</span>`; const biggest=w.biggest?`${w.biggest.buy?'🟢':'🔴'} ${fmt(w.biggest.notional)} USDT`: '—';$('whaleOutput').innerHTML=`<div class="whale-grid"><div class="whale-card buy"><span>${t('bigBuys')}</span><b>${w.bigBuys}</b></div><div class="whale-card sell"><span>${t('bigSells')}</span><b>${w.bigSells}</b></div><div class="whale-card"><span>${t('whaleNet')}</span><b class="${w.net>=0?'gain':'loss'}">${fmt(w.net)} USDT</b></div><div class="whale-card"><span>${t('whaleScore')}</span><b>${Math.round(w.score)}/100</b></div></div><div class="panel" style="margin-top:10px"><div class="section-head"><div><b>${dir}</b><div class="small muted" style="margin-top:7px">${t('biggest')}: ${biggest} · ${mode==='live'?t('live'):t('offline')}</div></div><span class="gateway-pill">${t('threshold')} ${fmt(w.threshold)} USDT</span></div><div class="whale-meter" style="margin-top:12px"><div class="buyfill" style="width:${clamp(buyPct)}%"></div><div class="sellfill" style="width:${clamp(sellPct)}%"></div></div><div class="flow-legend"><span><i class="legend-dot" style="background:var(--green)"></i>${t('bigBuys')}: ${buyPct.toFixed(1)}%</span><span><i class="legend-dot" style="background:var(--red)"></i>${t('bigSells')}: ${sellPct.toFixed(1)}%</span><span>${t('whaleReason')}</span></div></div>${top.length?`<div class="table-wrap"><table class="whale-table"><thead><tr><th>${t('rank')}</th><th>${t('symbol')}</th><th>${t('side')}</th><th>${t('notional')}</th></tr></thead><tbody>${top.map((x,i)=>`<tr><td>#${i+1}</td><td>${esc(state.lastFlowSymbol||'')}</td><td>${x.buy?'BUY':'SELL'}</td><td>${fmt(x.notional)}</td></tr>`).join('')}</tbody></table></div>`:''}`; }
  async function analyzeWhales(){const provider=$('flowExchange').value,symbol=$('flowSymbol').value.trim().toUpperCase().replace(/[\s\/_-]/g,''),limit=num($('whaleWindow').value,100),depth=num($('whaleDepth').value,50),minN=num($('whaleMin').value,25000);state.lastFlowSymbol=symbol;try{const [d,tr]=await Promise.all([fetchDepth(provider,symbol,depth),fetchTrades(provider,symbol,limit)]);const w=detectWhales(d,tr,minN);state.lastFlow={...flowFromData(d,tr)};renderWhaleOutput(w,'live');markLiveData('live_rest',`${t('liveRest')} · ${symbol}`);toast(t('liveUpdated'));}catch{renderWhaleOutput({score:0,bigBuys:0,bigSells:0,buyValue:0,sellValue:0,net:0,buyPressure:0,sellPressure:0,direction:'BALANCED',threshold:minN,biggest:null,top:[]},'offline');markLiveData(state.markets.length?'cached':'offline');toast(t('liveFailed'));}}

  function calcRisk(){const c=Math.max(0,num($('riskCapital').value)),rp=Math.max(0,num($('riskPct').value)),entry=num($('riskEntry').value),sl=num($('riskSLPrice').value),tp1=num($('riskTP1').value),tp2=num($('riskTP2').value),fee=num($('riskFee').value)/100,slip=num($('riskSlip').value)/100;if(!(c>0&&entry>0&&sl>0)||entry===sl){$('riskOutput').innerHTML=`<div class="risk-note">${state.lang==='ar'?'أدخل رأس المال وEntry وSL بقيم صحيحة.':'Enter valid capital, Entry and SL.'}</div>`;return;}const riskAmt=c*rp/100,distance=Math.abs(entry-sl),units=riskAmt/distance,notional=units*entry,stopPct=distance/entry*100,feeCost=notional*fee*2,slipCost=notional*slip*2,netRisk=riskAmt+feeCost+slipCost,rr1=Math.abs(tp1-entry)/distance,rr2=Math.abs(tp2-entry)/distance,reward1=Math.abs(tp1-entry)*units,reward2=Math.abs(tp2-entry)*units;$('riskOutput').innerHTML=`<div class="risk-summary"><div class="risk-stat"><span>${state.lang==='ar'?'مبلغ المخاطرة':'Risk amount'}</span><b>${fmt(riskAmt)} USDT</b></div><div class="risk-stat"><span>${state.lang==='ar'?'حجم الصفقة':'Position size'}</span><b>${fmt(notional)} USDT</b></div><div class="risk-stat"><span>${state.lang==='ar'?'الكمية':'Units'}</span><b>${fmt(units,8)}</b></div><div class="risk-stat"><span>${state.lang==='ar'?'SL %':'SL %'}</span><b>${stopPct.toFixed(2)}%</b></div><div class="risk-stat"><span>RR TP1</span><b>${rr1.toFixed(2)}x</b></div><div class="risk-stat"><span>RR TP2</span><b>${rr2.toFixed(2)}x</b></div><div class="risk-stat"><span>${state.lang==='ar'?'ربح TP1 النظري':'TP1 gross reward'}</span><b class="gain">${fmt(reward1)} USDT</b></div><div class="risk-stat"><span>${state.lang==='ar'?'ربح TP2 النظري':'TP2 gross reward'}</span><b class="gain">${fmt(reward2)} USDT</b></div></div><div class="risk-note" style="margin-top:10px">${state.lang==='ar'?'التكلفة التقريبية للرسوم + الانزلاق (دخول/خروج):':'Approx. round-trip fee + slippage cost:'} <b>${fmt(feeCost+slipCost)} USDT</b> · ${state.lang==='ar'?'التعرض النظري':'Theoretical notional'}: <b>${fmt(notional)} USDT</b>. ${t('disclaimer')}</div>`;}
  function useLastSignalInRisk(){const x=state.selected;if(!x)return toast(state.lang==='ar'?'حلل عملة أولاً.':'Analyze an asset first.');goTab('more');renderSub('lab');$('riskEntry').value=num(x.entry);$('riskSLPrice').value=num(x.sl);$('riskTP1').value=num(x.tp1);$('riskTP2').value=num(x.tp2);calcRisk();toast(`${x.symbol} · ${t('selected')}`);}

  function openPayment(plan){const cfg=readJSON(KEYS.settings,{}),links=cfg.checkout||{};const url=links[plan]||'';if(url&&/^https:\/\//i.test(url)){window.location.href=url;return;}const labels={weekly:state.lang==='ar'?'أسبوعي $3':'Weekly $3',monthly:state.lang==='ar'?'شهري $10':'Monthly $10',yearly:state.lang==='ar'?'سنوي $100':'Yearly $100'};$('modalBody').innerHTML=`<div class="eyebrow">CHECKOUT BRIDGE</div><h2>${labels[plan]||plan}</h2><p class="muted">${state.lang==='ar'?'هذه النسخة الواحدة لا تحتوي مفاتيح دفع سرية. افتح رابط Checkout مستضاف وآمن بعد وضعه في الإعدادات.':'This single-file build never stores payment secrets. Configure a hosted secure checkout URL in Settings.'}</p><div class="payment-modal-grid"><div class="payment-option"><h4>🌐 Hosted Checkout</h4><div class="checkout-url">${links[plan]?esc(links[plan]):'Not configured'}</div><button class="btn primary" style="margin-top:9px" id="modalCheckout">${state.lang==='ar'?'فتح الدفع':'Open checkout'}</button></div><div class="payment-option"><h4>🧪 Demo</h4><p class="pay-note">${state.lang==='ar'?'يستخدم للتجربة فقط ولا يحول أموالاً.':'For UX testing only; does not charge money.'}</p><button class="btn ghost" id="modalDemo">${t('demoUpgrade')}</button></div></div>`;$('modal').classList.remove('hidden');$('modalCheckout').onclick=()=>{if(url&&/^https:\/\//i.test(url))window.location.href=url;else toast(state.lang==='ar'?'ضع رابط الدفع في الإعدادات أولاً.':'Configure a checkout URL in Settings first.')};$('modalDemo').onclick=()=>{activateDemo(plan);$('modal').classList.add('hidden');};}

  // ---------- More tabs ----------
  function goTab(id){els('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));els('.screen').forEach(s=>s.classList.toggle('active',s.id===id));if(id==='more')renderMore();}
  function renderMore(){const active=$('#subcontent');if(!active)return; if(!active.dataset.ready){active.dataset.ready='1';renderSub('compare');} }
  function renderSub(kind){const out=$('subcontent'); if(!out)return; out.dataset.kind=kind;
    if(kind==='sentiment'){out.innerHTML=`<div class="subpanel"><div class="section-head"><h3>${t('sentimentTitle')}</h3><button class="btn ghost" id="sentimentRefresh">↻</button></div><div id="sentimentSub" style="margin-top:10px"></div></div>`;renderSentiment(state.sentiment);const wrap=$('sentimentSub');if(wrap){wrap.innerHTML=`<div class="gauge-wrap"><div class="gauge"><div class="gauge-needle" id="sentNeedle2"></div><div class="gauge-center"><div class="gauge-score" id="sentScore2">${state.sentiment.score==null?'—':Math.round(state.sentiment.score)}</div><div class="gauge-label">${sentimentText(state.sentiment.label)}</div></div></div><div><div class="sentiment-bar"><div class="sentiment-pin" id="sentPin2" style="left:${clamp(state.sentiment.score==null?50:state.sentiment.score)}%"></div></div><div class="source-note">${esc($('sentimentSourceNote')?.textContent||'')}</div><div class="sentiment-stats"><div class="tiny-stat"><span>BTC</span><b>${Math.round(state.sentiment.bthPrice||50)}/100</b></div><div class="tiny-stat"><span>${t('breadth')}</span><b>${Math.round(state.sentiment.breadth||50)}%</b></div><div class="tiny-stat"><span>F&G</span><b>${state.sentiment.fg==null?'—':Math.round(state.sentiment.fg)}</b></div></div></div></div>`;$('sentNeedle2').style.transform=`translateX(-50%) rotate(${(state.sentiment.score/100)*180-90}deg)`;}$('sentimentRefresh').onclick=()=>refreshSentiment(true);}
    else if(kind==='simulator'){out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('simulatorTitle')}</h3><div class="small muted">${t('simulatorNote')}</div></div><span class="gateway-pill">PAPER ONLY</span></div><div id="simulatorOutput" style="margin-top:10px"></div></div>`;renderSimulatorInto('simulatorOutput',state.selected);}
    else if(kind==='structure'){const sig=state.selected; if(!sig||!sig.rows?.length){out.innerHTML=`<div class="subpanel"><h3>${t('structureTitle2')}</h3><div class="empty-state">${t('noData')}</div></div>`;return;} state.structure=sig.structure||detectStructure(sig.rows);out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('structureTitle2')}</h3><div class="small muted">BOS = break of structure · CHoCH = change of character</div></div><span class="gateway-pill">${esc(sig.symbol)}</span></div><div id="structureSub" style="margin-top:10px"></div></div>`;const st=state.structure;const ev=st.event?`${st.event.type} · ${st.event.direction}`:t('noStructureEvent');$('structureSub').innerHTML=`<div class="structure-grid"><div class="structure-card"><span>${t('structureBias2')}</span><b>${st.bias==='BULLISH'?t('bull'):st.bias==='BEARISH'?t('bear'):t('neutral')}</b></div><div class="structure-card"><span>${t('lastStructure')}</span><b>${esc(ev)}</b></div><div class="structure-card"><span>${t('swingLevels')}</span><b>${st.highs.length} / ${st.lows.length}</b></div></div><div class="structure-event ${st.event?.direction==='BULLISH'?'bull':st.event?.direction==='BEARISH'?'bear':''}"><b>${esc(st.note)}</b><div class="small muted" style="margin-top:6px">${st.event?`${t('lastStructure')}: ${fmt(st.event.price)}`:'—'}</div></div>`;}
    else if(kind==='calendar'){out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('calendarTitle')}</h3><div class="small muted">${t('sourceCalendar')}</div></div><button class="btn ghost" id="calendarRefresh">↻ ${t('refreshCalendar')}</button></div><div id="calendarSub" style="margin-top:10px">${calendarHTML(state.calendar)}</div></div>`;$('calendarRefresh').onclick=loadRiskCalendar;loadRiskCalendar();}
    else if(kind==='deepdive'){const sig=state.selected||state.deepRows[0];if(!sig){out.innerHTML=`<div class="subpanel"><h3>${t('deepDiveTitle')}</h3><div class="empty-state">${t('noData')}</div></div>`;return;}out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('deepDiveTitle')}</h3><div class="small muted">${t('deepDiveSubtitle')}</div></div><span class="gateway-pill">${esc(sig.symbol)}</span></div><div style="margin-top:10px">${deepDiveHTML(sig)}</div></div>`;}
    else if(kind==='trap'){const sig=state.selected;if(!sig){out.innerHTML=`<div class="subpanel"><h3>${t('trapTitle')}</h3><div class="empty-state">${t('noData')}</div></div>`;return;}state.fakeout=sig.fakeout||detectFakeout(sig.rows,sig,sig.flow,sig.structure);out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('trapTitle')}</h3><div class="small muted">${t('trapHint')}</div></div><span class="gateway-pill">${esc(sig.symbol)}</span></div><div id="trapSub" style="margin-top:10px">${fakeoutHTML(state.fakeout)}</div><div class="paper-notice">${state.fakeout.level==='HIGH'?'🛑 ':state.fakeout.level==='MEDIUM'?'⚠️ ':'✅ '}${t('trapVerdict')}: <b>${esc(state.fakeout.verdict)}</b></div></div>`;}
    else if(kind==='psychology'){out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('psychologyTitle')}</h3><div class="small muted">${t('guardianHint')}</div></div><button class="btn danger" id="guardianResetBtn">↺ ${t('guardianReset')}</button></div><div id="psychologySub" style="margin-top:10px">${guardianHTML(updatePsychology())}</div></div>`;$('guardianResetBtn').onclick=()=>{state.paper.history=[];state.psychology={lossStreak:0,dailyLossPct:0,rapidEntries:0,status:'HEALTHY',cooldownUntil:0};paperPersist();renderPsychologyGuardian();renderSub('psychology');};}
    else if(kind==='briefing'){out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('briefingTitle')}</h3><div class="small muted">${t('briefingHint')}</div></div><button class="btn ghost" id="briefingSubRefresh">↻ ${t('refresh')}</button></div><div id="briefingSub" style="margin-top:10px"></div></div>`;renderBriefing();const b=state.briefing;const sub=$('briefingSub');if(sub)sub.innerHTML=$('dailyBriefing')?.innerHTML||'';$('briefingSubRefresh').onclick=()=>{refreshSentiment(true);renderBriefing();const z=$('briefingSub');if(z)z.innerHTML=$('dailyBriefing')?.innerHTML||'';toast(t('briefingUpdated'));};}
    else if(kind==='paper'){out.innerHTML=`<div class="subpanel"><div class="section-head"><div><h3>${t('paperTitle')}</h3><div class="small muted">${t('paperHint')}</div></div><span class="gateway-pill">${t('virtualOnly')}</span></div><div id="paperOutput" style="margin-top:10px"></div></div>`;renderPaper();}
    else if(kind==='compare'){out.innerHTML=`<div class="subpanel"><h3>${t('compare')}</h3><div class="two-col"><div class="field"><label>${t('symbol')}</label><input id="compareSymbol" value="BTCUSDT"></div><button class="btn primary" id="compareBtn">${t('refresh')}</button></div><div id="compareOutput" class="list-stack" style="margin-top:10px"></div></div>`;$('compareBtn').onclick=compareExchanges;$('compareSymbol').onkeydown=e=>{if(e.key==='Enter')compareExchanges();};}
    else if(kind==='news'){out.innerHTML=`<div class="subpanel"><div class="section-head"><h3>${t('news')}</h3><button class="btn ghost" id="newsBtn">↻</button></div><div id="newsOutput" class="list-stack"></div></div>`;$('newsBtn').onclick=loadNews;loadNews();}
    else if(kind==='alerts'){out.innerHTML=`<div class="subpanel"><div class="section-head"><h3>${t('alerts')}</h3><button class="btn danger" id="clearAlertsBtn">${t('clear')}</button></div><div id="moreAlerts" class="list-stack" style="margin-top:10px"></div></div>`;$('clearAlertsBtn').onclick=()=>{localStorage.removeItem(KEYS.alerts);renderAlerts();renderResultsCenter();};renderAlerts();}
    else if(kind==='lab'){out.innerHTML=`<div class="subpanel"><h3>${t('backtestTitle')}</h3><div class="analysis-select"><div class="field"><label>${t('symbol')}</label><input id="btSymbol" value="BTCUSDT"></div><div class="field"><label>${t('timeframe')}</label><select id="btTf"><option>1m</option><option selected>5m</option><option>15m</option><option>1h</option></select></div><div class="field"><label>${t('fee')}</label><input id="btFee" type="number" value="0.1" step="0.01"></div><div class="field"><label>${t('slip')}</label><input id="btSlip" type="number" value="0.05" step="0.01"></div><div class="field"><label>${t('tpRR')}</label><input id="btRR" type="number" value="2" step="0.1"></div></div><button class="btn primary" id="btRun" style="margin-top:10px">▶ ${t('run')}</button><div id="btOutput" style="margin-top:10px"></div></div><div class="subpanel" style="margin-top:10px"><div class="section-head"><h3>${t('riskTitle')}</h3><span class="gateway-pill">SPOT / NO LEVERAGE</span></div><div class="risk-pro-grid" style="margin-top:10px"><div class="field"><label>${t('capital')}</label><input id="riskCapital" type="number" value="100" min="0.01" step="0.01"></div><div class="field"><label>${t('riskPct')}</label><input id="riskPct" type="number" value="1" min="0.01" max="20" step="0.1"></div><div class="field"><label>${t('entry')}</label><input id="riskEntry" type="number" value="100" min="0" step="0.000001"></div><div class="field"><label>${t('sl')}</label><input id="riskSLPrice" type="number" value="99" min="0" step="0.000001"></div><div class="field"><label>TP1</label><input id="riskTP1" type="number" value="101.5" min="0" step="0.000001"></div><div class="field"><label>TP2</label><input id="riskTP2" type="number" value="103" min="0" step="0.000001"></div><div class="field"><label>${t('fee')}</label><input id="riskFee" type="number" value="0.1" min="0" step="0.01"></div><div class="field"><label>${t('slip')}</label><input id="riskSlip" type="number" value="0.05" min="0" step="0.01"></div></div><div class="commerce-actions" style="margin-top:10px"><button class="btn primary" id="riskRun">${t('calc')}</button><button class="btn ghost" id="riskUseSignal">${state.lang==='ar'?'استخدام آخر إشارة':'Use last signal'}</button></div><div id="riskOutput" style="margin-top:10px"></div></div>`;$('btRun').onclick=runBacktest;$('riskRun').onclick=calcRisk;$('riskUseSignal').onclick=useLastSignalInRisk;}
    else if(kind==='chart'){out.innerHTML=`<div class="subpanel"><h3>${t('chart')}</h3><div class="note">${t('securityNote')}</div><input id="chartInput" type="file" accept="image/*" style="margin-top:10px"><div id="chartPreview" style="margin-top:10px"></div></div>`;$('chartInput').onchange=renderChartPreview;}
    else if(kind==='settings'){const cfg=readJSON(KEYS.settings,{}),ck=cfg.checkout||{};out.innerHTML=`<div class="subpanel"><h3>${t('settings')}</h3><div class="two-col"><div><div class="note">${t('localOnly')}</div><div class="note" style="margin-top:8px">${t('securityNote')}</div></div><div><button class="btn ghost" id="notifyMore">${t('enableNotify')}</button><button class="btn danger" id="resetAll" style="margin-top:8px">${t('reset')}</button></div></div><div class="panel" style="margin-top:10px"><div class="section-head"><div><h3>${state.lang==='ar'?'روابط الدفع الآمن':'Secure checkout links'}</h3><span class="muted">${state.lang==='ar'?'ضع روابط Hosted Checkout فقط؛ لا تضع أسرار الدفع هنا.':'Use hosted checkout URLs only; never paste payment secrets here.'}</span></div></div><div class="analysis-select" style="margin-top:10px"><div class="field"><label>Weekly $3</label><input id="ckWeekly" placeholder="https://..." value="${esc(ck.weekly||'')}"></div><div class="field"><label>Monthly $10</label><input id="ckMonthly" placeholder="https://..." value="${esc(ck.monthly||'')}"></div><div class="field"><label>Yearly $100</label><input id="ckYearly" placeholder="https://..." value="${esc(ck.yearly||'')}"></div></div><button class="btn primary" style="margin-top:10px" id="saveCheckout">${state.lang==='ar'?'حفظ روابط الدفع':'Save checkout links'}</button></div></div>`;$('notifyMore').onclick=requestNotifications;$('resetAll').onclick=()=>{localStorage.removeItem(KEYS.profile);resetMembership();location.reload();};$('saveCheckout').onclick=()=>{const cur=readJSON(KEYS.settings,{});cur.checkout={weekly:$('ckWeekly').value.trim(),monthly:$('ckMonthly').value.trim(),yearly:$('ckYearly').value.trim()};writeJSON(KEYS.settings,cur);toast(state.lang==='ar'?'تم حفظ روابط الدفع.':'Checkout links saved.');};}
    else if(kind==='community'){out.innerHTML=`<div class="subpanel"><h3>${t('community')}</h3><div class="note">${t('communityHint')}</div><div class="two-col" style="margin-top:10px"><input id="postInput" placeholder="${t('message')}"><button class="btn primary" id="postBtn">${t('post')}</button></div><div id="communityOutput" class="list-stack" style="margin-top:10px"></div></div>`;$('postBtn').onclick=addPost;renderCommunity();}
  }
  async function compareExchanges(){const s=$('compareSymbol').value.trim().toUpperCase().replace(/[\s/_-]/g,'');const out=[];for(const p of Object.keys(PROVIDERS)){try{const x=await Promise.race([fetchTicker(p,s),sleep(2500).then(()=>{throw new Error('timeout')})]);if(x)out.push({p,x});}catch(e){out.push({p,error:e.message});}}$('compareOutput').innerHTML=out.map(r=>`<div class="compare-item"><b>${esc(PROVIDERS[r.p].name)}</b><div class="small muted">${r.x?`${fmt(r.x.last)} · ${pct(r.x.priceChangePercent)} · ${fmt(r.x.quoteVolume)}`:t('noApi')}</div></div>`).join('');}
  function loadNews(){$('newsOutput').innerHTML=`<div class="empty-state">${t('noData')}<br><span class="small muted">${t('liveSource')}</span></div>`;}

  // ---------- 4.1 Trap / Psychology / Briefing / Paper Trading ----------
  function paperDayStart(){const d=new Date();d.setHours(0,0,0,0);return d.getTime();}
  function paperState(){const p=state.paper;if(!Number.isFinite(p.balance))p.balance=10000;if(!Array.isArray(p.positions))p.positions=[];if(!Array.isArray(p.history))p.history=[];return p;}
  function paperPersist(){state.paper.updatedAt=Date.now();writeJSON(KEYS.paper,state.paper);writeJSON(KEYS.psychology,state.psychology);}
  function paperCurrentPrice(pos){const m=(state.markets||[]).find(x=>x.symbol===pos.symbol);if(m&&m.last>0)return m.last;if(state.selected?.symbol===pos.symbol&&state.selected.price>0)return state.selected.price;return pos.entry;}
  function updatePaperFromMarkets(markets){
    const p=paperState();let unreal=0;
    for(const pos of p.positions){
      pos.mark=paperCurrentPrice(pos);
      pos.unrealized=(pos.mark-pos.entry)*pos.qty;
      unreal+=pos.unrealized;
      if(!pos.secured&&num(pos.tp1)>0&&pos.mark>=pos.tp1){pos.secured=true;pushEvent('profit_secure',pos,{message:t('profitSecureEvent')});}
    }
    p.unrealized=unreal;
    p.equity=p.balance+p.positions.reduce((a,pos)=>a+pos.qty*pos.mark,0);
    const now=Date.now();
    const persistDue=now-num(state.paperLastPersistAt,0)>=5000;
    const uiDue=now-num(state.paperLastPaintAt,0)>=1800;
    if(persistDue){state.paperLastPersistAt=now;paperPersist();}
    if(uiDue){
      state.paperLastPaintAt=now;
      updatePsychology();
      if($('guardianHome'))renderPsychologyGuardian();
      renderResultsCenter();
    }
  }
  function pushEvent(type,x={},meta={}){try{const ev=readJSON(KEYS.events,[]);const message=meta.message|| (type==='golden_opportunity'?t('backgroundGolden'):type==='recommendation'?t('recommendationEvent'):type==='profit_secure'?t('profitSecureEvent'):type==='closed_profit'?t('profitCloseEvent'):type==='closed_loss'?t('lossCloseEvent'):t('breakEvenEvent'));ev.unshift({type,ts:Date.now(),symbol:x.symbol||state.currentSymbol||'—',exchange:x.exchange||state.selected?.exchange||$('exchangeSelect')?.value||'binance',message,pnl:(meta.pnl!==undefined&&Number.isFinite(Number(meta.pnl)))?Number(meta.pnl):undefined});writeJSON(KEYS.events,ev.slice(0,300));renderResultsCenter();}catch{}}
  function tradeStats(){const p=paperState();const closed=(p.history||[]).filter(x=>x.type==='CLOSED');const wins=closed.filter(x=>num(x.pnl)>=0.01).length,losses=closed.filter(x=>num(x.pnl)<=-0.01).length,be=closed.length-wins-losses;const decisive=wins+losses;return {total:closed.length,wins,losses,be,rate:decisive?(wins/decisive*100):0};}
  function eventMessage(e){return e.type==='golden_opportunity'?t('backgroundGolden'):e.type==='recommendation'?t('recommendationEvent'):e.type==='profit_secure'?t('profitSecureEvent'):e.type==='closed_profit'?t('profitCloseEvent'):e.type==='closed_loss'?t('lossCloseEvent'):t('breakEvenEvent');}
  function renderTradeResultsCenter(){const host=$('resultsCenterOutput');if(!host)return;const st=tradeStats(),ev=readJSON(KEYS.events,[]);host.innerHTML=`<div class="result-stat-grid"><div class="result-stat"><span>${t('totalTrades')}</span><b>${st.total}</b></div><div class="result-stat"><span>${t('winningTrades')}</span><b class="gain">${st.wins}</b></div><div class="result-stat"><span>${t('losingTrades')}</span><b class="loss">${st.losses}</b></div><div class="result-stat"><span>${t('successRate')}</span><b>${st.rate.toFixed(1)}%</b></div></div><div class="result-events">${ev.length?ev.slice(0,40).map(e=>{const icon=e.type==='recommendation'?'🎯':e.type==='profit_secure'?'🔒':e.type==='closed_profit'?'🟢':e.type==='closed_loss'?'🔴':'⚖️';return `<div class="result-event"><span class="event-icon">${icon}</span><div><b>${esc(e.symbol)} · ${esc(eventMessage(e))}</b><small>${esc(e.exchange)}${e.pnl!==undefined?` · PnL ${e.pnl>=0?'+':''}${num(e.pnl).toFixed(2)} USDT`:''}</small></div><time>${new Date(e.ts).toLocaleString()}</time></div>`}).join(''):`<div class="note">${t('noEvents')}</div>`}</div><div class="source-note" style="margin-top:8px">${t('resultsPaperOnly')}</div>`;}
  function renderResultsCenter(){try{renderResultsCenterWithContinuous();}catch{try{renderTradeResultsCenter();}catch{}}}
  function calcPaperGuardian(){const h=paperState().history.filter(x=>x.closedAt);let streak=0;for(const x of [...h].sort((a,b)=>b.closedAt-a.closedAt)){if(x.pnl<0)streak++;else break;}const daily=h.filter(x=>x.closedAt>=paperDayStart()).reduce((a,x)=>a+x.pnl,0);const dailyPct=state.paper.equity?daily/state.paper.equity*100:0;const recent=h.filter(x=>x.openedAt>=Date.now()-20*60000).length;let status='HEALTHY';if(streak>=3||dailyPct<=-3||recent>=4)status='COOLDOWN';else if(streak>=2||dailyPct<=-1.5||recent>=3)status='CAUTION';const now=Date.now(),previous=state.psychology||{};let cooldownUntil=Number(previous.cooldownUntil)||0;if(status!=='COOLDOWN')cooldownUntil=0;else if(previous.status!=='COOLDOWN'||cooldownUntil<=now)cooldownUntil=now+15*60000;state.psychology={lossStreak:streak,dailyLossPct:dailyPct,rapidEntries:recent,status,cooldownUntil};return state.psychology;}
  function updatePsychology(){return calcPaperGuardian();}
  function guardianStatusText(status){return status==='COOLDOWN'?t('psychologyCooldown'):status==='CAUTION'?t('psychologyCaution'):t('psychologyHealthy');}
  function guardianHTML(m=updatePsychology()){const until=Math.max(0,(m.cooldownUntil||0)-Date.now());const cls=m.status==='COOLDOWN'?'cooldown':m.status==='CAUTION'?'caution':'healthy';return `<div class="guardian-shell"><div><div class="guardian-score">${m.status==='COOLDOWN'?Math.ceil(until/60000):m.lossStreak}</div><div class="small muted">${m.status==='COOLDOWN'? (state.lang==='ar'?'دقيقة تهدئة متبقية':'cooldown minutes remaining') : t('consecutiveLosses')}</div></div><div><div class="guardian-grid"><div class="guardian-stat"><span>${t('consecutiveLosses')}</span><b>${m.lossStreak}</b></div><div class="guardian-stat"><span>${t('dailyLoss')}</span><b class="${m.dailyLossPct<0?'loss':'gain'}">${m.dailyLossPct.toFixed(2)}%</b></div><div class="guardian-stat"><span>${t('rapidReentries')}</span><b>${m.rapidEntries}</b></div></div><div class="paper-notice">${t('guardianHint')}<br>${m.status==='COOLDOWN'?t('cooldownText'):m.status==='CAUTION'?(state.lang==='ar'?'خفّف عدد المحاولات ولا تطارد الخسارة.':'Reduce attempts and avoid chasing losses.'):(state.lang==='ar'?'وتيرة التداول المحلية ضمن الحدود المسجلة.':'Local trading pace is within the recorded guardrails.')}</div></div></div>`;}
  function renderPsychologyGuardian(){const m=updatePsychology();const home=$('guardianHome');if(home)home.innerHTML=guardianHTML(m);const badge=$('guardianState');if(badge){badge.className=`guardian-state ${m.status==='COOLDOWN'?'cooldown':m.status==='CAUTION'?'caution':'healthy'}`;badge.textContent=guardianStatusText(m.status);} }
  function guardianCanTrade(){const m=updatePsychology();if(m.status==='COOLDOWN'&&Date.now()<m.cooldownUntil){toast(t('guardBlocked'));notifyUser('RadarX Psychology Guardian',t('guardBlocked'));return false;}if(m.status==='COOLDOWN'){state.psychology.status='HEALTHY';state.psychology.cooldownUntil=0;paperPersist();}return true;}
  function openPaperTrade(sig,amount=null){if(!sig){toast(t('paperNoSignal'));return false;}if(!guardianCanTrade())return false;const p=paperState();const size=Math.min(Math.max(num(amount,500),50),Math.max(50,p.balance));if(size>p.balance+1e-9){toast(t('paperInsufficient'));return false;}const price=num(sig.price||sig.entry);if(!(price>0))return false;const qty=size/price;const pos={id:p.nextId++,symbol:sig.symbol,exchange:sig.exchange,side:'LONG',entry:price,mark:price,qty,size,openedAt:Date.now(),score:num(sig.score),sl:num(sig.sl),tp1:num(sig.tp1),tp2:num(sig.tp2),tp3:num(sig.tp3||sig.tp2),secured:false,unrealized:0};p.balance-=size;p.positions.unshift(pos);p.positions=p.positions.slice(0,25);p.history.unshift({type:'OPEN',id:pos.id,symbol:pos.symbol,openedAt:pos.openedAt,size,pnl:0});pushEvent('recommendation',pos,{message:t('paperOpened')});p.history=p.history.slice(0,200);paperPersist();updatePsychology();renderPsychologyGuardian();toast(t('paperOpened'));if($('paperOutput'))renderPaper();return true;}
  function closePaperPosition(id){const p=paperState();const pos=p.positions.find(x=>x.id===id);if(!pos)return;const mark=paperCurrentPrice(pos);const pnl=(mark-pos.entry)*pos.qty;p.balance+=mark*pos.qty;p.realized+=pnl;p.positions=p.positions.filter(x=>x.id!==id);const h=p.history.find(x=>x.type==='OPEN'&&x.id===id);if(h){h.type='CLOSED';h.closedAt=Date.now();h.close=mark;h.pnl=pnl;h.returnPct=pos.entry?pnl/(pos.entry*pos.qty)*100:0;}else p.history.unshift({type:'CLOSED',id,symbol:pos.symbol,openedAt:pos.openedAt,closedAt:Date.now(),pnl,returnPct:pos.entry?pnl/(pos.entry*pos.qty)*100:0});paperPersist();updatePaperFromMarkets(state.markets);pushEvent(pnl>0.01?'closed_profit':pnl<-0.01?'closed_loss':'closed_break_even',pos,{message:pnl>0.01?t('profitCloseEvent'):pnl<-0.01?t('lossCloseEvent'):t('breakEvenEvent'),pnl});renderResultsCenter();toast(t('paperClosed'));}
  function paperReset(){state.paper={balance:10000,equity:10000,realized:0,unrealized:0,positions:[],history:[],nextId:1,updatedAt:Date.now()};state.psychology={lossStreak:0,dailyLossPct:0,rapidEntries:0,status:'HEALTHY',cooldownUntil:0};paperPersist();renderPaper();renderPsychologyGuardian();toast(t('paperReset'));}
  function paperLeaderboard(){const p=paperState();const competitors=[{name:'Atlas Quant',ret:12.8},{name:'Momentum Fox',ret:8.4},{name:'Flow Hunter',ret:5.7},{name:'Night Scanner',ret:3.9},{name:'Breakout Lab',ret:1.8},{name:'Liquidity Edge',ret:-1.2},{name:'Swing Pilot',ret:-4.6}];const userRet=p.balance?((p.equity/10000)-1)*100:0;competitors.push({name:state.profile.name||'Guest Trader',ret:userRet,me:true});return competitors.sort((a,b)=>b.ret-a.ret);}
  function renderLeaderboardHTML(){return `<div class="leaderboard">${paperLeaderboard().map((x,i)=>`<div class="leader-row ${x.me?'me':''}"><div class="leader-rank">#${i+1}</div><div class="leader-name"><b>${esc(x.name)}</b><span>${x.me?t('leaderYou'):t('leaderDemo')}</span></div><div class="leader-return ${x.ret>=0?'gain':'loss'}">${x.ret>=0?'+':''}${x.ret.toFixed(2)}%</div><span class="paper-pill">PAPER</span></div>`).join('')}</div>`;}
  function renderPaper(){updatePaperFromMarkets(state.markets||[]);const p=paperState();const target=$('paperOutput');if(!target)return;const open=p.positions.length,closed=p.history.filter(x=>x.type==='CLOSED').length;const positions=p.positions.map(x=>`<tr><td>${esc(x.symbol)}</td><td>${fmt(x.entry)}</td><td>${fmt(x.mark)}</td><td class="${x.unrealized>=0?'gain':'loss'}">${x.unrealized>=0?'+':''}${fmt(x.unrealized)}</td><td><button class="btn danger" data-close-paper="${x.id}">${t('paperClose')}</button></td></tr>`).join('');target.innerHTML=`<div class="paper-top"><div class="paper-stat"><span>${t('paperBalance')}</span><b>${fmt(p.balance)} USDT</b></div><div class="paper-stat"><span>${t('paperEquity')}</span><b>${fmt(p.equity)} USDT</b></div><div class="paper-stat"><span>${t('paperPnL')}</span><b class="${p.realized>=0?'gain':'loss'}">${p.realized>=0?'+':''}${Number(p.realized||0).toFixed(2)} USDT</b></div><div class="paper-stat"><span>${t('openPositions')}</span><b>${open}</b></div></div><div class="paper-actions"><div class="field" style="min-width:170px"><label>${t('paperAmount')}</label><input id="paperAmountInput" type="number" value="500" min="50" step="50"></div><button class="btn primary" id="paperOpenBtn">🏆 ${t('paperTrade')}</button><button class="btn ghost" id="paperRefreshBtn">↻ ${t('paperRefresh')}</button><button class="btn danger" id="paperResetBtn">↺ ${t('paperReset')}</button></div><div class="paper-notice">${t('virtualOnly')}<br>${t('paperHint')}</div><div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('openPositions')}</b><span class="gateway-pill">${open} · ${closed} ${t('closedTrades')}</span></div>${open?`<div class="table-wrap"><table class="paper-table"><thead><tr><th>${t('symbol')}</th><th>${t('entry')}</th><th>${state.lang==='ar'?'الآن':'Mark'}</th><th>PnL</th><th>${t('paperClose')}</th></tr></thead><tbody>${positions}</tbody></table></div>`:`<div class="empty-state">${t('paperNoSignal')}</div>`}</div><div class="panel" style="margin-top:10px"><div class="section-head"><b>${t('leaderboard')}</b><span class="gateway-pill">LOCAL / DEMO</span></div>${renderLeaderboardHTML()}</div>`;$('paperOpenBtn').onclick=()=>openPaperTrade(state.selected||state.deepRows[0],num($('paperAmountInput').value));$('paperRefreshBtn').onclick=()=>{updatePaperFromMarkets(state.markets||[]);renderPaper();};$('paperResetBtn').onclick=paperReset;els('[data-close-paper]').forEach(b=>b.onclick=()=>closePaperPosition(Number(b.dataset.closePaper)));}

  function scheduleBriefingRefresh(delay=700){
    clearTimeout(state.briefingRefreshTimer);
    state.briefingRefreshTimer=setTimeout(()=>{state.briefingRefreshTimer=null;renderBriefing();},Math.max(100,delay));
  }
  function briefingData(){const markets=state.markets;const rows=state.deepRows;const raw=state.sentiment||computeSentimentFromMarkets(markets,null);const sent={...raw};const has=Number.isFinite(Number(sent.score));const regime=has?(sent.score>=66?'BULLISH':sent.score<=39?'BEARISH':'NEUTRAL'):'WAITING';const safe=rows.filter(x=>(x.fakeout?.score||0)<55).slice(0,3);const traps=rows.filter(x=>(x.fakeout?.score||0)>=55).slice(0,2);const event=state.calendar.find(e=>Date.parse(e.date)>=Date.now());return {regime,sent,top:safe.length?safe:rows.slice(0,3),traps,event,updatedAt:Date.now(),has};}
  function renderBriefing(){const b=briefingData();state.briefing=b;const badge=$('briefingRegimeBadge');if(badge){badge.className=`briefing-chip ${b.regime==='BULLISH'?'green':b.regime==='BEARISH'?'red':'yellow'}`;badge.textContent=b.regime;}const out=$('dailyBriefing');const sentTxt=b.has?`${b.regime} · Sentiment ${Math.round(b.sent.score)}/100 · Breadth ${Math.round(b.sent.breadth||50)}%`:t('modeWaiting');if(out)out.innerHTML=`<div class="briefing-item"><b>🧠 ${t('briefingRegime')}</b><span>${sentTxt}</span></div><div class="briefing-item"><b>🎯 ${t('briefingTop')}</b><span>${b.top.map(x=>`${esc(x.symbol)} ${Math.round(x.score)}/100 · Trap ${Math.round(x.fakeout?.score||0)}/100`).join(' · ')||'—'}</span></div><div class="briefing-item"><b>👀 ${t('briefingWatch')}</b><span>${b.top.map(x=>esc((x.reasons||[])[0]||t('noData'))).join(' · ')||'—'}</span></div><div class="briefing-item"><b>🛑 ${t('briefingAvoid')}</b><span>${b.traps.length?b.traps.map(x=>`${esc(x.symbol)} · Trap ${Math.round(x.fakeout.score)}/100`).join(' · '):(b.event?`${esc(b.event.country||'MACRO')} · ${esc(b.event.title)}`:t('avoidChasing'))}</span></div><div class="source-note">${t('briefingHint')} · ${new Date(b.updatedAt).toLocaleTimeString()}</div>`;}

  function saveAlert(x){if(!x||x.signal==='NO_SIGNAL')return;const a=readJSON(KEYS.alerts,[]),key=`${x.exchange}|${x.symbol}|${x.signal}`;if(a.some(y=>y.key===key&&Date.now()-y.ts<15*60e3))return;a.unshift({key,ts:Date.now(),symbol:x.symbol,exchange:x.exchange,signal:x.signal,score:x.score,quality:x.quality,reasons:x.reasons.slice(0,8),entry:x.entry,sl:x.sl,tp1:x.tp1,tp2:x.tp2,tp3:x.tp3,mode:x.mode});writeJSON(KEYS.alerts,a.slice(0,200));pushEvent('recommendation',x);if(x.signal==='EARLY_ALERT')notifyUser(`${x.symbol} ${t('signalEarly')}`,`${t('strength')}: ${Math.round(x.score)}/100 · ${t('entry')}: ${fmt(x.entry)}`);renderResultsCenter();}
  function renderAlerts(){const a=readJSON(KEYS.alerts,[]);const target=$('moreAlerts');if(target){target.innerHTML=a.length?a.map(x=>`<div class="alert-item ${x.score>=83?'high':''}"><h4>${esc(x.exchange)} · ${esc(x.symbol)} · ${Math.round(x.score)}/100</h4><div class="small muted">${new Date(x.ts).toLocaleString()} · ${x.mode}</div><div class="tags">${x.reasons.map(r=>`<span class="tag">${esc(r)}</span>`).join('')}</div><div class="small" style="margin-top:7px">${t('entry')}: ${fmt(x.entry)} · SL: ${fmt(x.sl)} · TP1: ${fmt(x.tp1)} · TP2: ${fmt(x.tp2)} · TP3: ${fmt(x.tp3)}</div></div>`).join(''):`<div class="note">${t('noAlerts')}</div>`;}}

  async function requestNotifications(){if(!('Notification' in window))return toast('Notification API unavailable');const p=await Notification.requestPermission();toast(p==='granted'?t('permissionGranted'):t('permissionBlocked'));}
  function notifyUser(title,body){try{if('Notification' in window&&Notification.permission==='granted')new Notification(title,{body});}catch{}}


// ---------- Continuous Background Radar 4.11 ----------
// Real Binance live ticker stream -> lightweight early-move detector ->
// bounded deep verification -> persistent golden-opportunity alert ledger.
const CONTINUOUS_RADAR = {
  cycleMs:3500,
  restRefreshMs:15000,
  tapeWindowMs:120000,
  sampleKeep:45,
  minMove30:0.24,
  minMove60:0.35,
  minVolumeSpike:1.35,
  minPreScore:68,
  minFinalScore:75,
  maxTrapRisk:35,
  maxDeepPerCycle:2,
  deepCooldownMs:10*60*1000,
  alertCooldownMs:20*60*1000,
  staleMs:12000,
  historyMax:300
};

function warmAlertAudio(){
  try{
    if(!state.continuous.audioCtx){
      const Ctx=window.AudioContext||window.webkitAudioContext;
      if(Ctx)state.continuous.audioCtx=new Ctx();
    }
    const ac=state.continuous.audioCtx;
    if(ac?.state==='suspended')ac.resume().catch(()=>{});
  }catch{}
}
function playAlertFx(){
  try{
    const ac=state.continuous.audioCtx;
    if(ac){
      if(ac.state==='suspended')ac.resume().catch(()=>{});
      const now=ac.currentTime,osc=ac.createOscillator(),gain=ac.createGain();
      osc.type='sine';osc.frequency.setValueAtTime(880,now);osc.frequency.exponentialRampToValueAtTime(660,now+.12);
      gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.045,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.16);
      osc.connect(gain);gain.connect(ac.destination);osc.start(now);osc.stop(now+.17);
    }
  }catch{}
  try{navigator.vibrate?.([50,35,70]);}catch{}
}
function recordContinuousTicker(tk){
  if(!tk?.symbol||!(tk.last>0)||state.continuous?.enabled===false)return;
  const now=num(tk.eventTime,Date.now());
  const tape=state.continuous.tape;
  let rec=tape.get(tk.symbol);
  if(!rec){rec={samples:[],lastAlertAt:0,lastDeepAt:0};tape.set(tk.symbol,rec);}
  const last=rec.samples.at(-1);
  // Collapse bursts carrying the exact same event-time/price to keep memory bounded.
  if(last&&last.ts===now&&last.price===tk.last){state.continuous.lastLiveTickAt=Date.now();return;}
  rec.samples.push({ts:now,price:num(tk.last),quoteVolume:num(tk.quoteVolume)});
  const cut=Date.now()-CONTINUOUS_RADAR.tapeWindowMs;
  while(rec.samples.length>CONTINUOUS_RADAR.sampleKeep || (rec.samples[0]&&rec.samples[0].ts<cut))rec.samples.shift();
  state.continuous.lastLiveTickAt=Date.now();
}
function sampleAtOrBefore(samples,targetTs){
  for(let i=samples.length-1;i>=0;i--)if(samples[i].ts<=targetTs)return samples[i];
  return samples[0]||null;
}
function rateBetween(a,b){
  if(!a||!b||b.ts<=a.ts)return 0;
  return Math.max(0,b.quoteVolume-a.quoteVolume)/Math.max(1,(b.ts-a.ts)/1000);
}
function continuousMetrics(symbol){
  const rec=state.continuous.tape.get(symbol), samples=rec?.samples||[];
  if(samples.length<4)return null;
  const last=samples.at(-1);
  const s30=sampleAtOrBefore(samples,last.ts-30000),s60=sampleAtOrBefore(samples,last.ts-60000),s90=sampleAtOrBefore(samples,last.ts-90000);
  if(!s30)return null;
  const move30=(last.price/s30.price-1)*100;
  const move60=s60?.price?(last.price/s60.price-1)*100:move30;
  const recentRate=rateBetween(s30,last);
  const prevA=s90||samples[0],prevB=sampleAtOrBefore(samples,last.ts-45000)||s30;
  const prevRate=rateBetween(prevA,prevB);
  const liveSpike=liveMinuteVolumeSpike(symbol);
  const volumeSpike=liveSpike;
  const acceleration=prevRate>0?recentRate-prevRate:0;
  const ticker=state.marketsBySymbol?.[symbol]||null;
  const preScore=clamp(48+Math.max(0,move30)*35+Math.max(0,move60)*18+Math.min(28,Math.max(0,volumeSpike-1)*14)+(acceleration>0?4:0));
  return {symbol,lastPrice:last.price,move30,move60,volumeSpike,recentRate,prevRate,acceleration,preScore,ticker,ts:last.ts};
}
function continuousCandidates(){
  const out=[];
  for(const [symbol] of state.continuous.tape){
    const m=continuousMetrics(symbol); if(!m)continue;
    if(m.move30<CONTINUOUS_RADAR.minMove30 || m.move60<CONTINUOUS_RADAR.minMove60)continue;
    if(m.volumeSpike==null || m.volumeSpike<CONTINUOUS_RADAR.minVolumeSpike)continue;
    if(m.preScore<CONTINUOUS_RADAR.minPreScore)continue;
    const x=m.ticker;if(!isRadarSymbolEligible(x,'breakout',multiRadarSource()==='cached'))continue;
    out.push(m);
  }
  return out.sort((a,b)=>b.preScore-a.preScore).slice(0,8);
}
function continuousAlertExists(symbol,now=Date.now()){
  const last=state.continuous.lastAlertAt.get(symbol)||0;
  if(now-last<CONTINUOUS_RADAR.alertCooldownMs)return true;
  const hist=readJSON(KEYS.backgroundAlerts,[]);
  return hist.some(x=>x.symbol===symbol&&now-num(x.ts)<CONTINUOUS_RADAR.alertCooldownMs);
}
function persistBackgroundAlert(x,m){
  const now=Date.now();
  if(continuousAlertExists(x.symbol,now))return false;
  const hist=readJSON(KEYS.backgroundAlerts,[]);
  const item={id:`${x.symbol}-${now}`,ts:now,symbol:x.symbol,momentumPct:num(m.move30),momentum60Pct:num(m.move60),volumeSpike:num(m.volumeSpike),trapRisk:num(x.fakeout?.score,100),score:num(x.score),quality:num(x.quality),signal:x.signal||'GOLDEN_OPPORTUNITY',entry:num(x.entry),sl:num(x.sl),tp1:num(x.tp1),tp2:num(x.tp2),tp3:num(x.tp3),exchange:x.exchange||'binance',mode:'continuous_live'};
  hist.unshift(item);writeJSON(KEYS.backgroundAlerts,hist.slice(0,CONTINUOUS_RADAR.historyMax));
  state.continuous.lastAlertAt.set(x.symbol,now);state.continuous.alertCount=(state.continuous.alertCount||0)+1;state.continuous.lastGolden=item;
  pushEvent('golden_opportunity',x,{message:t('backgroundGolden')});
  const title=`🟡 ${x.symbol} · ${t('backgroundGolden')}`;
  const body=`${t('backgroundMomentum')}: ${m.move30>=0?'+':''}${m.move30.toFixed(2)}% · ${t('backgroundVolumeSpike')}: ${m.volumeSpike?m.volumeSpike.toFixed(2)+'×':'—'} · ${t('backgroundTrap')}: ${Math.round(x.fakeout?.score||0)}/100`;
  notifyUser(title,body);playAlertFx();
  toast(`${title} — ${body}`);renderResultsCenter();renderAlerts();return true;
}
function continuousEngineStatus(){
  const now=Date.now(),liveAge=state.continuous.lastLiveTickAt?now-state.continuous.lastLiveTickAt:Infinity;
  if(navigator.onLine===false || liveAge>CONTINUOUS_RADAR.staleMs)return 'offline';
  if(state.continuous.cycleBusy)return 'running';
  return state.continuous.lastCycleAt?'running':'waiting';
}
function renderContinuousResults(){
  const host=$('resultsCenterOutput');if(!host)return;
  const hist=readJSON(KEYS.backgroundAlerts,[]);
  const status=continuousEngineStatus();
  const statusText=status==='offline'?t('backgroundRadarOffline'):status==='running'?t('backgroundRadarRunning'):t('backgroundRadarWaiting');
  const last=state.continuous.lastCycleAt?new Date(state.continuous.lastCycleAt).toLocaleTimeString():'—';
  const latest=hist.slice(0,20);
  const html=`<div class="continuous-engine-card"><div><div class="continuous-engine-title">🛰 ${t('backgroundRadarTitle')}</div><div class="small muted">${esc(statusText)}</div></div><div class="continuous-engine-meta"><span>${t('backgroundRadarLast')}: <b>${esc(last)}</b></span><span>${t('backgroundRadarAlerts')}: <b>${hist.length}</b></span></div></div><div class="small muted" style="margin:8px 0 6px">${esc(t('backgroundEngineHint'))}</div><div class="continuous-alerts">${latest.length?latest.map(x=>`<div class="continuous-alert"><div><b>${esc(x.symbol)}</b><small>${new Date(x.ts).toLocaleString()}</small></div><div><span>${t('backgroundMomentum')}</span><b class="gain">${x.momentumPct>=0?'+':''}${num(x.momentumPct).toFixed(2)}%</b></div><div><span>${t('backgroundVolumeSpike')}</span><b>${x.volumeSpike?num(x.volumeSpike).toFixed(2)+'×':'—'}</b></div><div><span>${t('backgroundTrap')}</span><b class="${num(x.trapRisk)<35?'gain':'loss'}">${Math.round(num(x.trapRisk))}/100</b></div></div>`).join(''):`<div class="note">${t('noEvents')}</div>`}</div>`;
  return html;
}
async function continuousVerifyCandidate(m){
  const symbol=m.symbol,now=Date.now(),rec=state.continuous.tape.get(symbol);
  if(state.continuous.pending.has(symbol))return;
  const lastDeep=state.continuous.lastDeepAt.get(symbol)||rec?.lastDeepAt||0;
  if(now-lastDeep<CONTINUOUS_RADAR.deepCooldownMs)return;
  state.continuous.pending.add(symbol);state.continuous.lastDeepAt.set(symbol,now);if(rec)rec.lastDeepAt=now;
  try{
    const cached=state.deepRows.find(r=>r.symbol===symbol)||state.smartScan.results.find(r=>r.symbol===symbol);
    let x=cached;
    if(!x || (Date.now()-num(x.liveAt,0)>CONTINUOUS_RADAR.deepCooldownMs))x=await deepAnalyze('binance',symbol,'5m',{withFlow:true});
    if(!x?.fakeout)return;
    const trap=num(x.fakeout.score,100);
    const momentumPass=m.move30>=CONTINUOUS_RADAR.minMove30 && m.move60>=CONTINUOUS_RADAR.minMove60;
    const flowPass=num(x.forensic?.flowScore,50)>=50;
    const finalPass=momentumPass && m.preScore>=CONTINUOUS_RADAR.minPreScore && num(x.score)>=CONTINUOUS_RADAR.minFinalScore && trap<CONTINUOUS_RADAR.maxTrapRisk && num(x.quality)>=60 && flowPass;
    if(!finalPass)return;
    x={...x,continuousMomentumPct:m.move30,continuousMomentum60Pct:m.move60,continuousVolumeSpike:m.volumeSpike,continuousDetectedAt:Date.now()};
    state.deepRows=[x,...state.deepRows.filter(r=>r.symbol!==symbol)].slice(0,24);
    if(state.currentSymbol===symbol){state.selected=x;state.structure=x.structure||state.structure;renderStructurePanel(state.structure);renderActiveAssetHeader(symbol,'continuous-radar');renderSelectedLive();}
    renderRadarTable(state.deepRows);renderRadarMetrics(Math.max(1,state.markets.length),state.deepRows);renderBriefing();
    persistBackgroundAlert(x,m);
  }catch(e){state.continuous.lastError=String(e?.message||e);}
  finally{state.continuous.pending.delete(symbol);}
}
async function continuousRadarCycle(){
  if(!state.continuous.enabled||state.continuous.cycleBusy)return;
  if(navigator.onLine===false){state.continuous.mode='offline';return;}
  if(!Object.keys(state.marketsBySymbol||{}).length)return;
  state.continuous.cycleBusy=true;state.continuous.mode='running';state.continuous.lastCycleAt=Date.now();
  try{
    const candidates=continuousCandidates();
    let started=0;
    for(const m of candidates){
      if(started>=CONTINUOUS_RADAR.maxDeepPerCycle)break;
      if(state.continuous.pending.has(m.symbol))continue;
      started++;continuousVerifyCandidate(m).catch(()=>{});
    }
    // REST is a validation/watchdog path, not the primary real-time feed.
    if(Date.now()-num(state.continuous.lastRestAt,0)>=Math.max(CONTINUOUS_RADAR.restRefreshMs,30000) && !state.multiRadar.running && multiRadarSource()!=='ws'){
      state.continuous.lastRestAt=Date.now();
      multiRadarPoll().catch(()=>{});
    }
    renderResultsCenter();
  }finally{state.continuous.cycleBusy=false;}
}
function createContinuousWorker(){
  if(!('Worker' in window))return null;
  try{
    const code=`let timer=null;self.onmessage=e=>{const d=e.data||{};if(d.cmd==='start'){clearInterval(timer);const ms=Math.max(1000,Number(d.ms)||3500);timer=setInterval(()=>self.postMessage({type:'cycle',ts:Date.now()}),ms);self.postMessage({type:'started',ms});}if(d.cmd==='stop'){clearInterval(timer);timer=null;self.close();}};`;
    const blob=new Blob([code],{type:'application/javascript'}),url=URL.createObjectURL(blob),w=new Worker(url);
    w.onmessage=e=>{if(e.data?.type==='cycle')continuousRadarCycle().catch(()=>{});};
    w.onerror=()=>{try{w.terminate();}catch{};state.continuous.worker=null;startContinuousTimerFallback();};
    w.postMessage({cmd:'start',ms:CONTINUOUS_RADAR.cycleMs});
    state.continuous.worker=w;state.continuous.mode='waiting';state.continuous.workerURL=url;
    return w;
  }catch{return null;}
}
function startContinuousTimerFallback(){
  clearInterval(state.continuous.timer);
  state.continuous.timer=setInterval(()=>continuousRadarCycle().catch(()=>{}),CONTINUOUS_RADAR.cycleMs);
}
function startContinuousRadar(){
  stopContinuousRadar(false);
  state.continuous.enabled=true;
  const w=createContinuousWorker();
  if(!w)startContinuousTimerFallback();
  clearInterval(state.continuous.watchdogTimer);
  state.continuous.watchdogTimer=setInterval(()=>{
    const age=state.continuous.lastLiveTickAt?Date.now()-state.continuous.lastLiveTickAt:Infinity;
    if(navigator.onLine===false){state.continuous.mode='offline';return;}
    if(age>CONTINUOUS_RADAR.staleMs){state.continuous.mode='offline';if(state.ws.ticker?.readyState!==1)openTickerWS(0);if(state.multiRadar.ws?.readyState!==1)connectMultiRadarWS();}
    else if(!state.continuous.cycleBusy)state.continuous.mode='running';
    renderResultsCenter();
  },3000);
  continuousRadarCycle().catch(()=>{});
}
function stopContinuousRadar(disable=true){
  if(disable)state.continuous.enabled=false;
  clearInterval(state.continuous.timer);clearInterval(state.continuous.watchdogTimer);
  state.continuous.timer=null;state.continuous.watchdogTimer=null;
  if(state.continuous.worker){try{state.continuous.worker.postMessage({cmd:'stop'});}catch{try{state.continuous.worker.terminate();}catch{}}state.continuous.worker=null;}
  if(state.continuous.workerURL){try{URL.revokeObjectURL(state.continuous.workerURL);}catch{}state.continuous.workerURL=null;}
}
function renderResultsCenterWithContinuous(){
  const host=$('resultsCenterOutput');if(!host)return;
  // Preserve the original Results Center and prepend the automatic radar ledger.
  const st=tradeStats(),ev=readJSON(KEYS.events,[]);
  host.innerHTML=`${renderContinuousResults()}<div class="result-stat-grid"><div class="result-stat"><span>${t('totalTrades')}</span><b>${st.total}</b></div><div class="result-stat"><span>${t('winningTrades')}</span><b class="gain">${st.wins}</b></div><div class="result-stat"><span>${t('losingTrades')}</span><b class="loss">${st.losses}</b></div><div class="result-stat"><span>${t('successRate')}</span><b>${st.rate.toFixed(1)}%</b></div></div><div class="result-events">${ev.length?ev.slice(0,40).map(e=>{const icon=e.type==='golden_opportunity'?'🟡':e.type==='recommendation'?'🎯':e.type==='profit_secure'?'🔒':e.type==='closed_profit'?'🟢':e.type==='closed_loss'?'🔴':'⚖️';return `<div class="result-event"><span class="event-icon">${icon}</span><div><b>${esc(e.symbol)} · ${esc(eventMessage(e))}</b><small>${esc(e.exchange)}${e.pnl!==undefined?` · PnL ${e.pnl>=0?'+':''}${num(e.pnl).toFixed(2)} USDT`:''}</small></div><time>${new Date(e.ts).toLocaleString()}</time></div>`}).join(''):`<div class="note">${t('noEvents')}</div>`}</div><div class="source-note" style="margin-top:8px">${t('resultsPaperOnly')}</div>`;
}

  // ---------- Backtest / risk ----------
  async function runBacktest(){
    const s=$('btSymbol').value.trim().toUpperCase().replace(/[\s/_-]/g,'');const tf=$('btTf').value,fee=num($('btFee').value)/100,slip=num($('btSlip').value)/100,rr=Math.max(.5,num($('btRR').value)||2);let rows,mode='live';try{rows=await fetchKlines('binance',s,tf,500);}catch{ $('btOutput').innerHTML=`<div class="risk-note">${t('liveFailed')}</div>`;return; }
    let equity=100,trades=0,wins=0,losses=0;for(let i=35;i<rows.length-3;i++){const f=coreFeatures(rows.slice(0,i+1));const sig=scoreFeatures(f);if(sig.score<74)continue;const entry=rows[i].c*(1+slip),risk=Math.max(f.atr,entry*.004),sl=entry-risk,tp=entry+risk*rr;let result=null;for(let j=i+1;j<Math.min(rows.length,i+30);j++){const bar=rows[j],hitSL=bar.l<=sl,hitTP=bar.h>=tp;if(hitSL&&hitTP){result='SL';break;}if(hitTP){result='TP';break;}if(hitSL){result='SL';break;}}if(!result)continue;trades++;if(result==='TP')wins++;else losses++;const raw=result==='TP'?((tp/entry)-1):((sl/entry)-1);equity*=1+(raw-2*fee-2*slip);i+=5;}
    const hit=trades?wins/trades*100:0; $('btOutput').innerHTML=`<div class="calc-grid"><div class="indicator"><span>${t('signalsCount')}</span><b>${trades}</b></div><div class="indicator"><span>${t('wins')}</span><b class="gain">${wins}</b></div><div class="indicator"><span>${t('losses')}</span><b class="loss">${losses}</b></div><div class="indicator"><span>${t('hitRate')}</span><b>${hit.toFixed(1)}%</b></div></div><div class="risk-note" style="margin-top:9px">${t('approxResult')}: <b>${pct((equity-1)*100)}</b> · ${mode.toUpperCase()}. ${t('conservativeRule')}</div>`;
  }

  function renderChartPreview(){const f=$('chartInput')?.files?.[0];if(!f)return;const u=URL.createObjectURL(f);$('chartPreview').innerHTML=`<img src="${u}" alt="chart" style="width:100%;max-height:360px;object-fit:contain;border-radius:14px;border:1px solid var(--line)"><div class="small muted" style="margin-top:7px">${esc(f.name)} · ${Math.round(f.size/1024)} KB · ${t('localOnly')}</div>`;}
  function renderCommunity(){const a=readJSON(KEYS.community,[{name:'RadarX',text:'راقب الحجم والزخم معًا، ولا تعتمد على ارتفاع السعر وحده.',ts:Date.now()-3600000}]);const out=$('communityOutput');if(out)out.innerHTML=a.slice(0,20).map(x=>`<div class="alert-item"><h4>${esc(x.name)}</h4><div>${esc(x.text)}</div><div class="small muted">${new Date(x.ts).toLocaleString()}</div></div>`).join('');}
  function addPost(){const input=$('postInput'),v=input.value.trim();if(!v)return;const a=readJSON(KEYS.community,[]);a.unshift({name:state.profile.name,text:v,ts:Date.now()});writeJSON(KEYS.community,a.slice(0,50));input.value='';renderCommunity();toast(t('post'));}

  // ---------- PWA / events ----------
  function installPWA(){window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;if($('upgradeMini'))$('upgradeMini').classList.remove('hidden');});/* Service Worker intentionally disabled in the web runtime. The app must never depend on SW cache state for startup. */}
  async function promptInstall(){if(state.deferredInstall){await state.deferredInstall.prompt();state.deferredInstall=null;}}
  function bind(){
    // Hard UI gate: when expired, only the Paywall and its checkout/demo controls are interactive.
    document.addEventListener('click',e=>{
      if(!document.body.classList.contains('rx-subscription-locked'))return;
      const allowed=e.target.closest('#rxSubscriptionPaywall,#modal');
      if(!allowed){e.preventDefault();e.stopImmediatePropagation();toast(paywallLabel());return;}
    },true);
    document.addEventListener('keydown',e=>{
      if(!document.body.classList.contains('rx-subscription-locked'))return;
      const allowed=e.target.closest?.('#rxSubscriptionPaywall,#modal');
      if(!allowed){e.preventDefault();e.stopImmediatePropagation();}
    },true);
    document.addEventListener('pointerdown',warmAlertAudio,{once:true,passive:true});
    $('langToggle').onclick=()=>{state.lang=state.lang==='ar'?'en':'ar';writeJSON(KEYS.settings,{lang:state.lang});applyLanguage();renderMore();};
    $('notifyBtn').onclick=requestNotifications; $('calendarHomeRefresh').onclick=loadRiskCalendar; $('searchSignalBtn').onclick=()=>{goTab('signal');$('assetSearchInput').focus();}; $('refreshBtn').onclick=scan; $('smartScanBtn').onclick=smartScan; $('quickScan').onclick=smartScan; $('openSignals').onclick=()=>goTab('signal'); $('scanBtn').onclick=scan; $('marketsRefresh').onclick=()=>{renderMarkets();toast(t('refresh'));}; $('analyzeBtn').onclick=analyzeSelected; $('searchBtn').onclick=searchAssets; $('assetSearchInput').oninput=searchAssets; $('flowBtn').onclick=analyzeFlow;
    $('upgradeMini').onclick=()=>{goTab('account');}; $('profileBtn').onclick=()=>goTab('account'); $('saveProfile').onclick=saveProfile; $('resetProfile').onclick=()=>{state.profile={name:'Guest Trader',email:'guest@radarx.local'};writeJSON(KEYS.profile,state.profile);resetMembership();paperReset();renderProfile();};
    els('.plan-btn').forEach(b=>b.onclick=()=>openPayment(b.dataset.plan)); $('demoUpgrade').onclick=()=>activateDemo('monthly'); $('whaleBtn').onclick=analyzeWhales; $('manageSub').onclick=()=>{const st=membershipState();if(st==='ACTIVE')toast(`${state.membership.plan||'PRO'} · ${fmtDuration(state.membership.expiresAt-Date.now())}`);else goTab('account');};
    els('.tab-btn').forEach(b=>b.onclick=()=>goTab(b.dataset.tab)); els('.more-card').forEach(b=>b.onclick=()=>renderSub(b.dataset.subtab)); els('.quick-card').forEach(b=>b.onclick=()=>{const id=b.dataset.goto;if(id==='more'&&b.dataset.more){goTab('more');renderSub(b.dataset.more);}else goTab(id);});
    els('.filter-chip').forEach(b=>b.onclick=()=>{els('.filter-chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.sort=b.dataset.sort;renderMarkets();});
    $('autoScan').onchange=e=>{if(e.target.checked){if(state.scanTimer)clearInterval(state.scanTimer);scan();state.scanTimer=setInterval(scan,60000);}else{clearInterval(state.scanTimer);state.scanTimer=null;}};
    $('multiRadarCount').onchange=()=>{state.multiRadar.count=num($('multiRadarCount').value,8);state.multiRadar.renderKey='';renderMultiRadar(true);}; els('[data-multi-mode]').forEach(b=>b.onclick=()=>{state.multiRadar.mode=b.dataset.multiMode==='breakout'?'breakout':'gainers';els('[data-multi-mode]').forEach(x=>x.classList.toggle('active',x===b));state.multiRadar.renderKey='';renderMultiRadar(true);}); $('multiRadarRefresh').onclick=()=>{state.multiRadar.renderKey='';renderMultiRadar(true);if(multiRadarSource()!=='ws')multiRadarPoll();}; $('multiRadarScan').onclick=()=>{const top=state.multiRadar.leaders[0]||multiRadarLeaders()[0]; if(top)selectActiveAsset(top.symbol,{openSignal:true,refresh:true,source:`multi-radar-${state.multiRadar.mode}`}); else toast(state.multiRadar.mode==='breakout'?t('multiRadarNoBreakout'):t('multiRadarNoData'));};
    $('modalClose').onclick=()=>$('modal').classList.add('hidden');
    $('resultsRefresh').onclick=()=>{renderResultsCenter();toast(t('refresh'));};
    const handleRadarSymbolAction=(e,keyboard=false)=>{
      const target=e.target;
      const copy=target.closest('[data-copy-price]');if(copy){e.preventDefault();e.stopPropagation();copyPrice(copy.dataset.copyPrice);return;}
      const follow=target.closest('[data-follow-symbol]');if(follow){e.preventDefault();e.stopPropagation();selectActiveAsset(follow.dataset.followSymbol,{openSignal:true,refresh:true,source:'multi-radar'});return;}
      const deep=target.closest('[data-deep-symbol]');if(deep){e.preventDefault();e.stopPropagation();selectActiveAsset(deep.dataset.deepSymbol,{openSignal:true,refresh:true,source:'multi-radar-deep'});return;}
      const smart=target.closest('[data-smart-analysis]');if(smart){e.preventDefault();e.stopPropagation();selectActiveAsset(smart.dataset.smartAnalysis,{openSignal:true,refresh:true,source:'smart-scan'});return;}
      const smartPaper=target.closest('[data-smart-paper]');if(smartPaper){e.preventDefault();e.stopPropagation();const x=state.smartScan.results.find(r=>r.symbol===smartPaper.dataset.smartPaper);if(x)openPaperTrade(x);return;}
      const card=target.closest('[data-symbol],[data-multi-symbol],[data-rx-symbol]');
      if(!card)return;
      // Search results are buttons with data-symbol and MUST remain clickable.
      const isSymbolButton=card.matches('.match-item,[role="button"][data-symbol],[role="button"][data-rx-symbol]')||card.tagName==='TR'||card.classList.contains('asset-card')||card.classList.contains('multi-card')||card.matches('[data-symbol],[data-rx-symbol]');
      if(!isSymbolButton)return;
      if(!keyboard && target.closest('button,input,select,textarea,a') && !card.matches('.match-item,[data-rx-symbol]'))return;
      e.preventDefault();e.stopPropagation();
      const symbol=card.dataset.symbol||card.dataset.multiSymbol||card.dataset.rxSymbol;
      if(symbol)selectActiveAsset(symbol,{openSignal:true,refresh:true,source:card.matches('.match-item')?'search':card.matches('.multi-card')?'multi-radar':card.closest('#radarTable')?'top-candidates':card.closest('#smartOpportunityOutput')?'smart-scan':'list'});
    };
    document.addEventListener('click',e=>handleRadarSymbolAction(e,false),true);
    document.addEventListener('keydown',e=>{
      if(e.key!=='Enter'&&e.key!==' ')return;
      if(e.target.matches('input,textarea,select'))return;
      handleRadarSymbolAction(e,true);
    },true);
  }

  function heartbeat(){
    renderMembership();
    if(state.subscriptionGate.lastCheckedAt && Date.now()-state.subscriptionGate.lastCheckedAt>SUBSCRIPTION_CONFIG.remoteCheckEveryMs)checkSubscriptionStatus('periodic').catch(()=>{});
    updatePsychology();
    if(state.markets.length)updatePaperFromMarkets(state.markets);
    if($('paperOutput')&&$('subcontent')?.dataset.kind==='paper'&&state.paper.positions.length)renderPaper();
    setTimeout(heartbeat,2200);
  }
  function showBootError(err,stage='startup'){
    try{
      const host=document.body||document.documentElement;
      if(!host)return;
      let box=document.getElementById('radarxBootError');
      if(!box){
        box=document.createElement('div');
        box.id='radarxBootError';
        box.dir='rtl';
        box.style.cssText='position:fixed;inset:18px;z-index:2147483647;padding:18px;border:1px solid rgba(255,120,120,.45);border-radius:16px;background:rgba(5,10,15,.97);color:#fff;font:14px/1.7 system-ui,sans-serif;overflow:auto;box-shadow:0 18px 60px rgba(0,0,0,.45)';
        host.appendChild(box);
      }
      const msg=err?.message||String(err||'Unknown error');
      box.innerHTML='<b>RadarX: تعذر إكمال التشغيل</b><br>المرحلة: '+String(stage).replace(/[<>&\"']/g,'')+'<br><small>'+String(msg).replace(/[<>&\"']/g,'')+'</small><br><br><button id="radarxBootReload" style="padding:10px 14px;border-radius:10px;border:0;cursor:pointer">إعادة المحاولة</button>';
      document.getElementById('radarxBootReload')?.addEventListener('click',()=>location.reload());
    }catch{}
  }
  window.addEventListener('error',e=>showBootError(e.error||e.message,'runtime'));
  window.addEventListener('unhandledrejection',e=>showBootError(e.reason,'promise'));

  async function init(){
    try{
      loadState();applyLanguage();renderProfile();renderMembership();bind();installPWA();appHealthy();
      Promise.resolve(consumeNativeEntitlement()).catch(()=>{});
      Promise.resolve(checkSubscriptionStatus('startup')).catch(()=>{});window.addEventListener('online',()=>{appHealthy();if(!premiumIsUnlocked()){applySubscriptionGate('EXPIRED','expired');return;}state.continuous.mode='waiting';state.multiRadar.wsAttempt=0;connectMultiRadarWS();openTickerWS(0);clearTimeout(state.multiRadar.pollTimer);state.multiRadar.pollTimer=setTimeout(multiRadarPoll,200);continuousRadarCycle().catch(()=>{});if(state.markets.length&&!state.busy)scan();});window.addEventListener('offline',()=>{state.continuous.mode='offline';try{if(state.multiRadar.ws)state.multiRadar.ws.close(1000,'offline')}catch{}try{if(state.ws.ticker)state.ws.ticker.close(1000,'offline')}catch{}multiRadarSetBusy(false,state.markets.length?'cached':'offline');markLiveData(state.markets.length?'cached':'offline',t('dataAge'));renderResultsCenter();});markLiveData('waiting');renderMarkets();renderAlerts();if($('exchangeSelect')?.value==='binance')openTickerWS(0);renderSentiment();renderRiskCalendar([]);renderBriefing();renderPsychologyGuardian();renderResultsCenter();
    if(state.currentSymbol){
      const restored=state.deepRows.find(x=>x.symbol===state.currentSymbol)||state.smartScan.results.find(x=>x.symbol===state.currentSymbol)||null;
      if(restored){state.selected={...restored};state.structure=restored.structure||((restored.rows?.length>=8)?detectStructure(restored.rows):null);renderStructurePanel(state.structure);renderActiveAssetHeader(state.currentSymbol,'restored');}
      else if(state.marketsBySymbol?.[state.currentSymbol])renderActiveAssetHeader(state.currentSymbol,'restored');
    }
    heartbeat();startWSStaleMonitor();loadLiveSnapshot();startResilientMarketHeartbeat();ensureGlobalMarketsPanel();refreshGlobalMarkets().catch(()=>{});if(premiumIsUnlocked()){startMultiRadar();startContinuousRadar();}else{pausePremiumEngines();}
    $('dashUniverse').textContent=state.markets.length?state.markets.length.toLocaleString('en-US'):'—';$('dashCandidates').textContent='—';$('dashEarly').textContent='—';$('dashTop').textContent='—';
    if(state.markets.length){renderMarkets();renderSentiment(computeSentimentFromMarkets(state.markets,null));renderRadarMetrics(state.markets.length,state.deepRows||[]);}
    $('briefingRefresh').onclick=()=>{refreshSentiment(true).finally(()=>renderBriefing());toast(state.markets.length?t('briefingUpdated'):t('noApi'));};
    refreshSentiment();loadRiskCalendar();
    setTimeout(()=>scan().catch(e=>showBootError(e,'initial-scan')),180);
    if($('analysisSymbol').value&&$('analysisSymbol').value.trim()){}
    window.dispatchEvent(new CustomEvent('radarx:ready',{detail:{version:'5.1-stable',at:Date.now()}}));
    }catch(e){
      showBootError(e,'init');
      try{markLiveData('error','startup');}catch{}
    }
  }

  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){warmAlertAudio();openTickerWS(0);connectMultiRadarWS();renderMultiRadar(false);continuousRadarCycle().catch(()=>{});}});


  // RadarX 5.1 integration surface: expose only existing, verified core primitives.
  window.RadarXCore={
    state,$,els,num,clamp,t,sleep,
    fetchJSON,firstJSONRace,fetchAllTickers,fetchAllTickersResilient,fetchDataHealth,fetchTicker,fetchKlines,fetchDepth,fetchTrades,
    notifyUser,premiumIsUnlocked,selectActiveAsset,renderMultiRadar,toast
  };
  document.addEventListener('DOMContentLoaded',init);
})();
