import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  DEFAULT_BACKEND_BASE_URL,
  BACKEND_FALLBACK_URLS,
  requestJson
} from '../radarx-backend-client.mjs';

const [tradliActivity, mainActivity, page, suite] = await Promise.all([
  readFile(new URL('../../java/com/radarx/app/TradliActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../../java/com/radarx/app/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../tradli.html', import.meta.url), 'utf8'),
  readFile(new URL('../radarx-tradli-feature-suite.mjs', import.meta.url), 'utf8')
]);

test('TRADLI WebView allows the current Railway backend and its HTTPS fallback', () => {
  assert.match(tradliActivity, /BACKEND_ORIGIN\s*=\s*\n\s*"https:\/\/radarx-ai-triple-production\.up\.railway\.app"/);
  assert.match(tradliActivity, /BACKEND_FALLBACK_ORIGIN\s*=\s*\n\s*"https:\/\/radarx-ai-production\.up\.railway\.app"/);
  assert.match(tradliActivity, /BACKEND_ORIGIN\.equalsIgnoreCase\(origin\)\s*\|\|\s*\n\s*BACKEND_FALLBACK_ORIGIN\.equalsIgnoreCase\(origin\)/);
  assert.match(tradliActivity, /isAllowedBackendUri\(Uri\.parse\(url\.toString\(\)\)\)/);
  assert.match(tradliActivity, /connection\.setReadTimeout\(180000\)/);
  assert.match(mainActivity, /isAllowedBackendUri\(Uri\.parse\(request\.getUrl\(\)\.toString\(\)\)\)/);
  assert.match(mainActivity, /connection\.setReadTimeout\(180000\)/);
});

test('TRADLI checks the market data route, not only generic backend health', () => {
  assert.match(page, /\/api\/market-radar\?quote=USDT&limit=1/);
  assert.match(page, /CONNECTED \/ DEGRADED/);
  assert.match(page, /BACKEND CHECK/);
  assert.doesNotMatch(page, /LIVE DATA • PAPER ONLY/);
});

test('all six TRADLI modules use real backend analysis and safe market context', () => {
  for (const key of ['chart','verify','advisor','hub','sd','desk']) {
    assert.match(suite, new RegExp('data-tab="' + key + '"'));
    assert.match(suite, new RegExp('id="rx-p-' + key + '"'));
  }
  assert.match(suite, /getSymbolDeepScan/);
  assert.match(suite, /getRadarAlerts/);
  assert.match(suite, /levelsFor\(frame,'support_levels'/);
  assert.match(suite, /levelsFor\(frame,'resistance_levels'/);
  assert.match(suite, /SAVED_DATA_NOT_VALID_FOR_TRADE_REVIEW/);
  assert.doesNotMatch(suite, /num\(p\*\.988,8\)/);
  assert.match(suite, /NO EXECUTION/);
});

test('TRADLI mobile tabs and forms have valid independent responsive rules', () => {
  assert.match(suite, /@media\(max-width:700px\)\{\.rxsuite-tabs\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\.rxsuite-form\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(suite, /repeat\(2,1fr\)\.rxsuite-form/);
});

test('backend client retries the legacy host if the primary host returns 404', async () => {
  const calls=[];
  const fakeFetch=async url=>{
    calls.push(String(url));
    if(String(url).startsWith(DEFAULT_BACKEND_BASE_URL)) {
      return {status:404,ok:false,json:async()=>({error:'NOT_FOUND'})};
    }
    return {status:200,ok:true,json:async()=>({candidates:[],meta:{live:true}})};
  };
  const result=await requestJson(DEFAULT_BACKEND_BASE_URL,'/api/market-radar?quote=USDT&limit=1',fakeFetch,1000);
  assert.equal(result.status,200);
  assert.equal(result.ok,true);
  assert.equal(result.base,BACKEND_FALLBACK_URLS[0]);
  assert.equal(calls.length,2);
});
