import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Film,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type {
  Album,
  AlbumVisibility,
  MediaItem,
  SiteSettings,
  UploadQueueItem,
  UserAccount,
} from '../types/media';
import {
  classifyMediaKind,
  computeBatchStats,
  computeChunkCount,
  computeVirtualWindow,
  formatBytes,
  formatDuration,
  formatEta,
  formatTransferSpeed,
  generateSafeId,
  runConcurrentPool,
} from '../utils/albumLogic';
import { runChunkedUpload } from '../lib/api';
import { saveMediaToLocalBackup } from '../lib/localMediaBackup';
import { LinkImportPanel } from './LinkImportPanel';

interface UploadStudioProps {
  user: UserAccount | null;
  albums: Album[];
  siteSettings: SiteSettings;
  initialAlbumId?: string | null;
  onSignIn: () => void;
  onCreateAlbumInline: (payload: {
    title: string;
    description: string;
    visibility: AlbumVisibility;
    allowDownloads: boolean;
  }) => Promise<Album>;
  onUploadCompleted: (media: MediaItem, album: Album, options?: { silent?: boolean }) => void;
  onBatchFinished: (completedCount: number, albumId: string) => void;
  onOpenAlbum: (albumId: string) => void;
}

const PAGE_SIZE = 500;
const VIRTUALIZE_THRESHOLD = 60;
const VIRTUAL_ROW_HEIGHT = 76;
const VIRTUAL_VIEWPORT_HEIGHT = 608;

/**
 * Extracts image/video dimensions & poster frame lazily right before a file uploads,
 * and revokes the temporary object URL immediately so 5,000+ file batches never leak RAM.
 */
async function extractLazyMediaMetadata(file: File): Promise<{
  posterDataUrl: string;
  width: number;
  height: number;
  durationSec: number;
}> {
  const kind = classifyMediaKind(file.type, file.name);
  if (file.size === 0) {
    return { posterDataUrl: '', width: 0, height: 0, durationSec: 0 };
  }

  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(file);
  } catch {
    return { posterDataUrl: '', width: 0, height: 0, durationSec: 0 };
  }

  if (kind === 'photo') {
    return new Promise((resolve) => {
      const img = new Image();
      const done = (w: number, h: number) => {
        URL.revokeObjectURL(objectUrl);
        resolve({ posterDataUrl: '', width: w, height: h, durationSec: 0 });
      };
      const timer = window.setTimeout(() => done(0, 0), 2500);
      img.onload = () => {
        window.clearTimeout(timer);
        done(img.naturalWidth || 0, img.naturalHeight || 0);
      };
      img.onerror = () => {
        window.clearTimeout(timer);
        done(0, 0);
      };
      img.src = objectUrl;
    });
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (posterDataUrl: string) => {
      if (settled) return;
      settled = true;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve({ posterDataUrl, width, height, durationSec });
    };

    const timer = window.setTimeout(() => finish(''), 3000);

    video.onloadeddata = () => {
      try {
        const targetTime = video.duration > 0.5 ? Math.min(1, video.duration * 0.25) : 0;
        video.currentTime = targetTime;
      } catch {
        window.clearTimeout(timer);
        finish('');
      }
    };

    video.onseeked = () => {
      window.clearTimeout(timer);
      try {
        const w = Math.min(video.videoWidth || 640, 800);
        const ratio =
          video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
        const h = Math.max(120, Math.round(w * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
          finish(dataUrl);
          return;
        }
      } catch {
        // ignore unsupported video codec
      }
      finish('');
    };

    video.onerror = () => {
      window.clearTimeout(timer);
      finish('');
    };

    video.src = objectUrl;
  });
}

async function readDroppedEntries(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length === 0) {
    return Array.from(dataTransfer.files || []);
  }

  const collected: File[] = [];

  async function walkEntry(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      await new Promise<void>((resolve) => {
        fileEntry.file(
          (f) => {
            collected.push(f);
            resolve();
          },
          () => resolve()
        );
      });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      await new Promise<void>((resolve) => {
        const readNextBatch = () => {
          reader.readEntries(
            async (batch) => {
              if (!batch || batch.length === 0) {
                resolve();
                return;
              }
              for (const child of batch) {
                await walkEntry(child);
              }
              readNextBatch();
            },
            () => resolve()
          );
        };
        readNextBatch();
      });
    }
  }

  for (const entry of entries) {
    await walkEntry(entry);
  }
  return collected;
}

type QueueFilter = 'all' | 'active' | 'queued' | 'done' | 'error';

export function UploadStudio({
  user,
  albums,
  siteSettings,
  initialAlbumId,
  onSignIn,
  onCreateAlbumInline,
  onUploadCompleted,
  onBatchFinished,
  onOpenAlbum,
}: UploadStudioProps) {
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>(
    initialAlbumId || albums[0]?.id || ''
  );
  const [uploadMode, setUploadMode] = useState<'files' | 'link'>('files');
  const [showQuickAlbum, setShowQuickAlbum] = useState(albums.length === 0);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickVisibility, setQuickVisibility] = useState<AlbumVisibility>(
    siteSettings.defaultAlbumVisibility || 'private'
  );
  const [quickError, setQuickError] = useState('');
  const [creatingQuick, setCreatingQuick] = useState(false);

  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [autoStart, setAutoStart] = useState(true);
  const [concurrency, setConcurrency] = useState<number>(siteSettings.uploadConcurrency || 6);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [scanningDrop, setScanningDrop] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [queueSearch, setQueueSearch] = useState('');
  const [page, setPage] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const queueScrollRef = useRef<HTMLDivElement | null>(null);
  const pauseAllRef = useRef(false);
  const isBatchRunningRef = useRef(false);
  const pauseFlagsRef = useRef<Map<string, boolean>>(new Map());
  const cancelFlagsRef = useRef<Map<string, boolean>>(new Map());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const queueRef = useRef<UploadQueueItem[]>(queue);
  queueRef.current = queue;

  const chunkSizeBytes = Math.max(1, siteSettings.chunkSizeMb || 4) * 1024 * 1024;

  useEffect(() => {
    setConcurrency(siteSettings.uploadConcurrency || 6);
  }, [siteSettings.uploadConcurrency]);

  useEffect(() => {
    if (initialAlbumId && albums.some((a) => a.id === initialAlbumId)) {
      setSelectedAlbumId(initialAlbumId);
    }
  }, [initialAlbumId]);

  useEffect(() => {
    if (!selectedAlbumId && albums.length > 0) {
      setSelectedAlbumId(initialAlbumId && albums.some((a) => a.id === initialAlbumId) ? initialAlbumId : albums[0].id);
      setShowQuickAlbum(false);
    }
  }, [albums, initialAlbumId, selectedAlbumId]);

  const effectiveAlbumId =
    selectedAlbumId && albums.some((a) => a.id === selectedAlbumId)
      ? selectedAlbumId
      : albums[0]?.id || '';

  const effectiveAlbum = useMemo(
    () => albums.find((a) => a.id === effectiveAlbumId) || null,
    [albums, effectiveAlbumId]
  );

  const stats = useMemo(() => computeBatchStats(queue), [queue]);

  const filteredQueue = useMemo(() => {
    const q = queueSearch.trim().toLowerCase();
    return queue.filter((job) => {
      if (queueFilter === 'active' && job.status !== 'uploading' && job.status !== 'finalizing') {
        return false;
      }
      if (queueFilter === 'queued' && job.status !== 'queued' && job.status !== 'paused') {
        return false;
      }
      if (queueFilter === 'done' && job.status !== 'done') return false;
      if (queueFilter === 'error' && job.status !== 'error') return false;
      if (q) {
        return (
          job.title.toLowerCase().includes(q) ||
          job.file.name.toLowerCase().includes(q) ||
          (job.relativePath || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [queue, queueFilter, queueSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredQueue.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredQueue.slice(start, start + PAGE_SIZE);
  }, [filteredQueue, safePage]);

  const shouldVirtualize = pageItems.length > VIRTUALIZE_THRESHOLD;
  const virtualWindow = useMemo(() => {
    if (!shouldVirtualize) {
      return { startIndex: 0, endIndex: pageItems.length, totalHeight: 0 };
    }
    return computeVirtualWindow({
      totalItems: pageItems.length,
      scrollTop,
      viewportHeight: VIRTUAL_VIEWPORT_HEIGHT,
      rowHeight: VIRTUAL_ROW_HEIGHT,
      overscan: 8,
    });
  }, [shouldVirtualize, pageItems.length, scrollTop]);

  const visibleItems = useMemo(
    () =>
      shouldVirtualize
        ? pageItems.slice(virtualWindow.startIndex, virtualWindow.endIndex)
        : pageItems,
    [shouldVirtualize, pageItems, virtualWindow.startIndex, virtualWindow.endIndex]
  );

  useEffect(() => {
    setScrollTop(0);
    if (queueScrollRef.current) {
      queueScrollRef.current.scrollTop = 0;
    }
  }, [safePage, queueFilter, queueSearch]);

  // Warn the user before refreshing/closing the tab while uploads are still saving or unsent
  useEffect(() => {
    const hasUnsaved = isBatchRunning || stats.activeCount > 0 || stats.queuedCount > 0;
    if (!hasUnsaved) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isBatchRunning, stats.activeCount, stats.queuedCount]);

  if (!user) {
    return (
      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 py-20">
        <div className="max-w-xl mx-auto bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-8 sm:p-10 text-center">
          <UploadCloud className="w-8 h-8 text-[#00A846] dark:text-[#FFD600] mx-auto" aria-hidden="true" />
          <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
            Sign in to upload 5,000+ photos and videos
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Accounts keep your massive batch uploads tied to your private and public albums with
            zero file size limits and zero file count caps.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            style={{ backgroundColor: 'var(--accent)' }}
            className="mt-6 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Sign in or Create Account
          </button>
        </div>
      </div>
    );
  }

  /**
   * Synchronously queues 5,000+ File objects without touching DOM decoders so
   * selecting or dropping massive folders stays instant and never OOMs the tab.
   */
  const addFilesToQueue = (files: FileList | File[]) => {
    setGlobalError('');
    const list = Array.from(files);
    if (list.length === 0) return;

    const newEntries: UploadQueueItem[] = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const kind = classifyMediaKind(file.type, file.name);
      const cleanTitle =
        file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || file.name;
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      newEntries[i] = {
        localId: generateSafeId('job'),
        file,
        kind,
        title: cleanTitle.slice(0, 140),
        caption: '',
        cameraMeta: '',
        tags: [],
        relativePath: relPath,
        width: 0,
        height: 0,
        durationSec: 0,
        status: 'queued',
        uploadedBytes: 0,
        totalBytes: file.size,
        completedChunks: 0,
        totalChunks: computeChunkCount(file.size, chunkSizeBytes),
        speedBytesPerSec: 0,
      };
    }

    const nextQueue = [...queueRef.current, ...newEntries];
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    setPage(1);

    if (autoStart && effectiveAlbumId && !isBatchRunningRef.current && !pauseAllRef.current) {
      window.setTimeout(() => {
        void handleStartBatch(false);
      }, 0);
    }
  };

  const updateJob = (localId: string, patch: Partial<UploadQueueItem>) => {
    setQueue((prev) => {
      const idx = prev.findIndex((item) => item.localId === localId);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const uploadSingleJob = async (
    jobId: string,
    targetAlbumId: string,
    isMassiveBatch: boolean
  ): Promise<boolean> => {
    const job = queueRef.current.find((j) => j.localId === jobId);
    if (!job || job.status === 'done' || job.status === 'cancelled') return false;

    pauseFlagsRef.current.set(job.localId, false);
    cancelFlagsRef.current.set(job.localId, false);
    const controller = new AbortController();
    abortControllersRef.current.set(job.localId, controller);

    updateJob(job.localId, { status: 'uploading', error: undefined });

    try {
      // Lazy metadata/poster extraction right before upload (skip heavy poster gen on huge 500+ photo dumps if tiny)
      let width = job.width;
      let height = job.height;
      let durationSec = job.durationSec;
      let posterDataUrl = job.posterDataUrl || '';

      if (width === 0 && height === 0 && !posterDataUrl && job.file.size > 0) {
        const meta = await extractLazyMediaMetadata(job.file);
        width = meta.width;
        height = meta.height;
        durationSec = meta.durationSec;
        posterDataUrl = meta.posterDataUrl;
      }

      const result = await runChunkedUpload({
        file: job.file,
        albumId: targetAlbumId,
        title: job.title.trim() || job.file.name,
        caption: job.caption.trim(),
        cameraMeta: job.cameraMeta.trim(),
        tags: job.tags,
        width,
        height,
        durationSec,
        posterDataUrl: posterDataUrl || undefined,
        chunkSizeBytes,
        existingUploadId: job.uploadId,
        startChunkIndex: job.completedChunks,
        shouldPause: () => Boolean(pauseAllRef.current || pauseFlagsRef.current.get(job.localId)),
        shouldCancel: () => Boolean(cancelFlagsRef.current.get(job.localId)),
        abortSignal: controller.signal,
        onSessionInit: (uploadId, totalChunks) => {
          updateJob(job.localId, { uploadId, totalChunks, width, height, durationSec });
        },
        onProgress: (info) => {
          updateJob(job.localId, {
            uploadedBytes: info.uploadedBytes,
            totalBytes: info.totalBytes,
            completedChunks: info.completedChunks,
            totalChunks: info.totalChunks,
            speedBytesPerSec: info.speedBytesPerSec,
            status: info.completedChunks >= info.totalChunks ? 'finalizing' : 'uploading',
          });
        },
      });

      if (result.paused) {
        updateJob(job.localId, {
          status: 'paused',
          uploadId: result.uploadId,
          completedChunks: result.nextChunk,
          speedBytesPerSec: 0,
        });
        return false;
      }

      updateJob(job.localId, {
        status: 'done',
        uploadedBytes: job.totalBytes,
        completedChunks: job.totalChunks,
        speedBytesPerSec: 0,
        resultMedia: result.media,
      });
      void saveMediaToLocalBackup({
        mediaId: result.media.id,
        albumId: result.media.albumId,
        ownerId: result.media.ownerId,
        title: result.media.title,
        caption: result.media.caption,
        cameraMeta: result.media.cameraMeta,
        tags: result.media.tags,
        fileName: result.media.fileName,
        mimeType: result.media.mimeType,
        fileSize: result.media.fileSize,
        width: result.media.width,
        height: result.media.height,
        durationSec: result.media.durationSec,
        createdAt: result.media.createdAt,
        posterDataUrl: posterDataUrl || undefined,
        blob: job.file,
      }).catch(() => undefined);
      onUploadCompleted(result.media, result.album, { silent: isMassiveBatch });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      if (cancelFlagsRef.current.get(job.localId)) {
        updateJob(job.localId, { status: 'cancelled', speedBytesPerSec: 0 });
      } else {
        updateJob(job.localId, { status: 'error', error: message, speedBytesPerSec: 0 });
      }
      return false;
    } finally {
      abortControllersRef.current.delete(job.localId);
    }
  };

  const handleStartBatch = async (onlyFailed = false) => {
    if (isBatchRunningRef.current) return;
    setGlobalError('');
    if (!effectiveAlbumId) {
      setGlobalError('Please create or select a destination album before starting uploads.');
      setShowQuickAlbum(true);
      return;
    }

    const collectRunnable = () =>
      queueRef.current
        .filter((j) =>
          onlyFailed
            ? j.status === 'error'
            : j.status === 'queued' || j.status === 'paused' || j.status === 'error'
        )
        .map((j) => j.localId);

    const initialIds = collectRunnable();
    if (initialIds.length === 0) return;

    pauseAllRef.current = false;
    isBatchRunningRef.current = true;
    setIsBatchRunning(true);
    let completedInBatch = 0;
    const isMassiveBatch = initialIds.length > 3;

    try {
      let runnableIds = initialIds;
      while (runnableIds.length > 0 && !pauseAllRef.current) {
        await runConcurrentPool(
          runnableIds,
          concurrency,
          async (jobId) => {
            const ok = await uploadSingleJob(jobId, effectiveAlbumId, isMassiveBatch);
            if (ok) completedInBatch++;
          },
          () => pauseAllRef.current
        );
        if (onlyFailed || pauseAllRef.current) break;
        // Pick up any newly dropped/selected files that arrived while this batch was running
        runnableIds = queueRef.current
          .filter((j) => j.status === 'queued')
          .map((j) => j.localId);
      }
    } finally {
      isBatchRunningRef.current = false;
      setIsBatchRunning(false);
      if (completedInBatch > 0) {
        onBatchFinished(completedInBatch, effectiveAlbumId);
      }
    }
  };

  const handlePauseAll = () => {
    pauseAllRef.current = true;
  };

  const handleClearCompleted = () => {
    setQueue((prev) => prev.filter((item) => item.status !== 'done' && item.status !== 'cancelled'));
    setPage(1);
  };

  const handleClearAll = () => {
    pauseAllRef.current = true;
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setQueue([]);
    setPage(1);
  };

  const handleQuickCreateAlbum = async (e: React.FormEvent) => {
    e.preventDefault();
    setQuickError('');
    const title = quickTitle.trim();
    if (!title) {
      setQuickError('Album title is required.');
      return;
    }
    setCreatingQuick(true);
    try {
      const created = await onCreateAlbumInline({
        title,
        description: '',
        visibility: quickVisibility,
        allowDownloads: siteSettings.defaultAllowDownloads,
      });
      setSelectedAlbumId(created.id);
      setQuickTitle('');
      setShowQuickAlbum(false);
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : 'Could not create album.');
    } finally {
      setCreatingQuick(false);
    }
  };

  const pendingCount = stats.queuedCount + stats.pausedCount + stats.errorCount;

  return (
    <div className="max-w-[1240px] mx-auto px-6 sm:px-8 pt-10 pb-24">
      <header className="pb-8 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
        <p className="text-xs font-medium text-[#00A846] dark:text-[#FFD600]">
          Massive 5,000+ File Parallel Engine · Zero File Size Cap · Zero File Count Cap
        </p>
        <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
          Bulk Upload Studio
        </h1>
        <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395] max-w-2xl">
          Drop 5,000+ photos, entire folders, or multi-gigabyte 4K/8K videos at once—or paste a
          link from another website to import an album, video, or photo directly into your vault.
          Files stream in {siteSettings.chunkSizeMb} MiB binary chunks with zero size or count
          limits.
        </p>
      </header>

      {/* Destination Album & Parallel Engine Config */}
      <section className="mt-8 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-end">
          <div className="lg:col-span-6">
            <label
              htmlFor="upload-destination-album"
              className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]"
            >
              Destination Album (No File Limit)
            </label>
            <select
              id="upload-destination-album"
              value={effectiveAlbumId}
              onChange={(e) => setSelectedAlbumId(e.target.value)}
              className="mt-2 w-full px-3.5 py-2.5 text-sm text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg"
            >
              {albums.length === 0 ? (
                <option value="">No albums yet — create one below</option>
              ) : (
                albums.map((alb) => (
                  <option key={alb.id} value={alb.id}>
                    {alb.title} ({alb.visibility} · {alb.itemCount.toLocaleString()} files)
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="lg:col-span-3">
            <label
              htmlFor="parallel-workers-select"
              className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]"
            >
              Parallel Streams
            </label>
            <select
              id="parallel-workers-select"
              value={concurrency}
              disabled={isBatchRunning}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="mt-2 w-full px-3.5 py-2.5 text-sm font-mono-tabular text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg disabled:opacity-60"
            >
              {[1, 2, 4, 6, 8, 12, 16].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'file at a time' : 'files simultaneously'}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3 flex justify-start lg:justify-end">
            <button
              type="button"
              onClick={() => setShowQuickAlbum((prev) => !prev)}
              className="w-full lg:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors whitespace-nowrap"
            >
              <FolderPlus className="w-4 h-4" aria-hidden="true" />
              <span>{showQuickAlbum ? 'Close Quick Create' : 'New Album'}</span>
            </button>
          </div>
        </div>

        {showQuickAlbum && (
          <form
            onSubmit={handleQuickCreateAlbum}
            className="mt-5 pt-5 border-t border-[#E1EAE3] dark:border-[#262C21] grid grid-cols-1 sm:grid-cols-12 gap-4 items-end"
          >
            <div className="sm:col-span-5">
              <label
                htmlFor="quick-album-title"
                className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
              >
                New Album Title
              </label>
              <input
                id="quick-album-title"
                type="text"
                value={quickTitle}
                onChange={(e) => setQuickTitle(e.target.value)}
                placeholder="e.g., Full Archive Drop 2026"
                maxLength={120}
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-white dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
              />
            </div>

            <div className="sm:col-span-4">
              <label
                htmlFor="quick-album-vis"
                className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
              >
                Initial Privacy
              </label>
              <select
                id="quick-album-vis"
                value={quickVisibility}
                onChange={(e) => setQuickVisibility(e.target.value as AlbumVisibility)}
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-white dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
              >
                <option value="private">Private (Only me & invited)</option>
                <option value="unlisted">Unlisted (Share link only)</option>
                <option value="public">Public (Explore gallery)</option>
              </select>
            </div>

            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={creatingQuick}
                style={{ backgroundColor: 'var(--accent)' }}
                className="w-full px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {creatingQuick ? 'Creating...' : 'Create Album'}
              </button>
            </div>

            {quickError && (
              <p role="alert" className="sm:col-span-12 text-xs text-[#E11D32] dark:text-red-400">
                {quickError}
              </p>
            )}
          </form>
        )}
      </section>

      {/* Source Mode Switcher: Local Files & Folders vs Import from External Link */}
      <div
        role="tablist"
        aria-label="Upload source mode"
        className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3"
      >
        <button
          type="button"
          role="tab"
          aria-selected={uploadMode === 'files'}
          onClick={() => setUploadMode('files')}
          className={`flex items-center justify-between gap-3 px-5 py-3.5 rounded-xl border text-left transition-colors ${
            uploadMode === 'files'
              ? 'bg-[#00E676]/12 border-[#00E676] text-[#0C120E] dark:text-[#EEF4F0]'
              : 'bg-white dark:bg-[#0C110E] border-[#D4DFD7] dark:border-[#1C2A21] text-[#526056] dark:text-[#8FA395] hover:border-[#00E676]/60'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                uploadMode === 'files'
                  ? 'bg-[#00E676] text-[#060807]'
                  : 'bg-[#F3F6F4] dark:bg-[#111A14] text-[#00A846] dark:text-[#00E676]'
              }`}
            >
              <UploadCloud className="w-4 h-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Upload Files &amp; Folders
              </p>
              <p className="text-[11px] text-[#526056] dark:text-[#8FA395] truncate">
                Drag &amp; drop local photos, videos, or full folders
              </p>
            </div>
          </div>
          {queue.length > 0 && (
            <span className="shrink-0 px-2 py-0.5 text-[11px] font-mono-tabular font-semibold bg-[#00E676]/15 text-[#00A846] dark:text-[#00E676] rounded">
              {queue.length}
            </span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={uploadMode === 'link'}
          onClick={() => setUploadMode('link')}
          className={`flex items-center justify-between gap-3 px-5 py-3.5 rounded-xl border text-left transition-colors ${
            uploadMode === 'link'
              ? 'bg-[#FFD600]/12 border-[#FFD600] text-[#0C120E] dark:text-[#EEF4F0]'
              : 'bg-white dark:bg-[#0C110E] border-[#D4DFD7] dark:border-[#1C2A21] text-[#526056] dark:text-[#8FA395] hover:border-[#FFD600]/60'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                uploadMode === 'link'
                  ? 'bg-[#FFD600] text-[#060807]'
                  : 'bg-[#F3F6F4] dark:bg-[#111A14] text-[#D9A700] dark:text-[#FFD600]'
              }`}
            >
              <Link2 className="w-4 h-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Import from Link
              </p>
              <p className="text-[11px] text-[#526056] dark:text-[#8FA395] truncate">
                Paste a link from another site for an album, video, or photo
              </p>
            </div>
          </div>
          <span className="shrink-0 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-[#FFD600]/15 text-[#B58900] dark:text-[#FFD600] rounded">
            URL
          </span>
        </button>
      </div>

      {uploadMode === 'link' ? (
        <LinkImportPanel
          albums={albums}
          selectedAlbumId={effectiveAlbumId}
          concurrency={concurrency}
          siteSettings={siteSettings}
          onSelectAlbum={setSelectedAlbumId}
          onCreateAlbumInline={onCreateAlbumInline}
          onUploadCompleted={onUploadCompleted}
          onBatchFinished={onBatchFinished}
          onOpenAlbum={onOpenAlbum}
        />
      ) : (
        <>
          {/* Drag & Drop 5,000+ File / Folder Zone */}
          <section className="mt-6">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragActive(false);
            setScanningDrop(true);
            try {
              const files = await readDroppedEntries(e.dataTransfer);
              if (files.length > 0) addFilesToQueue(files);
            } finally {
              setScanningDrop(false);
            }
          }}
          className={`rounded-2xl border-2 border-dashed p-9 sm:p-12 text-center transition-colors ${
            dragActive
              ? 'border-[#00E676] dark:border-[#FFD600] bg-[#00E676]/10'
              : 'border-[#D4CEB8] dark:border-[#294031] bg-white dark:bg-[#0C110E] hover:border-[#00E676] dark:hover:border-[#FFD600]'
          }`}
        >
          <UploadCloud className="w-9 h-9 text-[#00A846] dark:text-[#FFD600] mx-auto" aria-hidden="true" />
          <h2 className="mt-4 font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            {scanningDrop
              ? 'Scanning dropped folders...'
              : 'Drop 5,000+ photos, videos, or entire folders here'}
          </h2>
          <p className="mt-1.5 text-sm text-[#526056] dark:text-[#8FA395]">
            MP4, MOV, WebM, MKV, ProRes, JPEG, PNG, WebP, HEIC, DNG — no file size limit & no file count cap
          </p>

          <input
            ref={fileInputRef}
            id="media-file-input"
            type="file"
            multiple
            accept="image/*,video/*,.mov,.mkv,.avi,.dng,.raw,.cr2,.nef,.arw,.prores"
            onChange={(e) => {
              if (e.target.files?.length) {
                addFilesToQueue(e.target.files);
                e.target.value = '';
              }
            }}
            className="sr-only"
          />

          <input
            ref={folderInputRef}
            id="media-folder-input"
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is supported across Chromium/Safari/Firefox for bulk folder uploads
            webkitdirectory=""
            directory=""
            onChange={(e) => {
              if (e.target.files?.length) {
                addFilesToQueue(e.target.files);
                e.target.value = '';
              }
            }}
            className="sr-only"
          />

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
            >
              Choose Files (Unlimited)
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors whitespace-nowrap"
            >
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              <span>Choose Entire Folder</span>
            </button>
          </div>

          <label className="mt-4 inline-flex items-center gap-2 text-xs text-[#526056] dark:text-[#8FA395] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="rounded border-[#C6D5CA] dark:border-[#294031] accent-[#00A846]"
            />
            <span>Auto-upload &amp; save immediately when files are selected</span>
          </label>
        </div>

        {globalError && (
          <p role="alert" className="mt-3 text-sm text-[#E11D32] dark:text-red-400">
            {globalError}
          </p>
        )}
      </section>

      {/* Aggregate Massive Batch Progress & Controls (Always visible: 0 / 500 ready state) */}
      <section className="mt-8" aria-label="Batch Upload Queue">
        <div className="bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0] tabular-nums">
                {queue.length === 0
                  ? `Batch Queue — 0 / ${PAGE_SIZE}`
                  : `Batch Queue — ${stats.doneCount.toLocaleString()} / ${Math.max(PAGE_SIZE, stats.totalCount).toLocaleString()} (${
                      stats.doneCount === stats.totalCount
                        ? `${stats.doneCount.toLocaleString()} saved`
                        : `${stats.totalCount.toLocaleString()} in batch`
                    } · ${stats.overallPercent}%)`}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-mono-tabular text-[#526056] dark:text-[#8FA395]">
                <span>
                  {formatBytes(stats.uploadedBytes)} / {formatBytes(stats.totalBytes)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{stats.activeCount} active</span>
                <span aria-hidden="true">·</span>
                <span>{stats.queuedCount.toLocaleString()} queued</span>
                <span aria-hidden="true">·</span>
                <span>{PAGE_SIZE} per batch page (unlimited total)</span>
                {stats.errorCount > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#E11D32] dark:text-red-400">
                      {stats.errorCount} failed
                    </span>
                  </>
                )}
                {stats.combinedSpeedBytesPerSec > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#00A846] dark:text-[#FFD600]">
                      {formatTransferSpeed(stats.combinedSpeedBytesPerSec)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>ETA {formatEta(stats.etaSeconds)}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add More Files</span>
              </button>

              {stats.doneCount > 0 && effectiveAlbumId && (
                <button
                  type="button"
                  onClick={() => onOpenAlbum(effectiveAlbumId)}
                  className="px-3.5 py-2 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] whitespace-nowrap"
                >
                  Open Album
                </button>
              )}

              {isBatchRunning ? (
                <button
                  type="button"
                  onClick={handlePauseAll}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-[#0C120E] bg-[#FFD600] rounded-lg hover:bg-[#E5BD0E] whitespace-nowrap"
                >
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Pause All</span>
                </button>
              ) : (
                pendingCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleStartBatch(false)}
                    style={{ backgroundColor: 'var(--accent)' }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      Upload {pendingCount.toLocaleString()} {pendingCount === 1 ? 'File' : 'Files'}
                    </span>
                  </button>
                )
              )}

              {!isBatchRunning && stats.errorCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleStartBatch(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#E11D32] rounded-lg hover:bg-[#AE0E20] whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Retry Failed ({stats.errorCount})</span>
                </button>
              )}

              {stats.doneCount > 0 && (
                <button
                  type="button"
                  onClick={handleClearCompleted}
                  className="px-3 py-2 text-xs font-medium text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white whitespace-nowrap"
                >
                  Clear Done
                </button>
              )}

              {queue.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="px-3 py-2 text-xs font-medium text-[#E11D32] dark:text-red-400 hover:underline whitespace-nowrap"
                >
                  Clear Queue
                </button>
              )}
            </div>
          </div>

          {/* Aggregate Progress Track */}
          <div className="mt-4 h-2.5 w-full bg-[#E1EAE3] dark:bg-[#232A1E] rounded-full overflow-hidden">
            <div
              className="h-full rasta-stripe transition-all duration-150"
              style={{ width: `${stats.overallPercent}%` }}
            />
          </div>

          {/* Live Save Status Banner so users always know when files are durably saved */}
          {queue.length > 0 && effectiveAlbum && (
            <div
              role="status"
              aria-live="polite"
              className={`mt-4 px-4 py-2.5 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
                isBatchRunning || stats.activeCount > 0
                  ? 'bg-[#FFD600]/10 border-[#FFD600]/40 text-[#7A5900] dark:text-[#FFD600]'
                  : stats.errorCount > 0
                    ? 'bg-[#E11D32]/10 border-[#E11D32]/40 text-[#E11D32] dark:text-red-400'
                    : stats.queuedCount > 0 || stats.pausedCount > 0
                      ? 'bg-[#E8EFEA] dark:bg-[#111A14] border-[#C6D5CA] dark:border-[#294031] text-[#526056] dark:text-[#C8CCB8]'
                      : 'bg-[#00A846]/10 border-[#00A846]/40 text-[#006B27] dark:text-[#00E676]'
              }`}
            >
              <span className="font-medium">
                {isBatchRunning || stats.activeCount > 0
                  ? `Saving ${stats.doneCount.toLocaleString()} of ${stats.totalCount.toLocaleString()} files to "${effectiveAlbum.title}"… Keep this tab open until finished.`
                  : stats.errorCount > 0
                    ? `${stats.doneCount.toLocaleString()} saved to "${effectiveAlbum.title}", ${stats.errorCount.toLocaleString()} failed — click Retry Failed to save remaining files.`
                    : stats.queuedCount > 0 || stats.pausedCount > 0
                      ? `${(stats.queuedCount + stats.pausedCount).toLocaleString()} file(s) staged and not yet saved — click Upload to save them into "${effectiveAlbum.title}".`
                      : `All ${stats.doneCount.toLocaleString()} ${stats.doneCount === 1 ? 'file' : 'files'} permanently saved to "${effectiveAlbum.title}".`}
              </span>
              {stats.doneCount > 0 && !isBatchRunning && (
                <button
                  type="button"
                  onClick={() => onOpenAlbum(effectiveAlbum.id)}
                  className="font-semibold underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
                >
                  View Saved Album
                </button>
              )}
            </div>
          )}

          {/* Filter & Pagination Controls for 500+ Items */}
          {queue.length > 0 && (
            <div className="mt-5 pt-4 border-t border-[#E1EAE3] dark:border-[#262C21] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div
                role="group"
                aria-label="Filter upload queue by status"
                className="inline-flex items-center p-1 bg-[#E8EFEA] dark:bg-[#060807] rounded-lg overflow-x-auto max-w-full"
              >
                {(
                  [
                    { id: 'all', label: `All (${stats.totalCount.toLocaleString()})` },
                    { id: 'active', label: `Active (${stats.activeCount})` },
                    {
                      id: 'queued',
                      label: `Queued (${(stats.queuedCount + stats.pausedCount).toLocaleString()})`,
                    },
                    { id: 'done', label: `Done (${stats.doneCount.toLocaleString()})` },
                    { id: 'error', label: `Failed (${stats.errorCount})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setQueueFilter(tab.id);
                      setPage(1);
                    }}
                    className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 tabular-nums transition-colors ${
                      queueFilter === tab.id
                        ? 'bg-white dark:bg-[#111A14] text-[#0C120E] dark:text-[#FFD600] shadow-xs'
                        : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <input
                type="search"
                value={queueSearch}
                onChange={(e) => {
                  setQueueSearch(e.target.value);
                  setPage(1);
                }}
                aria-label="Search queued filenames"
                placeholder="Filter queue by filename..."
                className="px-3 py-1.5 text-xs bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0] w-full sm:w-56"
              />
            </div>
          )}
        </div>

        {/* Virtualized Batch Queue List (Up to 500 files per page at 60fps) */}
        {queue.length > 0 && (
          <div
            ref={queueScrollRef}
            data-testid="batch-queue-scroller"
            onScroll={
              shouldVirtualize
                ? (e) => setScrollTop(e.currentTarget.scrollTop)
                : undefined
            }
            style={shouldVirtualize ? { maxHeight: `${VIRTUAL_VIEWPORT_HEIGHT}px` } : undefined}
            className={`mt-4 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl ${
              shouldVirtualize
                ? 'overflow-y-auto'
                : 'overflow-hidden divide-y divide-[#E1EAE3] dark:divide-[#262C21]'
            }`}
          >
            {pageItems.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#526056] dark:text-[#8FA395]">
                No files match this queue filter.
              </div>
            ) : (
              <div
                style={
                  shouldVirtualize
                    ? { position: 'relative', height: `${virtualWindow.totalHeight}px` }
                    : undefined
                }
                className={shouldVirtualize ? undefined : 'divide-y divide-[#E1EAE3] dark:divide-[#262C21]'}
              >
                {visibleItems.map((job, offsetIdx) => {
                  const absoluteIdx = virtualWindow.startIndex + offsetIdx;
                  const pct =
                    job.totalBytes > 0
                      ? Math.min(100, Math.round((job.uploadedBytes / job.totalBytes) * 100))
                      : job.status === 'done'
                        ? 100
                        : 0;
                  return (
                    <div
                      key={job.localId}
                      style={
                        shouldVirtualize
                          ? {
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              right: 0,
                              height: `${VIRTUAL_ROW_HEIGHT}px`,
                              transform: `translateY(${absoluteIdx * VIRTUAL_ROW_HEIGHT}px)`,
                            }
                          : undefined
                      }
                      className={`px-4 sm:px-5 py-3 flex items-center gap-3 sm:gap-5 ${
                        shouldVirtualize
                          ? 'border-b border-[#E1EAE3] dark:border-[#262C21]'
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-lg bg-[#E8EFEA] dark:bg-[#1E2419] flex items-center justify-center shrink-0">
                          {job.kind === 'video' ? (
                            <Film className="w-4 h-4 text-[#00A846] dark:text-[#FFD600]" aria-hidden="true" />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-[#00A846] dark:text-[#00E676]" aria-hidden="true" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              aria-label={`Title for ${job.file.name}`}
                              value={job.title}
                              disabled={job.status === 'uploading' || job.status === 'done'}
                              onChange={(e) => updateJob(job.localId, { title: e.target.value })}
                              maxLength={140}
                              className="w-full max-w-md bg-transparent text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] border-b border-transparent focus:border-[#00E676] dark:focus:border-[#FFD600] focus:outline-none truncate disabled:opacity-80"
                            />
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 sm:gap-2 text-[11px] font-mono-tabular text-[#526056] dark:text-[#8FA395] overflow-hidden whitespace-nowrap">
                            <span className="uppercase">{job.kind}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {formatBytes(job.uploadedBytes)} / {formatBytes(job.totalBytes)}
                            </span>
                            <span aria-hidden="true" className="hidden sm:inline">·</span>
                            <span className="hidden sm:inline">
                              Chunk {job.completedChunks}/{job.totalChunks}
                            </span>
                            {job.durationSec > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{formatDuration(job.durationSec)}</span>
                              </>
                            )}
                            {job.status === 'uploading' && job.speedBytesPerSec > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-[#00A846] dark:text-[#FFD600]">
                                  {formatTransferSpeed(job.speedBytesPerSec)}
                                </span>
                              </>
                            )}
                          </div>
                          {job.error && (
                            <p role="alert" className="mt-0.5 text-[11px] text-[#E11D32] dark:text-red-400 truncate">
                              {job.error}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Progress + Row Controls */}
                      <div className="flex items-center gap-2 sm:gap-3 sm:w-52 md:w-64 shrink-0">
                        <div className="hidden sm:block flex-1 h-1.5 bg-[#E1EAE3] dark:bg-[#232A1E] rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-150 ${
                              job.status === 'error'
                                ? 'bg-[#E11D32]'
                                : job.status === 'done'
                                  ? 'bg-[#00E676]'
                                  : 'bg-[#FFD600]'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {job.status === 'done' && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-[#00A846] dark:text-[#00E676]">
                              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                              Done
                            </span>
                          )}
                          {job.status === 'uploading' && (
                            <button
                              type="button"
                              onClick={() => pauseFlagsRef.current.set(job.localId, true)}
                              aria-label={`Pause ${job.title}`}
                              className="p-1.5 text-[#0C120E] dark:text-[#EEF4F0] hover:bg-[#E8EFEA] dark:hover:bg-[#262E20] rounded-md"
                            >
                              <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                          {(job.status === 'queued' || job.status === 'paused' || job.status === 'error') &&
                            !isBatchRunning && (
                              <button
                                type="button"
                                onClick={() => void uploadSingleJob(job.localId, effectiveAlbumId, false)}
                                aria-label={`Upload ${job.title}`}
                                style={{ backgroundColor: 'var(--accent)' }}
                                className="px-2.5 py-1 text-[11px] font-medium text-white rounded-md hover:opacity-90"
                              >
                                {job.status === 'paused' ? 'Resume' : 'Upload'}
                              </button>
                            )}
                          {job.status === 'uploading' ? (
                            <button
                              type="button"
                              onClick={() => {
                                cancelFlagsRef.current.set(job.localId, true);
                                abortControllersRef.current.get(job.localId)?.abort();
                              }}
                              aria-label={`Cancel ${job.title}`}
                              className="p-1.5 text-[#526056] dark:text-[#8FA395] hover:text-[#E11D32]"
                            >
                              <X className="w-4 h-4" aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setQueue((prev) => prev.filter((item) => item.localId !== job.localId))
                              }
                              aria-label={`Remove ${job.title}`}
                              className="p-1.5 text-[#526056] dark:text-[#8FA395] hover:text-[#E11D32]"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Batch Queue Range & Pagination Footer (500 files per page) */}
        {filteredQueue.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[#526056] dark:text-[#8FA395]">
            <p className="font-mono-tabular">
              Showing {((safePage - 1) * PAGE_SIZE + 1).toLocaleString()}–
              {Math.min(safePage * PAGE_SIZE, filteredQueue.length).toLocaleString()} of{' '}
              {filteredQueue.length.toLocaleString()} files ({PAGE_SIZE.toLocaleString()} per page)
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#1C2A21] rounded-lg disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                  Prev
                </button>
                <span className="font-mono-tabular px-2">
                  Page {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#1C2A21] rounded-lg disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
}
