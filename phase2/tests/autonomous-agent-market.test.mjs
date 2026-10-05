import test from 'node:test';
import assert from 'node:assert/strict';
import {rankAgentDiscovery,selectAgentDeepTargets} from '../core/autonomous-agent-market.mjs';

const symbols=[{symbol:'BTCUSDT'},{symbol:'SANDUSDT'},{symbol:'ONEUSDT'},{symbol:'NOMUSDT'}];
const tickers=[
 {symbol:'BTCUSDT',lastPrice:'70000',quoteVolume:'1000000000',count:1000000,priceChangePercent:1,highPrice:'70500',lowPrice:'69000'},
 {symbol:'SANDUSDT',lastPrice:'0.3',quoteVolume:'50000000',count:90000,priceChangePercent:4,highPrice:'0.31',lowPrice:'0.28'},
 {symbol:'ONEUSDT',lastPrice:'0.01',quoteVolume:'10000000',count:30000,priceChangePercent:2,highPrice:'0.011',lowPrice:'0.009'},
 {symbol:'NOMUSDT',lastPrice:'0.02',quoteVolume:'1000000',count:5000,priceChangePercent:-5,highPrice:'0.023',lowPrice:'0.018'}
];
test('agent discovery observes every eligible ticker row',()=>{const x=rankAgentDiscovery(tickers,symbols,{minQuoteVolume24h:750000});assert.equal(x.length,4);assert.ok(x.some(v=>v.symbol==='NOMUSDT'));});
test('deep target rotation keeps priority and adds rotating coverage',()=>{const x=rankAgentDiscovery(tickers,symbols,{minQuoteVolume24h:750000});const a=selectAgentDeepTargets(x,{deepCandidates:3,deepPool:4,cursor:0});const b=selectAgentDeepTargets(x,{deepCandidates:3,deepPool:4,cursor:a.nextCursor});assert.equal(a.targets.length,3);assert.equal(b.targets.length,3);assert.equal(a.targets[0].symbol,x[0].symbol);assert.ok(a.targets.some(v=>v.symbol==='SANDUSDT'));assert.ok(a.targets.some(v=>v.symbol==='BTCUSDT'));assert.ok(a.targets.some(v=>v.symbol==='ONEUSDT'));assert.equal(new Set(a.targets.map(v=>v.symbol)).size,3);});
