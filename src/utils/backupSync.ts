export interface LocalBackupMeta {
  mediaId: string;
  albumId: string;
  ownerId: string;
  title: string;
  caption: string;
  cameraMeta: string;
  tags: string[];
  fileName: string;
  mimeType: string;
  fileSize: number;
  width: number;
  height: number;
  durationSec: number;
  createdAt: string;
  posterDataUrl?: string;
}

const PREFERRED_MEDIA_ID_RE = /^med_[a-zA-Z0-9_-]{4,64}$/;
const API_MEDIA_OR_POSTER_RE = /^\/api\/(?:media|poster)\/(med_[a-zA-Z0-9_-]+)/;

/**
 * Validates an optional client-supplied preferred media ID used when
 * self-healing restores a backed-up file after a preview server disk reset.
 */
export function validatePreferredMediaId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!PREFERRED_MEDIA_ID_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Extracts a `med_...` media ID from a local `/api/media/:id` or `/api/poster/:id` URL.
 */
export function extractMediaIdFromApiUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0].split('#')[0];
  const match = API_MEDIA_OR_POSTER_RE.exec(clean);
  return match ? match[1] : null;
}

/**
 * Identifies locally backed-up media items belonging to `ownerId` whose parent album
 * still exists on the server but whose media binary/record is missing on the server.
 * Returned oldest-first so restored album ordering stays consistent.
 */
export function findMissingBackedUpMedia<T extends LocalBackupMeta>(
  cachedRecords: T[],
  serverAlbumIds: Iterable<string>,
  serverMediaIds: Iterable<string>,
  ownerId: string
): T[] {
  if (!ownerId) return [];
  const albumSet = new Set(serverAlbumIds);
  const mediaSet = new Set(serverMediaIds);

  return cachedRecords
    .filter(
      (record) =>
        record.ownerId === ownerId &&
        albumSet.has(record.albumId) &&
        !mediaSet.has(record.mediaId) &&
        record.fileSize >= 0
    )
    .sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime() || 0;
      const tb = new Date(b.createdAt || 0).getTime() || 0;
      return ta - tb;
    });
}
