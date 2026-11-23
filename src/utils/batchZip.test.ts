import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  buildBatchZipFilename,
  computeBatchZipProgress,
  computeSelectedBytes,
  createBrowserMediaZip,
  resolveMediaDownloadUrl,
  type BatchZipProgressState,
} from './batchZip';

test('buildBatchZipFilename distinguishes full album archives from selected subsets', () => {
  assert.equal(buildBatchZipFilename('Bunnie xo', 5, 5), 'Bunnie-xo.zip');
  assert.equal(buildBatchZipFilename('Bunnie xo', 1, 5), 'Bunnie-xo-1-item.zip');
  assert.equal(buildBatchZipFilename('Bunnie xo', 3, 5), 'Bunnie-xo-3-items.zip');
  assert.equal(buildBatchZipFilename('Summer / Trip: 2026!', 2, 10), 'Summer-Trip-2026-2-items.zip');
});

test('resolveMediaDownloadUrl safely attaches share tokens to protected media URLs only', () => {
  assert.equal(resolveMediaDownloadUrl('/api/media/med_1', 'tok_abc'), '/api/media/med_1?token=tok_abc');
  assert.equal(
    resolveMediaDownloadUrl('/api/media/med_1?auth=xyz', 'tok_abc'),
    '/api/media/med_1?auth=xyz&token=tok_abc'
  );
  assert.equal(
    resolveMediaDownloadUrl('/api/media/med_1?token=existing', 'tok_abc'),
    '/api/media/med_1?token=existing'
  );
  assert.equal(resolveMediaDownloadUrl('https://cdn.example.com/a.jpg', 'tok_abc'), 'https://cdn.example.com/a.jpg');
  assert.equal(resolveMediaDownloadUrl('/api/media/med_1', null), '/api/media/med_1');
});

test('computeBatchZipProgress weights fetching (0-85%) and zipping (85-99%) smoothly', () => {
  const start = computeBatchZipProgress({
    phase: 'fetching',
    fetchedCount: 0,
    totalCount: 4,
    fetchedBytes: 0,
    totalBytes: 4000,
    zipPercent: 0,
  });
  assert.equal(start.overallPercent, 0);
  assert.equal(start.statusText, 'Fetching 0 of 4 files...');

  const midFetch = computeBatchZipProgress({
    phase: 'fetching',
    fetchedCount: 2,
    totalCount: 4,
    fetchedBytes: 2000,
    totalBytes: 4000,
    zipPercent: 0,
  });
  assert.equal(midFetch.overallPercent, 43);

  const midZip = computeBatchZipProgress({
    phase: 'zipping',
    fetchedCount: 4,
    totalCount: 4,
    fetchedBytes: 4000,
    totalBytes: 4000,
    zipPercent: 50,
  });
  assert.equal(midZip.overallPercent, 92);
  assert.equal(midZip.statusText, 'Bundling ZIP archive (50%)...');

  const done = computeBatchZipProgress({
    phase: 'done',
    fetchedCount: 4,
    totalCount: 4,
    fetchedBytes: 4000,
    totalBytes: 4000,
    zipPercent: 100,
  });
  assert.equal(done.overallPercent, 100);
  assert.equal(done.statusText, 'Archive ready');
});

test('createBrowserMediaZip bundles mixed images and videos into a readable ZIP with unique filenames and progress updates', async () => {
  const payloads: Record<string, string> = {
    '/api/media/med_1?token=sec_1': 'JPEG-PHOTO-ONE',
    '/api/media/med_2?token=sec_1': 'JPEG-PHOTO-TWO',
    '/api/media/med_3?token=sec_1': 'MP4-VIDEO-MASTER',
  };

  const progressLog: BatchZipProgressState[] = [];

  const mockFetcher: typeof fetch = async (input) => {
    const url = String(input);
    const body = payloads[url];
    if (!body) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(body, { status: 200 });
  };

  const result = await createBrowserMediaZip({
    albumTitle: 'Studio Light Studies',
    totalAlbumItems: 5,
    shareToken: 'sec_1',
    fetcher: mockFetcher,
    onProgress: (p) => progressLog.push(p),
    items: [
      {
        id: 'med_1',
        title: 'Sunset',
        fileName: 'sunset.jpg',
        mimeType: 'image/jpeg',
        fileSize: 14,
        mediaUrl: '/api/media/med_1',
      },
      {
        id: 'med_2',
        title: 'Sunset',
        fileName: 'sunset.jpg',
        mimeType: 'image/jpeg',
        fileSize: 14,
        mediaUrl: '/api/media/med_2',
      },
      {
        id: 'med_3',
        title: 'Stage Reel',
        fileName: 'stage-reel',
        mimeType: 'video/mp4',
        fileSize: 16,
        mediaUrl: '/api/media/med_3',
      },
    ],
  });

  assert.equal(result.filename, 'Studio-Light-Studies-3-items.zip');
  assert.equal(result.fileCount, 3);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.totalBytes, 44);
  assert.ok(result.blob.size > 0);

  // Inspect generated ZIP contents via JSZip.loadAsync
  const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
  const names = Object.keys(archive.files).sort();
  assert.deepEqual(names, ['stage-reel.mp4', 'sunset (2).jpg', 'sunset.jpg']);

  assert.equal(await archive.file('sunset.jpg')?.async('string'), 'JPEG-PHOTO-ONE');
  assert.equal(await archive.file('sunset (2).jpg')?.async('string'), 'JPEG-PHOTO-TWO');
  assert.equal(await archive.file('stage-reel.mp4')?.async('string'), 'MP4-VIDEO-MASTER');

  // Verify phases occurred in order
  assert.ok(progressLog.some((p) => p.phase === 'fetching'));
  assert.ok(progressLog.some((p) => p.phase === 'zipping'));
  assert.equal(progressLog[progressLog.length - 1].phase, 'done');
  assert.equal(progressLog[progressLog.length - 1].overallPercent, 100);
});

test('createBrowserMediaZip handles partial fetch failures, cancellation, and selected byte aggregation', async () => {
  // Selected byte calculation
  assert.equal(
    computeSelectedBytes(
      [
        { id: 'a', fileSize: 1000 },
        { id: 'b', fileSize: 2500 },
        { id: 'c', fileSize: 500 },
      ],
      new Set(['a', 'c'])
    ),
    1500
  );

  // Partial failure skips 404 item and succeeds with surviving file
  const partialResult = await createBrowserMediaZip({
    albumTitle: 'Mixed Album',
    totalAlbumItems: 2,
    fetcher: async (input) => {
      if (String(input).includes('med_ok')) {
        return new Response('OK-DATA', { status: 200 });
      }
      return new Response('Missing', { status: 404 });
    },
    items: [
      { id: 'med_ok', fileName: 'ok.jpg', mimeType: 'image/jpeg', fileSize: 7, mediaUrl: '/api/media/med_ok' },
      { id: 'med_gone', fileName: 'gone.mp4', mimeType: 'video/mp4', fileSize: 100, mediaUrl: '/api/media/med_gone' },
    ],
  });
  assert.equal(partialResult.filename, 'Mixed-Album.zip');
  assert.equal(partialResult.fileCount, 1);
  assert.equal(partialResult.skippedCount, 1);

  // AbortSignal cancels cleanly
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      createBrowserMediaZip({
        albumTitle: 'Cancelled',
        signal: controller.signal,
        items: [{ id: 'm1', fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 10, mediaUrl: '/api/media/m1' }],
      }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError'
  );
});
