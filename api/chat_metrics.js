import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

function clampDays(raw, fallback = 7, min = 1, max = 30) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function canReadGlobal(scope = '', user = '') {
  return String(scope || '').toLowerCase() === 'global' && String(user || '') === 'Zaldy';
}

async function ensureRouterMetricsSchema() {
  if (global._zaiRouterMetricsSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_router_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60),
      response_id VARCHAR(80),
      status VARCHAR(20) NOT NULL DEFAULT 'ok',
      router_mode VARCHAR(20),
      selected_engine VARCHAR(40),
      engine_final VARCHAR(40),
      fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      complexity_score INTEGER,
      complexity_level VARCHAR(20),
      latency_ms INTEGER,
      intent VARCHAR(80),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_user_time ON z_ai_router_events(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_time ON z_ai_router_events(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_engine ON z_ai_router_events(engine_final, created_at DESC)');
  global._zaiRouterMetricsSchemaReady = true;
}

function buildWhereClause({ days = 7, userId = '', globalScope = false }) {
  const values = [days];
  const filters = ['created_at >= NOW() - ($1::int * INTERVAL \'1 day\')'];
  if (!globalScope) {
    values.push(userId);
    filters.push(`user_id=$${values.length}`);
  }
  return {
    where: filters.join(' AND '),
    values,
  };
}

async function getSummary(whereClause) {
  const { where, values } = whereClause;
  const result = await pool.query(
    `
      SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms,
        COALESCE(
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL),
          0
        )::float AS p95_latency_ms,
        COALESCE(SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END), 0)::int AS fallback_count,
        COALESCE(
          ROUND(
            (SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0)) * 100,
            2
          ),
          0
        )::float AS fallback_rate_pct
      FROM z_ai_router_events
      WHERE ${where}
    `,
    values
  );
  return result.rows[0] || {
    total_requests: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    fallback_count: 0,
    fallback_rate_pct: 0,
  };
}

async function getEngineBreakdown(whereClause) {
  const { where, values } = whereClause;
  const result = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(engine_final, ''), 'unknown') AS engine,
        COUNT(*)::int AS count
      FROM z_ai_router_events
      WHERE ${where}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
    `,
    values
  );
  return result.rows;
}

async function getIntentBreakdown(whereClause) {
  const { where, values } = whereClause;
  const result = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(intent, ''), 'unknown') AS intent,
        COUNT(*)::int AS count
      FROM z_ai_router_events
      WHERE ${where}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
    `,
    values
  );
  return result.rows;
}

async function getHourlyTrend(whereClause, globalScope, userId) {
  const values = [];
  const filters = [`created_at >= NOW() - INTERVAL '24 hour'`];
  if (!globalScope) {
    values.push(userId);
    filters.push(`user_id=$${values.length}`);
  }

  const result = await pool.query(
    `
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD HH24:00') AS hour_bucket,
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END), 0)::int AS fallback_count,
        COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms
      FROM z_ai_router_events
      WHERE ${filters.join(' AND ')}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 24
    `,
    values
  );
  return result.rows.reverse();
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = verifyToken(req, res);
  if (!auth) return;
  const userId = String(auth.user || '').trim();
  await ensureRouterMetricsSchema();

  const url = new URL(req.url, 'http://x');
  const days = clampDays(url.searchParams.get('days'), 7, 1, 30);
  const globalScope = canReadGlobal(url.searchParams.get('scope'), userId);
  const whereClause = buildWhereClause({ days, userId, globalScope });

  const [summary, engines, intents, hourly] = await Promise.all([
    getSummary(whereClause),
    getEngineBreakdown(whereClause),
    getIntentBreakdown(whereClause),
    getHourlyTrend(whereClause, globalScope, userId),
  ]);

  sendJson(res, 200, {
    scope: globalScope ? 'global' : 'self',
    days,
    summary: {
      total_requests: Number(summary.total_requests || 0),
      fallback_count: Number(summary.fallback_count || 0),
      fallback_rate_pct: Number(summary.fallback_rate_pct || 0),
      avg_latency_ms: Number(summary.avg_latency_ms || 0),
      p95_latency_ms: Number(summary.p95_latency_ms || 0),
    },
    engines,
    intents,
    hourly,
  }, 20);
});
