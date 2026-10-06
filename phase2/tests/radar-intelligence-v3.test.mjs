import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRadarIntelligenceV3} from '../core/radar-intelligence-v3.mjs';

const baseAlert={
  radar:'ALMUQAWIM_RADAR',
  symbol:'TESTUSDT',
  direction:'UP',
  opportunity_score:88,
  price_change_24h:1.1,
  closed_candles_only:true,
  source:'Binance Public REST',
  paper_trading:true,
  real_order_execution:false,
  almuqawim:{
    score:92,
    confirmation_count:6,
    confirmation_total:7,
    components:{
      market_structure:94,
      higher_timeframe_alignment:100,
      lower_timeframe_agreement:100,
      trendline:88,
      moving_average:91
    },
    timeframes:{
      '4h':{direction:'UP',score:90},
      '1h':{direction:'UP',score:90},
      '15m':{direction:'UP',score:90}
    }
  },
  components:{
    structure:94,
    trigger:90,
    volume:84,
    participation:86,
    taker:82,
    relative:88,
    momentum:85,
    compression:78,
    ema:91,
    vwap:88,
    liquidity:92,
    data_quality:96
  },
  risk_flags:[]
};

test('V3 passes a diversified high-quality closed-candle alert',()=>{
  const r=buildRadarIntelligenceV3(baseAlert);
  assert.equal(r.version,'3.0');
  assert.equal(r.gate,true);
  assert.ok(r.quality_score>=82);
  assert.equal(r.grade,'ELITE');
  assert.ok(r.evidence_diversity.count>=6);
  assert.equal(r.integrity.closed_candles,true);
});

test('V3 filters an alert with weak evidence diversity',()=>{
  const a={...baseAlert,components:{market_structure:92,data_quality:96,liquidity:90}};
  const r=buildRadarIntelligenceV3(a);
  assert.equal(r.gate,false);
  assert.ok(r.failures.includes('LOW_EVIDENCE_DIVERSITY'));
});

test('V3 blocks open-candle analysis even with high scores',()=>{
  const a={...baseAlert,closed_candles_only:false};
  const r=buildRadarIntelligenceV3(a);
  assert.equal(r.gate,false);
  assert.ok(r.failures.includes('OPEN_CANDLE_BLOCK'));
});

test('V3 penalizes higher-timeframe conflict',()=>{
  const a={...baseAlert,risk_flags:['AGAINST_HIGHER_TIMEFRAME']};
  const r=buildRadarIntelligenceV3(a);
  assert.equal(r.gate,false);
  assert.ok(r.failures.includes('HIGHER_TIMEFRAME_CONFLICT'));
});

console.log('Radar Intelligence V3 tests passed');
