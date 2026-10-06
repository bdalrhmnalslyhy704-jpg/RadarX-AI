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


test('V3 specialist layer recognizes each numbered radar role',()=>{
  const common={
    symbol:'TESTUSDT',direction:'UP_MOVE',opportunity_score:92,price_change_24h:0.8,
    closed_candles_only:true,source:'Binance Public REST',paper_trading:true,real_order_execution:false,risk_flags:[],
    components:{
      trigger:92,structure:94,volume:90,participation:91,taker:89,relative:88,momentum:93,
      compression:86,ema:92,vwap:90,breakout:94,acceleration:93,liquidity:94,data_quality:98,
      flash:94,velocity:92,trades:90,absorption:94,depth:93,trapped:91,dislocation:90,auction:92,
      lag:90,resilience:88,silent_volume:90,reclaim_or_reject:91,value_acceptance:93,rsi_turn:88,mfi_turn:90,
      stochastic_turn:89,persistence:90,early_score:94,ignition_score:95,relative_strength:91,
      one_minute_z:90,five_minute_z:92,efficiency:90,range_acceptance:91,relative_acceleration:90,
      market_structure:95,higher_timeframe_alignment:100,lower_timeframe_agreement:100,trendline:92,
      moving_average:94
    }
  };
  const roles=[
    ['EARLY_MOVE_RADAR',{early_wake:{score:94,pre_move:90}}],
    ['STRONG_MOVE_RADAR',{strong_move:{score:94,flash:95}}],
    ['ROTATION_LAG_RADAR',{rotation:{score:93,lag:92}}],
    ['LIQUIDITY_ABSORPTION_RADAR',{liquidity_absorption:{score:94,absorption_score:95}}],
    ['KAHIR_RADAR',{kahir_analysis:{score:94,one_minute_z:90}}],
    ['DOOMSDAY_RADAR',{doomsday:{score:95,early_score:94,ignition_score:96}}],
    ['ALMUQAWIM_RADAR',{almuqawim:{score:94,market_structure:95,higher_timeframe_alignment:100,lower_timeframe_agreement:100,trendline:92,moving_average:94}}]
  ];
  for(const [radar,root] of roles){
    const r=buildRadarIntelligenceV3({...common,radar,...root});
    assert.equal(r.gate,true,radar+' should pass specialist role gate');
    assert.ok(r.role_score>=65,radar+' specialist score');
  }
});
