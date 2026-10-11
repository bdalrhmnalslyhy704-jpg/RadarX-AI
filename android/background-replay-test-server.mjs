import http from 'node:http';

const PORT = Number(process.env.RADARX_REPLAY_TEST_PORT || 18765);
let mode = 'empty';
let requests = 0;
let emptyRequests = 0;
let queuedRequests = 0;
let drainedRequests = 0;
let pausedRequests = 0;
let resumeRequests = 0;
let lastRequest = null;
let events = [];

function buildEvents() {
  const detectedBase = Date.now() + 5 * 60 * 1000;
  return Array.from({ length: 623 }, (_, index) => {
    const at = detectedBase + Math.floor(index / 3);
    const event = 'REPLAY_TEST_' + String(index + 1).padStart(4, '0');
    const includeId = index % 17 !== 0;
    const id = includeId ? 'REPLAY:' + String(index + 1).padStart(4, '0') : '';
    const cursorIdentity = includeId ? id : ('TESTUSDT:' + event + ':' + at);
    return {
      ...(includeId ? { id } : {}),
      radar: 'FALCON_EYE_RADAR',
      radar_name: 'عين الصقر',
      symbol: 'TESTUSDT',
      event,
      potential_label: event,
      processed_at: at,
      detected_at: at,
      detected_time_12h: new Date(at).toISOString(),
      price: Number((0.12 + index / 100000).toFixed(6)),
      last_price: Number((0.12 + index / 100000).toFixed(6)),
      eligible: true,
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN',
      replay_cursor_at: at,
      replay_cursor_id: 'FALCON_EYE_RADAR|' + cursorIdentity
    };
  }).sort((a, b) => a.replay_cursor_at - b.replay_cursor_at ||
    a.replay_cursor_id.localeCompare(b.replay_cursor_id));
}

function send(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
}

function compareCursor(row, at, id) {
  return row.replay_cursor_at > at ||
    (row.replay_cursor_at === at && row.replay_cursor_id > id);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/test/health') {
    return send(res, 200, { ok: true, mode, count: events.length });
  }
  if (url.pathname === '/test/empty') {
    mode = 'empty';
    events = [];
    emptyRequests = 0;
    queuedRequests = 0;
    drainedRequests = 0;
    pausedRequests = 0;
    resumeRequests = 0;
    requests = 0;
    lastRequest = null;
    return send(res, 200, { ok: true, mode });
  }
  if (url.pathname === '/test/queue') {
    events = buildEvents();
    mode = 'queue';
    return send(res, 200, { ok: true, mode, events: events.length });
  }
  if (url.pathname === '/test/pause' && req.method === 'POST') {
    mode = 'paused';
    return send(res, 200, { ok: true, mode, count: events.length });
  }
  if (url.pathname === '/test/resume' && req.method === 'POST') {
    mode = 'queue';
    resumeRequests++;
    return send(res, 200, { ok: true, mode, count: events.length, resumeRequests });
  }
  if (url.pathname === '/test/stats') {
    return send(res, 200, {
      ok: true, mode, count: events.length, requests, emptyRequests,
      queuedRequests, drainedRequests, pausedRequests, resumeRequests, lastRequest
    });
  }
  if (url.pathname === '/api/radar-alerts' && req.method === 'GET') {
    requests++;
    const since = Math.max(0, Number(url.searchParams.get('since') || 0));
    const sinceId = String(url.searchParams.get('since_id') || '');
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(url.searchParams.get('limit') || 50))));
    lastRequest = { since, since_id: sinceId, limit, mode };
    if (mode === 'paused') {
      pausedRequests++;
      return send(res, 200, {
        oldest_first: true, has_more: false,
        next_cursor: { since, since_id: sinceId },
        radars: ['FALCON_EYE_RADAR'], alerts: [],
        meta: { live: true, paper_trading: true, real_order_execution: false,
          confidence_score: 'UNKNOWN', cursor_advance_allowed: true,
          feed_mode: 'DURABLE_TEST_FIXTURE_PAUSED' }
      });
    }
    if (mode !== 'queue') {
      emptyRequests++;
      return send(res, 200, {
        oldest_first: true, has_more: false,
        next_cursor: { since, since_id: sinceId },
        radars: ['FALCON_EYE_RADAR'],
        alerts: [],
        meta: { live: true, paper_trading: true, real_order_execution: false,
          confidence_score: 'UNKNOWN', cursor_advance_allowed: true,
          feed_mode: 'DURABLE_TEST_FIXTURE' }
      });
    }

    const after = events.filter(row => compareCursor(row, since, sinceId));
    const page = after.slice(0, limit);
    if (after.length === 0) drainedRequests++;
    else queuedRequests++;
    const last = page.length ? page[page.length - 1] : null;
    return send(res, 200, {
      oldest_first: true,
      has_more: after.length > page.length,
      next_cursor: last
        ? { since: last.replay_cursor_at, since_id: last.replay_cursor_id }
        : { since, since_id: sinceId },
      radars: ['FALCON_EYE_RADAR'],
      alerts: page,
      meta: { live: true, paper_trading: true, real_order_execution: false,
        confidence_score: 'UNKNOWN', cursor_advance_allowed: true,
        feed_mode: 'DURABLE_TEST_FIXTURE' }
    });
  }
  return send(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('RADARX_REPLAY_FIXTURE_READY port=' + PORT + '\n');
});
