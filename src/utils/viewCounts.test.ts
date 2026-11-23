import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCompactCount, formatViewCount, shouldRecordView } from './viewCounts.ts';

test('formatCompactCount and formatViewCount handle zero, singular, plural, thousands, and millions', () => {
  assert.equal(formatCompactCount(undefined), '0');
  assert.equal(formatCompactCount(-5), '0');
  assert.equal(formatCompactCount(0), '0');
  assert.equal(formatCompactCount(1), '1');
  assert.equal(formatCompactCount(999), '999');
  assert.equal(formatCompactCount(1_000), '1K');
  assert.equal(formatCompactCount(1_250), '1.3K');
  assert.equal(formatCompactCount(12_400), '12.4K');
  assert.equal(formatCompactCount(150_400), '150K');
  assert.equal(formatCompactCount(2_500_000), '2.5M');

  assert.equal(formatViewCount(0), '0 views');
  assert.equal(formatViewCount(1), '1 view');
  assert.equal(formatViewCount(2), '2 views');
  assert.equal(formatViewCount(1_400), '1.4K views');
});

test('shouldRecordView deduplicates rapid repeats from the same viewer while allowing distinct viewers and post-cooldown visits', () => {
  const tracker = new Map<string, number>();

  // First visit records
  assert.equal(shouldRecordView('user_a', 'alb_1', 10_000, tracker, 15_000), true);
  // Rapid repeat within 15s is suppressed
  assert.equal(shouldRecordView('user_a', 'alb_1', 15_000, tracker, 15_000), false);
  // Different target for same user records immediately
  assert.equal(shouldRecordView('user_a', 'med_1', 15_500, tracker, 15_000), true);
  // Different viewer on same album records immediately
  assert.equal(shouldRecordView('user_b', 'alb_1', 16_000, tracker, 15_000), true);
  // Same viewer returning after cooldown records again
  assert.equal(shouldRecordView('user_a', 'alb_1', 25_001, tracker, 15_000), true);
});
