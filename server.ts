import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive, type ArchiverError } from 'archiver';
import cookieParser from 'cookie-parser';
import express, { type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BLUEPRINT_LIMITS,
  DEFAULT_SITE_SETTINGS,
  buildAlbumZipFilename,
  buildConversationId,
  buildUniqueZipEntryNames,
  canAccessAlbum,
  classifyMediaKind,
  generateSafeId,
  matchDiskFileForMediaId,
  sanitizeHandle,
  sanitizeTags,
  validateAlbumInput,
  validateCommentBody,
  validateMessageBody,
  validateSiteSettings,
} from './src/utils/albumLogic.ts';
import type {
  Album,
  AlbumMember,
  AlbumVisibility,
  AuthProviderKind,
  ChatConversation,
  ChatMessage,
  MediaComment,
  MediaItem,
  MemberRole,
  PublicUserSummary,
  SiteSettings,
  UserAccount,
} from './src/types/media.ts';
import {
  deleteMediaSidecar,
  deleteUploadSessionMeta,
  loadJsonWithBackup,
  reconcileDiskMediaIntoDb,
  restoreActiveUploadSessions,
  saveUploadSessionMetaSync,
  streamChunkToFileHandle,
  writeFileAtomicSync,
  writeMediaSidecarSync,
} from './src/utils/uploadPersistence.ts';
import { validatePreferredMediaId } from './src/utils/backupSync.ts';
import {
  detectMediaKindFromUrlOrMime,
  extractMediaCandidatesFromHtml,
  inferFilenameFromUrl,
  isBlockedIpAddress,
  validateExternalImportUrl,
  type RemoteInspectResult,
  type RemoteMediaCandidate,
} from './src/utils/remoteImport.ts';
import { generateVideoPoster } from './src/utils/videoThumbnail.ts';
import { shouldRecordView } from './src/utils/viewCounts.ts';

const BOOTSTRAP_ADMIN_EMAILS = new Set(['puffthafire509@gmail.com']);

interface StoredUser extends UserAccount {
  passwordHash?: string;
  passwordSalt?: string;
}

interface StoredAlbum extends Album {
  passcodeHash?: string;
  passcodeSalt?: string;
}

interface StoredMedia extends MediaItem {
  diskFileName?: string; // stored inside data/uploads/
  posterFileName?: string; // stored inside data/posters/
}

interface VaultDatabase {
  users: Record<string, StoredUser>;
  albums: Record<string, StoredAlbum>;
  members: Record<string, AlbumMember[]>; // keyed by albumId
  media: Record<string, StoredMedia>;
  comments: Record<string, MediaComment[]>; // keyed by mediaId
  messages: Record<string, ChatMessage[]>; // keyed by conversationId
  siteSettings: SiteSettings;
}

interface ActiveUploadSession {
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

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const POSTERS_DIR = path.join(DATA_DIR, 'posters');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const DB_PATH = path.join(DATA_DIR, 'vault-db.json');
const DB_BACKUP_PATH = path.join(DATA_DIR, 'vault-db.backup.json');
const SECRET_PATH = path.join(DATA_DIR, 'server-secret.key');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(POSTERS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

function loadOrCreateSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

const SESSION_SECRET = loadOrCreateSecret();

function signValue(payload: string): string {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

function verifySignedValue(token: string | undefined): string | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  return payload;
}

function hashSecret(plain: string, salt?: string): { hash: string; salt: string } {
  const usedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, usedSalt, 64).toString('hex');
  return { hash, salt: usedSalt };
}

function verifySecret(plain: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(plain, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function generateShareToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function createSeedDatabase(): VaultDatabase {
  const now = new Date('2026-11-12T10:30:00.000Z').toISOString();
  const curatorId = 'usr_curator_aperture';

  const curator: StoredUser = {
    uid: curatorId,
    displayName: 'Maren Lindqvist',
    handle: 'maren.archive',
    email: 'archive@bigbzleaks.gallery',
    bio: 'Architectural documentary photographer & 65mm field cinematographer archiving uncompressed stills and location reels.',
    avatarUrl: '',
    provider: 'local',
    totalBytesUploaded: 148200000,
    isAdmin: false,
    createdAt: now,
  };

  const albumNordicId = 'alb_nordic_monographs';
  const albumFieldId = 'alb_nocturne_field';

  const albums: Record<string, StoredAlbum> = {
    [albumNordicId]: {
      id: albumNordicId,
      ownerId: curatorId,
      ownerName: curator.displayName,
      ownerHandle: curator.handle,
      title: 'Nordic Silence & Concrete',
      description: 'Medium-format architectural studies along the northern fjords and high alpine passes during blue hour.',
      visibility: 'public',
      allowDownloads: true,
      shareToken: 'nordic-monographs-2026',
      hasPasscode: false,
      coverUrl: '/src/assets/images/hero_alpine_cinema_1795068077664.jpg',
      itemCount: 3,
      totalBytes: 94600000,
      createdAt: '2026-11-10T08:15:00.000Z',
      updatedAt: '2026-11-14T16:40:00.000Z',
    },
    [albumFieldId]: {
      id: albumFieldId,
      ownerId: curatorId,
      ownerName: curator.displayName,
      ownerHandle: curator.handle,
      title: 'Nocturnes & Tactile Form',
      description: 'Rain-soaked 35mm street frames in Tokyo paired with studio stoneware studies under north-facing skylight.',
      visibility: 'public',
      allowDownloads: true,
      shareToken: 'nocturnes-tactile-2026',
      hasPasscode: false,
      coverUrl: '/src/assets/images/gallery_tokyo_rain_1795068077429.jpg',
      itemCount: 2,
      totalBytes: 53600000,
      createdAt: '2026-11-12T19:00:00.000Z',
      updatedAt: '2026-11-15T11:20:00.000Z',
    },
  };

  const media: Record<string, StoredMedia> = {
    med_alpine_01: {
      id: 'med_alpine_01',
      albumId: albumNordicId,
      albumVisibility: 'public',
      ownerId: curatorId,
      ownerName: curator.displayName,
      title: 'Ridge Observatory at Blue Hour',
      caption: 'Captured twenty minutes after sunset at 2,840 meters elevation as cloud cover swept over the eastern ridge.',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'ridge_observatory_65mm.jpg',
      fileSize: 38400000,
      mediaUrl: '/src/assets/images/hero_alpine_cinema_1795068077664.jpg',
      posterUrl: '/src/assets/images/hero_alpine_cinema_1795068077664.jpg',
      width: 2752,
      height: 1536,
      durationSec: 0,
      cameraMeta: 'Hasselblad X2D 100C · 38mm f/2.5 · ISO 400 · 1/15s',
      tags: ['Alpine', 'Architecture', 'Medium Format', 'Blue Hour'],
      createdAt: '2026-11-10T08:20:00.000Z',
      updatedAt: '2026-11-10T08:20:00.000Z',
    },
    med_coastal_02: {
      id: 'med_coastal_02',
      albumId: albumNordicId,
      albumVisibility: 'public',
      ownerId: curatorId,
      ownerName: curator.displayName,
      title: 'Fjord Concrete Pavilion, Dawn',
      caption: 'Board-formed concrete shelter cantilevered over basalt boulders overlooking the North Atlantic.',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'fjord_pavilion_dawn.jpg',
      fileSize: 29800000,
      mediaUrl: '/src/assets/images/gallery_coastal_brutalism_1795068077327.jpg',
      posterUrl: '/src/assets/images/gallery_coastal_brutalism_1795068077327.jpg',
      width: 2400,
      height: 1800,
      durationSec: 0,
      cameraMeta: 'Leica SL3 · 50mm Summilux · ISO 100 · 1/250s',
      tags: ['Brutalism', 'Coastal', 'Monochrome'],
      createdAt: '2026-11-11T06:45:00.000Z',
      updatedAt: '2026-11-11T06:45:00.000Z',
    },
    med_dunes_03: {
      id: 'med_dunes_03',
      albumId: albumNordicId,
      albumVisibility: 'public',
      ownerId: curatorId,
      ownerName: curator.displayName,
      title: 'Ochre Basin Wind Geometry',
      caption: 'First-light aerial elevation capturing the knife-edge shadow line across untouched desert ridges.',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'ochre_basin_aerial.jpg',
      fileSize: 26400000,
      mediaUrl: '/src/assets/images/gallery_desert_dunes_1795068076999.jpg',
      posterUrl: '/src/assets/images/gallery_desert_dunes_1795068076999.jpg',
      width: 2400,
      height: 1800,
      durationSec: 0,
      cameraMeta: 'Phase One IQ4 150MP · 90mm · ISO 50 · 1/500s',
      tags: ['Aerial', 'Landscape', 'Geometry'],
      createdAt: '2026-11-14T16:40:00.000Z',
      updatedAt: '2026-11-14T16:40:00.000Z',
    },
    med_tokyo_04: {
      id: 'med_tokyo_04',
      albumId: albumFieldId,
      albumVisibility: 'public',
      ownerId: curatorId,
      ownerName: curator.displayName,
      title: 'Yanaka Alley After Rain',
      caption: 'Paper lantern reflections along wet stone tiles in eastern Tokyo after a late autumn squall.',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'yanaka_alley_35mm.jpg',
      fileSize: 28200000,
      mediaUrl: '/src/assets/images/gallery_tokyo_rain_1795068077429.jpg',
      posterUrl: '/src/assets/images/gallery_tokyo_rain_1795068077429.jpg',
      width: 1800,
      height: 2400,
      durationSec: 0,
      cameraMeta: 'Leica M11 · 35mm Summicron · ISO 1600 · 1/60s',
      tags: ['Tokyo', 'Night', 'Street', '35mm'],
      createdAt: '2026-11-12T19:15:00.000Z',
      updatedAt: '2026-11-12T19:15:00.000Z',
    },
    med_ceramic_05: {
      id: 'med_ceramic_05',
      albumId: albumFieldId,
      albumVisibility: 'public',
      ownerId: curatorId,
      ownerName: curator.displayName,
      title: 'Stoneware Study on Travertine',
      caption: 'Three wheel-thrown stoneware vessels photographed in direct morning skylight with zero artificial fill.',
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: 'stoneware_travertine_study.jpg',
      fileSize: 25400000,
      mediaUrl: '/src/assets/images/gallery_studio_ceramic_1795068077329.jpg',
      posterUrl: '/src/assets/images/gallery_studio_ceramic_1795068077329.jpg',
      width: 1800,
      height: 2400,
      durationSec: 0,
      cameraMeta: 'Fujifilm GFX 100 II · 80mm f/1.7 · ISO 80 · 1/125s',
      tags: ['Still Life', 'Ceramics', 'Studio'],
      createdAt: '2026-11-15T11:20:00.000Z',
      updatedAt: '2026-11-15T11:20:00.000Z',
    },
  };

  return {
    users: { [curatorId]: curator },
    albums,
    members: {},
    media,
    comments: {},
    messages: {},
    siteSettings: { ...DEFAULT_SITE_SETTINGS, updatedAt: now },
  };
}

function loadDatabase(): VaultDatabase {
  const parsed = loadJsonWithBackup<Partial<VaultDatabase>>(DB_PATH, DB_BACKUP_PATH);
  if (!parsed) {
    const seed = createSeedDatabase();
    writeFileAtomicSync(DB_PATH, JSON.stringify(seed, null, 2), DB_BACKUP_PATH);
    return seed;
  }

  const users = parsed.users || {};
  for (const user of Object.values(users)) {
    const emailLower = (user.email || '').toLowerCase();
    if (BOOTSTRAP_ADMIN_EMAILS.has(emailLower)) {
      user.isAdmin = true;
    } else if (typeof user.isAdmin !== 'boolean') {
      user.isAdmin = false;
    }
  }
  const mergedSettings: SiteSettings = {
    ...DEFAULT_SITE_SETTINGS,
    ...(parsed.siteSettings || {}),
  };
  return {
    users,
    albums: parsed.albums || {},
    members: parsed.members || {},
    media: parsed.media || {},
    comments: parsed.comments || {},
    messages: parsed.messages || {},
    siteSettings: mergedSettings,
  };
}

const db: VaultDatabase = loadDatabase();
const activeUploads: Map<string, ActiveUploadSession> = restoreActiveUploadSessions(TMP_DIR);

let persistTimer: NodeJS.Timeout | null = null;
let dbDirty = false;

function persistDb(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  dbDirty = false;
  writeFileAtomicSync(DB_PATH, JSON.stringify(db, null, 2), DB_BACKUP_PATH);
}

// Reconcile per-file sidecars, missing binaries/covers, unindexed uploads, and album stats on startup
const startupReconcile = reconcileDiskMediaIntoDb(db, UPLOADS_DIR, POSTERS_DIR, COVERS_DIR);
if (
  startupReconcile.restoredFromSidecar > 0 ||
  startupReconcile.recoveredOrphans > 0 ||
  startupReconcile.prunedMissing > 0 ||
  startupReconcile.statsFixed
) {
  persistDb();
  if (startupReconcile.prunedMissing > 0) {
    console.log(
      `[reconcile] Pruned ${startupReconcile.prunedMissing} stale media record(s) whose local binary was missing.`
    );
  }
}

const pendingPosterJobs = new Map<string, Promise<boolean>>();

async function ensureVideoPoster(item: StoredMedia): Promise<boolean> {
  if (item.kind !== 'video' || !item.diskFileName) return false;

  const expectedPosterName = item.posterFileName || `${item.id}.jpg`;
  const existingPath = path.join(POSTERS_DIR, expectedPosterName);
  if (
    item.posterFileName &&
    fs.existsSync(existingPath) &&
    item.width > 0 &&
    item.height > 0
  ) {
    return true;
  }

  const inflight = pendingPosterJobs.get(item.id);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      const videoPath = path.join(UPLOADS_DIR, item.diskFileName!);
      if (!fs.existsSync(videoPath)) return false;

      const posterName = `${item.id}.jpg`;
      const posterPath = path.join(POSTERS_DIR, posterName);
      const result = await generateVideoPoster(videoPath, posterPath);

      let mutated = false;
      if (result.posterCreated) {
        item.posterFileName = posterName;
        item.posterUrl = `/api/poster/${item.id}`;
        mutated = true;
      }
      if (result.width > 0 && item.width !== result.width) {
        item.width = result.width;
        mutated = true;
      }
      if (result.height > 0 && item.height !== result.height) {
        item.height = result.height;
        mutated = true;
      }
      if (result.durationSec > 0 && item.durationSec !== result.durationSec) {
        item.durationSec = result.durationSec;
        mutated = true;
      }

      if (mutated) {
        item.updatedAt = new Date().toISOString();
        const parentAlbum = db.albums[item.albumId];
        if (parentAlbum && !parentAlbum.coverUrl && item.posterUrl) {
          parentAlbum.coverUrl = item.posterUrl;
          parentAlbum.updatedAt = item.updatedAt;
        }
        try {
          writeMediaSidecarSync(UPLOADS_DIR, item);
        } catch {
          // non-fatal sidecar refresh
        }
      }
      return result.posterCreated || fs.existsSync(posterPath);
    } finally {
      pendingPosterJobs.delete(item.id);
    }
  })();

  pendingPosterJobs.set(item.id, job);
  return job;
}

async function backfillMissingVideoPosters(): Promise<void> {
  const candidates = Object.values(db.media).filter((item) => {
    if (item.kind !== 'video' || !item.diskFileName) return false;
    if (!item.posterFileName) return true;
    const posterPath = path.join(POSTERS_DIR, item.posterFileName);
    return !fs.existsSync(posterPath) || item.width === 0 || item.durationSec === 0;
  });

  if (candidates.length === 0) return;

  let generatedCount = 0;
  const touchedAlbums = new Set<string>();
  const concurrency = 3;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      const ok = await ensureVideoPoster(item);
      if (ok) {
        generatedCount++;
        touchedAlbums.add(item.albumId);
      }
    }
  });

  await Promise.all(workers);

  if (generatedCount > 0) {
    for (const albumId of touchedAlbums) {
      recalculateAlbumStats(albumId);
    }
    persistDb();
    console.log(`[posters] Generated real video frame thumbnails for ${generatedCount} videos.`);
  }
}

void backfillMissingVideoPosters().catch((err) => {
  console.warn('[posters] Startup video thumbnail backfill failed:', err);
});

const shutdownCallbacks: Array<() => Promise<void> | void> = [];
let shuttingDown = false;

function handleShutdownSignal(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (dbDirty) {
    try {
      persistDb();
    } catch (err) {
      console.error('Failed to persist DB on shutdown:', err);
    }
  }
  const forceExitTimer = setTimeout(() => process.exit(0), 2000);
  forceExitTimer.unref();
  Promise.allSettled(shutdownCallbacks.map((fn) => Promise.resolve().then(fn))).finally(() => {
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdownSignal);
process.on('SIGTERM', handleShutdownSignal);

function hasAnyRealAdmin(): boolean {
  return Object.values(db.users).some((u) => u.isAdmin && u.uid !== 'usr_curator_aperture');
}

function isBootstrappedAdminEmail(email: string): boolean {
  return BOOTSTRAP_ADMIN_EMAILS.has(email.trim().toLowerCase());
}

function toPublicUser(user: StoredUser): UserAccount {
  return {
    uid: user.uid,
    displayName: user.displayName,
    handle: user.handle,
    email: user.email,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    provider: user.provider,
    totalBytesUploaded: user.totalBytesUploaded,
    isAdmin: Boolean(user.isAdmin || isBootstrappedAdminEmail(user.email)),
    createdAt: user.createdAt,
  };
}

function collectAlbumTags(album: StoredAlbum): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  const pushTag = (raw: string) => {
    const cleaned = raw.trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(cleaned);
    }
  };
  for (const t of album.tags || []) pushTag(t);
  for (const item of Object.values(db.media)) {
    if (item.albumId === album.id && Array.isArray(item.tags)) {
      for (const t of item.tags) {
        pushTag(t);
        if (combined.length >= 20) return combined;
      }
    }
  }
  return combined;
}

function toPublicAlbum(
  album: StoredAlbum,
  options: { includeShareToken: boolean; viewerRole?: Album['viewerRole'] }
): Album {
  return {
    id: album.id,
    ownerId: album.ownerId,
    ownerName: album.ownerName,
    ownerHandle: album.ownerHandle,
    title: album.title,
    description: album.description,
    visibility: album.visibility,
    allowDownloads: album.allowDownloads,
    shareToken: options.includeShareToken ? album.shareToken : '',
    hasPasscode: album.hasPasscode,
    coverUrl: album.coverUrl,
    itemCount: album.itemCount,
    totalBytes: album.totalBytes,
    viewCount: Math.max(0, Number(album.viewCount) || 0),
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
    tags: collectAlbumTags(album),
    ownTags: album.tags || [],
    viewerRole: options.viewerRole,
  };
}

function toPublicUserSummary(user: StoredUser, online = false): PublicUserSummary {
  return {
    uid: user.uid,
    displayName: user.displayName,
    handle: user.handle,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    isAdmin: Boolean(user.isAdmin || isBootstrappedAdminEmail(user.email)),
    online,
  };
}

function toPublicMedia(item: StoredMedia, shareToken?: string): MediaItem {
  const album = db.albums[item.albumId];
  let mediaUrl = item.mediaUrl;
  let posterUrl =
    item.posterUrl ||
    (item.kind === 'video' && item.diskFileName ? `/api/poster/${item.id}` : '');
  if (shareToken && mediaUrl.startsWith('/api/media/')) {
    const sep = mediaUrl.includes('?') ? '&' : '?';
    mediaUrl = `${mediaUrl}${sep}share=${encodeURIComponent(shareToken)}`;
  }
  if (shareToken && posterUrl.startsWith('/api/poster/')) {
    const sep = posterUrl.includes('?') ? '&' : '?';
    posterUrl = `${posterUrl}${sep}share=${encodeURIComponent(shareToken)}`;
  }
  return {
    id: item.id,
    albumId: item.albumId,
    albumTitle: album?.title,
    albumVisibility: item.albumVisibility,
    ownerId: item.ownerId,
    ownerName: item.ownerName,
    title: item.title,
    caption: item.caption,
    kind: item.kind,
    mimeType: item.mimeType,
    fileName: item.fileName,
    fileSize: item.fileSize,
    mediaUrl,
    posterUrl,
    width: item.width,
    height: item.height,
    durationSec: item.durationSec,
    cameraMeta: item.cameraMeta,
    tags: item.tags,
    commentCount: (db.comments[item.id] || []).length,
    viewCount: Math.max(0, Number(item.viewCount) || 0),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function isRequestSecure(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').toLowerCase();
  return proto.includes('https') || req.secure;
}

function extractSessionTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  if (typeof req.query.auth === 'string' && req.query.auth.trim()) {
    return req.query.auth.trim();
  }
  if (typeof req.cookies?.aperture_session === 'string' && req.cookies.aperture_session) {
    return req.cookies.aperture_session;
  }
  return undefined;
}

function getSessionUser(req: Request): StoredUser | null {
  const raw = verifySignedValue(extractSessionTokenFromRequest(req));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { uid?: string };
    if (!parsed.uid) return null;
    const user = db.users[parsed.uid] || null;
    if (user && isBootstrappedAdminEmail(user.email)) {
      user.isAdmin = true;
    }
    return user;
  } catch {
    return null;
  }
}

function setSessionCookie(req: Request, res: Response, uid: string): string {
  const signed = signValue(JSON.stringify({ uid }));
  const secure = isRequestSecure(req);
  res.cookie('aperture_session', signed, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  return signed;
}

function getUnlockedAlbums(req: Request): Set<string> {
  const headerToken = typeof req.headers['x-unlock-token'] === 'string' ? req.headers['x-unlock-token'].trim() : undefined;
  const queryToken = typeof req.query.unlock === 'string' ? req.query.unlock.trim() : undefined;
  const cookieToken = typeof req.cookies?.aperture_unlocked === 'string' ? req.cookies.aperture_unlocked : undefined;
  const raw = verifySignedValue(headerToken || queryToken || cookieToken);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function addUnlockedAlbumCookie(req: Request, res: Response, albumId: string): string {
  const current = getUnlockedAlbums(req);
  current.add(albumId);
  const signed = signValue(JSON.stringify(Array.from(current).slice(-30)));
  const secure = isRequestSecure(req);
  res.cookie('aperture_unlocked', signed, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  return signed;
}

function recalculateAlbumStats(albumId: string): void {
  const album = db.albums[albumId];
  if (!album) return;
  const items = Object.values(db.media)
    .filter((m) => m.albumId === albumId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  album.itemCount = items.length;
  album.totalBytes = items.reduce((sum, item) => sum + (item.fileSize || 0), 0);

  const hasCustomCover = Boolean(album.coverUrl && album.coverUrl.startsWith('/api/covers/'));
  if (
    !hasCustomCover &&
    (!album.coverUrl || !items.some((m) => m.posterUrl === album.coverUrl || m.mediaUrl === album.coverUrl))
  ) {
    const preferredCover = items.find((m) => m.posterUrl) || items.find((m) => m.kind === 'photo');
    album.coverUrl = preferredCover ? preferredCover.posterUrl || preferredCover.mediaUrl : '';
  }
  album.updatedAt = new Date().toISOString();
}

function recalculateUserStorage(uid: string): void {
  const user = db.users[uid];
  if (!user) return;
  user.totalBytesUploaded = Object.values(db.media)
    .filter((m) => m.ownerId === uid)
    .reduce((sum, m) => sum + (m.fileSize || 0), 0);
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore missing file
  }
}

async function saveDataUrlImage(
  targetDir: string,
  filePrefix: string,
  dataUrl: string | undefined,
  maxBytes: number = 8 * 1024 * 1024
): Promise<string | undefined> {
  if (!dataUrl || typeof dataUrl !== 'string') return undefined;
  const match = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) return undefined;
  const mime = match[1].toLowerCase();
  const ext =
    mime === 'image/png'
      ? '.png'
      : mime === 'image/webp'
        ? '.webp'
        : mime === 'image/gif'
          ? '.gif'
          : '.jpg';
  const buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buf.length === 0 || buf.length > maxBytes) return undefined;
  const safePrefix = filePrefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'img';
  const fileName = `${safePrefix}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fsp.writeFile(path.join(targetDir, fileName), buf);
  return fileName;
}

async function savePosterDataUrl(mediaId: string, dataUrl?: string): Promise<string | undefined> {
  if (!dataUrl || typeof dataUrl !== 'string') return undefined;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return undefined;
  const ext = match[1] === 'image/png' ? '.png' : match[1] === 'image/webp' ? '.webp' : '.jpg';
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return undefined;
  const fileName = `${mediaId}${ext}`;
  await fsp.writeFile(path.join(POSTERS_DIR, fileName), buf);
  return fileName;
}

function resolveServerListenConfig(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let cliPort: number | undefined;
  let cliHost: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0) cliPort = parsed;
      i++;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed > 0) cliPort = parsed;
    } else if (arg === '--host' && args[i + 1]) {
      cliHost = args[i + 1];
      i++;
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length);
    }
  }

  return {
    port: cliPort || Number(process.env.PORT) || 3000,
    host: cliHost || process.env.HOST || '0.0.0.0',
  };
}

async function startServer(): Promise<void> {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Prevent stale browser/proxy caching of dynamic API JSON responses
  app.use('/api', (req, res, next) => {
    const p = req.path;
    const isBinaryAsset =
      p.startsWith('/media/') ||
      p.startsWith('/poster/') ||
      p.startsWith('/covers/') ||
      p.startsWith('/avatars/');
    if (!isBinaryAsset) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  // Use JSON parser ONLY on non-binary routes (chunk PUT streams raw bytes directly to disk!)
  app.use((req, res, next) => {
    if (req.path.includes('/api/uploads/') && req.path.includes('/chunk/')) {
      return next();
    }
    return express.json({ limit: '12mb' })(req, res, next);
  });

  // =========================================================================
  // IMPORT ALBUM / VIDEO / PHOTO FROM EXTERNAL LINK (SSRF-HARDENED)
  // =========================================================================
  class ExternalImportError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }

  async function verifyHostResolvesToPublicIp(hostname: string): Promise<void> {
    const cleanHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // If already an IP literal, validateExternalImportUrl already checked it, double check here.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleanHost) || cleanHost.includes(':')) {
      if (isBlockedIpAddress(cleanHost)) {
        throw new ExternalImportError(400, 'Private, loopback, or local network addresses cannot be imported.');
      }
      return;
    }
    let records: Array<{ address: string; family: number }>;
    try {
      records = await dns.lookup(cleanHost, { all: true });
    } catch {
      throw new ExternalImportError(400, `Could not resolve website domain "${cleanHost}". Please verify the link.`);
    }
    if (!records || records.length === 0) {
      throw new ExternalImportError(400, `Could not resolve website domain "${cleanHost}".`);
    }
    for (const rec of records) {
      if (isBlockedIpAddress(rec.address)) {
        throw new ExternalImportError(400, 'Links pointing to private or local network addresses cannot be imported.');
      }
    }
  }

  async function safeFetchExternal(
    rawUrl: string,
    options?: {
      method?: 'GET' | 'HEAD';
      accept?: string;
      referer?: string;
      timeoutMs?: number;
      maxRedirects?: number;
    }
  ): Promise<{ response: globalThis.Response; finalUrl: string }> {
    const method = options?.method || 'GET';
    const maxRedirects = options?.maxRedirects ?? 5;
    const timeoutMs = options?.timeoutMs ?? 30_000;
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const validation = validateExternalImportUrl(currentUrl);
      if (!validation.ok || !validation.url) {
        throw new ExternalImportError(400, validation.error || 'Invalid external URL.');
      }
      await verifyHostResolvesToPublicIp(validation.url.hostname);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: globalThis.Response;
      try {
        const headers: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: options?.accept || 'text/html,application/xhtml+xml,image/*,video/*,*/*;q=0.8',
        };
        if (options?.referer) {
          headers.Referer = options.referer;
        }
        res = await fetch(validation.url.toString(), {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers,
        });
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        throw new ExternalImportError(
          isAbort ? 504 : 502,
          isAbort
            ? 'The remote website took too long to respond.'
            : 'Could not reach the remote website. Check the link and try again.'
        );
      }
      clearTimeout(timer);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new ExternalImportError(502, 'Remote website returned an invalid redirect.');
        }
        try {
          currentUrl = new URL(location, validation.url).toString();
        } catch {
          throw new ExternalImportError(400, 'Remote website redirected to an invalid URL.');
        }
        continue;
      }

      return { response: res, finalUrl: validation.url.toString() };
    }

    throw new ExternalImportError(400, 'Too many redirects while loading the external link.');
  }

  async function readLimitedResponseText(res: globalThis.Response, maxBytes: number): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }

  async function inspectSingleExternalUrl(rawUrl: string): Promise<RemoteInspectResult> {
    const { response, finalUrl } = await safeFetchExternal(rawUrl, {
      method: 'GET',
      timeoutMs: 25_000,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExternalImportError(
        400,
        `Remote site returned HTTP ${response.status} when scanning this link.`
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const contentDisposition = response.headers.get('content-disposition') || '';
    const contentLengthHeader = response.headers.get('content-length');
    const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    const fileSize =
      typeof parsedLength === 'number' && Number.isFinite(parsedLength) && parsedLength > 0
        ? parsedLength
        : undefined;

    const directMedia = detectMediaKindFromUrlOrMime(contentType, finalUrl);
    const isHtml =
      contentType.toLowerCase().includes('text/html') ||
      contentType.toLowerCase().includes('application/xhtml+xml');

    if (directMedia && !isHtml) {
      await response.body?.cancel().catch(() => undefined);
      const { fileName, title } = inferFilenameFromUrl(
        finalUrl,
        directMedia.mimeType,
        undefined,
        contentDisposition
      );
      const candidate: RemoteMediaCandidate = {
        url: finalUrl,
        kind: directMedia.kind,
        title,
        fileName,
        mimeType: directMedia.mimeType,
        fileSize,
        previewUrl: directMedia.kind === 'photo' ? finalUrl : undefined,
      };
      return {
        mode: 'direct',
        sourceUrl: finalUrl,
        pageTitle: title,
        pageDescription: '',
        items: [candidate],
      };
    }

    if (isHtml) {
      // Read up to 2 MiB of HTML safely to discover photos and videos on the external gallery/album page
      const html = await readLimitedResponseText(response, 2 * 1024 * 1024);
      const parsed = extractMediaCandidatesFromHtml(html, finalUrl, 200);
      if (parsed.items.length === 0) {
        throw new ExternalImportError(
          400,
          'No importable photos or videos were found on that page. Some sites load media only after login or via protected scripts—try pasting a direct image or video URL instead.'
        );
      }
      return parsed;
    }

    await response.body?.cancel().catch(() => undefined);
    throw new ExternalImportError(
      400,
      `Unsupported link type (${contentType.split(';')[0] || 'unknown'}). Paste a direct photo/video link or a public gallery webpage.`
    );
  }

  app.post('/api/import/inspect', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in before importing from a link.' });

    const singleUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const batchUrls: string[] = Array.isArray(req.body?.urls)
      ? req.body.urls.map((u: unknown) => String(u || '').trim()).filter(Boolean)
      : singleUrl
        ? [singleUrl]
        : [];

    if (batchUrls.length === 0) {
      return res.status(400).json({ error: 'Please paste at least one link to scan.' });
    }
    if (batchUrls.length > 50) {
      return res.status(400).json({ error: 'You can scan up to 50 links at once.' });
    }

    try {
      if (batchUrls.length === 1) {
        const result = await inspectSingleExternalUrl(batchUrls[0]);
        return res.json(result);
      }

      // Multi-link batch mode: inspect each URL and combine discovered items
      const combinedItems: RemoteMediaCandidate[] = [];
      const seenUrls = new Set<string>();
      const errors: string[] = [];
      let firstTitle = '';

      for (const link of batchUrls) {
        try {
          const single = await inspectSingleExternalUrl(link);
          if (!firstTitle && single.pageTitle) firstTitle = single.pageTitle;
          for (const item of single.items) {
            if (!seenUrls.has(item.url) && combinedItems.length < 200) {
              seenUrls.add(item.url);
              combinedItems.push(item);
            }
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Failed to scan ${link}`);
        }
      }

      if (combinedItems.length === 0) {
        return res.status(400).json({
          error: errors[0] || 'No valid photos or videos were found in the pasted links.',
        });
      }

      const batchResult: RemoteInspectResult = {
        mode: 'batch_links',
        sourceUrl: batchUrls[0],
        pageTitle: firstTitle || 'Imported Link Collection',
        pageDescription: `Imported from ${batchUrls.length} external links`,
        items: combinedItems,
        skippedCount: errors.length,
      };
      return res.json(batchResult);
    } catch (err) {
      if (err instanceof ExternalImportError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('External link inspect error:', err);
      return res.status(500).json({ error: 'Could not scan that link right now.' });
    }
  });

  app.post('/api/import/url', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in before importing media.' });

    const albumId = String(req.body?.albumId || '').trim();
    const album = db.albums[albumId];
    if (!album) return res.status(404).json({ error: 'Destination album was not found.' });

    const members = db.members[album.id] || [];
    const decision = canAccessAlbum(album, user, members);
    if (!decision.canUpload) {
      return res.status(403).json({ error: 'You do not have upload permission for this album.' });
    }

    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const rawSourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
    const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 140) : '';
    const requestedCaption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 600) : '';
    const requestedTags = sanitizeTags(Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []);

    let safeReferer: string | undefined;
    if (rawSourceUrl) {
      const refCheck = validateExternalImportUrl(rawSourceUrl);
      if (refCheck.ok && refCheck.url) {
        safeReferer = refCheck.url.toString();
      }
    }

    const tempId = generateSafeId('imp');
    const resolvedTmpRoot = path.resolve(TMP_DIR);
    const tempPath = path.resolve(resolvedTmpRoot, `${tempId}.part`);
    if (!tempPath.startsWith(resolvedTmpRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid temporary path.' });
    }

    try {
      const { response, finalUrl } = await safeFetchExternal(rawUrl, {
        method: 'GET',
        accept: 'image/*,video/*,*/*;q=0.8',
        referer: safeReferer,
        timeoutMs: 120_000,
      });

      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExternalImportError(
          400,
          `Remote site returned HTTP ${response.status} while downloading this media file.`
        );
      }

      const contentType = response.headers.get('content-type') || '';
      const contentDisposition = response.headers.get('content-disposition') || '';
      const detected = detectMediaKindFromUrlOrMime(contentType, finalUrl);
      if (!detected || contentType.toLowerCase().includes('text/html')) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExternalImportError(
          400,
          `That link did not return a direct photo or video file (${contentType.split(';')[0] || 'unknown type'}).`
        );
      }

      const { fileName, title } = inferFilenameFromUrl(
        finalUrl,
        detected.mimeType,
        requestedTitle || undefined,
        contentDisposition
      );

      const mediaId = generateSafeId('med');
      const rawExt = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
      const diskFileName = `${mediaId}${rawExt || ''}`;

      const resolvedUploadsRoot = path.resolve(UPLOADS_DIR);
      const finalPath = path.resolve(resolvedUploadsRoot, diskFileName);
      if (!finalPath.startsWith(resolvedUploadsRoot + path.sep)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExternalImportError(400, 'Invalid destination filename.');
      }

      // Stream remote media body directly to disk without buffering in RAM
      const webStream = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
      await pipeline(Readable.fromWeb(webStream), fs.createWriteStream(tempPath));

      const stat = await fsp.stat(tempPath);
      if (!stat.size || stat.size <= 0) {
        await safeUnlink(tempPath);
        throw new ExternalImportError(400, 'Remote file was empty (0 bytes).');
      }

      await fsp.rename(tempPath, finalPath);

      const now = new Date().toISOString();
      const mediaUrl = `/api/media/${mediaId}`;
      const posterUrl = detected.kind === 'photo' ? mediaUrl : '';
      let sourceHost = '';
      try {
        sourceHost = new URL(finalUrl).hostname.replace(/^www\./, '');
      } catch {
        sourceHost = '';
      }

      const mediaItem: StoredMedia = {
        id: mediaId,
        albumId: album.id,
        albumVisibility: album.visibility,
        ownerId: user.uid,
        ownerName: user.displayName,
        title: requestedTitle || title,
        caption: requestedCaption,
        kind: detected.kind,
        mimeType: detected.mimeType,
        fileName,
        fileSize: stat.size,
        mediaUrl,
        posterUrl,
        width: 0,
        height: 0,
        durationSec: 0,
        cameraMeta: sourceHost ? `Imported from ${sourceHost}` : 'Imported from external link',
        tags: requestedTags.length > 0 ? requestedTags : ['imported'],
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
        diskFileName,
      };

      db.media[mediaId] = mediaItem;

      if (mediaItem.kind === 'video') {
        await ensureVideoPoster(mediaItem);
      }

      album.itemCount = (album.itemCount || 0) + 1;
      album.totalBytes = (album.totalBytes || 0) + (mediaItem.fileSize || 0);
      if (!album.coverUrl && (mediaItem.posterUrl || detected.kind === 'photo')) {
        album.coverUrl = mediaItem.posterUrl || mediaUrl;
      }
      album.updatedAt = now;
      user.totalBytesUploaded = (user.totalBytesUploaded || 0) + (mediaItem.fileSize || 0);

      writeMediaSidecarSync(UPLOADS_DIR, mediaItem);
      persistDb();

      return res.status(201).json({
        media: toPublicMedia(mediaItem),
        album: toPublicAlbum(album, {
          includeShareToken: album.ownerId === user.uid,
          viewerRole: album.ownerId === user.uid ? 'owner' : 'contributor',
        }),
      });
    } catch (err) {
      await safeUnlink(tempPath);
      if (err instanceof ExternalImportError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('External URL import error:', err);
      return res.status(500).json({ error: 'Failed to import media from the external link.' });
    }
  });

  // =========================================================================
  // REAL-TIME WEBSOCKET HUB (LIVE CHAT, PRESENCE & LIVE MEDIA COMMENTS)
  // =========================================================================
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('error', (err) => {
    console.error('WebSocket server error:', err);
  });
  const userSockets = new Map<string, Set<WebSocket>>();
  const allSockets = new Set<WebSocket>();

  function getOnlineUserIds(): string[] {
    const ids: string[] = [];
    for (const [uid, sockets] of userSockets.entries()) {
      if (sockets.size > 0) ids.push(uid);
    }
    return ids;
  }

  function sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function broadcastAll(payload: unknown): void {
    const encoded = JSON.stringify(payload);
    for (const ws of allSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
      }
    }
  }

  function sendToUser(uid: string, payload: unknown): void {
    const sockets = userSockets.get(uid);
    if (!sockets) return;
    const encoded = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
      }
    }
  }

  function broadcastPresence(): void {
    broadcastAll({ type: 'presence:update', onlineUserIds: getOnlineUserIds() });
  }

  function parseCookieHeader(cookieHeader?: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        try {
          out[k] = decodeURIComponent(v);
        } catch {
          out[k] = v;
        }
      }
    }
    return out;
  }

  wss.on('connection', (ws, req) => {
    allSockets.add(ws);
    let authedUid: string | null = null;
    try {
      const reqUrl = new URL(req.url || '/ws', 'http://localhost');
      const queryToken = reqUrl.searchParams.get('token') || undefined;
      const cookies = parseCookieHeader(req.headers.cookie);
      const token = queryToken || cookies.aperture_session;
      const raw = verifySignedValue(token);
      if (raw) {
        const parsed = JSON.parse(raw) as { uid?: string };
        if (parsed.uid && db.users[parsed.uid]) {
          authedUid = parsed.uid;
        }
      }
    } catch {
      authedUid = null;
    }

    if (authedUid) {
      let set = userSockets.get(authedUid);
      if (!set) {
        set = new Set<WebSocket>();
        userSockets.set(authedUid, set);
      }
      set.add(ws);
      broadcastPresence();
    } else {
      sendJson(ws, { type: 'presence:update', onlineUserIds: getOnlineUserIds() });
    }

    ws.on('close', () => {
      allSockets.delete(ws);
      if (authedUid) {
        const set = userSockets.get(authedUid);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            userSockets.delete(authedUid);
          }
        }
        broadcastPresence();
      }
    });

    ws.on('error', () => {
      // cleanup happens in close handler
    });
  });

  // =========================================================================
  // PUBLIC SITE SETTINGS & CPANEL ADMIN ROUTES
  // =========================================================================
  app.get('/api/settings', (_req, res) => {
    res.json({ settings: db.siteSettings });
  });

  app.get('/api/admin/overview', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const allAlbums = Object.values(db.albums)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((a) => ({
        ...toPublicAlbum(a, { includeShareToken: true, viewerRole: 'owner' }),
        members: db.members[a.id] || [],
      }));

    const allUsers = Object.values(db.users)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((u) => toPublicUser(u));

    const allMedia = Object.values(db.media);
    const totalBytes = allMedia.reduce((sum, m) => sum + (m.fileSize || 0), 0);

    return res.json({
      stats: {
        totalUsers: allUsers.length,
        totalAlbums: allAlbums.length,
        publicAlbums: allAlbums.filter((a) => a.visibility === 'public').length,
        unlistedAlbums: allAlbums.filter((a) => a.visibility === 'unlisted').length,
        privateAlbums: allAlbums.filter((a) => a.visibility === 'private').length,
        totalMedia: allMedia.length,
        totalBytes,
      },
      albums: allAlbums,
      users: allUsers,
    });
  });

  app.patch('/api/admin/settings', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const merged = { ...db.siteSettings, ...(req.body || {}) };
    const validation = validateSiteSettings(merged);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    db.siteSettings = {
      ...validation.normalized,
      updatedAt: new Date().toISOString(),
    };
    persistDb();
    return res.json({ settings: db.siteSettings });
  });

  app.patch('/api/admin/albums/:albumId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const nextTitle = req.body?.title !== undefined ? String(req.body.title).trim() : album.title;
    const nextDescription =
      req.body?.description !== undefined ? String(req.body.description).trim() : album.description;
    const nextVisibility = (req.body?.visibility ?? album.visibility) as AlbumVisibility;

    const validation = validateAlbumInput({
      title: nextTitle,
      description: nextDescription,
      visibility: nextVisibility,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    album.title = nextTitle;
    album.description = nextDescription;
    if (req.body?.allowDownloads !== undefined) {
      album.allowDownloads = Boolean(req.body.allowDownloads);
    }
    if (album.visibility !== nextVisibility) {
      album.visibility = nextVisibility;
      for (const item of Object.values(db.media)) {
        if (item.albumId === album.id) {
          item.albumVisibility = nextVisibility;
          item.updatedAt = new Date().toISOString();
        }
      }
    }
    album.updatedAt = new Date().toISOString();
    persistDb();
    return res.json({ album: toPublicAlbum(album, { includeShareToken: true, viewerRole: 'owner' }) });
  });

  app.delete('/api/admin/albums/:albumId', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const ownerId = album.ownerId;
    const items = Object.values(db.media).filter((m) => m.albumId === album.id);
    for (const item of items) {
      if (item.diskFileName) {
        await safeUnlink(path.join(UPLOADS_DIR, item.diskFileName));
      }
      if (item.posterFileName) {
        await safeUnlink(path.join(POSTERS_DIR, item.posterFileName));
      }
      await deleteMediaSidecar(UPLOADS_DIR, item.id);
      delete db.comments[item.id];
      delete db.media[item.id];
    }

    delete db.albums[album.id];
    delete db.members[album.id];
    recalculateUserStorage(ownerId);
    persistDb();
    return res.json({ ok: true });
  });

  app.patch('/api/admin/users/:uid', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const target = db.users[req.params.uid];
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const nextAdmin = Boolean(req.body?.isAdmin);
    if (!nextAdmin && isBootstrappedAdminEmail(target.email)) {
      return res.status(400).json({ error: 'The primary site owner cannot be demoted.' });
    }
    if (!nextAdmin && target.uid === user.uid) {
      const otherAdmins = Object.values(db.users).filter((u) => u.uid !== target.uid && u.isAdmin);
      if (otherAdmins.length === 0) {
        return res.status(400).json({ error: 'At least one administrator account must remain active.' });
      }
    }

    target.isAdmin = nextAdmin;
    persistDb();
    return res.json({ user: toPublicUser(target) });
  });

  const EXPORT_ROOT_FILES = [
    'package.json',
    'package-lock.json',
    'bun.lock',
    'index.html',
    'server.ts',
    'tsconfig.json',
    'vite.config.ts',
    'eslint.config.mjs',
    'firestore.rules',
    'firebase-blueprint.json',
    'firebase-applet-config.json',
    '.env.example',
    'metadata.json',
  ];

  const buildDeployReadme = (siteName: string, includedMedia: boolean) =>
    `${siteName} — Self-Hosting & Deployment Guide
============================================================

What is inside this ZIP:
- Full frontend & Express/WebSocket backend source code (src/, server.ts, index.html)
- Pre-built production frontend bundle (dist/, if built)
- Package manifest, TypeScript/Vite configs, and Firebase web config/rules
${
  includedMedia
    ? '- Full site data backup (data/vault-db.json, uploads, video posters, covers, avatars)'
    : '- Lightweight code-only bundle (no node_modules or uploaded media files)'
}

How to host this app on your own website / server:
Because this app includes chunked video uploads, album ZIP streaming, video
thumbnail generation, and real-time WebSocket messaging, deploy it to a
Node.js host (Render, Railway, Fly.io, DigitalOcean, VPS, or cPanel Node.js App).

1. Upload and extract this ZIP on your Node.js host (Node.js 20+ recommended).
2. Copy .env.example to .env and set PORT=3000 (or your host's PORT).
3. Install dependencies:
     npm install
4. Build the frontend bundle:
     npm run build
5. Start the server:
     npx tsx server.ts
   (Or on Node 22.6+: npm start)
6. Optional: Install ffmpeg on your server for automatic video frame thumbnails.
7. If using Google Sign-In on a custom domain, add your new domain under:
   Firebase Console -> Authentication -> Settings -> Authorized domains.
`;

  app.head('/api/admin/export-app', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = getSessionUser(req);
    if (!user) return res.status(401).end();
    if (!user.isAdmin) return res.status(403).end();

    const includeMedia = req.query.includeMedia === '1' || req.query.includeMedia === 'true';
    const baseName = buildAlbumZipFilename(db.siteSettings.siteName || 'app').replace(/\.zip$/i, '');
    const zipFilename = includeMedia ? `${baseName}-full-backup.zip` : `${baseName}-deploy-app.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodeURIComponent(zipFilename)}`
    );
    return res.status(200).end();
  });

  app.get('/api/admin/export-app', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator privileges required.' });

    const includeMedia = req.query.includeMedia === '1' || req.query.includeMedia === 'true';
    const baseName = buildAlbumZipFilename(db.siteSettings.siteName || 'app').replace(/\.zip$/i, '');
    const zipFilename = includeMedia ? `${baseName}-full-backup.zip` : `${baseName}-deploy-app.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodeURIComponent(zipFilename)}`
    );

    // Use STORE mode when bundling large pre-compressed videos/photos; deflate for tiny code-only ZIP
    const archive = new ZipArchive(includeMedia ? { store: true } : { zlib: { level: 6 } });

    archive.on('warning', (err: ArchiverError) => {
      if (err.code !== 'ENOENT') {
        console.warn('[export-app] archive warning:', err.message);
      }
    });

    archive.on('error', (err: ArchiverError) => {
      console.error('[export-app] archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create application ZIP export.' });
      } else {
        res.destroy(err);
      }
    });

    req.on('close', () => {
      if (!res.writableEnded) {
        archive.abort();
      }
    });

    archive.pipe(res);

    const projectRoot = process.cwd();
    for (const relFile of EXPORT_ROOT_FILES) {
      const absPath = path.join(projectRoot, relFile);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        archive.file(absPath, { name: relFile });
      }
    }

    const srcDir = path.join(projectRoot, 'src');
    if (fs.existsSync(srcDir)) {
      archive.directory(srcDir, 'src');
    }

    const distDir = path.join(projectRoot, 'dist');
    if (fs.existsSync(distDir)) {
      archive.directory(distDir, 'dist');
    }

    if (includeMedia) {
      for (const dbFile of ['vault-db.json', 'vault-db.backup.json']) {
        const absDb = path.join(DATA_DIR, dbFile);
        if (fs.existsSync(absDb)) {
          archive.file(absDb, { name: `data/${dbFile}` });
        }
      }
      for (const subDir of ['uploads', 'posters', 'covers', 'avatars']) {
        const absSub = path.join(DATA_DIR, subDir);
        if (fs.existsSync(absSub)) {
          archive.directory(absSub, `data/${subDir}`);
        }
      }
    }

    archive.append(buildDeployReadme(db.siteSettings.siteName || 'Big B’z Leaks', includeMedia), {
      name: 'DEPLOY_README.txt',
    });

    void archive.finalize();
  });

  // =========================================================================
  // AUTH ROUTES
  // =========================================================================
  app.get('/api/auth/me', (req, res) => {
    const user = getSessionUser(req);
    const sessionToken = user ? setSessionCookie(req, res, user.uid) : undefined;
    res.json({ user: user ? toPublicUser(user) : null, sessionToken });
  });

  app.post('/api/auth/register', (req, res) => {
    if (!db.siteSettings.allowRegistrations) {
      return res.status(403).json({
        error: 'New account registrations are currently paused in the site cPanel.',
      });
    }

    const displayName = String(req.body?.displayName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const rawHandle = String(req.body?.handle || displayName);

    if (displayName.length < 1 || displayName.length > BLUEPRINT_LIMITS.displayNameMaxLength) {
      return res.status(400).json({ error: 'Please provide a display name (1–80 characters).' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const emailTaken = Object.values(db.users).some((u) => u.email.toLowerCase() === email);
    if (emailTaken) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in instead.' });
    }

    let handle = sanitizeHandle(rawHandle);
    while (Object.values(db.users).some((u) => u.handle === handle)) {
      handle = sanitizeHandle(`${handle}-${crypto.randomBytes(2).toString('hex')}`);
    }

    const uid = generateSafeId('usr');
    const { hash, salt } = hashSecret(password);
    const now = new Date().toISOString();
    const grantAdmin = isBootstrappedAdminEmail(email) || !hasAnyRealAdmin();

    const newUser: StoredUser = {
      uid,
      displayName,
      handle,
      email,
      bio: '',
      avatarUrl: '',
      provider: 'local',
      totalBytesUploaded: 0,
      isAdmin: grantAdmin,
      createdAt: now,
      passwordHash: hash,
      passwordSalt: salt,
    };

    db.users[uid] = newUser;
    persistDb();
    const sessionToken = setSessionCookie(req, res, uid);
    return res.status(201).json({ user: toPublicUser(newUser), sessionToken });
  });

  app.post('/api/auth/login', (req, res) => {
    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email or handle and password are required.' });
    }

    const user = Object.values(db.users).find(
      (u) => u.email.toLowerCase() === identifier || u.handle.toLowerCase() === identifier
    );
    if (!user || !user.passwordHash || !user.passwordSalt) {
      return res.status(401).json({ error: 'Invalid credentials. Check your email/handle and password.' });
    }

    if (!verifySecret(password, user.passwordHash, user.passwordSalt)) {
      return res.status(401).json({ error: 'Invalid credentials. Check your email/handle and password.' });
    }

    const sessionToken = setSessionCookie(req, res, user.uid);
    return res.json({ user: toPublicUser(user), sessionToken });
  });

  app.post('/api/auth/google-sync', (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const displayName = String(req.body?.displayName || 'Creator').trim().slice(0, 80);
    const avatarUrl = String(req.body?.avatarUrl || '').trim().slice(0, 500);

    if (!uid || !BLUEPRINT_LIMITS.idPattern.test(uid) || !email) {
      return res.status(400).json({ error: 'Invalid Google account payload.' });
    }

    let user = db.users[uid];
    if (!user) {
      let handle = sanitizeHandle(displayName || email.split('@')[0]);
      while (Object.values(db.users).some((u) => u.handle === handle)) {
        handle = sanitizeHandle(`${handle}-${crypto.randomBytes(2).toString('hex')}`);
      }
      const grantAdmin = isBootstrappedAdminEmail(email) || !hasAnyRealAdmin();
      user = {
        uid,
        displayName,
        handle,
        email,
        bio: '',
        avatarUrl,
        provider: 'google' as AuthProviderKind,
        totalBytesUploaded: 0,
        isAdmin: grantAdmin,
        createdAt: new Date().toISOString(),
      };
      db.users[uid] = user;
    } else {
      user.displayName = displayName || user.displayName;
      user.avatarUrl = avatarUrl || user.avatarUrl;
      user.provider = 'google';
      if (isBootstrappedAdminEmail(email)) {
        user.isAdmin = true;
      }
    }
    persistDb();
    const sessionToken = setSessionCookie(req, res, uid);
    return res.json({ user: toPublicUser(user), sessionToken });
  });

  app.patch('/api/auth/profile', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const displayName = String(req.body?.displayName || '').trim();
    const handle = sanitizeHandle(String(req.body?.handle || user.handle));
    const bio = String(req.body?.bio || '').trim().slice(0, BLUEPRINT_LIMITS.bioMaxLength);

    if (displayName.length < 1 || displayName.length > BLUEPRINT_LIMITS.displayNameMaxLength) {
      return res.status(400).json({ error: 'Display name must be between 1 and 80 characters.' });
    }
    const handleConflict = Object.values(db.users).some(
      (u) => u.uid !== user.uid && u.handle === handle
    );
    if (handleConflict) {
      return res.status(409).json({ error: 'That handle is already taken.' });
    }

    user.displayName = displayName;
    user.handle = handle;
    user.bio = bio;

    // Keep denormalized owner names fresh across albums and media
    for (const album of Object.values(db.albums)) {
      if (album.ownerId === user.uid) {
        album.ownerName = displayName;
        album.ownerHandle = handle;
      }
    }
    for (const item of Object.values(db.media)) {
      if (item.ownerId === user.uid) {
        item.ownerName = displayName;
      }
    }

    persistDb();
    return res.json({ user: toPublicUser(user) });
  });

  // --- Profile Photo (Avatar) Upload & Serving ---
  app.post('/api/auth/avatar', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
    const savedFile = await saveDataUrlImage(AVATARS_DIR, `av_${user.uid}`, dataUrl, 6 * 1024 * 1024);
    if (!savedFile) {
      return res.status(400).json({ error: 'Please upload a valid JPEG, PNG, WebP, or GIF image (max 6 MB).' });
    }

    // Delete previous locally stored avatar file if any
    if (user.avatarUrl && user.avatarUrl.startsWith('/api/avatars/')) {
      const oldFile = path.basename(user.avatarUrl.split('?')[0]);
      if (oldFile && oldFile !== savedFile) {
        await safeUnlink(path.join(AVATARS_DIR, oldFile));
      }
    }

    user.avatarUrl = `/api/avatars/${savedFile}`;
    persistDb();
    return res.json({ user: toPublicUser(user) });
  });

  app.delete('/api/auth/avatar', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    if (user.avatarUrl && user.avatarUrl.startsWith('/api/avatars/')) {
      const oldFile = path.basename(user.avatarUrl.split('?')[0]);
      if (oldFile) {
        await safeUnlink(path.join(AVATARS_DIR, oldFile));
      }
    }
    user.avatarUrl = '';
    persistDb();
    return res.json({ user: toPublicUser(user) });
  });

  app.get('/api/avatars/:fileName', (req, res) => {
    const safeFile = path.basename(req.params.fileName || '');
    if (!safeFile || !/^[a-zA-Z0-9_.\-]+$/.test(safeFile)) {
      return res.status(400).end();
    }
    const fullPath = path.join(AVATARS_DIR, safeFile);
    if (!fs.existsSync(fullPath)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(fullPath);
  });

  app.post('/api/auth/logout', (req, res) => {
    const secure = isRequestSecure(req);
    res.clearCookie('aperture_session', {
      path: '/',
      sameSite: secure ? 'none' : 'lax',
      secure,
    });
    res.json({ ok: true });
  });

  // =========================================================================
  // EXPLORE & ALBUM MANAGEMENT ROUTES
  // =========================================================================
  app.get('/api/explore', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const publicAlbums = Object.values(db.albums)
      .filter((a) => a.visibility === 'public')
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((a) => toPublicAlbum(a, { includeShareToken: false, viewerRole: 'public' }));

    const publicAlbumIds = new Set(publicAlbums.map((a) => a.id));
    const publicMedia = Object.values(db.media)
      .filter((m) => m.albumVisibility === 'public' && publicAlbumIds.has(m.albumId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((m) => toPublicMedia(m));

    res.json({ albums: publicAlbums, media: publicMedia });
  });

  app.get('/api/albums', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const owned = Object.values(db.albums)
      .filter((a) => a.ownerId === user.uid)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((a) => ({
        ...toPublicAlbum(a, { includeShareToken: true, viewerRole: 'owner' }),
        members: db.members[a.id] || [],
      }));

    const sharedWithMe: Album[] = [];
    for (const [albumId, memberList] of Object.entries(db.members)) {
      const match = memberList.find(
        (m) =>
          m.uid === user.uid ||
          m.email.toLowerCase() === user.email.toLowerCase()
      );
      if (match && db.albums[albumId] && db.albums[albumId].ownerId !== user.uid) {
        sharedWithMe.push(
          toPublicAlbum(db.albums[albumId], {
            includeShareToken: false,
            viewerRole: match.role,
          })
        );
      }
    }

    res.json({ owned, sharedWithMe });
  });

  app.post('/api/albums', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required to create an album.' });

    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const visibility = (req.body?.visibility || 'private') as AlbumVisibility;
    const allowDownloads = Boolean(req.body?.allowDownloads ?? true);
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    const tags = Array.isArray(req.body?.tags)
      ? sanitizeTags(req.body.tags.map((t: unknown) => String(t)))
      : [];

    const validation = validateAlbumInput({ title, description, visibility, passcode });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    const id = generateSafeId('alb');
    const now = new Date().toISOString();
    let passcodeHash: string | undefined;
    let passcodeSalt: string | undefined;
    if (passcode.length >= 4) {
      const hashed = hashSecret(passcode);
      passcodeHash = hashed.hash;
      passcodeSalt = hashed.salt;
    }

    const newAlbum: StoredAlbum = {
      id,
      ownerId: user.uid,
      ownerName: user.displayName,
      ownerHandle: user.handle,
      title,
      description,
      visibility,
      allowDownloads,
      shareToken: generateShareToken(),
      hasPasscode: Boolean(passcodeHash),
      passcodeHash,
      passcodeSalt,
      coverUrl: '',
      itemCount: 0,
      totalBytes: 0,
      viewCount: 0,
      tags,
      createdAt: now,
      updatedAt: now,
    };

    db.albums[id] = newAlbum;
    db.members[id] = [];
    persistDb();

    return res.status(201).json({
      album: {
        ...toPublicAlbum(newAlbum, { includeShareToken: true, viewerRole: 'owner' }),
        members: [],
      },
    });
  });

  app.get('/api/albums/:albumId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken,
      unlockedAlbumIds: unlocked,
    });

    if (!decision.allowed) {
      if (decision.reason === 'passcode_required') {
        return res.status(403).json({
          error: 'Passcode required to unlock this album.',
          code: 'PASSCODE_REQUIRED',
        });
      }
      return res.status(403).json({ error: 'You do not have permission to view this private album.' });
    }

    const isOwner = decision.reason === 'owner';
    const items = Object.values(db.media)
      .filter((m) => m.albumId === album.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((m) => toPublicMedia(m, decision.reason === 'share_link' ? shareToken : undefined));

    return res.json({
      album: toPublicAlbum(album, {
        includeShareToken: isOwner,
        viewerRole: isOwner
          ? 'owner'
          : decision.canUpload
            ? 'contributor'
            : decision.reason === 'public'
              ? 'public'
              : 'viewer',
      }),
      media: items,
      members: isOwner ? members : [],
      access: decision,
    });
  });

  // Track unique recent views per viewer + resource so rapid re-renders do not double-count
  const recentViews = new Map<string, number>();

  function getViewerTrackingKey(req: Request, user: StoredUser | null): string {
    if (user?.uid) return `u:${user.uid}`;
    const forwarded = String(req.headers['x-forwarded-for'] || req.ip || 'anon').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0, 120);
    return `a:${crypto.createHash('sha256').update(`${forwarded}|${ua}`).digest('hex').slice(0, 20)}`;
  }

  app.post('/api/albums/:albumId/view', (req, res) => {
    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken =
      typeof req.body?.shareToken === 'string' && req.body.shareToken.trim()
        ? req.body.shareToken.trim()
        : typeof req.query.share === 'string'
          ? req.query.share
          : undefined;
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken,
      unlockedAlbumIds: unlocked,
    });
    if (!decision.allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this album.' });
    }

    const viewerKey = getViewerTrackingKey(req, user);
    if (shouldRecordView(viewerKey, `album:${album.id}`, Date.now(), recentViews)) {
      album.viewCount = (Number(album.viewCount) || 0) + 1;
      persistDb();
    }

    return res.json({
      albumId: album.id,
      viewCount: Math.max(0, Number(album.viewCount) || 0),
    });
  });

  app.post('/api/media/:mediaId/view', (req, res) => {
    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const album = db.albums[item.albumId];
    if (!album) return res.status(404).json({ error: 'Parent album not found.' });

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken =
      typeof req.body?.shareToken === 'string' && req.body.shareToken.trim()
        ? req.body.shareToken.trim()
        : typeof req.query.share === 'string'
          ? req.query.share
          : undefined;
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken,
      unlockedAlbumIds: unlocked,
    });
    if (!decision.allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this media item.' });
    }

    const viewerKey = getViewerTrackingKey(req, user);
    if (shouldRecordView(viewerKey, `media:${item.id}`, Date.now(), recentViews)) {
      item.viewCount = (Number(item.viewCount) || 0) + 1;
      writeMediaSidecarSync(UPLOADS_DIR, item);
      persistDb();
    }

    return res.json({
      mediaId: item.id,
      albumId: item.albumId,
      viewCount: Math.max(0, Number(item.viewCount) || 0),
    });
  });

  const resolveAlbumDownloadRequest = (req: Request, res: Response) => {
    const album = db.albums[req.params.albumId];
    if (!album) {
      res.status(404).json({ error: 'Album not found.' });
      return null;
    }

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken,
      unlockedAlbumIds: unlocked,
    });

    if (!decision.allowed) {
      if (decision.reason === 'passcode_required') {
        res.status(403).json({
          error: 'Passcode required to unlock this album.',
          code: 'PASSCODE_REQUIRED',
        });
        return null;
      }
      res.status(403).json({ error: 'You do not have permission to download this private album.' });
      return null;
    }

    if (!decision.canDownload) {
      res.status(403).json({ error: 'Original file downloads are disabled for this album.' });
      return null;
    }

    const mediaItems = Object.values(db.media)
      .filter((m) => m.albumId === album.id && Boolean(m.diskFileName))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const downloadable = mediaItems
      .map((item) => ({
        item,
        fullPath: path.join(UPLOADS_DIR, item.diskFileName!),
      }))
      .filter(({ fullPath }) => fs.existsSync(fullPath));

    if (downloadable.length === 0) {
      res.status(404).json({ error: 'No downloadable media files found in this album.' });
      return null;
    }

    const zipFilename = buildAlbumZipFilename(album.title);
    return { album, downloadable, zipFilename };
  };

  app.head('/api/albums/:albumId/download', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const resolved = resolveAlbumDownloadRequest(req, res);
    if (!resolved) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${resolved.zipFilename}"; filename*=UTF-8''${encodeURIComponent(resolved.zipFilename)}`
    );
    res.setHeader('X-Album-File-Count', String(resolved.downloadable.length));
    return res.status(200).end();
  });

  app.get('/api/albums/:albumId/download', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const resolved = resolveAlbumDownloadRequest(req, res);
    if (!resolved) return;

    const { downloadable, zipFilename } = resolved;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodeURIComponent(zipFilename)}`
    );

    // Use STORE mode (no re-compression) because photos and videos are already compressed;
    // streams directly from disk with constant low RAM even for multi-gigabyte video albums.
    const archive = new ZipArchive({ store: true });

    archive.on('warning', (err: ArchiverError) => {
      if (err.code !== 'ENOENT') {
        console.warn('[zip-download] archive warning:', err.message);
      }
    });

    archive.on('error', (err: ArchiverError) => {
      console.error('[zip-download] archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to bundle album media into ZIP archive.' });
      } else {
        res.destroy(err);
      }
    });

    req.on('close', () => {
      if (!res.writableEnded) {
        archive.abort();
      }
    });

    archive.pipe(res);

    const uniqueNames = buildUniqueZipEntryNames(
      downloadable.map(({ item }) => ({
        id: item.id,
        title: item.title,
        fileName: item.fileName,
        diskFileName: item.diskFileName,
      }))
    );
    const entryNameById = new Map(uniqueNames.map((entry) => [entry.id, entry.entryName]));

    for (const { item, fullPath } of downloadable) {
      const entryName = entryNameById.get(item.id) || item.fileName || item.id;
      archive.file(fullPath, { name: entryName });
    }

    void archive.finalize();
  });

  app.patch('/api/albums/:albumId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Only the album owner can modify album settings.' });
    }

    const nextTitle = req.body?.title !== undefined ? String(req.body.title).trim() : album.title;
    const nextDescription =
      req.body?.description !== undefined ? String(req.body.description).trim() : album.description;
    const nextVisibility = (req.body?.visibility ?? album.visibility) as AlbumVisibility;
    const nextPasscode =
      typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : undefined;

    const validation = validateAlbumInput({
      title: nextTitle,
      description: nextDescription,
      visibility: nextVisibility,
      passcode: nextPasscode,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    album.title = nextTitle;
    album.description = nextDescription;
    if (Array.isArray(req.body?.tags)) {
      album.tags = sanitizeTags(req.body.tags.map((t: unknown) => String(t)));
    }
    if (req.body?.allowDownloads !== undefined) {
      album.allowDownloads = Boolean(req.body.allowDownloads);
    }
    if (typeof req.body?.coverUrl === 'string') {
      album.coverUrl = req.body.coverUrl.slice(0, 500);
    }

    if (album.visibility !== nextVisibility) {
      album.visibility = nextVisibility;
      // Synchronize denormalized visibility on every media item inside the album
      for (const item of Object.values(db.media)) {
        if (item.albumId === album.id) {
          item.albumVisibility = nextVisibility;
          item.updatedAt = new Date().toISOString();
          if (item.diskFileName) {
            try {
              writeMediaSidecarSync(UPLOADS_DIR, item);
            } catch {
              // non-fatal
            }
          }
        }
      }
    }

    if (req.body?.clearPasscode === true) {
      album.hasPasscode = false;
      delete album.passcodeHash;
      delete album.passcodeSalt;
    } else if (nextPasscode && nextPasscode.length >= 4) {
      const hashed = hashSecret(nextPasscode);
      album.passcodeHash = hashed.hash;
      album.passcodeSalt = hashed.salt;
      album.hasPasscode = true;
    }

    if (req.body?.revokeShareToken === true) {
      album.shareToken = '';
    } else if (req.body?.regenerateShareToken === true) {
      album.shareToken = generateShareToken();
    }

    album.updatedAt = new Date().toISOString();
    persistDb();

    return res.json({
      album: {
        ...toPublicAlbum(album, { includeShareToken: true, viewerRole: 'owner' }),
        members: db.members[album.id] || [],
      },
    });
  });

  // --- Custom Album Cover Photo Upload & Protected Serving ---
  app.post('/api/albums/:albumId/cover', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid && !user.isAdmin) {
      return res.status(403).json({ error: 'Only the album owner can change the cover photo.' });
    }

    const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
    const savedFile = await saveDataUrlImage(COVERS_DIR, `cov_${album.id}`, dataUrl, 8 * 1024 * 1024);
    if (!savedFile) {
      return res.status(400).json({ error: 'Please upload a valid JPEG, PNG, WebP, or GIF cover image (max 8 MB).' });
    }

    if (album.coverUrl && album.coverUrl.startsWith('/api/covers/')) {
      const oldFile = path.basename(album.coverUrl.split('?')[0]);
      if (oldFile && oldFile !== savedFile) {
        await safeUnlink(path.join(COVERS_DIR, oldFile));
      }
    }

    album.coverUrl = `/api/covers/${savedFile}`;
    album.updatedAt = new Date().toISOString();
    persistDb();

    return res.json({
      album: {
        ...toPublicAlbum(album, { includeShareToken: true, viewerRole: 'owner' }),
        members: db.members[album.id] || [],
      },
    });
  });

  app.delete('/api/albums/:albumId/cover', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid && !user.isAdmin) {
      return res.status(403).json({ error: 'Only the album owner can change the cover photo.' });
    }

    if (album.coverUrl && album.coverUrl.startsWith('/api/covers/')) {
      const oldFile = path.basename(album.coverUrl.split('?')[0]);
      if (oldFile) {
        await safeUnlink(path.join(COVERS_DIR, oldFile));
      }
    }
    album.coverUrl = '';
    recalculateAlbumStats(album.id);
    persistDb();

    return res.json({
      album: {
        ...toPublicAlbum(album, { includeShareToken: true, viewerRole: 'owner' }),
        members: db.members[album.id] || [],
      },
    });
  });

  app.get('/api/covers/:fileName', (req, res) => {
    const safeFile = path.basename(req.params.fileName || '');
    if (!safeFile || !/^[a-zA-Z0-9_.\-]+$/.test(safeFile)) {
      return res.status(400).end();
    }
    const coverPathUrl = `/api/covers/${safeFile}`;
    const album = Object.values(db.albums).find((a) => a.coverUrl === coverPathUrl);
    if (album) {
      const user = getSessionUser(req);
      const members = db.members[album.id] || [];
      const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
      const unlocked = getUnlockedAlbums(req);
      const decision = canAccessAlbum(album, user, members, { shareToken, unlockedAlbumIds: unlocked });
      if (!decision.allowed) return res.status(403).end();
    }
    const fullPath = path.join(COVERS_DIR, safeFile);
    if (!fs.existsSync(fullPath)) return res.status(404).end();
    res.setHeader(
      'Cache-Control',
      album && album.visibility !== 'public' ? 'private, no-store' : 'public, max-age=3600'
    );
    return res.sendFile(fullPath);
  });

  app.delete('/api/albums/:albumId', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Only the album owner can delete this album.' });
    }

    if (album.coverUrl && album.coverUrl.startsWith('/api/covers/')) {
      const oldFile = path.basename(album.coverUrl.split('?')[0]);
      if (oldFile) await safeUnlink(path.join(COVERS_DIR, oldFile));
    }

    const items = Object.values(db.media).filter((m) => m.albumId === album.id);
    for (const item of items) {
      if (item.diskFileName) {
        await safeUnlink(path.join(UPLOADS_DIR, item.diskFileName));
      }
      if (item.posterFileName) {
        await safeUnlink(path.join(POSTERS_DIR, item.posterFileName));
      }
      await deleteMediaSidecar(UPLOADS_DIR, item.id);
      delete db.comments[item.id];
      delete db.media[item.id];
    }

    delete db.albums[album.id];
    delete db.members[album.id];
    recalculateUserStorage(user.uid);
    persistDb();

    return res.json({ ok: true });
  });

  // --- Collaborator Access Management ---
  app.post('/api/albums/:albumId/members', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Only the album owner can manage collaborators.' });
    }

    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const role: MemberRole = req.body?.role === 'contributor' ? 'contributor' : 'viewer';

    if (!identifier) {
      return res.status(400).json({ error: 'Enter a collaborator email address or handle.' });
    }

    const matchedUser = Object.values(db.users).find(
      (u) => u.email.toLowerCase() === identifier || u.handle.toLowerCase() === identifier
    );
    if (matchedUser && matchedUser.uid === user.uid) {
      return res.status(400).json({ error: 'You are already the owner of this album.' });
    }

    const email = matchedUser ? matchedUser.email : identifier;
    if (!matchedUser && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address or an existing user handle.' });
    }

    const list = db.members[album.id] || [];
    const existingIdx = list.findIndex((m) => m.email.toLowerCase() === email.toLowerCase());
    const member: AlbumMember = {
      id: existingIdx >= 0 ? list[existingIdx].id : generateSafeId('mem'),
      uid: matchedUser?.uid || '',
      albumId: album.id,
      email,
      memberName: matchedUser?.displayName || email.split('@')[0],
      handle: matchedUser?.handle || sanitizeHandle(email.split('@')[0]),
      role,
      createdAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      list[existingIdx] = member;
    } else {
      list.push(member);
    }
    db.members[album.id] = list;
    persistDb();

    return res.status(201).json({ member });
  });

  app.delete('/api/albums/:albumId/members/:memberId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const album = db.albums[req.params.albumId];
    if (!album) return res.status(404).json({ error: 'Album not found.' });
    if (album.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Only the album owner can revoke collaborator access.' });
    }

    const list = db.members[album.id] || [];
    db.members[album.id] = list.filter((m) => m.id !== req.params.memberId);
    persistDb();

    return res.json({ ok: true });
  });

  // =========================================================================
  // SHARE LINK RESOLUTION & PASSCODE UNLOCK
  // =========================================================================
  app.get('/api/share/:token', (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(404).json({ error: 'Share link is invalid or has been revoked.' });

    const album = Object.values(db.albums).find((a) => a.shareToken && a.shareToken === token);
    if (!album) {
      return res.status(404).json({ error: 'This share link is invalid or has been revoked by the owner.' });
    }

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken: token,
      unlockedAlbumIds: unlocked,
    });

    if (!decision.allowed && decision.reason === 'passcode_required') {
      return res.json({
        locked: true,
        albumId: album.id,
        albumTitle: album.title,
        ownerName: album.ownerName,
        itemCount: album.itemCount,
      });
    }

    if (!decision.allowed) {
      return res.status(403).json({ error: 'Access to this album is restricted.' });
    }

    const items = Object.values(db.media)
      .filter((m) => m.albumId === album.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((m) => toPublicMedia(m, token));

    return res.json({
      locked: false,
      album: toPublicAlbum(album, {
        includeShareToken: decision.reason === 'owner',
        viewerRole: decision.reason === 'owner' ? 'owner' : 'viewer',
      }),
      media: items,
      access: decision,
    });
  });

  app.post('/api/share/:token/unlock', (req, res) => {
    const token = String(req.params.token || '').trim();
    const passcode = String(req.body?.passcode || '').trim();

    const album = Object.values(db.albums).find((a) => a.shareToken && a.shareToken === token);
    if (!album) {
      return res.status(404).json({ error: 'This share link is invalid or has been revoked.' });
    }

    let unlockToken: string | undefined;
    if (album.hasPasscode && album.passcodeHash && album.passcodeSalt) {
      if (!passcode || !verifySecret(passcode, album.passcodeHash, album.passcodeSalt)) {
        return res.status(403).json({ error: 'Incorrect passcode. Please try again.' });
      }
      unlockToken = addUnlockedAlbumCookie(req, res, album.id);
    }

    const items = Object.values(db.media)
      .filter((m) => m.albumId === album.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((m) => toPublicMedia(m, token));

    return res.json({
      locked: false,
      album: toPublicAlbum(album, { includeShareToken: false, viewerRole: 'viewer' }),
      media: items,
      access: {
        allowed: true,
        reason: 'share_link',
        canEdit: false,
        canUpload: false,
        canDownload: album.allowDownloads,
      },
      unlockToken,
    });
  });

  // =========================================================================
  // UNLIMITED-SIZE CHUNKED STREAMING UPLOADS (NO FILE SIZE CAP)
  // =========================================================================
  app.post('/api/uploads/init', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in before uploading media.' });

    const albumId = String(req.body?.albumId || '').trim();
    const album = db.albums[albumId];
    if (!album) return res.status(404).json({ error: 'Selected album was not found.' });

    const members = db.members[album.id] || [];
    const decision = canAccessAlbum(album, user, members);
    if (!decision.canUpload) {
      return res.status(403).json({ error: 'You do not have upload permission for this album.' });
    }

    const fileName = String(req.body?.fileName || 'untitled').trim().slice(0, 200);
    const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim().slice(0, 100);
    const fileSize = Number(req.body?.fileSize ?? 0);
    const chunkSize = Math.max(1024, Math.min(Number(req.body?.chunkSize) || 4 * 1024 * 1024, 64 * 1024 * 1024));
    const totalChunks = Math.max(1, Number(req.body?.totalChunks) || 1);

    if (!Number.isFinite(fileSize) || fileSize < 0) {
      return res.status(400).json({ error: 'Invalid file size.' });
    }

    const uploadId = generateSafeId('upl');
    const tempPath = path.join(TMP_DIR, `${uploadId}.part`);
    await fsp.writeFile(tempPath, Buffer.alloc(0));

    const posterFileName = await savePosterDataUrl(uploadId, req.body?.posterDataUrl);
    const preferredMediaId = validatePreferredMediaId(req.body?.preferredMediaId);
    const rawCreatedAt = typeof req.body?.createdAt === 'string' ? req.body.createdAt.trim() : '';
    const createdAtOverride =
      rawCreatedAt && !Number.isNaN(Date.parse(rawCreatedAt)) ? rawCreatedAt : undefined;

    const session: ActiveUploadSession = {
      uploadId,
      ownerId: user.uid,
      ownerName: user.displayName,
      albumId: album.id,
      fileName,
      mimeType,
      fileSize,
      chunkSize,
      totalChunks,
      receivedChunks: new Set<number>(),
      tempPath,
      title: String(req.body?.title || fileName.replace(/\.[^.]+$/, '') || 'Untitled').trim().slice(0, 140),
      caption: String(req.body?.caption || '').trim().slice(0, 600),
      cameraMeta: String(req.body?.cameraMeta || '').trim().slice(0, 160),
      tags: sanitizeTags(Array.isArray(req.body?.tags) ? req.body.tags.map(String) : []),
      width: Math.max(0, Number(req.body?.width) || 0),
      height: Math.max(0, Number(req.body?.height) || 0),
      durationSec: Math.max(0, Number(req.body?.durationSec) || 0),
      posterFileName,
      preferredMediaId,
      createdAtOverride,
      createdAt: Date.now(),
    };

    activeUploads.set(uploadId, session);
    saveUploadSessionMetaSync(TMP_DIR, session);
    return res.status(201).json({ uploadId, chunkSize });
  });

  app.put('/api/uploads/:uploadId/chunk/:index', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const session = activeUploads.get(req.params.uploadId);
    if (!session) return res.status(404).json({ error: 'Upload session expired or not found.' });
    if (session.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Unauthorized upload session.' });
    }

    const chunkIndex = Number(req.params.index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      return res.status(400).json({ error: 'Invalid chunk index.' });
    }

    const offset = chunkIndex * session.chunkSize;
    let fileHandle: fsp.FileHandle | null = null;
    try {
      fileHandle = await fsp.open(session.tempPath, 'r+');
      const { receivedBytes } = await streamChunkToFileHandle(req, fileHandle, offset);
      await fileHandle.sync();
      session.receivedChunks.add(chunkIndex);
      saveUploadSessionMetaSync(TMP_DIR, session);
      return res.json({ receivedBytes, chunkIndex });
    } catch (err) {
      console.error('Chunk write error:', err);
      return res.status(500).json({ error: 'Failed to write uploaded chunk to storage.' });
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => undefined);
    }
  });

  app.post('/api/uploads/:uploadId/complete', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const session = activeUploads.get(req.params.uploadId);
    if (!session) return res.status(404).json({ error: 'Upload session not found.' });
    if (session.ownerId !== user.uid) {
      return res.status(403).json({ error: 'Unauthorized upload session.' });
    }

    if (session.receivedChunks.size < session.totalChunks) {
      return res.status(400).json({
        error: `Upload incomplete (${session.receivedChunks.size} of ${session.totalChunks} chunks received).`,
      });
    }

    const album = db.albums[session.albumId];
    if (!album) {
      await safeUnlink(session.tempPath);
      await deleteUploadSessionMeta(TMP_DIR, session.uploadId);
      activeUploads.delete(session.uploadId);
      return res.status(404).json({ error: 'Destination album no longer exists.' });
    }

    const mediaId =
      session.preferredMediaId && !db.media[session.preferredMediaId]
        ? session.preferredMediaId
        : generateSafeId('med');
    const rawExt = path.extname(session.fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    const diskFileName = `${mediaId}${rawExt || ''}`;
    const finalPath = path.join(UPLOADS_DIR, diskFileName);

    await fsp.rename(session.tempPath, finalPath);
    const stat = await fsp.stat(finalPath);
    await deleteUploadSessionMeta(TMP_DIR, session.uploadId);
    activeUploads.delete(session.uploadId);

    const kind = classifyMediaKind(session.mimeType, session.fileName);
    const now = new Date().toISOString();
    const createdAt = session.createdAtOverride || now;
    const mediaUrl = `/api/media/${mediaId}`;
    const posterUrl = session.posterFileName
      ? `/api/poster/${mediaId}`
      : kind === 'photo'
        ? mediaUrl
        : '';

    const mediaItem: StoredMedia = {
      id: mediaId,
      albumId: album.id,
      albumVisibility: album.visibility,
      ownerId: user.uid,
      ownerName: user.displayName,
      title: session.title || session.fileName,
      caption: session.caption,
      kind,
      mimeType: session.mimeType,
      fileName: session.fileName,
      fileSize: stat.size || session.fileSize,
      mediaUrl,
      posterUrl,
      width: session.width,
      height: session.height,
      durationSec: session.durationSec,
      cameraMeta: session.cameraMeta,
      tags: session.tags,
      viewCount: 0,
      createdAt,
      updatedAt: now,
      diskFileName,
      posterFileName: session.posterFileName,
    };

    db.media[mediaId] = mediaItem;

    // Guarantee a real video thumbnail frame + dimensions/duration on upload completion
    if (
      mediaItem.kind === 'video' &&
      (!mediaItem.posterFileName || mediaItem.width === 0 || mediaItem.durationSec === 0)
    ) {
      await ensureVideoPoster(mediaItem);
    }

    album.itemCount = (album.itemCount || 0) + 1;
    album.totalBytes = (album.totalBytes || 0) + (mediaItem.fileSize || 0);
    if (!album.coverUrl && (mediaItem.posterUrl || kind === 'photo')) {
      album.coverUrl = mediaItem.posterUrl || mediaUrl;
    }
    album.updatedAt = now;
    user.totalBytesUploaded = (user.totalBytesUploaded || 0) + (mediaItem.fileSize || 0);
    // Write durable per-file sidecar AND atomic vault-db.json BEFORE returning 201
    writeMediaSidecarSync(UPLOADS_DIR, mediaItem);
    persistDb();

    return res.status(201).json({
      media: toPublicMedia(mediaItem),
      album: toPublicAlbum(album, { includeShareToken: album.ownerId === user.uid, viewerRole: 'owner' }),
    });
  });

  app.delete('/api/uploads/:uploadId', async (req, res) => {
    const user = getSessionUser(req);
    const session = activeUploads.get(req.params.uploadId);
    if (session && (!user || session.ownerId === user.uid)) {
      await safeUnlink(session.tempPath);
      await deleteUploadSessionMeta(TMP_DIR, session.uploadId);
      if (session.posterFileName) {
        await safeUnlink(path.join(POSTERS_DIR, session.posterFileName));
      }
      activeUploads.delete(req.params.uploadId);
    }
    res.json({ ok: true });
  });

  // Return owned album IDs and media IDs whose files are currently alive on disk
  app.get('/api/vault/inventory', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const albumIds = Object.values(db.albums)
      .filter((a) => a.ownerId === user.uid)
      .map((a) => a.id);

    const mediaIds = Object.values(db.media)
      .filter((m) => {
        if (m.ownerId !== user.uid) return false;
        if (!m.diskFileName) return true;
        return fs.existsSync(path.join(UPLOADS_DIR, m.diskFileName));
      })
      .map((m) => m.id);

    return res.json({ albumIds, mediaIds });
  });

  // Reconcile signed-in user's Firestore album/media metadata against binaries on disk
  app.post('/api/sync/reconcile', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const incomingAlbums = Array.isArray(req.body?.albums) ? req.body.albums : [];
    const incomingMedia = Array.isArray(req.body?.media) ? req.body.media : [];

    let restoredAlbums = 0;
    let restoredMedia = 0;
    const touchedAlbumIds = new Set<string>();

    for (const raw of incomingAlbums) {
      if (!raw || typeof raw.id !== 'string' || !BLUEPRINT_LIMITS.idPattern.test(raw.id)) continue;
      if (raw.ownerId !== user.uid) continue;
      if (db.albums[raw.id]) continue;

      const visibility: AlbumVisibility =
        raw.visibility === 'public' || raw.visibility === 'unlisted' ? raw.visibility : 'private';
      const now = new Date().toISOString();
      db.albums[raw.id] = {
        id: raw.id,
        ownerId: user.uid,
        ownerName: user.displayName,
        ownerHandle: user.handle,
        title: String(raw.title || 'Untitled Album').trim().slice(0, BLUEPRINT_LIMITS.albumTitleMaxLength),
        description: String(raw.description || '').trim().slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
        visibility,
        allowDownloads: Boolean(raw.allowDownloads ?? true),
        shareToken: typeof raw.shareToken === 'string' && raw.shareToken ? raw.shareToken.slice(0, 64) : generateShareToken(),
        hasPasscode: Boolean(raw.hasPasscode),
        coverUrl: typeof raw.coverUrl === 'string' ? raw.coverUrl.slice(0, 500) : '',
        itemCount: 0,
        totalBytes: 0,
        tags: [],
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
      };
      if (!db.members[raw.id]) db.members[raw.id] = [];
      touchedAlbumIds.add(raw.id);
      restoredAlbums++;
    }

    let diskFiles: string[] = [];
    let posterFiles: string[] = [];
    try {
      diskFiles = await fsp.readdir(UPLOADS_DIR);
    } catch {
      diskFiles = [];
    }
    try {
      posterFiles = await fsp.readdir(POSTERS_DIR);
    } catch {
      posterFiles = [];
    }

    for (const raw of incomingMedia) {
      if (!raw || typeof raw.id !== 'string' || !BLUEPRINT_LIMITS.idPattern.test(raw.id)) continue;
      if (raw.ownerId !== user.uid) continue;
      if (db.media[raw.id]) continue;
      if (typeof raw.albumId !== 'string' || !db.albums[raw.albumId]) continue;

      const parentAlbum = db.albums[raw.albumId];
      if (parentAlbum.ownerId !== user.uid) continue;

      const diskFileName = matchDiskFileForMediaId(raw.id, diskFiles);
      if (!diskFileName) continue;

      const fullPath = path.join(UPLOADS_DIR, diskFileName);
      let fileSize = Number(raw.fileSize) || 0;
      try {
        const stat = await fsp.stat(fullPath);
        fileSize = stat.size;
      } catch {
        continue;
      }

      const posterFileName = matchDiskFileForMediaId(raw.id, posterFiles) || undefined;
      const fileName = String(raw.fileName || diskFileName).slice(0, 200);
      const mimeType = String(raw.mimeType || 'application/octet-stream').slice(0, 100);
      const kind = raw.kind === 'video' || raw.kind === 'photo' ? raw.kind : classifyMediaKind(mimeType, fileName);
      const mediaUrl = `/api/media/${raw.id}`;
      const posterUrl = posterFileName
        ? `/api/poster/${raw.id}`
        : kind === 'photo'
          ? mediaUrl
          : '';
      const now = new Date().toISOString();

      db.media[raw.id] = {
        id: raw.id,
        albumId: parentAlbum.id,
        albumVisibility: parentAlbum.visibility,
        ownerId: user.uid,
        ownerName: user.displayName,
        title: String(raw.title || fileName).trim().slice(0, BLUEPRINT_LIMITS.mediaTitleMaxLength),
        caption: String(raw.caption || '').trim().slice(0, BLUEPRINT_LIMITS.captionMaxLength),
        kind,
        mimeType,
        fileName,
        fileSize,
        mediaUrl,
        posterUrl,
        width: Math.max(0, Number(raw.width) || 0),
        height: Math.max(0, Number(raw.height) || 0),
        durationSec: Math.max(0, Number(raw.durationSec) || 0),
        cameraMeta: String(raw.cameraMeta || '').trim().slice(0, BLUEPRINT_LIMITS.cameraMetaMaxLength),
        tags: sanitizeTags(Array.isArray(raw.tags) ? raw.tags.map(String) : []),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
        diskFileName,
        posterFileName,
      };
      try {
        writeMediaSidecarSync(UPLOADS_DIR, db.media[raw.id]);
      } catch {
        // non-fatal
      }
      touchedAlbumIds.add(parentAlbum.id);
      restoredMedia++;
    }

    if (restoredAlbums > 0 || restoredMedia > 0) {
      for (const albumId of touchedAlbumIds) {
        recalculateAlbumStats(albumId);
      }
      recalculateUserStorage(user.uid);
      persistDb();
    }

    return res.json({ restoredAlbums, restoredMedia });
  });

  // =========================================================================
  // SECURE MEDIA & POSTER STREAMING (HTTP 206 BYTE-RANGE SUPPORT)
  // =========================================================================
  app.get('/api/poster/:mediaId', async (req, res) => {
    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).end();
    const album = db.albums[item.albumId];
    if (!album) return res.status(404).end();

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);
    const decision = canAccessAlbum(album, user, members, { shareToken, unlockedAlbumIds: unlocked });
    if (!decision.allowed) return res.status(403).end();

    let posterFileName = item.posterFileName;
    if (
      item.kind === 'video' &&
      (!posterFileName || !fs.existsSync(path.join(POSTERS_DIR, posterFileName)))
    ) {
      const ok = await ensureVideoPoster(item);
      if (ok) {
        posterFileName = item.posterFileName;
        persistDb();
      }
    }

    if (!posterFileName) return res.status(404).end();
    const fullPath = path.join(POSTERS_DIR, posterFileName);
    if (!fs.existsSync(fullPath)) return res.status(404).end();
    res.setHeader(
      'Cache-Control',
      album.visibility === 'public' ? 'public, max-age=86400' : 'private, max-age=3600'
    );
    return res.sendFile(fullPath);
  });

  app.get('/api/media/:mediaId', (req, res) => {
    const item = db.media[req.params.mediaId];
    if (!item || !item.diskFileName) return res.status(404).json({ error: 'Media file not found.' });

    const album = db.albums[item.albumId];
    if (!album) return res.status(404).json({ error: 'Parent album not found.' });

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);

    const decision = canAccessAlbum(album, user, members, {
      shareToken,
      unlockedAlbumIds: unlocked,
    });
    if (!decision.allowed) {
      return res.status(403).json({ error: 'Access denied to private media.' });
    }

    const wantsDownload = req.query.download === '1' || req.query.download === 'true';
    if (wantsDownload && !decision.canDownload) {
      return res.status(403).json({ error: 'Original file downloads are disabled for this album.' });
    }

    const fullPath = path.join(UPLOADS_DIR, item.diskFileName);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Media binary is unavailable.' });
    }

    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;
    const contentType = item.mimeType || 'application/octet-stream';

    if (wantsDownload) {
      const safeName = item.fileName.replace(/["\\\r\n]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    const range = req.headers.range;
    if (range && fileSize > 0) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 8 * 1024 * 1024 - 1, fileSize - 1);
      if (Number.isNaN(start) || start < 0 || start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': album.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store',
      });
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': album.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store',
    });
    return fs.createReadStream(fullPath).pipe(res);
  });

  app.patch('/api/media/:mediaId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const currentAlbum = db.albums[item.albumId];
    const isAuthorized = item.ownerId === user.uid || currentAlbum?.ownerId === user.uid;
    if (!isAuthorized) {
      return res.status(403).json({ error: 'You do not have permission to edit this media item.' });
    }

    if (req.body?.title !== undefined) {
      const nextTitle = String(req.body.title).trim();
      if (!nextTitle) return res.status(400).json({ error: 'Title cannot be empty.' });
      item.title = nextTitle.slice(0, BLUEPRINT_LIMITS.mediaTitleMaxLength);
    }
    if (req.body?.caption !== undefined) {
      item.caption = String(req.body.caption).trim().slice(0, BLUEPRINT_LIMITS.captionMaxLength);
    }
    if (req.body?.cameraMeta !== undefined) {
      item.cameraMeta = String(req.body.cameraMeta).trim().slice(0, BLUEPRINT_LIMITS.cameraMetaMaxLength);
    }
    if (Array.isArray(req.body?.tags)) {
      item.tags = sanitizeTags(req.body.tags.map(String));
    }

    if (typeof req.body?.albumId === 'string' && req.body.albumId !== item.albumId) {
      const targetAlbum = db.albums[req.body.albumId];
      if (!targetAlbum || targetAlbum.ownerId !== user.uid) {
        return res.status(403).json({ error: 'You can only move media into an album you own.' });
      }
      const oldAlbumId = item.albumId;
      item.albumId = targetAlbum.id;
      item.albumVisibility = targetAlbum.visibility;
      recalculateAlbumStats(oldAlbumId);
      recalculateAlbumStats(targetAlbum.id);
    }

    item.updatedAt = new Date().toISOString();
    if (item.diskFileName) {
      try {
        writeMediaSidecarSync(UPLOADS_DIR, item);
      } catch {
        // non-fatal
      }
    }
    persistDb();
    return res.json({ media: toPublicMedia(item) });
  });

  app.delete('/api/media/:mediaId', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const album = db.albums[item.albumId];
    if (item.ownerId !== user.uid && album?.ownerId !== user.uid) {
      return res.status(403).json({ error: 'You do not have permission to delete this item.' });
    }

    if (item.diskFileName) {
      await safeUnlink(path.join(UPLOADS_DIR, item.diskFileName));
    }
    if (item.posterFileName) {
      await safeUnlink(path.join(POSTERS_DIR, item.posterFileName));
    }
    await deleteMediaSidecar(UPLOADS_DIR, item.id);

    const albumId = item.albumId;
    const ownerId = item.ownerId;
    delete db.comments[item.id];
    delete db.media[item.id];
    recalculateAlbumStats(albumId);
    recalculateUserStorage(ownerId);
    persistDb();

    return res.json({ ok: true });
  });

  // =========================================================================
  // PHOTO & VIDEO COMMENTS (PERSISTED + LIVE WEBSOCKET BROADCAST)
  // =========================================================================
  function enrichComment(c: MediaComment): MediaComment {
    const author = db.users[c.authorId];
    if (!author) return c;
    return {
      ...c,
      authorName: author.displayName,
      authorHandle: author.handle,
      authorAvatarUrl: author.avatarUrl || '',
    };
  }

  app.get('/api/media/:mediaId/comments', (req, res) => {
    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const album = db.albums[item.albumId];
    if (!album) return res.status(404).json({ error: 'Parent album not found.' });

    const user = getSessionUser(req);
    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);
    const decision = canAccessAlbum(album, user, members, { shareToken, unlockedAlbumIds: unlocked });
    if (!decision.allowed) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const list = (db.comments[item.id] || []).map(enrichComment);
    return res.json({ comments: list });
  });

  app.post('/api/media/:mediaId/comments', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required to post a comment.' });

    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const album = db.albums[item.albumId];
    if (!album) return res.status(404).json({ error: 'Parent album not found.' });

    const members = db.members[album.id] || [];
    const shareToken = typeof req.query.share === 'string' ? req.query.share : undefined;
    const unlocked = getUnlockedAlbums(req);
    const decision = canAccessAlbum(album, user, members, { shareToken, unlockedAlbumIds: unlocked });
    if (!decision.allowed) {
      return res.status(403).json({ error: 'You do not have permission to comment on this media.' });
    }

    const check = validateCommentBody(String(req.body?.body || ''));
    if (!check.valid) {
      return res.status(400).json({ error: check.error });
    }

    const comment: MediaComment = {
      id: generateSafeId('cmt'),
      mediaId: item.id,
      albumId: album.id,
      authorId: user.uid,
      authorName: user.displayName,
      authorHandle: user.handle,
      authorAvatarUrl: user.avatarUrl || '',
      body: check.body,
      createdAt: new Date().toISOString(),
    };

    if (!db.comments[item.id]) db.comments[item.id] = [];
    db.comments[item.id].push(comment);
    persistDb();

    broadcastAll({ type: 'comment:created', mediaId: item.id, comment });
    return res.status(201).json({ comment });
  });

  app.delete('/api/media/:mediaId/comments/:commentId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const item = db.media[req.params.mediaId];
    if (!item) return res.status(404).json({ error: 'Media item not found.' });

    const list = db.comments[item.id] || [];
    const idx = list.findIndex((c) => c.id === req.params.commentId);
    if (idx === -1) return res.status(404).json({ error: 'Comment not found.' });

    const target = list[idx];
    const album = db.albums[item.albumId];
    const canDelete =
      target.authorId === user.uid || album?.ownerId === user.uid || Boolean(user.isAdmin);
    if (!canDelete) {
      return res.status(403).json({ error: 'You do not have permission to delete this comment.' });
    }

    list.splice(idx, 1);
    db.comments[item.id] = list;
    persistDb();

    broadcastAll({ type: 'comment:deleted', mediaId: item.id, commentId: target.id });
    return res.json({ ok: true });
  });

  // =========================================================================
  // USER DIRECTORY & REAL-TIME DIRECT MESSAGING (CHAT)
  // =========================================================================
  function enrichMessage(msg: ChatMessage): ChatMessage {
    const sender = db.users[msg.senderId];
    if (!sender) return msg;
    return {
      ...msg,
      senderName: sender.displayName,
      senderHandle: sender.handle,
      senderAvatarUrl: sender.avatarUrl || '',
    };
  }

  app.get('/api/users/directory', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const onlineSet = new Set(getOnlineUserIds());
    const users = Object.values(db.users)
      .filter((u) => u.uid !== user.uid)
      .sort((a, b) => {
        const aOnline = onlineSet.has(a.uid) ? 1 : 0;
        const bOnline = onlineSet.has(b.uid) ? 1 : 0;
        if (bOnline !== aOnline) return bOnline - aOnline;
        return a.displayName.localeCompare(b.displayName);
      })
      .map((u) => toPublicUserSummary(u, onlineSet.has(u.uid)));

    return res.json({ users });
  });

  app.get('/api/messages/conversations', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const onlineSet = new Set(getOnlineUserIds());
    const conversations: ChatConversation[] = [];
    let unreadTotal = 0;

    for (const [conversationId, rawMessages] of Object.entries(db.messages)) {
      if (!rawMessages || rawMessages.length === 0) continue;
      const sample = rawMessages[0];
      if (sample.senderId !== user.uid && sample.recipientId !== user.uid) continue;

      const otherUid = sample.senderId === user.uid ? sample.recipientId : sample.senderId;
      const other = db.users[otherUid];
      if (!other) continue;

      const unreadCount = rawMessages.filter(
        (m) => m.recipientId === user.uid && !m.readAt
      ).length;
      unreadTotal += unreadCount;

      const lastMessage = enrichMessage(rawMessages[rawMessages.length - 1]);
      conversations.push({
        id: conversationId,
        participantIds: [user.uid, otherUid],
        otherUser: toPublicUserSummary(other, onlineSet.has(otherUid)),
        lastMessage,
        unreadCount,
        updatedAt: lastMessage.createdAt,
      });
    }

    conversations.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return res.json({ conversations, unreadTotal });
  });

  app.get('/api/messages/:otherUid', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const other = db.users[req.params.otherUid];
    if (!other) return res.status(404).json({ error: 'User not found.' });
    if (other.uid === user.uid) {
      return res.status(400).json({ error: 'Choose another user to message.' });
    }

    const conversationId = buildConversationId(user.uid, other.uid);
    const list = db.messages[conversationId] || [];

    // Mark incoming messages as read
    const now = new Date().toISOString();
    let markedAny = false;
    for (const msg of list) {
      if (msg.recipientId === user.uid && !msg.readAt) {
        msg.readAt = now;
        markedAny = true;
      }
    }
    if (markedAny) {
      persistDb();
      sendToUser(other.uid, {
        type: 'chat:read',
        conversationId,
        readerId: user.uid,
        readAt: now,
      });
    }

    const onlineSet = new Set(getOnlineUserIds());
    return res.json({
      conversationId,
      otherUser: toPublicUserSummary(other, onlineSet.has(other.uid)),
      messages: list.map(enrichMessage),
    });
  });

  app.post('/api/messages/:otherUid', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required to send messages.' });

    const other = db.users[req.params.otherUid];
    if (!other) return res.status(404).json({ error: 'Recipient user not found.' });
    if (other.uid === user.uid) {
      return res.status(400).json({ error: 'You cannot send a direct message to yourself.' });
    }

    const check = validateMessageBody(String(req.body?.body || ''));
    if (!check.valid) {
      return res.status(400).json({ error: check.error });
    }

    const conversationId = buildConversationId(user.uid, other.uid);
    const message: ChatMessage = {
      id: generateSafeId('msg'),
      conversationId,
      senderId: user.uid,
      senderName: user.displayName,
      senderHandle: user.handle,
      senderAvatarUrl: user.avatarUrl || '',
      recipientId: other.uid,
      body: check.body,
      createdAt: new Date().toISOString(),
    };

    if (!db.messages[conversationId]) db.messages[conversationId] = [];
    db.messages[conversationId].push(message);
    persistDb();

    // Real-time WebSocket push to both recipient and sender's connected clients
    sendToUser(other.uid, { type: 'chat:message', message });
    sendToUser(user.uid, { type: 'chat:message', message });

    return res.status(201).json({ message });
  });

  app.post('/api/messages/:otherUid/read', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });

    const other = db.users[req.params.otherUid];
    if (!other) return res.status(404).json({ error: 'User not found.' });

    const conversationId = buildConversationId(user.uid, other.uid);
    const list = db.messages[conversationId] || [];
    const now = new Date().toISOString();
    let markedAny = false;
    for (const msg of list) {
      if (msg.recipientId === user.uid && !msg.readAt) {
        msg.readAt = now;
        markedAny = true;
      }
    }
    if (markedAny) {
      persistDb();
      sendToUser(other.uid, {
        type: 'chat:read',
        conversationId,
        readerId: user.uid,
        readAt: now,
      });
    }
    return res.json({ ok: true });
  });

  // =========================================================================
  // VITE DEV MIDDLEWARE / PRODUCTION STATIC SERVING
  // =========================================================================
  let viteInstance: { close: () => Promise<void> } | null = null;
  const distDir = path.join(ROOT_DIR, 'dist');
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    (process.env.NODE_ENV !== 'development' && fs.existsSync(path.join(distDir, 'index.html')));

  if (!isProduction) {
    const disableHmr = process.env.DISABLE_HMR === 'true';

    // When HMR is disabled in AI Studio, serve a clean no-WebSocket /@vite/client shim
    // so CSS style injection works normally without throwing unhandled WebSocket errors on port 24678.
    if (disableHmr) {
      const NO_HMR_VITE_CLIENT_JS = `
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== '.' && url[0] !== '/') return url;
  const pathname = url.replace(/[?#].*$/, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
export class ErrorOverlay extends HTMLElement {}
`.trimStart();

      app.get('/@vite/client', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(NO_HMR_VITE_CLIENT_JS);
      });
    }

    const viteReady = import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({
        server: {
          middlewareMode: true,
          hmr: disableHmr ? false : { server: httpServer },
          ws: disableHmr ? false : undefined,
          watch: disableHmr ? null : undefined,
        },
        appType: 'spa',
      })
    );

    viteReady
      .then((vite) => {
        viteInstance = vite;
      })
      .catch((err) => {
        console.error('Vite middleware initialization failed:', err);
      });

    app.use((req, res, next) => {
      viteReady
        .then((vite) => {
          vite.middlewares(req, res, next);
        })
        .catch((err) => {
          next(err);
        });
    });
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  shutdownCallbacks.push(async () => {
    for (const ws of allSockets) {
      try {
        ws.terminate();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    try {
      wss.close();
    } catch {
      // Ignore close errors during shutdown
    }
    if (viteInstance) {
      await viteInstance.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  const { port: PORT, host: HOST } = resolveServerListenConfig();
  httpServer.on('error', (err) => {
    console.error(`HTTP server failed on ${HOST}:${PORT}:`, err);
    process.exit(1);
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`Big B’z Leaks media & WebSocket server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
