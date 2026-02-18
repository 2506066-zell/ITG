import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pushFamilyFromEventType,
  cooldownMinutesByFamily,
  horizonBucketFromPayload,
  sourceDomainFromPayload,
  buildDerivedDedupKey,
} from '../api/push_policy_core.js';

test('push policy core: event family mapping', () => {
  assert.equal(pushFamilyFromEventType('urgent_radar_critical'), 'urgent_due');
  assert.equal(pushFamilyFromEventType('partner_assist_suggestion'), 'partner_assist');
  assert.equal(pushFamilyFromEventType('study_window_prompt'), 'study_window');
  assert.equal(pushFamilyFromEventType('zai_reminder_due'), 'reminder');
  assert.equal(pushFamilyFromEventType('execution_followup'), 'execution_followup');
  assert.equal(pushFamilyFromEventType('daily_close_loop'), 'daily_close');
});

test('push policy core: cooldown by family', () => {
  assert.ok(cooldownMinutesByFamily('execution_followup') >= 30);
  assert.ok(cooldownMinutesByFamily('daily_close') >= 60);
});

test('push policy core: horizon bucket mapping', () => {
  assert.equal(horizonBucketFromPayload({ minutes_left: 20 }), '<=24h');
  assert.equal(horizonBucketFromPayload({ minutes_left: -3 }), 'overdue');
  assert.equal(horizonBucketFromPayload({ hours_left: 30 }), '<=48h');
});

test('push policy core: source domain mapping', () => {
  assert.equal(sourceDomainFromPayload({ source: 'assignment' }), 'assignment');
  assert.equal(sourceDomainFromPayload({ entity_type: 'task' }), 'task');
  assert.equal(sourceDomainFromPayload({ source: 'study_session' }), 'study_session');
});

test('push policy core: derived dedup key shape', () => {
  const key = buildDerivedDedupKey('urgent_due', '', {
    source: 'assignment',
    hours_left: 6,
    item_id: 77,
  });
  assert.equal(key, 'urgent_due:assignment:<=24h:77');
});
