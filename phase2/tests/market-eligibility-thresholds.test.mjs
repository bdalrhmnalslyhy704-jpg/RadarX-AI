import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG} from '../config.mjs';

test('Build 224 uses a single 750000 USDT quote-volume floor across radar configs',()=>{
  const floors=[
    CONFIG.moveRadar.minQuoteVolume24h,
    CONFIG.strongMoveRadar.minQuoteVolume24h,
    CONFIG.marketRadar.minQuoteVolume24h,
    CONFIG.rotationRadar.minQuoteVolume24h,
    CONFIG.alMuqawimRadar.minQuoteVolume24h,
    CONFIG.liquidityAbsorptionRadar.minQuoteVolume24h,
    CONFIG.kahirRadar.minQuoteVolume24h,
    CONFIG.doomsdayRadar.minQuoteVolume24h,
    CONFIG.multiAnalyst.minQuoteVolume24h,
    CONFIG.earlyExpansionRadar.minQuoteVolume24h,
    CONFIG.whaleAccumulationRadar.minQuoteVolume24h,
    CONFIG.coinHunterRadar.minQuoteVolume24h,
    CONFIG.falconEyeRadar.minQuoteVolume24h
  ];
  assert.deepEqual([...new Set(floors)],[750000]);
});
