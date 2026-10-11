import test from 'node:test';
import assert from 'node:assert/strict';

test('all Spot USDT radar liquidity thresholds enforce the shared 750,000 USDT floor while preserving stricter gates', async () => {
  const lowOverrides = {
    RADARX_MOVE_MIN_QUOTE_VOLUME_24H: '100000',
    RADARX_STRONG_MOVE_MIN_QUOTE_VOLUME_24H: '500000',
    RADARX_MARKET_RADAR_MIN_QUOTE_VOLUME_24H: '750000',
    RADARX_ROTATION_RADAR_MIN_QUOTE_VOLUME_24H: '0',
    RADARX_ALMUQAWIM_MIN_QUOTE_VOLUME_24H: '750000',
    RADARX_LIQUIDITY_ABSORPTION_MIN_QUOTE_VOLUME_24H: '1500000',
    RADARX_KAHIR_MIN_QUOTE_VOLUME_24H: '500000',
    RADARX_DOOMSDAY_MIN_QUOTE_VOLUME_24H: '500000',
    RADARX_MULTI_ANALYST_MIN_QUOTE_VOLUME_24H: '300000',
    RADARX_EARLY_EXPANSION_MIN_QUOTE_VOLUME_24H: '350000',
    RADARX_WHALE_ACCUMULATION_MIN_QUOTE_VOLUME_24H: '1500000',
    RADARX_COIN_HUNTER_MIN_QUOTE_VOLUME_24H: '750000',
    RADARX_FALCON_EYE_MIN_QUOTE_VOLUME_24H: '500000',
    RADARX_FALCON_EYE_FAST_MIN_QUOTE_VOLUME_24H: '200000'
  };
  const prior = new Map(Object.keys(lowOverrides).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(lowOverrides)) process.env[key] = value;
    const { CONFIG, DEFAULT_MIN_SPOT_QUOTE_VOLUME_24H_USDT, minSpotQuoteVolume24h } =
      await import('../config.mjs?liquidity-floor-regression');
    assert.equal(DEFAULT_MIN_SPOT_QUOTE_VOLUME_24H_USDT, 750000);
    for (const section of [
      CONFIG.moveRadar, CONFIG.strongMoveRadar, CONFIG.marketRadar, CONFIG.rotationRadar,
      CONFIG.alMuqawimRadar, CONFIG.liquidityAbsorptionRadar, CONFIG.kahirRadar, CONFIG.doomsdayRadar,
      CONFIG.multiAnalyst, CONFIG.earlyExpansionRadar, CONFIG.whaleAccumulationRadar,
      CONFIG.coinHunter, CONFIG.falconEyeRadar
    ]) {
      assert.ok(section.minQuoteVolume24h >= 750000, JSON.stringify(section));
    }
    assert.equal(CONFIG.falconEye.fastMinQuoteVolume24h, 750000);
    assert.equal(CONFIG.strongMoveRadar.minQuoteVolume24h, 750000);
    assert.equal(CONFIG.liquidityAbsorptionRadar.minQuoteVolume24h, 1500000);
    assert.equal(CONFIG.whaleAccumulationRadar.minQuoteVolume24h, 1500000);
    assert.equal(minSpotQuoteVolume24h('not-a-number', 1000000), 1000000);
    assert.equal(minSpotQuoteVolume24h('200000', 1500000), 750000);
    assert.equal(minSpotQuoteVolume24h('2000000', 1500000), 2000000);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
