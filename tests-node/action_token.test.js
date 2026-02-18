import test from 'node:test';
import assert from 'node:assert/strict';

test('action token: create + verify success', async () => {
  process.env.PUSH_ACTION_SECRET = 'unit-secret-a';
  const mod = await import(`../api/action_token.js?ts=${Date.now()}a`);
  const token = mod.createActionToken({
    user_id: 'Zaldy',
    entity_type: 'task',
    entity_id: '123',
    route_fallback: '/daily-tasks',
  }, 3600);
  const verified = mod.verifyActionToken(token);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.user_id, 'Zaldy');
  assert.equal(verified.payload.entity_type, 'task');
  assert.equal(verified.payload.entity_id, '123');
});

test('action token: expired token rejected', async () => {
  process.env.PUSH_ACTION_SECRET = 'unit-secret-b';
  const mod = await import(`../api/action_token.js?ts=${Date.now()}b`);
  const token = mod.createActionToken({ user_id: 'Nesya' }, 1);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const verified = mod.verifyActionToken(token);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'expired');
});

test('action token: wrong signature rejected', async () => {
  process.env.PUSH_ACTION_SECRET = 'unit-secret-c';
  const mod = await import(`../api/action_token.js?ts=${Date.now()}c`);
  const token = mod.createActionToken({ user_id: 'Zaldy' }, 3600);
  const tampered = `${token.slice(0, -1)}x`;
  const verified = mod.verifyActionToken(tampered);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'invalid_signature');
});
