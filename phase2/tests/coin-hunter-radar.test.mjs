import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {CoinHunterRadar} from '../core/coin-hunter-radar.mjs';

const NOW=Date.now();

test('TEST_FIXTURE: coin hunter is selective, closed-candle only, and paper-only', async () => {
  const dir=await mkdtemp(join(tmpdir(),'radarx-coin-hunter-'));
  const store=await new DurableStore({dir}).init();
  const radar=new CoinHunterRadar({rest:{},store,config:{pollMs:60000}});
  assert.equal(radar.health().radar,'COIN_HUNTER_RADAR');
  assert.equal(radar.health().closed_candles_only,true);
  assert.equal(radar.health().paper_trading,true);
  assert.equal(radar.health().real_order_execution,false);
  assert.equal(radar.health().confidence_score,'UNKNOWN');

  radar.running=true;
  radar.lastScanAtMs=NOW;
  radar.latestCandidates=[{
    symbol:'TESTUSDT',score:91.2,decision:'قنص',similarity:88.4,
    today_pct:2.1,price:1.2345,radar:'COIN_HUNTER_RADAR',
    factors:{volume_acceleration:1.8,trade_acceleration:1.5,taker_buy_ratio:.54},
    reasons:['بصمة قريبة من المتحركين الأقوياء اليوم'],
    risk_flags:[],
    detected_at:NOW,source:'Binance Public REST',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',closed_candles_only:true
  }];
  radar.lesson={samples:7,profile:{volumeAcceleration:1.8},top_factors:[{key:'volumeAcceleration',label:'تسارع الحجم',value:1.8}],learned_at:new Date(NOW).toISOString()};
  const snap=radar.snapshot();
  assert.equal(snap.radar_name,'🎯 صائد العملات');
  assert.equal(snap.candidates[0].decision,'قنص');
  assert.equal(snap.data_policy.spot_only,true);
  assert.equal(snap.data_policy.closed_candles_only,true);
  assert.equal(snap.data_policy.real_order_execution,false);
  await store.appendCoinHunterAlert(snap.candidates[0]);
  const rows=await store.readCoinHunterAlerts({limit:10});
  assert.equal(rows.length,1);
  assert.equal(rows[0].symbol,'TESTUSDT');
});
console.log('Coin Hunter Radar tests passed');
