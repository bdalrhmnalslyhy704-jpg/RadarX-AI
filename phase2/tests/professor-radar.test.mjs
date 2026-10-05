import test from 'node:test';
import assert from 'node:assert/strict';
import {ProfessorRadar,calculateProfessorOpinion,classifyStreamClaim} from '../core/professor-radar.mjs';
import {resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';

test('TEST_PROFESSOR: stream claim classifier separates buy and sell language',()=>{
  assert.equal(classifyStreamClaim('BTC buy long breakout entry').action,'BUY_BIAS');
  assert.equal(classifyStreamClaim('ETH sell short bearish breakdown').action,'SELL_BIAS');
});

test('TEST_PROFESSOR: opinion produces paper-only plan after confluence',()=>{
  const candidate={stream_mentions:1,news_mentions:1,stream_score:100,news_score:82};
  const deep={price:{last:100},assessment:{direction_score:82,trap_risk:20},zones:{support:96,resistance:108}};
  const opinion=calculateProfessorOpinion({candidate,deep,now:1700000000000,entryThreshold:78,watchThreshold:66});
  assert.equal(opinion.action,'PAPER_ENTRY_CANDIDATE');
  assert.equal(opinion.paper_trade.mode,'PAPER_ONLY');
  assert.equal(opinion.paper_trade.direction,'BUY');
  assert.match(opinion.stance,/رأيي/);
});

test('TEST_PROFESSOR: weak technical/news evidence avoids paper entry',()=>{
  const candidate={stream_mentions:0,news_mentions:1,stream_score:50,news_score:35};
  const deep={price:{last:100},assessment:{direction_score:42,trap_risk:70},zones:{support:90,resistance:101}};
  const opinion=calculateProfessorOpinion({candidate,deep,now:1700000000000});
  assert.equal(opinion.action,'SPOT_AVOID');
  assert.equal(opinion.paper_trade,null);
});

test('TEST_PROFESSOR: scan fuses public stream + news + Binance technical confirmation',async()=>{
  resetRadarNotificationGateForTests();
  const alerts=[];
  const store={appendProfessorAlert:async x=>alerts.push(x)};
  const rest={request:async path=>{
    assert.equal(path,'/api/v3/exchangeInfo');
    return {data:{symbols:[
      {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true},
      {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}
    ]}};
  }};
  const deepAnalyzer={scan:async symbol=>{
    assert.equal(symbol,'BTCUSDT');
    return {status:'ok',symbol,price:{last:100,last_closed_15m:100},assessment:{direction_score:82,trap_risk:20},zones:{support:96,resistance:108}};
  }};
  const ytData={contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[
    {videoRenderer:{videoId:'abc123',title:{simpleText:'BTC buy long breakout LIVE'},descriptionSnippet:{runs:[{text:'BTC entry now'}]},ownerText:{simpleText:'Test Trader'},viewCountText:{simpleText:'1K'},badges:[{metadataBadgeRenderer:{label:{simpleText:'LIVE NOW'}}}],thumbnailOverlays:[]}}
  ]}}]}}}}};
  const player={};
  const gdelt={articles:[{title:'BTC partnership boosts market growth',url:'https://example.com/news/1',domain:'example.com',datetime:'2026-10-04T18:00:00Z',tone:4}]};
  const fetchImpl=async url=>{
    const u=String(url);
    if(u.includes('youtube.com/results?search_query='))return new Response('var ytInitialData = '+JSON.stringify(ytData)+';',{status:200});
    if(u.includes('youtube.com/watch?v=abc123'))return new Response('var ytInitialPlayerResponse = '+JSON.stringify(player)+';',{status:200});
    if(u.includes('api.gdeltproject.org'))return new Response(JSON.stringify(gdelt),{status:200,headers:{'content-type':'application/json'}});
    throw new Error('UNEXPECTED_URL');
  };
  const radar=new ProfessorRadar({rest,store,deepAnalyzer,fetchImpl,config:{liveSearchLimit:8,transcriptStreams:1,newsLimit:10,deepCandidates:5,deepConcurrency:1,alertCooldownMs:0,minEntryScore:78,minWatchScore:66},clock:()=>1700000000000,logger:{warn(){}}});
  radar.running=true;
  const ok=await radar.tick();
  radar.running=false;
  assert.equal(ok,true);
  const snap=radar.snapshot(10);
  assert.equal(snap.radar,'PROFESSOR_RADAR');
  assert.equal(snap.streams.live_count,1);
  assert.equal(snap.news.count,1);
  assert.equal(snap.candidates[0].symbol,'BTCUSDT');
  assert.equal(snap.candidates[0].opinion.action,'PAPER_ENTRY_CANDIDATE');
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].radar_name,'Radar 6 — البروفيسور');
  assert.equal(alerts[0].paper_trading,true);
  assert.equal(alerts[0].real_order_execution,false);
});
