import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SAMPLE_TARGET =
  'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_24H_15M_V1';
const SAMPLE_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_SAFE_FIRST_TOUCH_HORIZONS_V1';
const TEMPORAL_INTERVAL_MS = 15 * 60 * 1000;
const TEMPORAL_STEPS = 24;
const TEMPORAL_CHANNELS = 29;

const finiteNumber = value =>
  typeof value === 'number' && Number.isFinite(value);

async function scanJsonl(filePath, visit) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  let pending = Buffer.alloc(0);
  let rows = 0;

  const consumeLine = buffer => {
    let line = buffer;
    if (line.length && line[line.length - 1] === 13)
      line = line.subarray(0, line.length - 1);
    if (!line.length) return;
    let value;
    try {
      value = JSON.parse(line.toString('utf8'));
    } catch (error) {
      throw new Error('JSONL_ROW_PARSE_FAILED:' + (rows + 1) + ':' + error.message);
    }
    rows++;
    visit(value, rows);
  };

  for await (const chunk of stream) {
    hash.update(chunk);
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(10, start);
      if (newline < 0) break;
      consumeLine(buffer.subarray(start, newline));
      start = newline + 1;
    }
    pending = Buffer.from(buffer.subarray(start));
  }
  if (pending.length) consumeLine(pending);
  return { rows, sha256: hash.digest('hex') };
}

export async function verifyDailyEarlyRiserCensusArtifact({
  reportPath,
  samplePath,
  temporalPath,
  expectedSourceCommit,
  censusRunId,
  minimumSamples = 10000
} = {}) {
  if (![reportPath, samplePath, temporalPath].every(value =>
    typeof value === 'string' && value.length > 0))
    throw new TypeError('CENSUS_ARTIFACT_PATHS_REQUIRED');
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1)
    throw new TypeError('CENSUS_MINIMUM_SAMPLE_CONFIGURATION_INVALID');

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (!['READY', 'AUDITED_WITH_SURVIVOR_UNIVERSE_CAVEAT'].includes(report.status) ||
      report.data_quality?.all_sample_audits_ready !== true ||
      report.data_quality?.no_overlapping_daily_labels !== true ||
      Number(report.data_quality?.feature_cutoff_violations) !== 0 ||
      Number(report.data_quality?.horizon_violations) !== 0 ||
      Number(report.data_quality?.symbols_failed) !== 0 ||
      Number(report.data_quality?.symbols_incomplete_archive) !== 0 ||
      Number(report.data_quality?.archive_coverage_after_first_available_pct) !== 100)
    throw new Error('CENSUS_NOT_READY_FOR_UNIFIED_BENCHMARK');

  const sampleMetadata = report.sample_file;
  if (!sampleMetadata || !finiteNumber(Number(sampleMetadata.rows)) ||
      typeof sampleMetadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sampleMetadata.sha256))
    throw new Error('SAMPLE_FILE_METADATA_INVALID');

  const sampleIds = new Map();
  const timestampsBySymbol = new Map();
  let badLane = 0, badLabel = 0, badCutoff = 0, invalidSamples = 0;

  const sampleAudit = await scanJsonl(samplePath, row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      invalidSamples++;
      return;
    }
    const id = String(row.id ?? '').trim();
    const symbol = String(row.symbol ?? '').trim().toUpperCase();
    const at = row.at;
    if (!id || !symbol || !finiteNumber(at)) {
      invalidSamples++;
      return;
    }
    if (sampleIds.has(id)) throw new Error('DUPLICATE_SAMPLE_ID:' + id);
    sampleIds.set(id, { symbol, at });

    if (row.liquidity_lane !== 'STANDARD_750K_PLUS' ||
        !Number.isFinite(Number(row.quote_volume_24h)) ||
        Number(row.quote_volume_24h) < 750000) badLane++;

    const label = row.safe_opportunity_targets?.['24h']?.plus_5_pct;
    if (!label || !['RESOLVED', 'AMBIGUOUS'].includes(label.status) ||
        !['UP', 'DOWN', 'FLAT', 'AMBIGUOUS'].includes(label.outcome) ||
        Number(label.horizon_ms) !== 86400000 ||
        label.target_definition !== SAMPLE_TARGET ||
        label.outcome_source !== SAMPLE_SOURCE) badLabel++;

    if (row.feature_information_cutoff_at !== at ||
        row.observation_source !== 'BINANCE_OFFICIAL_CLOSED_15M_BASELINE') badCutoff;

    if (!timestampsBySymbol.has(symbol)) timestampsBySymbol.set(symbol, []);
    timestampsBySymbol.get(symbol).push(at);
  });

  if (sampleAudit.sha256 !== sampleMetadata.sha256)
    throw new Error('SAMPLE_SHA256_MISMATCH');
  if (sampleAudit.rows !== Number(sampleMetadata.rows))
    throw new Error('SAMPLE_ROW_COUNT_MISMATCH');
  if (sampleAudit.rows < minimumSamples)
    throw new Error('SAMPLE_SUPPORT_TOO_SMALL:' + sampleAudit.rows);
  if (invalidSamples) throw new Error('SAMPLE_IDENTITY_OR_TIMESTAMP_INVALID:' + invalidSamples);

  let overlap = 0;
  for (const values of timestampsBySymbol.values()) {
    values.sort((a, b) => a - b);
    for (let index = 1; index < values.length; index++) {
      if (values[index] - values[index - 1] < 86400000) overlap++;
    }
  }

  const temporalMetadata = report.temporal_sample_file;
  if (!temporalMetadata || temporalMetadata.timestamps_verified !== true ||
      temporalMetadata.sequence_steps !== TEMPORAL_STEPS ||
      temporalMetadata.sequence_channels !== TEMPORAL_CHANNELS ||
      temporalMetadata.interval_ms !== TEMPORAL_INTERVAL_MS ||
      Number(temporalMetadata.invalid_declared_sequences) !== 0 ||
      !finiteNumber(Number(temporalMetadata.rows)) ||
      typeof temporalMetadata.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(temporalMetadata.sha256))
    throw new Error('TIMESTAMPED_TCN_SIDECAR_METADATA_INVALID');

  const temporalIds = new Set();
  let invalidTemporal = 0;
  const temporalAudit = await scanJsonl(temporalPath, row => {
    const identity = row && sampleIds.get(String(row.id ?? ''));
    if (!identity || identity.symbol !== String(row.symbol ?? '').toUpperCase() ||
        identity.at !== row.at || temporalIds.has(String(row.id))) {
      invalidTemporal++;
      return;
    }
    temporalIds.add(String(row.id));
    const sequence = row.temporal_sequence;
    const times = row.temporal_sequence_timestamps;
    if (!Array.isArray(sequence) || sequence.length !== TEMPORAL_STEPS ||
        sequence.some(step => !Array.isArray(step) || step.length !== TEMPORAL_CHANNELS ||
          step.some(value => !finiteNumber(value) || Math.abs(value) > 4)) ||
        !Array.isArray(times) || times.length !== TEMPORAL_STEPS ||
        times.some(value => !finiteNumber(value)) ||
        times[TEMPORAL_STEPS - 1] !== row.at ||
        times.some((value, index) => index > 0 &&
          value - times[index - 1] !== TEMPORAL_INTERVAL_MS)) invalidTemporal++;
  });

  if (temporalAudit.sha256 !== temporalMetadata.sha256)
    throw new Error('TEMPORAL_SIDECAR_SHA256_MISMATCH');
  if (temporalAudit.rows !== Number(temporalMetadata.rows))
    throw new Error('TEMPORAL_SIDECAR_ROW_COUNT_MISMATCH');
  if (invalidTemporal) throw new Error('TEMPORAL_SIDECAR_IDENTITY_OR_SEQUENCE_INVALID:' + invalidTemporal);

  if (badLane || badLabel || badCutoff || overlap)
    throw new Error(JSON.stringify({ badLane, badLabel, badCutoff, overlap }));

  return {
    expected_source_commit: expectedSourceCommit ?? null,
    census_run_id: censusRunId ?? null,
    census_status: report.status,
    sample_rows: sampleAudit.rows,
    sample_sha256: sampleAudit.sha256,
    temporal_rows: temporalAudit.rows,
    temporal_sha256: temporalAudit.sha256,
    temporal_timestamps_verified: true,
    bad_lane: badLane,
    bad_label: badLabel,
    bad_cutoff: badCutoff,
    overlap,
    invalid_temporal: invalidTemporal,
    validation_mode: 'STREAMING_JSONL_SHA_AND_ROW_IDENTITY_AUDIT_V1'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportPath, samplePath, temporalPath] = process.argv.slice(2);
  try {
    const result = await verifyDailyEarlyRiserCensusArtifact({
      reportPath,
      samplePath,
      temporalPath,
      expectedSourceCommit: process.env.EXPECTED_SOURCE_COMMIT,
      censusRunId: process.env.CENSUS_RUN_ID
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
