import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  deleteMediaSidecar,
  loadJsonWithBackup,
  reconcileDiskMediaIntoDb,
  restoreActiveUploadSessions,
  saveUploadSessionMetaSync,
  streamChunkToFileHandle,
  writeFileAtomicSync,
  writeMediaSidecarSync,
  type ActiveUploadSessionRecord,
  type ReconcilableDatabase,
  type StoredMediaRecord,
} from './uploadPersistence';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('writeFileAtomicSync + loadJsonWithBackup recovers automatically when primary is corrupted', () => {
  const dir = makeTempDir('vault-atomic-');
  try {
    const primary = path.join(dir, 'vault-db.json');
    const backup = path.join(dir, 'vault-db.backup.json');
    const payload = { version: 1, count: 42, items: ['a', 'b'] };

    writeFileAtomicSync(primary, JSON.stringify(payload), backup);
    assert.deepEqual(loadJsonWithBackup(primary, backup), payload);

    // Corrupt the primary file (e.g., power loss or truncated overwrite)
    fs.writeFileSync(primary, '{"version": 1, "broken', 'utf8');
    const recovered = loadJsonWithBackup<typeof payload>(primary, backup);
    assert.deepEqual(recovered, payload);

    // Primary should now be healed on disk
    assert.deepEqual(JSON.parse(fs.readFileSync(primary, 'utf8')), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamChunkToFileHandle flushes all bytes before resolving without closing early', async () => {
  const dir = makeTempDir('vault-chunk-');
  try {
    const partPath = path.join(dir, 'upl_test.part');
    await fsp.writeFile(partPath, Buffer.alloc(0));

    // Write chunk 0 (16 KB across rapid tiny buffers) and chunk 1 at offset 16384
    const chunk0 = Buffer.alloc(16384, 0x41);
    const chunk1 = Buffer.alloc(4096, 0x42);

    const handle0 = await fsp.open(partPath, 'r+');
    try {
      const pieces: Buffer[] = [];
      for (let i = 0; i < chunk0.length; i += 512) {
        pieces.push(chunk0.subarray(i, i + 512));
      }
      const res0 = await streamChunkToFileHandle(Readable.from(pieces), handle0, 0);
      assert.equal(res0.receivedBytes, chunk0.length);
    } finally {
      await handle0.close();
    }

    const handle1 = await fsp.open(partPath, 'r+');
    try {
      const res1 = await streamChunkToFileHandle(Readable.from([chunk1]), handle1, chunk0.length);
      assert.equal(res1.receivedBytes, chunk1.length);
    } finally {
      await handle1.close();
    }

    const finalBuf = await fsp.readFile(partPath);
    assert.equal(finalBuf.length, chunk0.length + chunk1.length);
    assert.equal(finalBuf.subarray(0, chunk0.length).equals(chunk0), true);
    assert.equal(finalBuf.subarray(chunk0.length).equals(chunk1), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileDiskMediaIntoDb restores media from sidecars when vault-db loses media entries', async () => {
  const dir = makeTempDir('vault-reconcile-');
  const uploadsDir = path.join(dir, 'uploads');
  const postersDir = path.join(dir, 'posters');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(postersDir, { recursive: true });

  try {
    const mediaBin = Buffer.alloc(4096, 0x7f);
    fs.writeFileSync(path.join(uploadsDir, 'med_photo_1.jpg'), mediaBin);

    const sidecarMedia: StoredMediaRecord = {
      id: 'med_photo_1',
      albumId: 'alb_main',
      albumVisibility: 'private',
      ownerId: 'usr_1',
      ownerName: 'Brandon',
      title: 'Sunset Master',
      caption: 'Saved durably',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'sunset.jpg',
      fileSize: mediaBin.length,
      mediaUrl: '/api/media/med_photo_1',
      posterUrl: '/api/media/med_photo_1',
      width: 1920,
      height: 1080,
      durationSec: 0,
      cameraMeta: '',
      tags: ['sunset'],
      createdAt: '2026-11-20T05:00:00.000Z',
      updatedAt: '2026-11-20T05:00:00.000Z',
      diskFileName: 'med_photo_1.jpg',
    };
    writeMediaSidecarSync(uploadsDir, sidecarMedia);

    const db: ReconcilableDatabase = {
      users: {
        usr_1: {
          uid: 'usr_1',
          displayName: 'Brandon',
          handle: 'brandon',
          email: 'b@example.com',
          bio: '',
          avatarUrl: '',
          provider: 'google',
          totalBytesUploaded: 0,
          isAdmin: false,
          createdAt: '2026-11-19T00:00:00.000Z',
        },
      },
      albums: {
        alb_main: {
          id: 'alb_main',
          ownerId: 'usr_1',
          ownerName: 'Brandon',
          ownerHandle: 'brandon',
          title: 'Main Album',
          description: '',
          visibility: 'public',
          allowDownloads: true,
          shareToken: 'tok',
          hasPasscode: false,
          coverUrl: '',
          itemCount: 0,
          totalBytes: 0,
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
      },
      media: {},
    };

    const result = reconcileDiskMediaIntoDb(db, uploadsDir, postersDir);
    assert.equal(result.restoredFromSidecar, 1);
    assert.equal(result.recoveredOrphans, 0);
    assert.equal(db.media['med_photo_1']?.title, 'Sunset Master');
    assert.equal(db.media['med_photo_1']?.albumVisibility, 'public');
    assert.equal(db.albums['alb_main'].itemCount, 1);
    assert.equal(db.albums['alb_main'].totalBytes, mediaBin.length);
    assert.equal(db.albums['alb_main'].coverUrl, '/api/media/med_photo_1');
    assert.equal(db.users['usr_1'].totalBytesUploaded, mediaBin.length);

    // Deleting sidecar ensures deleted items do not resurrect
    await deleteMediaSidecar(uploadsDir, 'med_photo_1');
    fs.unlinkSync(path.join(uploadsDir, 'med_photo_1.jpg'));
    db.media = {};
    const afterDelete = reconcileDiskMediaIntoDb(db, uploadsDir, postersDir);
    assert.equal(afterDelete.restoredFromSidecar, 0);
    assert.equal(db.albums['alb_main'].itemCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileDiskMediaIntoDb recovers pre-existing orphan videos into a single empty album and skips tiny test files', () => {
  const dir = makeTempDir('vault-orphan-');
  const uploadsDir = path.join(dir, 'uploads');
  const postersDir = path.join(dir, 'posters');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(postersDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(uploadsDir, 'med_real_clip.mp4'), Buffer.alloc(2048, 0x11));
    fs.writeFileSync(path.join(uploadsDir, 'med_tiny_test.png'), Buffer.alloc(86, 0x89));

    const db: ReconcilableDatabase = {
      users: {
        usr_owner: {
          uid: 'usr_owner',
          displayName: 'Owner',
          handle: 'owner',
          email: 'owner@example.com',
          bio: '',
          avatarUrl: '',
          provider: 'google',
          totalBytesUploaded: 0,
          isAdmin: false,
          createdAt: '2026-11-19T00:00:00.000Z',
        },
      },
      albums: {
        alb_only: {
          id: 'alb_only',
          ownerId: 'usr_owner',
          ownerName: 'Owner',
          ownerHandle: 'owner',
          title: 'Only Album',
          description: '',
          visibility: 'public',
          allowDownloads: true,
          shareToken: 'tok',
          hasPasscode: false,
          coverUrl: '',
          itemCount: 0,
          totalBytes: 0,
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
      },
      media: {},
    };

    const result = reconcileDiskMediaIntoDb(db, uploadsDir, postersDir);
    assert.equal(result.recoveredOrphans, 1);
    assert.ok(db.media['med_real_clip']);
    assert.equal(db.media['med_real_clip'].kind, 'video');
    assert.equal(db.media['med_tiny_test'], undefined);
    assert.equal(db.albums['alb_only'].itemCount, 1);
    assert.equal(db.albums['alb_only'].totalBytes, 2048);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'med_real_clip.meta.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveUploadSessionMetaSync + restoreActiveUploadSessions survives server restart', () => {
  const dir = makeTempDir('vault-sessions-');
  try {
    const partPath = path.join(dir, 'upl_abc.part');
    fs.writeFileSync(partPath, Buffer.alloc(1024));

    const session: ActiveUploadSessionRecord = {
      uploadId: 'upl_abc',
      ownerId: 'usr_1',
      ownerName: 'Brandon',
      albumId: 'alb_1',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      fileSize: 8192,
      chunkSize: 4096,
      totalChunks: 2,
      receivedChunks: new Set([0]),
      tempPath: partPath,
      title: 'Clip',
      caption: '',
      cameraMeta: '',
      tags: ['test'],
      width: 1920,
      height: 1080,
      durationSec: 12,
      createdAt: Date.now(),
    };

    saveUploadSessionMetaSync(dir, session);
    const restored = restoreActiveUploadSessions(dir);
    assert.equal(restored.size, 1);
    const loaded = restored.get('upl_abc');
    assert.ok(loaded);
    assert.equal(loaded.receivedChunks.has(0), true);
    assert.equal(loaded.albumId, 'alb_1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileDiskMediaIntoDb prunes missing local binaries and heals stale album covers', () => {
  const dir = makeTempDir('vault-prune-');
  const uploadsDir = path.join(dir, 'uploads');
  const postersDir = path.join(dir, 'posters');
  const coversDir = path.join(dir, 'covers');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(postersDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });

  try {
    // Only med_alive exists on disk; med_gone is missing from uploadsDir
    fs.writeFileSync(path.join(uploadsDir, 'med_alive.mp4'), Buffer.alloc(4096, 0x22));
    fs.writeFileSync(path.join(postersDir, 'med_alive.jpg'), Buffer.alloc(512, 0xff));
    fs.writeFileSync(path.join(uploadsDir, 'med_gone.meta.json'), '{"id":"med_gone"}', 'utf8');

    const db: ReconcilableDatabase = {
      users: {
        usr_1: {
          uid: 'usr_1',
          displayName: 'Brandon',
          handle: 'brandon',
          email: 'b@example.com',
          bio: '',
          avatarUrl: '',
          provider: 'google',
          totalBytesUploaded: 999999,
          isAdmin: true,
          createdAt: '2026-11-19T00:00:00.000Z',
        },
      },
      albums: {
        alb_videos: {
          id: 'alb_videos',
          ownerId: 'usr_1',
          ownerName: 'Brandon',
          ownerHandle: 'brandon',
          title: 'Videos',
          description: '',
          visibility: 'public',
          allowDownloads: true,
          shareToken: 'tok1',
          hasPasscode: false,
          coverUrl: '/api/poster/med_gone',
          itemCount: 2,
          totalBytes: 999999,
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
        alb_missing_cover: {
          id: 'alb_missing_cover',
          ownerId: 'usr_1',
          ownerName: 'Brandon',
          ownerHandle: 'brandon',
          title: 'Cover Test',
          description: '',
          visibility: 'public',
          allowDownloads: true,
          shareToken: 'tok2',
          hasPasscode: false,
          coverUrl: '/api/covers/cov_missing_file.jpg',
          itemCount: 0,
          totalBytes: 0,
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
      },
      media: {
        med_alive: {
          id: 'med_alive',
          albumId: 'alb_videos',
          albumVisibility: 'public',
          ownerId: 'usr_1',
          ownerName: 'Brandon',
          title: 'Video 1',
          caption: '',
          kind: 'video',
          mimeType: 'video/mp4',
          fileName: 'med_alive.mp4',
          fileSize: 4096,
          mediaUrl: '/api/media/med_alive',
          posterUrl: '/api/poster/med_alive',
          width: 192,
          height: 360,
          durationSec: 55,
          cameraMeta: '',
          tags: [],
          createdAt: '2026-11-20T05:00:00.000Z',
          updatedAt: '2026-11-20T05:00:00.000Z',
          diskFileName: 'med_alive.mp4',
          posterFileName: 'med_alive.jpg',
        },
        med_gone: {
          id: 'med_gone',
          albumId: 'alb_videos',
          albumVisibility: 'public',
          ownerId: 'usr_1',
          ownerName: 'Brandon',
          title: 'Video 2',
          caption: '',
          kind: 'video',
          mimeType: 'video/mp4',
          fileName: 'med_gone.mp4',
          fileSize: 995903,
          mediaUrl: '/api/media/med_gone',
          posterUrl: '',
          width: 0,
          height: 0,
          durationSec: 0,
          cameraMeta: '',
          tags: [],
          createdAt: '2026-11-20T05:05:00.000Z',
          updatedAt: '2026-11-20T05:05:00.000Z',
          diskFileName: 'med_gone.mp4',
        },
      },
    };

    const result = reconcileDiskMediaIntoDb(db, uploadsDir, postersDir, coversDir);
    assert.equal(result.prunedMissing, 1);
    assert.equal(result.statsFixed, true);
    assert.equal(db.media['med_gone'], undefined);
    assert.ok(db.media['med_alive']);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'med_gone.meta.json')), false);
    assert.equal(db.albums['alb_videos'].itemCount, 1);
    assert.equal(db.albums['alb_videos'].totalBytes, 4096);
    assert.equal(db.albums['alb_videos'].coverUrl, '/api/poster/med_alive');
    assert.equal(db.albums['alb_missing_cover'].coverUrl, '');
    assert.equal(db.users['usr_1'].totalBytesUploaded, 4096);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

