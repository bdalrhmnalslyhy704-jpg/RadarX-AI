/**
 * Produce a stable, non-repeating order for public data-provider fallbacks.
 * Compute the complete order before requests increment their shared counter.
 */
export function orderedHostIndexes(requestCount, hostCount) {
  const requests = Number(requestCount);
  const count = Number(hostCount);
  if (!Number.isSafeInteger(requests) || requests < 0) {
    throw new RangeError('requestCount must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('hostCount must be a positive safe integer');
  }
  const first = requests % count;
  return Array.from({ length: count }, (_, offset) => (first + offset) % count);
}
