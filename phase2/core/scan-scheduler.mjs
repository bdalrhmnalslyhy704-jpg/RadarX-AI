const keyOf = (symbol) => String(symbol || '').trim().toUpperCase();
const finite = (value) => Number.isFinite(Number(value)) && value !== null && value !== undefined;

export const SCAN_SCHEDULER_DEFAULTS = Object.freeze({
  deferLogIntervalMs: 5 * 60 * 1000,
  archiveReadLimit: 5000
});

/**
 * Internal audit/queue memory for scan scheduling. This deliberately has no HTTP
 * contract: Radar 8 and Radar 9 persist their scheduling journey through DurableStore.
 */
export class ScanSchedulerJournal {
  constructor({ radar, store, clock = () => Date.now(), logger = console, config = {} } = {}) {
    this.radar = String(radar || 'UNKNOWN');
    this.store = store;
    this.clock = clock;
    this.logger = logger;
    this.config = { ...SCAN_SCHEDULER_DEFAULTS, ...config };
    this.lastStartedAt = new Map();
    this.queuedAt = new Map();
    this.lastDeferredAt = new Map();
    this.buffer = [];
    this.hydrated = false;
    this.lastFlushError = null;
  }

  stageKey(stage, symbol) {
    return String(stage || '').trim().toUpperCase() + ':' + keyOf(symbol);
  }

  lastScanAt(stage, symbol) {
    return this.lastStartedAt.get(this.stageKey(stage, symbol)) ?? null;
  }

  queueStartedAt(stage, symbol) {
    return this.queuedAt.get(this.stageKey(stage, symbol)) ?? null;
  }

  waitAgeMs(stage, symbol, now = this.clock()) {
    const last = this.lastScanAt(stage, symbol);
    if (last === null) {
      const queued = this.queueStartedAt(stage, symbol);
      return queued === null ? Number.MAX_SAFE_INTEGER : Math.max(0, now - queued);
    }
    return Math.max(0, now - last);
  }

  async hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    if (typeof this.store?.readScanSchedulerEvents !== 'function') return;
    try {
      const rows = await this.store.readScanSchedulerEvents({
        radar: this.radar,
        limit: this.config.archiveReadLimit
      });
      for (const row of [...(rows || [])].sort((a, b) => Number(a.event_at || 0) - Number(b.event_at || 0))) {
        this.apply(row);
      }
    } catch (error) {
      this.lastFlushError = String(error?.message ?? error);
      this.logger.warn?.('SCAN_SCHEDULER_ARCHIVE_READ_FAILED', this.lastFlushError);
    }
  }

  apply(event) {
    const symbol = keyOf(event?.symbol);
    const stage = String(event?.stage || '').toUpperCase();
    if (!symbol || !stage || stage === 'CYCLE') return;
    const key = this.stageKey(stage, symbol);
    const at = Number(event.event_at);
    if (event.event_type === 'DEFERRED' || event.event_type === 'SELECTED') {
      const queued = Number(event.queued_at);
      if (Number.isFinite(queued) && !this.queuedAt.has(key)) this.queuedAt.set(key, queued);
      if (event.event_type === 'DEFERRED' && Number.isFinite(at)) this.lastDeferredAt.set(key, at);
      return;
    }
    if (event.event_type === 'STARTED') {
      if (Number.isFinite(at)) this.lastStartedAt.set(key, at);
      if (Number.isFinite(Number(event.queued_at))) this.queuedAt.set(key, Number(event.queued_at));
      return;
    }
    if (['COMPLETED', 'INCOMPLETE', 'FAILED'].includes(event.event_type)) {
      if (Number.isFinite(at) && event.started_at !== undefined) this.lastStartedAt.set(key, Number(event.started_at));
      this.queuedAt.delete(key);
      this.lastDeferredAt.delete(key);
    }
  }

  ensureQueued(stage, symbol, at = this.clock()) {
    const key = this.stageKey(stage, symbol);
    if (!key.endsWith(':')) {
      if (!this.queuedAt.has(key)) this.queuedAt.set(key, at);
    }
    return this.queuedAt.get(key) ?? at;
  }

  record({
    stage, symbol = null, eventType, cycle = null, at = this.clock(),
    queuedAt = null, startedAt = null, elapsedMs = null, waitMs = null,
    lane = null, reasonCode = null, failureCounted = false, fastSeenAt = null,
    extra = {}
  } = {}) {
    const normalizedStage = String(stage || 'CYCLE').toUpperCase();
    const normalizedSymbol = keyOf(symbol);
    let queueAt = finite(queuedAt) ? Number(queuedAt) :
      (normalizedSymbol ? this.queueStartedAt(normalizedStage, normalizedSymbol) : null);
    if (normalizedSymbol && queueAt === null && ['DEFERRED', 'SELECTED', 'STARTED'].includes(eventType)) {
      queueAt = this.ensureQueued(normalizedStage, normalizedSymbol, at);
    }
    const lastAt = normalizedSymbol ? this.lastScanAt(normalizedStage, normalizedSymbol) : null;
    const calculatedWait = normalizedSymbol
      ? Math.max(0, Number(at) - Number(lastAt ?? queueAt ?? at))
      : null;
    const eventAt=Number(at);
    const startedAtValue=finite(startedAt)?Number(startedAt):null;
    const fastSeenAtValue=finite(fastSeenAt)?Number(fastSeenAt):null;
    const queueAgeMs=normalizedSymbol&&finite(queueAt)?Math.max(0,eventAt-Number(queueAt)):null;
    const timeToFastMs=normalizedStage==='FAST'&&normalizedSymbol&&fastSeenAtValue!==null&&finite(queueAt)
      ?Math.max(0,fastSeenAtValue-Number(queueAt)):null;
    const timeFromFastToScanMs=normalizedSymbol&&fastSeenAtValue!==null&&startedAtValue!==null
      ?Math.max(0,startedAtValue-fastSeenAtValue):null;
    const event = {
      radar: this.radar,
      symbol: normalizedSymbol || null,
      stage: normalizedStage,
      cycle: finite(cycle) ? Number(cycle) : null,
      event_type: String(eventType || 'OBSERVED').toUpperCase(),
      event_at: eventAt,
      queued_at: queueAt,
      queue_age_ms: queueAgeMs,
      time_to_fast_ms: timeToFastMs,
      time_from_fast_to_scan_ms: timeFromFastToScanMs,
      started_at: startedAtValue,
      wait_ms: finite(waitMs) ? Math.max(0, Number(waitMs)) : calculatedWait,
      elapsed_ms: finite(elapsedMs) ? Math.max(0, Number(elapsedMs)) : null,
      lane: lane || null,
      reason_code: reasonCode || null,
      fast_seen_at: fastSeenAtValue,
      failure_counted: Boolean(failureCounted),
      ...extra
    };
    this.buffer.push(event);
    this.apply(event);
    return event;
  }

  defer(stage, symbol, { cycle = null, at = this.clock(), reasonCode = 'BATCH_CAPACITY', fastSeenAt = null, extra = {} } = {}) {
    const key = this.stageKey(stage, symbol);
    const queueAt = this.ensureQueued(stage, symbol, at);
    const previous = Number(this.lastDeferredAt.get(key) || 0);
    const interval = Math.max(0, Number(this.config.deferLogIntervalMs) || 0);
    if (previous && at - previous < interval) return null;
    return this.record({
      stage, symbol, eventType: 'DEFERRED', cycle, at, queuedAt: queueAt,
      reasonCode, fastSeenAt, extra
    });
  }

  selected(stage, symbol, { cycle = null, at = this.clock(), lane = null, reasonCode = 'SELECTED_FOR_SCAN', fastSeenAt = null, extra = {} } = {}) {
    const queueAt = this.ensureQueued(stage, symbol, at);
    return this.record({ stage, symbol, eventType: 'SELECTED', cycle, at, queuedAt: queueAt, lane, reasonCode, fastSeenAt, extra });
  }

  started(stage, symbol, { cycle = null, at = this.clock(), lane = null, reasonCode = 'SCAN_STARTED', fastSeenAt = null, extra = {} } = {}) {
    const queueAt = this.ensureQueued(stage, symbol, at);
    return this.record({
      stage, symbol, eventType: 'STARTED', cycle, at, queuedAt: queueAt, startedAt: at,
      waitMs: Math.max(0, at - Number(this.lastScanAt(stage, symbol) ?? queueAt)),
      lane, reasonCode, fastSeenAt, extra
    });
  }

  finished(stage, symbol, {
    outcome = 'COMPLETED', cycle = null, at = this.clock(), startedAt = null,
    lane = null, reasonCode = null, failureCounted = false, fastSeenAt = null, extra = {}
  } = {}) {
    const queueAt = this.queueStartedAt(stage, symbol);
    return this.record({
      stage, symbol, eventType: outcome, cycle, at, queuedAt: queueAt,
      startedAt, elapsedMs: finite(startedAt) ? Math.max(0, at - Number(startedAt)) : null,
      waitMs: Math.max(0, Number(startedAt ?? at) - Number(this.lastScanAt(stage, symbol) ?? queueAt ?? at)),
      lane, reasonCode: reasonCode || outcome, failureCounted, fastSeenAt, extra
    });
  }

  cycleSummary({ cycle, at = this.clock(), elapsedMs = null, reasonCode = 'CYCLE_COMPLETE', extra = {} } = {}) {
    return this.record({ stage: 'CYCLE', eventType: 'COMPLETED', cycle, at, elapsedMs, reasonCode, extra });
  }

  async flush() {
    if (!this.buffer.length || typeof this.store?.appendScanSchedulerEvents !== 'function') {
      this.buffer.length = 0;
      return { written: 0 };
    }
    const pending = this.buffer.splice(0, this.buffer.length);
    try {
      await this.store.appendScanSchedulerEvents(pending);
      this.lastFlushError = null;
      return { written: pending.length };
    } catch (error) {
      this.buffer.unshift(...pending);
      this.lastFlushError = String(error?.message ?? error);
      this.logger.warn?.('SCAN_SCHEDULER_ARCHIVE_WRITE_FAILED', this.lastFlushError);
      return { written: 0, error: this.lastFlushError };
    }
  }
}

export function schedulerLaneReason(lane, stage) {
  const key = String(lane || '').toLowerCase();
  if (key === 'exceptional') return 'EXCEPTIONAL_ACTIVITY_ACCELERATION';
  if (key === 'quiet') return 'QUIET_BASE_WITH_IMPROVING_PARTICIPATION';
  if (key === 'rotation' || key === 'fill_rotation') return 'LONGEST_WAITING_ROTATION';
  if (key === 'score' || key === 'fill_score') return 'HIGHEST_CURRENT_EARLY_SCORE';
  if (key === 'fill_quiet') return 'QUIET_QUEUE_FILL';
  if (key === 'anchor') return 'BEST_EXISTING_ANCHOR_RANK';
  if (key === 'fast') return 'EXCEPTIONAL_FAST_PATH';
  return String(stage || 'SCAN').toUpperCase() + '_RESOURCE_BOUNDED_FALLBACK';
}
