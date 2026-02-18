const COOLDOWN_URGENT_MIN = Math.max(15, Number(process.env.PUSH_COOLDOWN_URGENT_MIN || 90));
const COOLDOWN_PARTNER_MIN = Math.max(30, Number(process.env.PUSH_COOLDOWN_PARTNER_MIN || 180));
const COOLDOWN_STUDY_MIN = Math.max(30, Number(process.env.PUSH_COOLDOWN_STUDY_MIN || 120));
const COOLDOWN_EXECUTION_MIN = Math.max(30, Number(process.env.PUSH_COOLDOWN_EXECUTION_MIN || 120));
const COOLDOWN_DAILY_CLOSE_MIN = Math.max(60, Number(process.env.PUSH_COOLDOWN_DAILY_CLOSE_MIN || (24 * 60)));
const COOLDOWN_DEFAULT_MIN = Math.max(15, Number(process.env.PUSH_COOLDOWN_DEFAULT_MIN || 90));

export function pushFamilyFromEventType(eventType = '') {
  const key = String(eventType || '').toLowerCase();
  if (!key) return 'general';
  if (key.includes('urgent') || key.includes('overdue') || key.includes('critical')) return 'urgent_due';
  if (key.includes('support') || key.includes('assist') || key.includes('checkin')) return 'partner_assist';
  if (key.includes('daily_close')) return 'daily_close';
  if (key.includes('execution') || key.includes('copilot')) return 'execution_followup';
  if (key.includes('study') || key.includes('focus')) return 'study_window';
  if (key.includes('reminder')) return 'reminder';
  return 'general';
}

export function cooldownMinutesByFamily(family = '') {
  const key = String(family || '').toLowerCase();
  if (key === 'urgent_due') return COOLDOWN_URGENT_MIN;
  if (key === 'partner_assist') return COOLDOWN_PARTNER_MIN;
  if (key === 'study_window') return COOLDOWN_STUDY_MIN;
  if (key === 'execution_followup') return COOLDOWN_EXECUTION_MIN;
  if (key === 'daily_close') return COOLDOWN_DAILY_CLOSE_MIN;
  return COOLDOWN_DEFAULT_MIN;
}

export function horizonBucketFromPayload(payload = {}) {
  const h = Number(payload?.hours_left);
  const m = Number(payload?.minutes_left);
  if (Number.isFinite(m)) {
    if (m <= 0) return 'overdue';
    if (m <= 24 * 60) return '<=24h';
    if (m <= 48 * 60) return '<=48h';
    return '>48h';
  }
  if (Number.isFinite(h)) {
    if (h <= 0) return 'overdue';
    if (h <= 24) return '<=24h';
    if (h <= 48) return '<=48h';
    return '>48h';
  }
  return 'na';
}

export function sourceDomainFromPayload(payload = {}) {
  const source = String(payload?.source || payload?.entity_type || '').toLowerCase();
  if (source.includes('assignment')) return 'assignment';
  if (source.includes('task')) return 'task';
  if (source.includes('study')) return 'study_session';
  return 'general';
}

export function buildDerivedDedupKey(eventFamily = '', dedupKey = '', payload = {}) {
  if (dedupKey) return String(dedupKey);
  const family = String(eventFamily || 'general');
  const sourceDomain = sourceDomainFromPayload(payload);
  const horizonBucket = horizonBucketFromPayload(payload);
  const entityId = String(payload?.item_id || payload?.entity_id || 'none');
  return `${family}:${sourceDomain}:${horizonBucket}:${entityId}`;
}
