import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMediaIdFromApiUrl,
  findMissingBackedUpMedia,
  validatePreferredMediaId,
  type LocalBackupMeta,
} from './backupSync';

function makeBackup(overrides: Partial<LocalBackupMeta> = {}): LocalBackupMeta {
  return {
    mediaId: 'med_clip_01',
    albumId: 'alb_main',
    ownerId: 'usr_owner',
    title: 'Clip 1',
    caption: '',
    cameraMeta: '',
    tags: [],
    fileName: 'clip1.mp4',
    mimeType: 'video/mp4',
    fileSize: 102400,
    width: 1280,
    height: 720,
    durationSec: 12,
    createdAt: '2026-11-20T05:00:00.000Z',
    ...overrides,
  };
}

test('validatePreferredMediaId accepts valid med_ IDs and rejects unsafe values', () => {
  assert.equal(validatePreferredMediaId('med_da543c1f07074a2a'), 'med_da543c1f07074a2a');
  assert.equal(validatePreferredMediaId('  med_abc-123_XYZ  '), 'med_abc-123_XYZ');
  assert.equal(validatePreferredMediaId('alb_123456'), undefined);
  assert.equal(validatePreferredMediaId('med_../etc/passwd'), undefined);
  assert.equal(validatePreferredMediaId('med_ab'), undefined);
  assert.equal(validatePreferredMediaId(''), undefined);
  assert.equal(validatePreferredMediaId(null), undefined);
});

test('extractMediaIdFromApiUrl extracts IDs from /api/media and /api/poster URLs with query strings', () => {
  assert.equal(extractMediaIdFromApiUrl('/api/media/med_da543c1f07074a2a'), 'med_da543c1f07074a2a');
  assert.equal(
    extractMediaIdFromApiUrl('/api/poster/med_da543c1f07074a2a?auth=abc&unlock=xyz'),
    'med_da543c1f07074a2a'
  );
  assert.equal(extractMediaIdFromApiUrl('/api/covers/cov_123.jpg'), null);
  assert.equal(extractMediaIdFromApiUrl('https://example.com/video.mp4'), null);
  assert.equal(extractMediaIdFromApiUrl(''), null);
});

test('findMissingBackedUpMedia filters by owner, surviving album, and missing server media sorted oldest-first', () => {
  const records: LocalBackupMeta[] = [
    makeBackup({ mediaId: 'med_present', createdAt: '2026-11-20T05:01:00.000Z' }),
    makeBackup({ mediaId: 'med_missing_newer', createdAt: '2026-11-20T05:05:00.000Z' }),
    makeBackup({ mediaId: 'med_missing_older', createdAt: '2026-11-20T05:02:00.000Z' }),
    makeBackup({ mediaId: 'med_deleted_album', albumId: 'alb_deleted' }),
    makeBackup({ mediaId: 'med_other_user', ownerId: 'usr_someone_else' }),
  ];

  const missing = findMissingBackedUpMedia(
    records,
    ['alb_main'],
    ['med_present'],
    'usr_owner'
  );

  assert.deepEqual(
    missing.map((r) => r.mediaId),
    ['med_missing_older', 'med_missing_newer']
  );
});
