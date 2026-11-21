import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runFixedShaBenchmark } from '../core/hybrid-tcn-attention-benchmark.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
function numericArgument(name, fallback, minimum = 0) {
  const raw = argument(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) throw new Error('INVALID_ARGUMENT_' + name);
  return value;
}

const inputPath = argument('--input');
const outputPath = resolve(argument('--output', 'reports/hybrid-tcn-attention-benchmark.json'));
const sourceCommitSha = argument('--source-commit-sha', process.env.GITHUB_SHA ?? '');
if (!inputPath) {
  console.error('Usage: node phase2/tools/hybrid-tcn-attention-benchmark.mjs --input <prepared-dataset.json> --source-commit-sha <full-40-char-sha> [--output report.json]');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
    const rows = Array.isArray(input) ? input : input.rows;
    const options = Array.isArray(input) ? {} : (input.benchmark_options ?? {});
    const report = runFixedShaBenchmark(rows, {
      ...options,
      sourceCommitSha,
      folds: numericArgument('--folds', options.folds ?? 5, 2),
      minimumTrainTimes: numericArgument('--minimum-train-times', options.minimumTrainTimes ?? 160, 20),
      minimumTrainRows: numericArgument('--minimum-train-rows', options.minimumTrainRows ?? 100, 20),
      minimumValidationRows: numericArgument('--minimum-validation-rows', options.minimumValidationRows ?? 30, 10),
      minimumTestRows: numericArgument('--minimum-test-rows', options.minimumTestRows ?? 30, 10),
      epochs: numericArgument('--epochs', options.epochs ?? 8, 1),
      learningRate: numericArgument('--learning-rate', options.learningRate ?? 0.003, 0.0001),
      crossSectionalRankingWeight: numericArgument('--ranking-weight',
        options.crossSectionalRankingWeight ?? 0.15, 0),
      roundTripCostBps: numericArgument('--round-trip-cost-bps', options.roundTripCostBps ?? 30, 0),
      embargoMs: numericArgument('--embargo-hours', options.embargoHours ?? 4, 0) * 60 * 60 * 1000
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({
      status: report.status,
      source_commit_sha: report.integrity?.source_commit_sha,
      dataset_sha256: report.integrity?.dataset_sha256,
      fixed_benchmark_sha256: report.integrity?.fixed_benchmark_sha256,
      walk_forward: report.walk_forward?.status,
      neural: report.neural,
      classic_baseline: report.classic_baseline,
      acceptance_gates: report.acceptance_gates,
      report_path: outputPath
    }, null, 2));
    if (report.status !== 'HYBRID_TCN_ATTENTION_ACCEPTED') process.exitCode = 1;
  } catch (error) {
    console.error('[HYBRID_TCN_ATTENTION_BENCHMARK_FAILED] ' + String(error?.stack || error).slice(0, 4000));
    process.exitCode = 1;
  }
}
