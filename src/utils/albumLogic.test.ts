import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_STORAGE_QUOTA_BYTES,
  DEFAULT_SITE_SETTINGS,
  DEFAULT_STORAGE_QUOTA_BYTES,
  buildAlbumZipFilename,
  buildConversationId,
  buildUniqueZipEntryNames,
  canAccessAlbum,
  classifyMediaKind,
  computeBatchStats,
  computeChunkCount,
  computeStorageBreakdownByVisibility,
  computeStorageQuota,
  computeVirtualWindow,
  extractPopularTags,
  filterAlbumsByQuery,
  filterMediaByQuery,
  formatBytes,
  formatDuration,
  formatEta,
  formatRelativeTime,
  formatTransferSpeed,
  getAllocatedStorageBytes,
  getChunkRange,
  matchDiskFileForMediaId,
  mergeUniqueById,
  parseSearchTokens,
  planUploadChunks,
  runConcurrentPool,
  sanitizeHandle,
  sanitizeTags,
  sanitizeZipEntryName,
  shouldRetryUploadRequest,
  upsertAlbumInList,
  validateAlbumInput,
  validateCommentBody,
  validateMessageBody,
  validateSiteSettings,
} from './albumLogic';

test('formatBytes, transfer speed, and ETA format accurately from bytes to terabytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(4.5 * 1024 * 1024 * 1024), '4.50 GB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024 * 1024), '2.00 TB');
  assert.equal(formatTransferSpeed(12.5 * 1024 * 1024), '12.5 MB/s');
  assert.equal(formatEta(null), '--');
  assert.equal(formatEta(45), '45s');
  assert.equal(formatEta(125), '2m 5s');
  assert.equal(formatEta(3720), '1h 2m');
});

test('formatDuration handles minutes and multi-hour cinema files', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
});

test('chunk planning supports arbitrarily large multi-terabyte files without caps', () => {
  const fourMB = 4 * 1024 * 1024;
  assert.equal(computeChunkCount(0, fourMB), 1);
  assert.equal(computeChunkCount(100, fourMB), 1);
  assert.equal(computeChunkCount(10 * 1024 * 1024, fourMB), 3);

  // 2 TB cinema master file (~524,288 chunks of 4 MiB) computes in O(1)
  const twoTerabytes = 2 * 1024 * 1024 * 1024 * 1024;
  const totalChunks = computeChunkCount(twoTerabytes, fourMB);
  assert.equal(totalChunks, 524288);
  const lastChunk = getChunkRange(twoTerabytes, totalChunks - 1, fourMB);
  assert.equal(lastChunk.end, twoTerabytes);
  assert.equal(lastChunk.size, fourMB);

  const plan = planUploadChunks(9 * 1024 * 1024, fourMB);
  assert.equal(plan.totalChunks, 3);
  assert.equal(plan.chunks[2].size, 1 * 1024 * 1024);
});

test('5,000+ file batch stats aggregation and concurrent worker pool run with bounded parallelism and no count cap', async () => {
  const totalFiles = 5500;
  const batchItems = Array.from({ length: totalFiles }, (_, idx) => ({
    id: idx,
    status:
      idx < 2000
        ? ('done' as const)
        : idx < 2006
          ? ('uploading' as const)
          : idx === 2006
            ? ('error' as const)
            : ('queued' as const),
    uploadedBytes: idx < 2000 ? 1024 * 1024 : idx < 2006 ? 512 * 1024 : 0,
    totalBytes: 1024 * 1024,
    speedBytesPerSec: idx >= 2000 && idx < 2006 ? 2 * 1024 * 1024 : 0,
  }));

  const stats = computeBatchStats(batchItems);
  assert.equal(stats.totalCount, totalFiles);
  assert.equal(stats.doneCount, 2000);
  assert.equal(stats.activeCount, 6);
  assert.equal(stats.errorCount, 1);
  assert.equal(stats.queuedCount, totalFiles - 2007);
  assert.equal(stats.combinedSpeedBytesPerSec, 12 * 1024 * 1024);
  assert.ok(stats.etaSeconds !== null && stats.etaSeconds > 0);

  // Execute 5,000 tasks through concurrent worker pool capped at 8 parallel workers
  const fiveThousandTasks = Array.from({ length: 5000 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;
  let sum = 0;

  const result = await runConcurrentPool(fiveThousandTasks, 8, async (n) => {
    active++;
    if (active > maxActive) maxActive = active;
    await Promise.resolve();
    sum += n;
    active--;
  });

  assert.equal(result.processed, 5000);
  assert.equal(sum, (4999 * 5000) / 2);
  assert.ok(maxActive >= 1 && maxActive <= 8, `Expected max concurrency <= 8, got ${maxActive}`);
});

test('validateSiteSettings enforces cPanel rules and defaults to Big B’z Leaks', () => {
  assert.equal(DEFAULT_SITE_SETTINGS.siteName, 'Big B’z Leaks');
  const ok = validateSiteSettings(DEFAULT_SITE_SETTINGS);
  assert.equal(ok.valid, true);
  assert.equal(ok.normalized.uploadConcurrency, 6);

  const badHex = validateSiteSettings({ ...DEFAULT_SITE_SETTINGS, accentColor: 'blue' });
  assert.equal(badHex.valid, false);

  const badConcurrency = validateSiteSettings({ ...DEFAULT_SITE_SETTINGS, uploadConcurrency: 99 });
  assert.equal(badConcurrency.valid, false);

  const emptyName = validateSiteSettings({ ...DEFAULT_SITE_SETTINGS, siteName: '   ' });
  assert.equal(emptyName.valid, false);
});

test('classifyMediaKind recognizes standard and cinema RAW/ProRes formats', () => {
  assert.equal(classifyMediaKind('image/jpeg', 'shot.jpg'), 'photo');
  assert.equal(classifyMediaKind('video/mp4', 'clip.mp4'), 'video');
  assert.equal(classifyMediaKind('application/octet-stream', 'master.mov'), 'video');
  assert.equal(classifyMediaKind('', 'cinema.braw'), 'video');
  assert.equal(classifyMediaKind('', 'medium_format.dng'), 'photo');
});

test('canAccessAlbum enforces private, unlisted, passcode, collaborator, and public rules', () => {
  const privateAlbum = {
    id: 'alb_1',
    ownerId: 'user_owner',
    visibility: 'private' as const,
    allowDownloads: false,
    shareToken: 'tok_secret_99',
    hasPasscode: true,
  };

  assert.equal(canAccessAlbum(privateAlbum, null).allowed, false);
  assert.equal(canAccessAlbum(privateAlbum, null).reason, 'denied');
  assert.equal(canAccessAlbum(privateAlbum, { uid: 'user_stranger', email: 's@example.com' }).allowed, false);

  const ownerAccess = canAccessAlbum(privateAlbum, { uid: 'user_owner' });
  assert.equal(ownerAccess.allowed, true);
  assert.equal(ownerAccess.canEdit, true);
  assert.equal(ownerAccess.canUpload, true);
  assert.equal(ownerAccess.canDownload, true);

  const lockedLink = canAccessAlbum(privateAlbum, null, [], { shareToken: 'tok_secret_99' });
  assert.equal(lockedLink.allowed, false);
  assert.equal(lockedLink.reason, 'passcode_required');

  const unlockedLink = canAccessAlbum(privateAlbum, null, [], {
    shareToken: 'tok_secret_99',
    unlockedAlbumIds: new Set(['alb_1']),
  });
  assert.equal(unlockedLink.allowed, true);
  assert.equal(unlockedLink.reason, 'share_link');
  assert.equal(unlockedLink.canDownload, false);

  const revokedAlbum = { ...privateAlbum, shareToken: '' };
  const afterRevoke = canAccessAlbum(revokedAlbum, null, [], {
    shareToken: 'tok_secret_99',
    unlockedAlbumIds: new Set(['alb_1']),
  });
  assert.equal(afterRevoke.allowed, false);

  const members = [
    { uid: 'u_view', email: 'v@example.com', role: 'viewer' as const },
    { uid: 'u_contrib', email: 'c@example.com', role: 'contributor' as const },
  ];
  const viewerDecision = canAccessAlbum(privateAlbum, { uid: 'u_view' }, members);
  assert.equal(viewerDecision.allowed, true);
  assert.equal(viewerDecision.canUpload, false);

  const contribDecision = canAccessAlbum(privateAlbum, { uid: 'u_contrib' }, members);
  assert.equal(contribDecision.allowed, true);
  assert.equal(contribDecision.canUpload, true);
  assert.equal(contribDecision.canEdit, false);

  const publicAlbum = { ...privateAlbum, visibility: 'public' as const, allowDownloads: true };
  const pubDecision = canAccessAlbum(publicAlbum, null);
  assert.equal(pubDecision.allowed, true);
  assert.equal(pubDecision.reason, 'public');
  assert.equal(pubDecision.canDownload, true);
});

test('validateAlbumInput and sanitizers enforce blueprint boundaries', () => {
  assert.equal(validateAlbumInput({ title: '', visibility: 'private' }).valid, false);
  assert.equal(validateAlbumInput({ title: 'a'.repeat(121), visibility: 'public' }).valid, false);
  assert.equal(validateAlbumInput({ title: 'Winter Reels', visibility: 'unlisted', passcode: '12' }).valid, false);
  assert.equal(validateAlbumInput({ title: 'Winter Reels', visibility: 'unlisted', passcode: '1234' }).valid, true);

  assert.equal(sanitizeHandle('Elena Vance!'), 'elena-vance');
  const tags = sanitizeTags(['  4K ', '4k', 'Alpine', ...Array.from({ length: 15 }, (_, i) => `tag${i}`)]);
  assert.equal(tags.length, 10);
  assert.equal(tags[0], '4K');
});

test('filterAlbumsByQuery, filterMediaByQuery, and extractPopularTags filter by title, #tag, and multi-term queries', () => {
  const sampleAlbums = [
    {
      title: 'Nordic Silence & Concrete',
      description: 'Medium-format architectural studies along the northern fjords.',
      ownerName: 'Maren Lindqvist',
      ownerHandle: 'maren.archive',
      visibility: 'public' as const,
      tags: ['Alpine', 'Architecture', 'Brutalism'],
    },
    {
      title: 'Nocturnes & Tactile Form',
      description: 'Rain-soaked 35mm street frames in Tokyo.',
      ownerName: 'Maren Lindqvist',
      ownerHandle: 'maren.archive',
      visibility: 'private' as const,
      tags: ['Tokyo', 'Street', '35mm'],
    },
    {
      title: 'Roots Festival 4K Reels',
      description: 'Live stage recordings and backstage portraits.',
      ownerName: 'Big B',
      ownerHandle: 'bigb',
      visibility: 'public' as const,
      tags: ['Roots', 'Reggae', '4K'],
    },
  ];

  const sampleMedia = [
    {
      title: 'Fjord Concrete Pavilion, Dawn',
      caption: 'Concrete shelter overlooking the North Atlantic.',
      ownerName: 'Maren Lindqvist',
      albumTitle: 'Nordic Silence & Concrete',
      kind: 'photo' as const,
      tags: ['Brutalism', 'Coastal'],
    },
    {
      title: 'Kingston Soundcheck Reel',
      caption: 'Full-bitrate 4K video master.',
      ownerName: 'Big B',
      albumTitle: 'Roots Festival 4K Reels',
      kind: 'video' as const,
      tags: ['Reggae', '4K', 'Live'],
    },
  ];

  // Token parsing
  assert.deepEqual(parseSearchTokens('  #Reggae  roots '), [
    { raw: '#Reggae', term: 'reggae', tagOnly: true },
    { raw: 'roots', term: 'roots', tagOnly: false },
  ]);

  // Title search
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'nordic').length, 1);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'nordic')[0].title, 'Nordic Silence & Concrete');

  // Tag-only (#tag) search ignores title-only match
  assert.equal(filterAlbumsByQuery(sampleAlbums, '#brutalism').length, 1);
  assert.equal(filterAlbumsByQuery(sampleAlbums, '#silence').length, 0);

  // Visibility + query combined
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'tokyo', 'public').length, 0);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'tokyo', 'private').length, 1);

  // Multi-term AND query across title and tag
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'roots #4k').length, 1);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'roots #tokyo').length, 0);

  // Media filtering by title, tag, and kind
  assert.equal(filterMediaByQuery(sampleMedia, '#4k', 'video').length, 1);
  assert.equal(filterMediaByQuery(sampleMedia, '#4k', 'photo').length, 0);
  assert.equal(filterMediaByQuery(sampleMedia, 'pavilion').length, 1);

  // Explicit title-only and tag-only search modes
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'nordic', 'all', 'title').length, 1);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'brutalism', 'all', 'title').length, 0);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'brutalism', 'all', 'tag').length, 1);
  assert.equal(filterAlbumsByQuery(sampleAlbums, 'nordic', 'all', 'tag').length, 0);

  assert.equal(filterMediaByQuery(sampleMedia, 'pavilion', 'all', 'title').length, 1);
  assert.equal(filterMediaByQuery(sampleMedia, 'coastal', 'all', 'title').length, 0);
  assert.equal(filterMediaByQuery(sampleMedia, 'coastal', 'all', 'tag').length, 1);
  assert.equal(filterMediaByQuery(sampleMedia, 'pavilion', 'all', 'tag').length, 0);

  // Popular tags extraction
  const popular = extractPopularTags(sampleAlbums, sampleMedia, 4);
  assert.equal(popular.length, 4);
  assert.ok(popular.includes('4K'));
  assert.ok(popular.includes('Brutalism'));
});

test('computeVirtualWindow smoothly windows a 5,000-file batch queue across top, middle, and bottom scroll positions', () => {
  const empty = computeVirtualWindow({
    totalItems: 0,
    scrollTop: 0,
    viewportHeight: 600,
    rowHeight: 76,
  });
  assert.deepEqual(empty, { startIndex: 0, endIndex: 0, totalHeight: 0 });

  const top = computeVirtualWindow({
    totalItems: 5000,
    scrollTop: 0,
    viewportHeight: 608,
    rowHeight: 76,
    overscan: 6,
  });
  assert.equal(top.startIndex, 0);
  assert.equal(top.endIndex, 14);
  assert.equal(top.totalHeight, 5000 * 76);

  const bottom = computeVirtualWindow({
    totalItems: 5000,
    scrollTop: 5000 * 76 - 608,
    viewportHeight: 608,
    rowHeight: 76,
    overscan: 6,
  });
  assert.equal(bottom.endIndex, 5000);
  assert.equal(bottom.startIndex, 4986);
});

test('buildConversationId, comment/message validation, mergeUniqueById, and formatRelativeTime enforce chat & comment invariants', () => {
  // Order-independent deterministic conversation IDs
  assert.equal(buildConversationId('usr_b', 'usr_a'), buildConversationId('usr_a', 'usr_b'));
  assert.equal(buildConversationId('usr_a', 'usr_b'), 'dm_usr_a__usr_b');

  // Comment & message validation boundaries
  assert.equal(validateCommentBody('   ').valid, false);
  assert.equal(validateCommentBody('x'.repeat(601)).valid, false);
  assert.deepEqual(validateCommentBody('  Fire shot!  '), { valid: true, body: 'Fire shot!' });

  assert.equal(validateMessageBody('').valid, false);
  assert.equal(validateMessageBody('m'.repeat(1001)).valid, false);
  assert.deepEqual(validateMessageBody('  Yo check the new drop  '), {
    valid: true,
    body: 'Yo check the new drop',
  });

  // Idempotent merge prevents duplicates on WebSocket reconnect / optimistic reconciliation
  const first = mergeUniqueById([{ id: 'm1', body: 'hi' }], { id: 'm2', body: 'yo' });
  assert.equal(first.length, 2);
  const deduped = mergeUniqueById(first, { id: 'm2', body: 'yo updated' });
  assert.equal(deduped.length, 2);
  assert.equal(deduped[1].body, 'yo updated');

  // Relative time formatting
  const now = new Date('2026-11-18T12:00:00.000Z').getTime();
  assert.equal(formatRelativeTime('2026-11-18T11:59:45.000Z', now), 'Just now');
  assert.equal(formatRelativeTime('2026-11-18T11:55:00.000Z', now), '5m ago');
  assert.equal(formatRelativeTime('2026-11-18T09:00:00.000Z', now), '3h ago');
});

test('shouldRetryUploadRequest, matchDiskFileForMediaId, and upsertAlbumInList enforce durable upload behavior', () => {
  // Retry policy: network errors, 408, 429, and 5xx retry; aborted & 400/401/403/404 do not
  assert.equal(shouldRetryUploadRequest(undefined, false), true);
  assert.equal(shouldRetryUploadRequest(500, false), true);
  assert.equal(shouldRetryUploadRequest(503, false), true);
  assert.equal(shouldRetryUploadRequest(408, false), true);
  assert.equal(shouldRetryUploadRequest(429, false), true);
  assert.equal(shouldRetryUploadRequest(400, false), false);
  assert.equal(shouldRetryUploadRequest(401, false), false);
  assert.equal(shouldRetryUploadRequest(404, false), false);
  assert.equal(shouldRetryUploadRequest(500, true), false);
  assert.equal(shouldRetryUploadRequest(undefined, true), false);

  // Disk file reconciliation avoids prefix collisions and invalid IDs
  const files = ['med_abc1234.mp4', 'med_abc123.mp4', 'med_xyz999'];
  assert.equal(matchDiskFileForMediaId('med_abc123', files), 'med_abc123.mp4');
  assert.equal(matchDiskFileForMediaId('med_xyz999', files), 'med_xyz999');
  assert.equal(matchDiskFileForMediaId('med_abc', files), null);
  assert.equal(matchDiskFileForMediaId('../etc/passwd', files), null);

  // Album list upsert updates counts in-place without duplicating
  const existing = [
    {
      id: 'alb_1',
      ownerId: 'u1',
      ownerName: 'User',
      ownerHandle: 'user',
      title: 'First',
      description: '',
      visibility: 'public' as const,
      allowDownloads: true,
      shareToken: '',
      hasPasscode: false,
      coverUrl: '',
      itemCount: 0,
      totalBytes: 0,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    },
  ];
  const afterUpdate = upsertAlbumInList(existing, {
    ...existing[0],
    itemCount: 3,
    totalBytes: 4096,
    coverUrl: '/api/media/med_1',
  });
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0].itemCount, 3);
  assert.equal(afterUpdate[0].coverUrl, '/api/media/med_1');

  const afterInsert = upsertAlbumInList(afterUpdate, {
    ...existing[0],
    id: 'alb_2',
    title: 'Second',
  });
  assert.equal(afterInsert.length, 2);
  assert.equal(afterInsert[0].id, 'alb_2');
});

test('buildAlbumZipFilename, sanitizeZipEntryName, and buildUniqueZipEntryNames produce safe, collision-free ZIP entries', () => {
  assert.equal(buildAlbumZipFilename('Bunnie xo'), 'Bunnie-xo.zip');
  assert.equal(buildAlbumZipFilename('  Summer / Trip: 2026! '), 'Summer-Trip-2026.zip');
  assert.equal(buildAlbumZipFilename('!!!'), 'album-archive.zip');

  assert.equal(sanitizeZipEntryName('../../etc/passwd', '.mp4'), 'passwd.mp4');
  assert.equal(sanitizeZipEntryName('Clip: 01?.mp4'), 'Clip_ 01_.mp4');
  assert.equal(sanitizeZipEntryName('', '.jpg'), 'media-file.jpg');

  const entries = buildUniqueZipEntryNames([
    { id: 'med_1', title: 'Sunset', fileName: 'sunset.jpg', diskFileName: 'med_1.jpg' },
    { id: 'med_2', title: 'Sunset', fileName: 'sunset.jpg', diskFileName: 'med_2.jpg' },
    { id: 'med_3', title: 'Sunset', fileName: 'SUNSET.JPG', diskFileName: 'med_3.jpg' },
    { id: 'med_4', title: 'Video 1', fileName: '', diskFileName: 'med_4.mp4' },
  ]);

  assert.deepEqual(
    entries.map((e) => e.entryName),
    ['sunset.jpg', 'sunset (2).jpg', 'SUNSET (3).JPG', 'Video 1.mp4']
  );
});

test('computeStorageQuota, getAllocatedStorageBytes, and computeStorageBreakdownByVisibility handle all utilization tiers and edge cases', () => {
  // Tier resolution
  assert.equal(getAllocatedStorageBytes({ isAdmin: false }), DEFAULT_STORAGE_QUOTA_BYTES);
  assert.equal(getAllocatedStorageBytes({ isAdmin: true }), ADMIN_STORAGE_QUOTA_BYTES);
  assert.equal(
    getAllocatedStorageBytes({ isAdmin: false, storageQuotaBytes: 5 * 1024 * 1024 * 1024 }),
    5 * 1024 * 1024 * 1024
  );

  const tenGb = 10 * 1024 * 1024 * 1024;

  // 0 bytes used
  const empty = computeStorageQuota(0, tenGb);
  assert.equal(empty.usedBytes, 0);
  assert.equal(empty.remainingBytes, tenGb);
  assert.equal(empty.percentBarWidth, 0);
  assert.equal(empty.percentClamped, 0);
  assert.equal(empty.percentLabel, '0%');
  assert.equal(empty.status, 'healthy');
  assert.equal(empty.statusLabel, 'Healthy');
  assert.equal(empty.isOverQuota, false);

  // Tiny non-zero usage (3.3 MB of 10 GB) shows < 0.1% label and minimum visible sliver
  const tiny = computeStorageQuota(3.3 * 1024 * 1024, tenGb);
  assert.equal(tiny.percentLabel, '< 0.1%');
  assert.equal(tiny.percentBarWidth, 1.5);
  assert.equal(tiny.status, 'healthy');

  // Healthy mid usage (4.2%)
  const healthy = computeStorageQuota(0.42 * tenGb, tenGb);
  assert.equal(healthy.percentLabel, '42%');
  assert.equal(healthy.status, 'healthy');

  const singleDigit = computeStorageQuota(0.042 * tenGb, tenGb);
  assert.equal(singleDigit.percentLabel, '4.2%');

  // Warning threshold (75%)
  const warning = computeStorageQuota(0.75 * tenGb, tenGb);
  assert.equal(warning.status, 'warning');
  assert.equal(warning.statusLabel, 'High Usage');
  assert.equal(warning.percentLabel, '75%');
  assert.equal(warning.isOverQuota, false);

  // Critical threshold (94%)
  const nearLimit = computeStorageQuota(0.94 * tenGb, tenGb);
  assert.equal(nearLimit.status, 'critical');
  assert.equal(nearLimit.statusLabel, 'Near Limit');
  assert.equal(nearLimit.percentLabel, '94%');
  assert.equal(nearLimit.isOverQuota, false);

  // Over quota (115%)
  const over = computeStorageQuota(1.15 * tenGb, tenGb);
  assert.equal(over.status, 'critical');
  assert.equal(over.statusLabel, 'Quota Reached');
  assert.equal(over.isOverQuota, true);
  assert.equal(over.remainingBytes, 0);
  assert.equal(over.percentClamped, 100);
  assert.equal(over.percentBarWidth, 100);

  // Defensive negative / NaN handling
  const defensive = computeStorageQuota(-500, Number.NaN);
  assert.equal(defensive.usedBytes, 0);
  assert.equal(defensive.allocatedBytes, DEFAULT_STORAGE_QUOTA_BYTES);

  // Visibility breakdown
  const breakdown = computeStorageBreakdownByVisibility([
    { visibility: 'public', totalBytes: 1000 },
    { visibility: 'public', totalBytes: 2500 },
    { visibility: 'unlisted', totalBytes: 500 },
    { visibility: 'private', totalBytes: 4000 },
  ]);
  assert.deepEqual(breakdown, {
    publicBytes: 3500,
    unlistedBytes: 500,
    privateBytes: 4000,
    totalAlbumBytes: 8000,
  });
});
