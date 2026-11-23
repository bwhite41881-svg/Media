import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Album, MediaItem, UserAccount } from '../types/media.ts';
import { classifyMediaKind } from './albumLogic.ts';
import { extractMediaIdFromApiUrl } from './backupSync.ts';

export interface StoredMediaRecord extends MediaItem {
  diskFileName?: string;
  posterFileName?: string;
}

export interface StoredAlbumRecord extends Album {
  passcodeHash?: string;
  passcodeSalt?: string;
}

export interface StoredUserRecord extends UserAccount {
  passwordHash?: string;
  passwordSalt?: string;
}

export interface ReconcilableDatabase {
  users: Record<string, StoredUserRecord>;
  albums: Record<string, StoredAlbumRecord>;
  media: Record<string, StoredMediaRecord>;
}

export interface ActiveUploadSessionRecord {
  uploadId: string;
  ownerId: string;
  ownerName: string;
  albumId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  tempPath: string;
  title: string;
  caption: string;
  cameraMeta: string;
  tags: string[];
  width: number;
  height: number;
  durationSec: number;
  posterFileName?: string;
  preferredMediaId?: string;
  createdAtOverride?: string;
  createdAt: number;
}

interface SerializedUploadSession extends Omit<ActiveUploadSessionRecord, 'receivedChunks'> {
  receivedChunks: number[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const RECOVERABLE_MEDIA_FILE_RE =
  /^(med_[a-zA-Z0-9_-]+)\.(mp4|mov|webm|mkv|avi|m4v|jpg|jpeg|png|webp|gif|heic|heif)$/i;

/**
 * Atomically writes a UTF-8 file using a unique temp path + fsync + rename,
 * optionally maintaining a secondary backup file so a crash or interrupted write
 * can never corrupt or truncate the database.
 */
export function writeFileAtomicSync(
  filePath: string,
  content: string,
  backupPath?: string
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const uniqueSuffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'w', 0o644);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }

  if (backupPath) {
    const backupTmp = `${backupPath}.${uniqueSuffix}.tmp`;
    try {
      fs.writeFileSync(backupTmp, content, 'utf8');
      fs.renameSync(backupTmp, backupPath);
    } catch {
      try {
        if (fs.existsSync(backupTmp)) fs.unlinkSync(backupTmp);
      } catch {
        // ignore backup cleanup error
      }
    }
  }
}

/**
 * Loads JSON from primaryPath, automatically falling back to backupPath if
 * primaryPath is missing or corrupted, and restores primaryPath from backup.
 */
export function loadJsonWithBackup<T>(primaryPath: string, backupPath: string): T | null {
  if (fs.existsSync(primaryPath)) {
    try {
      const raw = fs.readFileSync(primaryPath, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      // fall through to backupPath
    }
  }

  if (fs.existsSync(backupPath)) {
    try {
      const raw = fs.readFileSync(backupPath, 'utf8');
      const parsed = JSON.parse(raw) as T;
      try {
        writeFileAtomicSync(primaryPath, raw);
      } catch {
        // non-fatal if primary restore fails here
      }
      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

export function getMediaSidecarPath(uploadsDir: string, mediaId: string): string {
  const safeId = path.basename(mediaId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(uploadsDir, `${safeId}.meta.json`);
}

export function writeMediaSidecarSync(uploadsDir: string, media: StoredMediaRecord): void {
  const sidecarPath = getMediaSidecarPath(uploadsDir, media.id);
  writeFileAtomicSync(sidecarPath, JSON.stringify(media, null, 2));
}

export async function deleteMediaSidecar(uploadsDir: string, mediaId: string): Promise<void> {
  const sidecarPath = getMediaSidecarPath(uploadsDir, mediaId);
  try {
    await fsp.unlink(sidecarPath);
  } catch {
    // ignore missing sidecar
  }
}

export function getUploadSessionMetaPath(tmpDir: string, uploadId: string): string {
  const safeId = path.basename(uploadId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(tmpDir, `${safeId}.meta.json`);
}

export function saveUploadSessionMetaSync(
  tmpDir: string,
  session: ActiveUploadSessionRecord
): void {
  const serialized: SerializedUploadSession = {
    ...session,
    receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
  };
  writeFileAtomicSync(
    getUploadSessionMetaPath(tmpDir, session.uploadId),
    JSON.stringify(serialized)
  );
}

export async function deleteUploadSessionMeta(tmpDir: string, uploadId: string): Promise<void> {
  try {
    await fsp.unlink(getUploadSessionMetaPath(tmpDir, uploadId));
  } catch {
    // ignore missing session meta
  }
}

export function restoreActiveUploadSessions(
  tmpDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): Map<string, ActiveUploadSessionRecord> {
  const restored = new Map<string, ActiveUploadSessionRecord>();
  if (!fs.existsSync(tmpDir)) return restored;

  const now = Date.now();
  const entries = fs.readdirSync(tmpDir);

  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    const metaPath = path.join(tmpDir, name);
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SerializedUploadSession>;
      const age = now - (Number(parsed.createdAt) || 0);
      const tempPath = typeof parsed.tempPath === 'string' ? parsed.tempPath : '';
      const validPart = Boolean(tempPath && fs.existsSync(tempPath));
      if (!parsed.uploadId || !validPart || age > maxAgeMs) {
        try {
          fs.unlinkSync(metaPath);
        } catch {
          // ignore
        }
        if (tempPath && fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // ignore
          }
        }
        continue;
      }

      restored.set(parsed.uploadId, {
        uploadId: parsed.uploadId,
        ownerId: String(parsed.ownerId || ''),
        ownerName: String(parsed.ownerName || 'Creator'),
        albumId: String(parsed.albumId || ''),
        fileName: String(parsed.fileName || 'untitled'),
        mimeType: String(parsed.mimeType || 'application/octet-stream'),
        fileSize: Number(parsed.fileSize) || 0,
        chunkSize: Number(parsed.chunkSize) || 4 * 1024 * 1024,
        totalChunks: Math.max(1, Number(parsed.totalChunks) || 1),
        receivedChunks: new Set(
          Array.isArray(parsed.receivedChunks)
            ? parsed.receivedChunks.filter((n): n is number => Number.isInteger(n) && n >= 0)
            : []
        ),
        tempPath,
        title: String(parsed.title || 'Untitled'),
        caption: String(parsed.caption || ''),
        cameraMeta: String(parsed.cameraMeta || ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        width: Number(parsed.width) || 0,
        height: Number(parsed.height) || 0,
        durationSec: Number(parsed.durationSec) || 0,
        posterFileName: parsed.posterFileName,
        preferredMediaId:
          typeof parsed.preferredMediaId === 'string' ? parsed.preferredMediaId : undefined,
        createdAtOverride:
          typeof parsed.createdAtOverride === 'string' ? parsed.createdAtOverride : undefined,
        createdAt: Number(parsed.createdAt) || now,
      });
    } catch {
      // ignore corrupted upload session metadata
    }
  }

  return restored;
}

/**
 * Streams a binary HTTP request body sequentially to a FileHandle at a byte offset.
 * Guarantees every pending async write finishes BEFORE resolving so the caller's
 * finally { fileHandle.close() } never races with the final write.
 */
export async function streamChunkToFileHandle(
  stream: Readable,
  fileHandle: fsp.FileHandle,
  offset: number
): Promise<{ receivedBytes: number }> {
  let writePos = offset;
  let receivedBytes = 0;
  let writeChain = Promise.resolve();
  let streamError: Error | null = null;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      streamError = err instanceof Error ? err : new Error(String(err));
      reject(streamError);
    };

    stream.on('data', (rawChunk: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      stream.pause();
      writeChain = writeChain
        .then(async () => {
          if (streamError) return;
          let chunkOffset = 0;
          while (chunkOffset < chunk.length) {
            const { bytesWritten } = await fileHandle.write(
              chunk,
              chunkOffset,
              chunk.length - chunkOffset,
              writePos
            );
            if (bytesWritten <= 0) {
              throw new Error('Short write while saving uploaded chunk.');
            }
            chunkOffset += bytesWritten;
            writePos += bytesWritten;
            receivedBytes += bytesWritten;
          }
          if (!settled) stream.resume();
        })
        .catch(fail);
    });

    stream.on('end', () => {
      writeChain
        .then(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .catch(fail);
    });

    stream.on('aborted', () => {
      fail(new Error('Upload chunk stream aborted by client.'));
    });

    stream.on('error', fail);
  });

  return { receivedBytes };
}

export interface ReconciliationResult {
  restoredFromSidecar: number;
  recoveredOrphans: number;
  prunedMissing: number;
  statsFixed: boolean;
}

/**
 * Self-heals the vault database on startup by:
 * 1. Pruning stale local media records whose binary file is no longer on disk (preventing broken 404 cards).
 * 2. Restoring any media items whose binary + sidecar metadata exist in data/uploads/ but are missing from vault-db.json.
 * 3. Safely recovering pre-existing unindexed uploads when a single empty user album exists.
 * 4. Ensuring album item counts, byte totals, cover URLs, and user storage totals match surviving files.
 */
export function reconcileDiskMediaIntoDb(
  db: ReconcilableDatabase,
  uploadsDir: string,
  postersDir: string,
  coversDir?: string
): ReconciliationResult {
  let restoredFromSidecar = 0;
  let recoveredOrphans = 0;
  let prunedMissing = 0;
  let statsFixed = false;

  // Pass 0: Prune local media entries whose binary file no longer exists on disk,
  // and clear missing poster references so ffmpeg backfill can regenerate them.
  for (const [mediaId, item] of Object.entries(db.media)) {
    if (!item.diskFileName) continue;
    const binaryPath = path.join(uploadsDir, item.diskFileName);
    if (!fs.existsSync(binaryPath)) {
      delete db.media[mediaId];
      prunedMissing++;
      statsFixed = true;
      const sidecarPath = getMediaSidecarPath(uploadsDir, mediaId);
      try {
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
      } catch {
        // ignore sidecar cleanup error
      }
      if (item.posterFileName) {
        const posterPath = path.join(postersDir, item.posterFileName);
        try {
          if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
        } catch {
          // ignore poster cleanup error
        }
      }
      continue;
    }

    if (item.posterFileName) {
      const posterPath = path.join(postersDir, item.posterFileName);
      if (!fs.existsSync(posterPath)) {
        item.posterFileName = undefined;
        item.posterUrl = item.kind === 'photo' ? item.mediaUrl : '';
        statsFixed = true;
      }
    }
  }

  if (fs.existsSync(uploadsDir)) {
    const entries = fs.readdirSync(uploadsDir);

    // Pass 1: Restore every valid media item from per-file *.meta.json sidecars
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      const metaPath = path.join(uploadsDir, entry);
      try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const item = JSON.parse(raw) as StoredMediaRecord;
        if (!item?.id || !item.albumId || !item.diskFileName) continue;
        const album = db.albums[item.albumId];
        if (!album) continue;
        const binaryPath = path.join(uploadsDir, item.diskFileName);
        if (!fs.existsSync(binaryPath)) continue;

        if (!db.media[item.id]) {
          const stat = fs.statSync(binaryPath);
          const posterExists =
            item.posterFileName && fs.existsSync(path.join(postersDir, item.posterFileName));
          db.media[item.id] = {
            ...item,
            albumVisibility: album.visibility,
            fileSize: stat.size || item.fileSize || 0,
            mediaUrl: `/api/media/${item.id}`,
            posterUrl: posterExists
              ? `/api/poster/${item.id}`
              : item.kind === 'photo'
                ? `/api/media/${item.id}`
                : '',
            posterFileName: posterExists ? item.posterFileName : undefined,
          };
          restoredFromSidecar++;
        }
      } catch {
        // skip unreadable sidecar
      }
    }

    // Pass 2: Recover orphaned binary uploads (no sidecar) when db.media is empty
    // and there is a single real user album currently showing 0 items
    const realAlbums = Object.values(db.albums).filter(
      (a) => a.ownerId && a.ownerId !== 'usr_curator_aperture'
    );
    if (
      Object.keys(db.media).length === 0 &&
      realAlbums.length === 1 &&
      (realAlbums[0].itemCount || 0) === 0
    ) {
      const targetAlbum = realAlbums[0];
      const candidates: Array<{
        mediaId: string;
        fileName: string;
        ext: string;
        size: number;
        mtimeMs: number;
      }> = [];

      for (const entry of entries) {
        const match = RECOVERABLE_MEDIA_FILE_RE.exec(entry);
        if (!match) continue;
        const mediaId = match[1];
        const ext = `.${match[2].toLowerCase()}`;
        if (db.media[mediaId]) continue;
        if (fs.existsSync(getMediaSidecarPath(uploadsDir, mediaId))) continue;
        const fullPath = path.join(uploadsDir, entry);
        try {
          const st = fs.statSync(fullPath);
          if (!st.isFile() || st.size < 1024) continue;
          candidates.push({
            mediaId,
            fileName: entry,
            ext,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // ignore
        }
      }

      candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let videoIdx = 0;
      let photoIdx = 0;

      for (const file of candidates) {
        const mimeType = MIME_BY_EXT[file.ext] || 'application/octet-stream';
        const kind = classifyMediaKind(mimeType, file.fileName);
        const label = kind === 'video' ? `Video ${++videoIdx}` : `Photo ${++photoIdx}`;
        const createdAt = new Date(file.mtimeMs || Date.now()).toISOString();
        const mediaUrl = `/api/media/${file.mediaId}`;
        const posterUrl = kind === 'photo' ? mediaUrl : '';

        const recovered: StoredMediaRecord = {
          id: file.mediaId,
          albumId: targetAlbum.id,
          albumVisibility: targetAlbum.visibility,
          ownerId: targetAlbum.ownerId,
          ownerName: targetAlbum.ownerName,
          title: label,
          caption: '',
          kind,
          mimeType,
          fileName: file.fileName,
          fileSize: file.size,
          mediaUrl,
          posterUrl,
          width: 0,
          height: 0,
          durationSec: 0,
          cameraMeta: '',
          tags: [],
          createdAt,
          updatedAt: createdAt,
          diskFileName: file.fileName,
        };

        db.media[file.mediaId] = recovered;
        try {
          writeMediaSidecarSync(uploadsDir, recovered);
        } catch {
          // non-fatal
        }
        recoveredOrphans++;
      }
    }
  }

  // Pass 3: Reconcile album itemCount, totalBytes, coverUrl, and user totalBytesUploaded
  const mediaByAlbum = new Map<string, StoredMediaRecord[]>();
  const bytesByUser = new Map<string, number>();

  for (const item of Object.values(db.media)) {
    const list = mediaByAlbum.get(item.albumId) || [];
    list.push(item);
    mediaByAlbum.set(item.albumId, list);
    bytesByUser.set(item.ownerId, (bytesByUser.get(item.ownerId) || 0) + (item.fileSize || 0));
  }

  for (const album of Object.values(db.albums)) {
    const items = (mediaByAlbum.get(album.id) || []).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const actualCount = items.length;
    const actualBytes = items.reduce((sum, m) => sum + (m.fileSize || 0), 0);
    if (album.itemCount !== actualCount || album.totalBytes !== actualBytes) {
      album.itemCount = actualCount;
      album.totalBytes = actualBytes;
      statsFixed = true;
    }

    // Clear stale coverUrl if it points to a missing custom cover or a pruned/deleted media item
    if (album.coverUrl) {
      if (album.coverUrl.startsWith('/api/covers/') && coversDir) {
        const coverFile = path.basename(album.coverUrl.split('?')[0]);
        if (!coverFile || !fs.existsSync(path.join(coversDir, coverFile))) {
          album.coverUrl = '';
          statsFixed = true;
        }
      } else {
        const refMediaId = extractMediaIdFromApiUrl(album.coverUrl);
        if (refMediaId && !db.media[refMediaId]) {
          album.coverUrl = '';
          statsFixed = true;
        }
      }
    }

    const hasCustomCover = Boolean(album.coverUrl && album.coverUrl.startsWith('/api/covers/'));
    if (!hasCustomCover && !album.coverUrl && items.length > 0) {
      const preferred = items.find((m) => m.posterUrl) || items.find((m) => m.kind === 'photo');
      if (preferred) {
        album.coverUrl = preferred.posterUrl || preferred.mediaUrl;
        statsFixed = true;
      }
    }
  }

  for (const user of Object.values(db.users)) {
    const actualUserBytes = bytesByUser.get(user.uid) || 0;
    if (user.totalBytesUploaded !== actualUserBytes) {
      user.totalBytesUploaded = actualUserBytes;
      statsFixed = true;
    }
  }

  return { restoredFromSidecar, recoveredOrphans, prunedMissing, statsFixed };
}
