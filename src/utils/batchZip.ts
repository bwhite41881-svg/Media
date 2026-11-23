import JSZip from 'jszip';
import type { MediaItem } from '../types/media';
import {
  buildAlbumZipFilename,
  buildUniqueZipEntryNames,
  runConcurrentPool,
} from './albumLogic';

export type BatchZipPhase = 'fetching' | 'zipping' | 'done';

export interface BatchZipProgressState {
  phase: BatchZipPhase;
  fetchedCount: number;
  totalCount: number;
  fetchedBytes: number;
  totalBytes: number;
  zipPercent: number;
  overallPercent: number;
  statusText: string;
}

export interface BrowserZipItemInput {
  id: string;
  title?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  mediaUrl: string;
}

export interface CreateBrowserMediaZipOptions {
  items: ReadonlyArray<BrowserZipItemInput>;
  albumTitle: string;
  totalAlbumItems?: number;
  shareToken?: string | null;
  resolveUrl?: (url: string) => string;
  concurrency?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onProgress?: (progress: BatchZipProgressState) => void;
}

export interface CreateBrowserMediaZipResult {
  blob: Blob;
  filename: string;
  fileCount: number;
  skippedCount: number;
  totalBytes: number;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/ogg': '.ogv',
};

function inferFallbackExtension(mimeType?: string): string {
  const normalized = (mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[normalized] || '';
}

/**
 * Produces a clean `.zip` archive filename distinguishing full-album downloads
 * from partial selected-item batch downloads.
 */
export function buildBatchZipFilename(
  albumTitle: string,
  selectedCount: number,
  totalAlbumItems: number
): string {
  const fullArchiveName = buildAlbumZipFilename(albumTitle);
  const safeSelected = Math.max(0, Math.floor(selectedCount));
  const safeTotal = Math.max(0, Math.floor(totalAlbumItems));

  if (safeSelected === 0 || safeTotal === 0 || safeSelected >= safeTotal) {
    return fullArchiveName;
  }

  const stem = fullArchiveName.replace(/\.zip$/i, '');
  const suffix = safeSelected === 1 ? '1-item' : `${safeSelected}-items`;
  return `${stem}-${suffix}.zip`;
}

/**
 * Safely appends an unlisted album share token to `/api/media/*` URLs without
 * clobbering existing query parameters or external URLs.
 */
export function resolveMediaDownloadUrl(
  mediaUrl: string,
  shareToken?: string | null
): string {
  const trimmedUrl = (mediaUrl || '').trim();
  if (!trimmedUrl) return '';
  const trimmedToken = (shareToken || '').trim();
  if (!trimmedToken || !trimmedUrl.startsWith('/api/media/')) {
    return trimmedUrl;
  }
  if (/(?:[?&])token=/.test(trimmedUrl)) {
    return trimmedUrl;
  }
  const sep = trimmedUrl.includes('?') ? '&' : '?';
  return `${trimmedUrl}${sep}token=${encodeURIComponent(trimmedToken)}`;
}

/**
 * Weighted overall progress calculation for browser-side batch ZIP creation:
 * 0-85% media fetching, 85-100% JSZip archive assembly.
 */
export function computeBatchZipProgress(params: {
  phase: BatchZipPhase;
  fetchedCount: number;
  totalCount: number;
  fetchedBytes: number;
  totalBytes: number;
  zipPercent: number;
}): { overallPercent: number; statusText: string } {
  const totalCount = Math.max(1, Math.floor(params.totalCount));
  const fetchedCount = Math.min(totalCount, Math.max(0, Math.floor(params.fetchedCount)));
  const safeZipPercent = Math.min(100, Math.max(0, Number.isFinite(params.zipPercent) ? params.zipPercent : 0));

  if (params.phase === 'done') {
    return {
      overallPercent: 100,
      statusText: 'Archive ready',
    };
  }

  if (params.phase === 'zipping') {
    const overallPercent = Math.min(99, Math.round(85 + (safeZipPercent / 100) * 14));
    return {
      overallPercent,
      statusText: `Bundling ZIP archive (${Math.round(safeZipPercent)}%)...`,
    };
  }

  const ratio =
    params.totalBytes > 0
      ? Math.min(1, Math.max(0, params.fetchedBytes / params.totalBytes))
      : fetchedCount / totalCount;
  const overallPercent = Math.min(85, Math.round(ratio * 85));
  const noun = totalCount === 1 ? 'file' : 'files';
  return {
    overallPercent,
    statusText: `Fetching ${fetchedCount} of ${totalCount} ${noun}...`,
  };
}

function createAbortError(): Error {
  const err = new Error('Download cancelled.');
  err.name = 'AbortError';
  return err;
}

/**
 * Fetches selected images and videos in parallel and bundles them into a single
 * ZIP archive entirely in the browser using JSZip (`STORE` mode for fast,
 * lossless packaging of already-compressed photos and videos).
 */
export async function createBrowserMediaZip(
  options: CreateBrowserMediaZipOptions
): Promise<CreateBrowserMediaZipResult> {
  const {
    items,
    albumTitle,
    totalAlbumItems = items.length,
    shareToken,
    resolveUrl,
    concurrency = 4,
    signal,
    fetcher = fetch,
    onProgress,
  } = options;

  if (items.length === 0) {
    throw new Error('Select at least one photo or video to download.');
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const uniqueEntries = buildUniqueZipEntryNames(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      fileName: item.fileName,
      diskFileName: inferFallbackExtension(item.mimeType)
        ? `${item.id}${inferFallbackExtension(item.mimeType)}`
        : undefined,
    }))
  );

  const entryNameById = new Map(uniqueEntries.map((entry) => [entry.id, entry.entryName]));
  const totalEstimatedBytes = items.reduce(
    (sum, item) => sum + (typeof item.fileSize === 'number' && item.fileSize > 0 ? item.fileSize : 0),
    0
  );

  const zip = new JSZip();
  let fetchedCount = 0;
  let fetchedBytes = 0;
  let addedCount = 0;
  let skippedCount = 0;
  let actualArchivedBytes = 0;

  const emitProgress = (phase: BatchZipPhase, zipPercent = 0) => {
    if (!onProgress) return;
    const computed = computeBatchZipProgress({
      phase,
      fetchedCount,
      totalCount: items.length,
      fetchedBytes,
      totalBytes: totalEstimatedBytes,
      zipPercent,
    });
    onProgress({
      phase,
      fetchedCount,
      totalCount: items.length,
      fetchedBytes,
      totalBytes: totalEstimatedBytes,
      zipPercent,
      overallPercent: computed.overallPercent,
      statusText: computed.statusText,
    });
  };

  emitProgress('fetching', 0);

  await runConcurrentPool(items, Math.max(1, Math.min(6, concurrency)), async (item) => {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const withToken = resolveMediaDownloadUrl(item.mediaUrl, shareToken);
    const finalUrl = resolveUrl ? resolveUrl(withToken) : withToken;
    const entryName = entryNameById.get(item.id) || `${item.id}${inferFallbackExtension(item.mimeType)}`;

    try {
      const response = await fetcher(finalUrl, {
        method: 'GET',
        credentials: 'include',
        signal,
      });

      if (!response.ok) {
        skippedCount += 1;
        fetchedCount += 1;
        fetchedBytes += item.fileSize || 0;
        emitProgress('fetching', 0);
        return;
      }

      const buffer = await response.arrayBuffer();
      if (signal?.aborted) {
        throw createAbortError();
      }

      zip.file(entryName, buffer, {
        binary: true,
        compression: 'STORE',
      });

      addedCount += 1;
      actualArchivedBytes += buffer.byteLength;
      fetchedCount += 1;
      fetchedBytes += item.fileSize && item.fileSize > 0 ? item.fileSize : buffer.byteLength;
      emitProgress('fetching', 0);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw createAbortError();
      }
      skippedCount += 1;
      fetchedCount += 1;
      fetchedBytes += item.fileSize || 0;
      emitProgress('fetching', 0);
    }
  });

  if (signal?.aborted) {
    throw createAbortError();
  }

  if (addedCount === 0) {
    throw new Error('Unable to fetch any selected media files for the ZIP archive.');
  }

  emitProgress('zipping', 0);

  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'STORE',
      mimeType: 'application/zip',
    },
    (metadata) => {
      emitProgress('zipping', metadata.percent);
    }
  );

  if (signal?.aborted) {
    throw createAbortError();
  }

  emitProgress('done', 100);

  return {
    blob,
    filename: buildBatchZipFilename(albumTitle, items.length, totalAlbumItems),
    fileCount: addedCount,
    skippedCount,
    totalBytes: actualArchivedBytes,
  };
}

/**
 * Triggers a browser file download from a generated Blob and cleans up its Object URL.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 30_000);
}

/**
 * Computes total bytes for a set of selected media IDs.
 */
export function computeSelectedBytes(
  media: ReadonlyArray<Pick<MediaItem, 'id' | 'fileSize'>>,
  selectedIds: ReadonlySet<string>
): number {
  let total = 0;
  for (const item of media) {
    if (selectedIds.has(item.id) && typeof item.fileSize === 'number' && item.fileSize > 0) {
      total += item.fileSize;
    }
  }
  return total;
}
