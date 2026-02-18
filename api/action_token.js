import { createHmac, timingSafeEqual } from 'crypto';

const ACTION_TOKEN_SECRET = String(process.env.PUSH_ACTION_SECRET || process.env.JWT_SECRET || '').trim();
const DEFAULT_TTL_SECONDS = Math.max(1, Number(process.env.PUSH_ACTION_TTL_SECONDS || 6 * 3600));

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function signRaw(input) {
  if (!ACTION_TOKEN_SECRET) throw new Error('PUSH_ACTION_SECRET or JWT_SECRET is required');
  return createHmac('sha256', ACTION_TOKEN_SECRET).update(input).digest('base64url');
}

export function createActionToken(payload = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const nowSec = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: nowSec,
    exp: nowSec + Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
  };
  const encoded = base64UrlEncode(JSON.stringify(body));
  const sig = signRaw(encoded);
  return `${encoded}.${sig}`;
}

export function verifyActionToken(token = '') {
  const value = String(token || '').trim();
  const [encoded, sig] = value.split('.');
  if (!encoded || !sig) return { ok: false, reason: 'invalid_format' };

  let expected = '';
  try {
    expected = signRaw(encoded);
  } catch {
    return { ok: false, reason: 'secret_missing' };
  }

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return { ok: false, reason: 'invalid_signature' };
  const okSig = timingSafeEqual(sigBuf, expBuf);
  if (!okSig) return { ok: false, reason: 'invalid_signature' };

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload?.exp || 0);
  if (!exp || exp < nowSec) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}
