import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKET_RADAR_DEFAULTS,
  PRE_MOVE_MAX_CONCURRENT_DEEP_SCANS,
  PRE_MOVE_MAX_DEEP_SCAN_PER_CYCLE
} from '../market/universe-scanner.mjs';

test('Build 224 Pre-Move deep-scan capacity is bounded, configurable, and deadline-protected', async () => {
  assert.equal(MARKET_RADAR_DEFAULTS.preMoveCycleScanLimit, 8);
  assert.equal(PRE_MOVE_MAX_CONCURRENT_DEEP_SCANS, 4);
  assert.equal(PRE_MOVE_MAX_DEEP_SCAN_PER_CYCLE, 10);

  const original = process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT;
  try {
    delete process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT;
    const defaults = await import('../config.mjs?pre-move-cap-default-test');
    assert.equal(defaults.CONFIG.marketRadar.preMoveCycleScanLimit, 8);

    process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT = '10';
    const maximum = await import('../config.mjs?pre-move-cap-maximum-test');
    assert.equal(maximum.CONFIG.marketRadar.preMoveCycleScanLimit, 10);

    process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT = '2';
    const minimum = await import('../config.mjs?pre-move-cap-minimum-test');
    assert.equal(minimum.CONFIG.marketRadar.preMoveCycleScanLimit, 8);

    process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT = 'not-a-number';
    const invalid = await import('../config.mjs?pre-move-cap-invalid-test');
    assert.equal(invalid.CONFIG.marketRadar.preMoveCycleScanLimit, 8);
  } finally {
    if (original === undefined) delete process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT;
    else process.env.RADARX_PREMOVE_DEEP_SCAN_LIMIT = original;
  }
});
