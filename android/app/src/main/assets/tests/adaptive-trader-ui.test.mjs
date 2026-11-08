import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../adaptive-trader.html',import.meta.url),'utf8');
const home=await readFile(new URL('../index.html',import.meta.url),'utf8');
const client=await readFile(new URL('../adaptive-trader-client.js',import.meta.url),'utf8');

test('standalone Arabic adaptive trader page is linked from the existing RadarX home screen',()=>{
  assert.match(html,/<html lang="ar" dir="rtl">/);
  assert.match(html,/ADAPTIVE TRADER/);
  assert.match(html,/فرص التي فاتت/);
  assert.match(html,/محاكاة الصفقات تلقائيًا/);
  assert.match(html,/ذاكرة التعلّم/);
  assert.match(html,/adaptive-trader-client\.js/);
  assert.match(home,/href="\.\/adaptive-trader\.html"/);
  assert.match(home,/openAdaptiveTraderBtn/);
});

test('market scan requests a persisted server worker cycle and waits for real completion',()=>{
  assert.match(html,/\/api\/adaptive-trader\/scan/);
  assert.match(html,/method:'POST'/);
  assert.match(html,/JSON\.stringify\(\{limit:limit\}\)/);
  assert.match(html,/successful_scans/);
  assert.match(html,/worker\.in_flight!==false/);
  assert.match(html,/ADAPTIVE_TRADER_SCAN_COOLDOWN/);
  assert.match(html,/SERVER_SCAN_RESULT_NOT_VERIFIED/);
  assert.doesNotMatch(html,/\/api\/adaptive-trader\/market-snapshot\?limit=/);
});

test('adaptive trader UI has visible data coverage and paper-only status',()=>{
  assert.match(html,/kpiEligible/);
  assert.match(html,/kpiScanned/);
  assert.match(html,/coverage_pct/);
  assert.match(html,/SERVER_SCAN_RESULT_NOT_VERIFIED|ADAPTIVE_TRADER_WORKER_SCAN_FAILED|DATA_UNAVAILABLE/);
  assert.match(html,/real_order_execution/);
  assert.match(html,/لا مفاتيح API/);
  assert.match(html,/تغطية جزئية/);
});

test('dashboard consumes the verified server worker snapshot and reports network or CORS failure',()=>{
  assert.match(html,/value\.last_summary/);
  assert.match(html,/BACKEND_NETWORK_OR_CORS_UNAVAILABLE/);
  assert.match(html,/successful_scans/);
  assert.match(html,/آخر نجاح/);
});

test('offline learning placeholder uses the same 60-result threshold as the server',()=>{
  assert.ok(client.includes('minSamples = 60'));
  assert.ok(html.includes('Number(model.required_samples)||60'));
});

test('learning panel exposes server-side historical input and rejection diagnostics',()=>{
  assert.match(html,/id="learningDiagnosticsText"/);
  assert.match(html,/historical_input_samples/);
  assert.match(html,/historical_rejected/);
  assert.match(html,/snapshot_historical_samples_available/);
  assert.match(html,/نتائج شموع مغلقة جديدة/);
  assert.match(html,/لا نفترض أن المحرك يتعلّم/);
});

test('server learning profile is preferred even when its resolved sample count is zero',()=>{
  assert.match(html,/if\(remote&&typeof remote==='object'\)return remote/);
  assert.match(html,/return buildAdaptiveLearningProfile\(\[\]\)/);
  assert.doesNotMatch(html,/resolveLearningSamples\(snapshot,now\)/);
  assert.match(html,/const resolvedCount=state\.serverStatus&&state\.serverStatus\.learning_profile/);
  assert.match(html,/لقطات السوق الواسعة للتدقيق فقط/);
  assert.doesNotMatch(html,/if\(remote&&\(remote\.ready===true\|\|\(Number\(remote\.resolved_samples\)\|\|0\)>0\)\)return remote/);
});

test('dashboard shows already-extended movers in a separate audit-only list, never as entry candidates',()=>{
  assert.match(html,/moverAuditList/);
  assert.match(html,/function renderMoverAudit\(\)/);
  assert.match(html,/mover_audit/);
  assert.match(html,/LATE_MOVE/);
  assert.match(html,/paper_candidate===false/);
  assert.match(html,/entry_eligible===false/);
  assert.match(html,/real_order_execution===false/);
  assert.match(html,/حركة ممتدة — لا مطاردة/);
  assert.match(html,/تدقيق فقط/);
});

test('dashboard distinguishes push-provider status from actual device delivery',()=>{
  assert.match(html,/value\.notification_transport/);
  assert.match(html,/fcm_devices/);
  assert.match(html,/لا يوجد جهاز مسجّل/);
  assert.match(html,/الاستلام الفعلي غير مثبت/);
  assert.match(html,/مزود إشعارات الهاتف/);
});


test('learning panel displays separate 1h and 24h radar outcome calibration and retained case studies',()=>{
  assert.match(html,/id="radarOutcomeLearningStatus"/);
  assert.match(html,/id="radarOutcomeLearning"/);
  assert.match(html,/id="radarOutcomeCases"/);
  assert.match(html,/horizonCard\('60m','ساعة'\)/);
  assert.match(html,/horizonCard\('24h','24 ساعة'\)/);
  assert.match(html,/complete_closed_candle_outcomes/);
  assert.match(html,/case_studies/);
  assert.match(html,/after 24 hours|24 ساعة/);
  assert.match(html,/لا تُحوَّل الحالة غير المكتملة إلى ربح أو خسارة/);
  assert.match(html,/لا تعدّل الترتيب بعد/);
});

test('candidate card explains accumulation, order-book support and uncertainty about spoofing',()=>{
  assert.match(html,/market_motive_assessment/);
  assert.match(html,/قرائن تدفق وتجميع متوافقة/);
  assert.match(html,/دفتر الأوامر لم يُفحص/);
  assert.match(html,/لا تثبت لقطة واحدة هوية حوت أو تلاعبًا/);
  assert.match(html,/تحذير: قرائن فخ سيولة/);
});

test('server owns the recurring scan loop; page visibility only polls status',()=>{
  assert.match(html,/setInterval\(function\(\)\{if\(document\.visibilityState==='visible'\)void refreshWorkerStatus\(\);\},15\*1000\)/);
  assert.doesNotMatch(html,/setInterval\(function\(\)\{if\(document\.visibilityState==='visible'&&!scanBusy\)void scanMarket\(\);\},5\*60\*1000\)/);
  assert.doesNotMatch(html,/setTimeout\(function\(\)\{if\(document\.visibilityState==='visible'\)void scanMarket\(\);\},500\)/);
});

test('sidecar client contains no exchange order execution endpoint or secret storage',()=>{
  assert.doesNotMatch(client,/\/api\/v3\/order/);
  assert.doesNotMatch(client,/newOrder|createOrder|apiSecret|secretKey|BINANCE_API_SECRET/i);
  assert.match(client,/real_order_execution\s*!==\s*false/);
});

test('cognitive dashboard distinguishes nested validation, untouched holdout, adaptive model choice and forward drift',()=>{
  assert.match(html,/brainProfile\.factor_evidence\|\|brainProfile\.factors/);
  assert.match(html,/brainProfile\.validation\|\|brain\.validation/);
  assert.match(html,/brainProfile\.model_selection\|\|brain\.model_selection/);
  assert.match(html,/brainProfile\.regime_adaptation\|\|brain\.regime_adaptation/);
  assert.match(html,/brain\.prequential/);
  assert.match(html,/عينات تداخل مستبعدة/);
  assert.match(html,/التحقق الأوسط/);
  assert.match(html,/الامتحان الأخير نجح/);
  assert.match(html,/أداء التوقعات المسجلة يتراجع/);
  assert.match(html,/error_patterns/);
  assert.match(html,/أخطاء عالية الثقة/);
  assert.match(html,/هذا ارتباط تشخيصي وليس إثباتًا للسبب/);
  assert.match(html,/لا تُرفع العملة إلى مرشح دخول قبل اجتياز الشبكة الزمنية للتحقق والاختبار المستقل/);
  assert.match(html,/TCN 24×29→8 latent|TCN_24x29_TO8_LATENT_DILATED_RESIDUAL_BTC_CONTEXT_V7/);
  assert.match(html,/temporalNetwork\.probability_ready/);
  assert.match(html,/OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY/);
});



test('cognitive dashboard exposes the V5 residual neural network and selected model without hiding fallback status',()=>{
  assert.match(html,/neuralNetwork=brainProfile\.neural_network\|\|brainCapture\.neural_network/);
  assert.match(html,/الشبكة العصبية العميقة V5/);
  assert.match(html,/neuralNetwork\.architecture/);
  assert.match(html,/neuralNetwork\.samples_required/);
  assert.match(html,/neuralNetwork\.ensemble_members/);
  assert.match(html,/neuralNetwork\.ensemble_members_required/);
  assert.match(html,/neuralValidationText/);
  assert.match(html,/neuralHoldoutText/);
  assert.match(html,/modelSelection\.selected_model==='NEURAL_GLOBAL'/);
  assert.match(html,/18-10-6-1\+RESIDUAL/);
  assert.match(html,/boostedTreeModel=brainProfile\.boosted_tree_model/);
  assert.match(html,/hybridModel=brainProfile\.hybrid_model/);
  assert.match(html,/أشجار التعزيز التدريجي GBDT/);
  assert.match(html,/النموذج الهجين GBDT \+ V5/);
  assert.match(html,/boostedTreeHoldoutText/);
  assert.match(html,/hybridHoldoutText/);
  assert.match(html,/temporalNetwork\.latent_channels/);
  assert.match(html,/temporalNetwork\.trainable_parameter_count/);

});
