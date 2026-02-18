import { verifyToken, withErrorHandling, sendJson, pool } from './_lib.js';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = String(v.user || '').trim();

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const u = new URL(req.url, 'http://x');
  const days = Math.max(1, Math.min(30, toInt(u.searchParams.get('days'), 7)));
  const fromIso = new Date(Date.now() - days * 24 * 3600000).toISOString();

  const [countsRes, latencyRes, copilotRes] = await Promise.all([
    pool.query(
      `SELECT event_name, COUNT(*)::int AS cnt
       FROM user_activity_events
       WHERE user_id = $1
         AND server_ts >= $2
         AND event_name IN (
           'push_sent',
           'push_opened',
           'push_action_start',
           'push_action_snooze',
           'push_action_done',
           'push_ignored',
           'push_action_replan',
           'copilot_action_start',
           'copilot_action_replan',
           'copilot_drift_followup_sent'
         )
       GROUP BY event_name`,
      [user, fromIso]
    ),
    pool.query(
      `WITH actions AS (
         SELECT server_ts AS action_ts
         FROM user_activity_events
         WHERE user_id = $1
           AND server_ts >= $2
           AND event_name IN ('push_action_start', 'push_action_snooze', 'push_action_done', 'push_action_replan')
       ),
       pairs AS (
         SELECT
           EXTRACT(EPOCH FROM (a.action_ts - p.server_ts))::int AS latency_sec
         FROM actions a
         JOIN LATERAL (
           SELECT server_ts
           FROM user_activity_events
           WHERE user_id = $1
             AND event_name = 'push_sent'
             AND server_ts <= a.action_ts
           ORDER BY server_ts DESC
           LIMIT 1
         ) p ON TRUE
       )
       SELECT COALESCE(AVG(latency_sec), 0)::float AS avg_latency_sec
       FROM pairs`,
      [user, fromIso]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_name = 'push_sent')::int AS sent_cnt,
         COUNT(*) FILTER (WHERE event_name = 'push_ignored')::int AS ignored_cnt
       FROM user_activity_events
       WHERE user_id = $1
         AND server_ts >= $2
         AND COALESCE(payload->>'event_family', '') IN ('execution_followup', 'daily_close')`,
      [user, fromIso]
    ),
  ]);

  const byName = Object.fromEntries(
    (countsRes.rows || []).map((x) => [String(x.event_name || ''), toInt(x.cnt, 0)])
  );
  const sentCount = toInt(byName.push_sent, 0);
  const openedCount = toInt(byName.push_opened, 0);
  const actionStartCount = toInt(byName.push_action_start, 0);
  const actionSnoozeCount = toInt(byName.push_action_snooze, 0);
  const actionDoneCount = toInt(byName.push_action_done, 0);
  const actionReplanCount = toInt(byName.push_action_replan, 0);
  const ignoredCount = toInt(byName.push_ignored, 0);
  const actionTotal = actionStartCount + actionSnoozeCount + actionDoneCount + actionReplanCount;
  const copilotActionStart = toInt(byName.copilot_action_start, 0);
  const copilotActionReplan = toInt(byName.copilot_action_replan, 0);
  const copilotDriftRecovered = toInt(byName.copilot_drift_followup_sent, 0);
  const copilotSent = toInt(copilotRes.rows?.[0]?.sent_cnt, 0);
  const copilotIgnored = toInt(copilotRes.rows?.[0]?.ignored_cnt, 0);
  const copilotIgnoreRate = copilotSent > 0 ? Number((copilotIgnored / copilotSent).toFixed(3)) : 0;
  const ignoreRate = sentCount > 0 ? Number((ignoredCount / sentCount).toFixed(3)) : 0;
  const openRate = sentCount > 0 ? Number((openedCount / sentCount).toFixed(3)) : 0;
  const actionRate = sentCount > 0 ? Number((actionTotal / sentCount).toFixed(3)) : 0;

  sendJson(res, 200, {
    days,
    sent_count: sentCount,
    delivered_count: sentCount,
    opened_count: openedCount,
    action_start_count: actionStartCount,
    action_snooze_count: actionSnoozeCount,
    action_done_count: actionDoneCount,
    action_replan_count: actionReplanCount,
    ignore_count: ignoredCount,
    ignore_rate: ignoreRate,
    open_rate: openRate,
    action_rate: actionRate,
    push_to_action_latency_sec: Number(latencyRes.rows?.[0]?.avg_latency_sec || 0),
    copilot_sent: copilotSent,
    copilot_action_start: copilotActionStart,
    copilot_action_replan: copilotActionReplan,
    copilot_drift_recovered: copilotDriftRecovered,
    copilot_ignore_rate: copilotIgnoreRate,
  });
});
