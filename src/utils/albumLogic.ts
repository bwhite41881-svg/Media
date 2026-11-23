import type {
  Album,
  AlbumAccessDecision,
  AlbumMember,
  AlbumVisibility,
  BatchUploadStats,
  MediaItem,
  MediaKind,
  SiteSettings,
  UploadChunkPlan,
  UploadItemStatus,
} from '../types/media';

export const BLUEPRINT_LIMITS = {
  idMaxLength: 128,
  idPattern: /^[a-zA-Z0-9_-]+$/,
  displayNameMaxLength: 80,
  handleMinLength: 2,
  handleMaxLength: 40,
  handlePattern: /^[a-z0-9_.-]+$/,
  bioMaxLength: 280,
  albumTitleMaxLength: 120,
  descriptionMaxLength: 600,
  mediaTitleMaxLength: 140,
  captionMaxLength: 600,
  cameraMetaMaxLength: 160,
  maxTags: 10,
  tagMaxLength: 40,
  shareTokenMaxLength: 64,
  siteNameMaxLength: 80,
  heroKickerMaxLength: 60,
  heroHeadlineMaxLength: 160,
  heroSubheadlineMaxLength: 400,
  footerTextMaxLength: 240,
  announcementTextMaxLength: 240,
  commentMaxLength: 600,
  messageMaxLength: 1000,
  accentHexPattern: /^#[0-9a-fA-F]{6}$/,
} as const;

export const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB chunks for unlimited-size streaming

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: 'Big B’z Leaks',
  heroKicker: 'Unlimited Media Vault',
  heroHeadline: 'Upload 5,000+ photos and full-length videos with zero caps.',
  heroSubheadline:
    'Drop entire folders or multi-gigabyte video masters into private vaults, passcode-locked share links, or public galleries.',
  footerText: 'Big B’z Leaks — Unlimited photo & video archive with private and public album control.',
  accentColor: '#00B84C',
  themeMode: 'dark',
  announcementEnabled: false,
  announcementText: '',
  allowRegistrations: true,
  defaultAlbumVisibility: 'private',
  defaultAllowDownloads: true,
  uploadConcurrency: 6,
  chunkSizeMb: 4,
  updatedAt: '2026-11-18T00:00:00.000Z',
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  if (exponent === 0) return `${Math.round(value)} B`;
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[exponent]}`;
}

export function formatTransferSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

export function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Computes chunk byte ranges for any file size (zero artificial file size cap).
 * For extremely large files (> 100 GB), use computeChunkCount / getChunkRange
 * so memory stays O(1) without materializing a massive chunk array.
 */
export function computeChunkCount(
  fileSize: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE_BYTES
): number {
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    throw new Error('File size must be a non-negative finite number.');
  }
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error('Chunk size must be positive.');
  }
  if (fileSize === 0) return 1;
  return Math.ceil(fileSize / chunkSize);
}

export function getChunkRange(
  fileSize: number,
  chunkIndex: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE_BYTES
): { index: number; start: number; end: number; size: number } {
  const totalChunks = computeChunkCount(fileSize, chunkSize);
  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new RangeError(`Chunk index ${chunkIndex} out of bounds [0, ${totalChunks - 1}]`);
  }
  const start = chunkIndex * chunkSize;
  const end = Math.min(start + chunkSize, fileSize);
  return { index: chunkIndex, start, end, size: end - start };
}

export function planUploadChunks(
  fileSize: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE_BYTES
): UploadChunkPlan {
  const totalChunks = computeChunkCount(fileSize, chunkSize);
  const chunks: UploadChunkPlan['chunks'] = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push(getChunkRange(fileSize, i, chunkSize));
  }
  return { chunkSize, totalChunks, chunks };
}

/**
 * Computes aggregate batch metrics in a single O(N) pass so 5,000+ file queues
 * stay responsive on every render.
 */
export function computeBatchStats(
  items: ReadonlyArray<{
    status: UploadItemStatus;
    uploadedBytes: number;
    totalBytes: number;
    speedBytesPerSec: number;
  }>
): BatchUploadStats {
  let queuedCount = 0;
  let activeCount = 0;
  let pausedCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  let totalBytes = 0;
  let uploadedBytes = 0;
  let combinedSpeedBytesPerSec = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.status === 'cancelled') continue;
    totalBytes += Math.max(0, item.totalBytes || 0);
    if (item.status === 'done') {
      doneCount++;
      uploadedBytes += Math.max(0, item.totalBytes || 0);
    } else if (item.status === 'uploading' || item.status === 'finalizing') {
      activeCount++;
      uploadedBytes += Math.min(Math.max(0, item.uploadedBytes || 0), Math.max(0, item.totalBytes || 0));
      combinedSpeedBytesPerSec += Math.max(0, item.speedBytesPerSec || 0);
    } else if (item.status === 'paused') {
      pausedCount++;
      uploadedBytes += Math.min(Math.max(0, item.uploadedBytes || 0), Math.max(0, item.totalBytes || 0));
    } else if (item.status === 'error') {
      errorCount++;
    } else {
      queuedCount++;
    }
  }

  const totalCount = queuedCount + activeCount + pausedCount + doneCount + errorCount;
  let overallPercent = 0;
  if (totalBytes > 0) {
    overallPercent = Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
  } else if (totalCount > 0) {
    overallPercent = Math.min(100, Math.round((doneCount / totalCount) * 100));
  }

  const remainingBytes = Math.max(0, totalBytes - uploadedBytes);
  const etaSeconds =
    combinedSpeedBytesPerSec > 0 && remainingBytes > 0
      ? remainingBytes / combinedSpeedBytesPerSec
      : null;

  return {
    totalCount,
    queuedCount,
    activeCount,
    pausedCount,
    doneCount,
    errorCount,
    totalBytes,
    uploadedBytes,
    combinedSpeedBytesPerSec,
    overallPercent,
    etaSeconds,
  };
}

/**
 * Pure concurrent worker pool supporting 5,000+ queued tasks with bounded parallelism,
 * dynamic pull-based scheduling, and cooperative stop/pause signals.
 */
export async function runConcurrentPool<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<{ processed: number }> {
  const safeConcurrency = Math.max(1, Math.min(Math.floor(concurrency) || 1, 32));
  let cursor = 0;
  let processed = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (shouldStop?.()) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
      processed++;
    }
  }

  const workerCount = Math.min(safeConcurrency, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return { processed };
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg',
  'ogv', '3gp', 'ts', 'mts', 'm2ts', 'prores', 'r3d', 'braw',
]);

export function classifyMediaKind(mimeType: string, fileName: string): MediaKind {
  const lowerMime = (mimeType || '').toLowerCase();
  if (lowerMime.startsWith('video/')) return 'video';
  if (lowerMime.startsWith('image/')) return 'photo';
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'photo';
}

export function sanitizeHandle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BLUEPRINT_LIMITS.handleMaxLength);
  return cleaned.length >= BLUEPRINT_LIMITS.handleMinLength ? cleaned : `creator-${cleaned || 'user'}`;
}

export function generateSafeId(prefix: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'id';
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${cleanPrefix}_${randomPart}`;
}

export function validateAlbumInput(input: {
  title: string;
  description?: string;
  visibility: AlbumVisibility;
  passcode?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const title = (input.title || '').trim();
  if (title.length < 1) {
    errors.push('Album title is required.');
  } else if (title.length > BLUEPRINT_LIMITS.albumTitleMaxLength) {
    errors.push(`Album title must be ${BLUEPRINT_LIMITS.albumTitleMaxLength} characters or fewer.`);
  }
  const description = (input.description || '').trim();
  if (description.length > BLUEPRINT_LIMITS.descriptionMaxLength) {
    errors.push(`Description must be ${BLUEPRINT_LIMITS.descriptionMaxLength} characters or fewer.`);
  }
  if (!['private', 'unlisted', 'public'].includes(input.visibility)) {
    errors.push('Visibility must be private, unlisted, or public.');
  }
  if (input.passcode && input.passcode.length > 0 && input.passcode.length < 4) {
    errors.push('Passcode must be at least 4 characters long.');
  }
  return { valid: errors.length === 0, errors };
}

export function validateSiteSettings(
  input: Partial<SiteSettings>
): { valid: boolean; errors: string[]; normalized: Omit<SiteSettings, 'updatedAt'> } {
  const errors: string[] = [];
  const siteName = String(input.siteName ?? DEFAULT_SITE_SETTINGS.siteName).trim();
  const heroKicker = String(input.heroKicker ?? DEFAULT_SITE_SETTINGS.heroKicker).trim();
  const heroHeadline = String(input.heroHeadline ?? DEFAULT_SITE_SETTINGS.heroHeadline).trim();
  const heroSubheadline = String(
    input.heroSubheadline ?? DEFAULT_SITE_SETTINGS.heroSubheadline
  ).trim();
  const footerText = String(input.footerText ?? DEFAULT_SITE_SETTINGS.footerText).trim();
  const accentColor = String(input.accentColor ?? DEFAULT_SITE_SETTINGS.accentColor).trim();
  const themeMode = input.themeMode === 'dark' ? 'dark' : 'light';
  const announcementEnabled = Boolean(input.announcementEnabled ?? false);
  const announcementText = String(input.announcementText ?? '').trim();
  const allowRegistrations = Boolean(input.allowRegistrations ?? true);
  const defaultAlbumVisibility: AlbumVisibility =
    input.defaultAlbumVisibility === 'public' ||
    input.defaultAlbumVisibility === 'unlisted' ||
    input.defaultAlbumVisibility === 'private'
      ? input.defaultAlbumVisibility
      : 'private';
  const defaultAllowDownloads = Boolean(input.defaultAllowDownloads ?? true);
  const uploadConcurrency = Math.round(Number(input.uploadConcurrency ?? 6));
  const chunkSizeMb = Math.round(Number(input.chunkSizeMb ?? 4));

  if (siteName.length < 1 || siteName.length > BLUEPRINT_LIMITS.siteNameMaxLength) {
    errors.push(`Site name must be between 1 and ${BLUEPRINT_LIMITS.siteNameMaxLength} characters.`);
  }
  if (heroKicker.length > BLUEPRINT_LIMITS.heroKickerMaxLength) {
    errors.push(`Hero kicker must be ${BLUEPRINT_LIMITS.heroKickerMaxLength} characters or fewer.`);
  }
  if (heroHeadline.length < 1 || heroHeadline.length > BLUEPRINT_LIMITS.heroHeadlineMaxLength) {
    errors.push(`Hero headline must be between 1 and ${BLUEPRINT_LIMITS.heroHeadlineMaxLength} characters.`);
  }
  if (heroSubheadline.length > BLUEPRINT_LIMITS.heroSubheadlineMaxLength) {
    errors.push(`Hero description must be ${BLUEPRINT_LIMITS.heroSubheadlineMaxLength} characters or fewer.`);
  }
  if (footerText.length > BLUEPRINT_LIMITS.footerTextMaxLength) {
    errors.push(`Footer text must be ${BLUEPRINT_LIMITS.footerTextMaxLength} characters or fewer.`);
  }
  if (!BLUEPRINT_LIMITS.accentHexPattern.test(accentColor)) {
    errors.push('Accent color must be a valid 6-digit hex color (for example #1d4ed8).');
  }
  if (announcementText.length > BLUEPRINT_LIMITS.announcementTextMaxLength) {
    errors.push(
      `Announcement text must be ${BLUEPRINT_LIMITS.announcementTextMaxLength} characters or fewer.`
    );
  }
  if (!Number.isFinite(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 16) {
    errors.push('Upload concurrency must be between 1 and 16 parallel files.');
  }
  if (!Number.isFinite(chunkSizeMb) || chunkSizeMb < 1 || chunkSizeMb > 64) {
    errors.push('Chunk size must be between 1 MiB and 64 MiB.');
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      siteName,
      heroKicker,
      heroHeadline,
      heroSubheadline,
      footerText,
      accentColor: BLUEPRINT_LIMITS.accentHexPattern.test(accentColor)
        ? accentColor
        : DEFAULT_SITE_SETTINGS.accentColor,
      themeMode,
      announcementEnabled,
      announcementText,
      allowRegistrations,
      defaultAlbumVisibility,
      defaultAllowDownloads,
      uploadConcurrency: Math.max(1, Math.min(16, uploadConcurrency || 6)),
      chunkSizeMb: Math.max(1, Math.min(64, chunkSizeMb || 4)),
    },
  };
}

export function sanitizeTags(rawTags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of rawTags) {
    const cleaned = tag.trim().slice(0, BLUEPRINT_LIMITS.tagMaxLength);
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase());
      out.push(cleaned);
    }
    if (out.length >= BLUEPRINT_LIMITS.maxTags) break;
  }
  return out;
}

export function canAccessAlbum(
  album: Pick<Album, 'id' | 'ownerId' | 'visibility' | 'allowDownloads' | 'shareToken' | 'hasPasscode'>,
  viewer: { uid: string; email?: string; isAdmin?: boolean } | null,
  members: Array<Pick<AlbumMember, 'uid' | 'email' | 'role'>> = [],
  options: { shareToken?: string | null; unlockedAlbumIds?: ReadonlySet<string> } = {}
): AlbumAccessDecision {
  // 1. Owner always has full control
  if (viewer && viewer.uid === album.ownerId) {
    return {
      allowed: true,
      reason: 'owner',
      canEdit: true,
      canUpload: true,
      canDownload: true,
    };
  }

  // 2. Explicit collaborator match (by UID or verified email)
  if (viewer) {
    const member = members.find(
      (m) =>
        (m.uid && m.uid === viewer.uid) ||
        (viewer.email && m.email && m.email.toLowerCase() === viewer.email.toLowerCase())
    );
    if (member) {
      return {
        allowed: true,
        reason: 'collaborator',
        canEdit: false,
        canUpload: member.role === 'contributor',
        canDownload: album.allowDownloads || member.role === 'contributor',
      };
    }
  }

  // 3. Public albums are openly viewable
  if (album.visibility === 'public') {
    return {
      allowed: true,
      reason: 'public',
      canEdit: false,
      canUpload: false,
      canDownload: album.allowDownloads,
    };
  }

  // 4. Share token verification (for unlisted OR explicitly link-shared private albums)
  const providedToken = (options.shareToken || '').trim();
  const hasValidToken = Boolean(album.shareToken && providedToken && providedToken === album.shareToken);

  if (hasValidToken) {
    if (album.hasPasscode && !options.unlockedAlbumIds?.has(album.id)) {
      return {
        allowed: false,
        reason: 'passcode_required',
        canEdit: false,
        canUpload: false,
        canDownload: false,
      };
    }
    return {
      allowed: true,
      reason: 'share_link',
      canEdit: false,
      canUpload: false,
      canDownload: album.allowDownloads,
    };
  }

  // 5. Default deny
  return {
    allowed: false,
    reason: 'denied',
    canEdit: false,
    canUpload: false,
    canDownload: false,
  };
}

/**
 * Splits a search query into normalized lowercase tokens.
 * Tokens prefixed with '#' specifically match tags; plain tokens match title, description, tags, and metadata.
 */
export function parseSearchTokens(query: string): Array<{ raw: string; term: string; tagOnly: boolean }> {
  return (query || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const tagOnly = raw.startsWith('#');
      const term = (tagOnly ? raw.slice(1) : raw).trim().toLowerCase();
      return { raw, term, tagOnly };
    })
    .filter((token) => token.term.length > 0);
}

export type SearchMatchMode = 'all' | 'title' | 'tag';

export function filterAlbumsByQuery<
  T extends Pick<Album, 'title' | 'description' | 'ownerName' | 'ownerHandle' | 'visibility' | 'tags'>
>(
  albums: ReadonlyArray<T>,
  query: string,
  visibility: 'all' | AlbumVisibility = 'all',
  mode: SearchMatchMode = 'all'
): T[] {
  const tokens = parseSearchTokens(query);
  return albums.filter((album) => {
    if (visibility !== 'all' && album.visibility !== visibility) return false;
    if (tokens.length === 0) return true;

    const tagsLower = (album.tags || []).map((t) => t.toLowerCase());
    const titleLower = (album.title || '').toLowerCase();
    const haystack = [
      album.title,
      album.description,
      album.ownerName,
      album.ownerHandle,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return tokens.every(({ term, tagOnly }) => {
      if (tagOnly || mode === 'tag') {
        return tagsLower.some((tag) => tag.includes(term));
      }
      if (mode === 'title') {
        return titleLower.includes(term);
      }
      return haystack.includes(term) || tagsLower.some((tag) => tag.includes(term));
    });
  });
}

export function filterMediaByQuery<
  T extends Pick<MediaItem, 'title' | 'caption' | 'ownerName' | 'albumTitle' | 'kind' | 'tags'>
>(
  media: ReadonlyArray<T>,
  query: string,
  kind: 'all' | MediaKind = 'all',
  mode: SearchMatchMode = 'all'
): T[] {
  const tokens = parseSearchTokens(query);
  return media.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (tokens.length === 0) return true;

    const tagsLower = (item.tags || []).map((t) => t.toLowerCase());
    const titleLower = (item.title || '').toLowerCase();
    const haystack = [
      item.title,
      item.caption,
      item.ownerName,
      item.albumTitle || '',
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return tokens.every(({ term, tagOnly }) => {
      if (tagOnly || mode === 'tag') {
        return tagsLower.some((tag) => tag.includes(term));
      }
      if (mode === 'title') {
        return titleLower.includes(term);
      }
      return haystack.includes(term) || tagsLower.some((tag) => tag.includes(term));
    });
  });
}

/**
 * Extracts the most frequent unique tags across albums and/or media items for quick-filter buttons.
 */
export function extractPopularTags(
  albums: ReadonlyArray<Pick<Album, 'tags'>>,
  media: ReadonlyArray<Pick<MediaItem, 'tags'>> = [],
  limit = 8
): string[] {
  const counts = new Map<string, { label: string; count: number }>();

  const record = (tag: string) => {
    const cleaned = tag.trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { label: cleaned, count: 1 });
    }
  };

  for (const album of albums) {
    for (const tag of album.tags || []) record(tag);
  }
  for (const item of media) {
    for (const tag of item.tags || []) record(tag);
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.label);
}

/**
 * Pure virtual list window calculation so a 5,000-file batch queue scrolls smoothly at 60fps.
 */
export function computeVirtualWindow(params: {
  totalItems: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
}): { startIndex: number; endIndex: number; totalHeight: number } {
  const totalItems = Math.max(0, Math.floor(params.totalItems));
  const rowHeight = Math.max(1, params.rowHeight);
  const totalHeight = totalItems * rowHeight;
  if (totalItems === 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0 };
  }
  const overscan = Math.max(0, Math.floor(params.overscan ?? 8));
  const safeScrollTop = Math.max(0, Math.min(params.scrollTop, Math.max(0, totalHeight - 1)));
  const safeViewport = Math.max(rowHeight, params.viewportHeight);

  const visibleStart = Math.floor(safeScrollTop / rowHeight);
  const visibleEnd = Math.ceil((safeScrollTop + safeViewport) / rowHeight);

  const startIndex = Math.max(0, visibleStart - overscan);
  const endIndex = Math.min(totalItems, visibleEnd + overscan);

  return { startIndex, endIndex, totalHeight };
}

/**
 * Deterministic 1:1 direct message conversation ID independent of participant order.
 */
export function buildConversationId(uidA: string, uidB: string): string {
  const a = (uidA || '').trim();
  const b = (uidB || '').trim();
  if (!a || !b) {
    throw new Error('Both participant IDs are required to create a conversation.');
  }
  const [first, second] = a < b ? [a, b] : [b, a];
  return `dm_${first}__${second}`;
}

export function validateCommentBody(raw: string): { valid: boolean; body: string; error?: string } {
  const body = (raw || '').trim();
  if (body.length < 1) {
    return { valid: false, body: '', error: 'Comment cannot be empty.' };
  }
  if (body.length > BLUEPRINT_LIMITS.commentMaxLength) {
    return {
      valid: false,
      body,
      error: `Comment must be ${BLUEPRINT_LIMITS.commentMaxLength} characters or fewer.`,
    };
  }
  return { valid: true, body };
}

export function validateMessageBody(raw: string): { valid: boolean; body: string; error?: string } {
  const body = (raw || '').trim();
  if (body.length < 1) {
    return { valid: false, body: '', error: 'Message cannot be empty.' };
  }
  if (body.length > BLUEPRINT_LIMITS.messageMaxLength) {
    return {
      valid: false,
      body,
      error: `Message must be ${BLUEPRINT_LIMITS.messageMaxLength} characters or fewer.`,
    };
  }
  return { valid: true, body };
}

/**
 * Idempotent event merge helper: appends an item only if its ID is not already present,
 * preventing duplicates across WebSocket reconnects and optimistic sends.
 */
export function mergeUniqueById<T extends { id: string }>(
  existing: ReadonlyArray<T>,
  incoming: T
): T[] {
  if (existing.some((item) => item.id === incoming.id)) {
    return existing.map((item) => (item.id === incoming.id ? incoming : item));
  }
  return [...existing, incoming];
}

export function formatRelativeTime(isoString: string, nowMs: number = Date.now()): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
  if (diffSec < 45) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`;
  return formatRelativeDate(isoString);
}

/**
 * Determines whether a failed chunk or upload-complete request should be retried.
 * Aborted requests and deterministic 4xx client errors (except 408/429) fail immediately.
 */
export function shouldRetryUploadRequest(
  statusCode: number | undefined,
  isAborted: boolean
): boolean {
  if (isAborted) return false;
  if (statusCode === undefined) return true; // network/connection reset
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

/**
 * Matches a stored upload filename in data/uploads/ (e.g. "med_abc123.mp4" or "med_abc123")
 * for an exact mediaId without prefix collisions.
 */
export function matchDiskFileForMediaId(
  mediaId: string,
  diskFiles: ReadonlyArray<string>
): string | null {
  const cleanId = (mediaId || '').trim();
  if (!cleanId || !BLUEPRINT_LIMITS.idPattern.test(cleanId)) return null;
  const prefix = `${cleanId}.`;
  for (const name of diskFiles) {
    if (name === cleanId || name.startsWith(prefix)) {
      return name;
    }
  }
  return null;
}

/**
 * Replaces or prepends an updated Album inside a list while preserving order for other albums.
 */
export function upsertAlbumInList(
  albums: ReadonlyArray<Album>,
  updated: Album
): Album[] {
  const idx = albums.findIndex((a) => a.id === updated.id);
  if (idx === -1) return [updated, ...albums];
  const next = albums.slice();
  next[idx] = { ...albums[idx], ...updated };
  return next;
}

/**
 * Builds a clean, filesystem-safe `.zip` filename from an album title.
 */
export function buildAlbumZipFilename(albumTitle: string): string {
  const cleaned = (albumTitle || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'album-archive'}.zip`;
}

/**
 * Sanitizes a single media entry filename for inclusion in a ZIP archive,
 * stripping directory traversal, control characters, and reserved characters.
 */
export function sanitizeZipEntryName(rawName: string, fallbackExt = ''): string {
  const base = (rawName || '')
    .replace(/^.*[\\/]/, '')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedFallbackExt =
    fallbackExt && fallbackExt.startsWith('.')
      ? fallbackExt.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12)
      : fallbackExt
        ? `.${fallbackExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 11)}`
        : '';

  if (!base) {
    return `media-file${normalizedFallbackExt}`;
  }

  const hasExt = /\.[a-zA-Z0-9]{1,10}$/.test(base);
  const clipped = base.slice(0, 140);
  if (hasExt || !normalizedFallbackExt) {
    return clipped;
  }
  return `${clipped}${normalizedFallbackExt}`;
}

/**
 * Produces unique, collision-free ZIP entry filenames for a list of album media items.
 * Duplicate names receive deterministic suffixes such as `photo (2).jpg`.
 */
export function buildUniqueZipEntryNames(
  items: ReadonlyArray<{
    id: string;
    title?: string;
    fileName?: string;
    diskFileName?: string;
  }>
): Array<{ id: string; entryName: string }> {
  const seen = new Map<string, number>();

  return items.map((item) => {
    const diskExtMatch = (item.diskFileName || '').match(/(\.[a-zA-Z0-9]{1,10})$/);
    const fileExtMatch = (item.fileName || '').match(/(\.[a-zA-Z0-9]{1,10})$/);
    const fallbackExt = fileExtMatch?.[1] || diskExtMatch?.[1] || '';

    const preferredSource =
      item.fileName && item.fileName.trim().length > 0
        ? item.fileName
        : item.title && item.title.trim().length > 0
          ? item.title
          : item.id;

    const initialName = sanitizeZipEntryName(preferredSource, fallbackExt);
    const dotIdx = initialName.lastIndexOf('.');
    const stem = dotIdx > 0 ? initialName.slice(0, dotIdx) : initialName;
    const ext = dotIdx > 0 ? initialName.slice(dotIdx) : '';

    let candidate = initialName;
    let key = candidate.toLowerCase();
    let counter = seen.get(key) ?? 0;

    if (counter > 0) {
      let suffix = counter + 1;
      while (seen.has(`${stem} (${suffix})${ext}`.toLowerCase())) {
        suffix += 1;
      }
      candidate = `${stem} (${suffix})${ext}`;
      key = candidate.toLowerCase();
      seen.set(initialName.toLowerCase(), suffix);
    }
    seen.set(key, 1);

    return { id: item.id, entryName: candidate };
  });
}

export const DEFAULT_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB standard creator quota
export const ADMIN_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GiB studio/admin quota

export type StorageQuotaStatus = 'healthy' | 'warning' | 'critical';

export interface StorageQuotaSummary {
  usedBytes: number;
  allocatedBytes: number;
  remainingBytes: number;
  percentUsed: number;
  percentClamped: number;
  percentBarWidth: number;
  percentLabel: string;
  status: StorageQuotaStatus;
  statusLabel: string;
  isOverQuota: boolean;
}

/**
 * Resolves the effective storage allocation for an account.
 */
export function getAllocatedStorageBytes(user: {
  isAdmin?: boolean;
  storageQuotaBytes?: number;
}): number {
  if (
    typeof user.storageQuotaBytes === 'number' &&
    Number.isFinite(user.storageQuotaBytes) &&
    user.storageQuotaBytes > 0
  ) {
    return user.storageQuotaBytes;
  }
  return user.isAdmin ? ADMIN_STORAGE_QUOTA_BYTES : DEFAULT_STORAGE_QUOTA_BYTES;
}

/**
 * Pure storage utilization calculation for AccountView quota indicator & progress bar.
 */
export function computeStorageQuota(
  usedBytes: number,
  allocatedBytes: number = DEFAULT_STORAGE_QUOTA_BYTES
): StorageQuotaSummary {
  const safeUsed =
    typeof usedBytes === 'number' && Number.isFinite(usedBytes) && usedBytes > 0
      ? usedBytes
      : 0;
  const safeAllocated =
    typeof allocatedBytes === 'number' && Number.isFinite(allocatedBytes) && allocatedBytes > 0
      ? allocatedBytes
      : DEFAULT_STORAGE_QUOTA_BYTES;

  const remainingBytes = Math.max(0, safeAllocated - safeUsed);
  const percentUsed = (safeUsed / safeAllocated) * 100;
  const percentClamped = Math.min(100, Math.max(0, Number(percentUsed.toFixed(1))));
  const percentBarWidth =
    safeUsed === 0 ? 0 : Math.min(100, Math.max(1.5, Number(percentUsed.toFixed(2))));

  let percentLabel: string;
  if (safeUsed === 0) {
    percentLabel = '0%';
  } else if (percentUsed < 0.1) {
    percentLabel = '< 0.1%';
  } else if (percentUsed < 10) {
    percentLabel = `${percentUsed.toFixed(1)}%`;
  } else {
    percentLabel = `${Math.min(999, Math.round(percentUsed))}%`;
  }

  let status: StorageQuotaStatus = 'healthy';
  let statusLabel = 'Healthy';
  const isOverQuota = percentUsed >= 100;

  if (isOverQuota) {
    status = 'critical';
    statusLabel = 'Quota Reached';
  } else if (percentUsed >= 90) {
    status = 'critical';
    statusLabel = 'Near Limit';
  } else if (percentUsed >= 70) {
    status = 'warning';
    statusLabel = 'High Usage';
  }

  return {
    usedBytes: safeUsed,
    allocatedBytes: safeAllocated,
    remainingBytes,
    percentUsed,
    percentClamped,
    percentBarWidth,
    percentLabel,
    status,
    statusLabel,
    isOverQuota,
  };
}

/**
 * Aggregates album storage usage by visibility tier for AccountView breakdown display.
 */
export function computeStorageBreakdownByVisibility(
  albums: ReadonlyArray<Pick<Album, 'visibility' | 'totalBytes'>>
): {
  publicBytes: number;
  unlistedBytes: number;
  privateBytes: number;
  totalAlbumBytes: number;
} {
  let publicBytes = 0;
  let unlistedBytes = 0;
  let privateBytes = 0;

  for (const album of albums) {
    const bytes =
      typeof album.totalBytes === 'number' && Number.isFinite(album.totalBytes) && album.totalBytes > 0
        ? album.totalBytes
        : 0;
    if (album.visibility === 'public') publicBytes += bytes;
    else if (album.visibility === 'unlisted') unlistedBytes += bytes;
    else privateBytes += bytes;
  }

  return {
    publicBytes,
    unlistedBytes,
    privateBytes,
    totalAlbumBytes: publicBytes + unlistedBytes + privateBytes,
  };
}
