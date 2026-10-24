/**
 * Numeric normalization for market-data payloads.
 *
 * Missing values must remain missing: Number(null), Number('') and Number(false)
 * all produce zero, which can silently turn an absent field into false evidence.
 */
export function finiteNumberOr(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}
