import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Share2,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Album, MediaItem, UserAccount } from '../types/media';
import { formatBytes, formatRelativeDate } from '../utils/albumLogic';
import {
  computeSelectedBytes,
  createBrowserMediaZip,
  triggerBlobDownload,
  type BatchZipProgressState,
} from '../utils/batchZip';
import { resolveProtectedUrl } from '../lib/api';
import { MediaSurface } from './MediaSurface';

interface AlbumDetailViewProps {
  album: Album | null;
  media: MediaItem[];
  currentUser?: UserAccount | null;
  access: {
    canEdit: boolean;
    canUpload: boolean;
    canDownload: boolean;
    reason: string;
  } | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onOpenMedia: (item: MediaItem, collection: MediaItem[]) => void;
  onUploadToAlbum: (albumId: string) => void;
  onOpenShareModal: (album: Album) => void;
  onEditAlbum: (album: Album) => void;
  onChangeCover?: (album: Album) => void;
  onMessageUser?: (uid: string) => void;
  onNotify?: (message: string) => void;
  shareToken?: string | null;
  onBatchDeleteMedia: (mediaIds: string[]) => Promise<void>;
}

const GALLERY_PAGE_SIZE = 60;

export function AlbumDetailView({
  album,
  media,
  currentUser,
  access,
  loading,
  error,
  onBack,
  onOpenMedia,
  onUploadToAlbum,
  onOpenShareModal,
  onEditAlbum,
  onChangeCover,
  onMessageUser,
  onNotify,
  shareToken,
  onBatchDeleteMedia,
}: AlbumDetailViewProps) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [zipMode, setZipMode] = useState<'all' | 'selected' | null>(null);
  const [zipProgress, setZipProgress] = useState<BatchZipProgressState | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const zipAbortRef = useRef<AbortController | null>(null);

  const isZipping = zipMode !== null;
  const canSelectItems = Boolean((access?.canDownload || access?.canEdit) && media.length > 0);

  // Reset selection and cancel any active ZIP when switching albums or unmounting
  useEffect(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setDownloadError(null);
    setPage(1);
    return () => {
      zipAbortRef.current?.abort();
      zipAbortRef.current = null;
    };
  }, [album?.id]);

  // Prune selected IDs if items are deleted while select mode is open
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(media.map((m) => m.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [media]);

  const runBrowserZipDownload = async (itemsToZip: MediaItem[], mode: 'all' | 'selected') => {
    if (!album || itemsToZip.length === 0 || isZipping) return;

    const controller = new AbortController();
    zipAbortRef.current = controller;
    setZipMode(mode);
    setDownloadError(null);
    setZipProgress({
      phase: 'fetching',
      fetchedCount: 0,
      totalCount: itemsToZip.length,
      fetchedBytes: 0,
      totalBytes: itemsToZip.reduce((sum, item) => sum + (item.fileSize || 0), 0),
      zipPercent: 0,
      overallPercent: 0,
      statusText: `Fetching 0 of ${itemsToZip.length} ${itemsToZip.length === 1 ? 'file' : 'files'}...`,
    });

    try {
      const effectiveShareToken = shareToken || album.shareToken || undefined;
      const result = await createBrowserMediaZip({
        items: itemsToZip,
        albumTitle: album.title,
        totalAlbumItems: media.length,
        shareToken: effectiveShareToken,
        resolveUrl: resolveProtectedUrl,
        signal: controller.signal,
        onProgress: (progress) => setZipProgress(progress),
      });

      triggerBlobDownload(result.blob, result.filename);

      const skippedNote =
        result.skippedCount > 0 ? ` (${result.skippedCount} unavailable skipped)` : '';
      onNotify?.(
        `Downloaded ${result.filename} (${result.fileCount.toLocaleString()} ${
          result.fileCount === 1 ? 'file' : 'files'
        })${skippedNote}`
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        onNotify?.('Batch ZIP download cancelled.');
      } else {
        const msg = err instanceof Error ? err.message : 'Unable to create album ZIP archive.';
        setDownloadError(msg);
        onNotify?.(msg);
      }
    } finally {
      if (zipAbortRef.current === controller) {
        zipAbortRef.current = null;
      }
      setZipMode(null);
      window.setTimeout(() => {
        setZipProgress((current) => (current?.phase === 'done' ? null : null));
      }, 450);
    }
  };

  const handleDownloadAll = () => {
    void runBrowserZipDownload(media, 'all');
  };

  const handleDownloadSelected = () => {
    const selectedItems = media.filter((item) => selectedIds.has(item.id));
    if (selectedItems.length === 0) return;
    void runBrowserZipDownload(selectedItems, 'selected');
  };

  const handleCancelZip = () => {
    zipAbortRef.current?.abort();
  };

  const totalPages = Math.max(1, Math.ceil(media.length / GALLERY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleMedia = useMemo(() => {
    const start = (safePage - 1) * GALLERY_PAGE_SIZE;
    return media.slice(start, start + GALLERY_PAGE_SIZE);
  }, [media, safePage]);

  const selectedBytes = useMemo(
    () => computeSelectedBytes(media, selectedIds),
    [media, selectedIds]
  );

  const allSelected = media.length > 0 && selectedIds.size === media.length;
  const pageAllSelected =
    visibleMedia.length > 0 && visibleMedia.every((item) => selectedIds.has(item.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 py-12">
        <div className="h-8 w-48 bg-[#ECE8D9] dark:bg-[#1B2017] rounded animate-pulse" />
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((n) => (
            <div key={n} className="aspect-[4/3] bg-[#ECE8D9] dark:bg-[#1B2017] rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !album) {
    return (
      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 py-20">
        <div className="max-w-lg mx-auto bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-8 text-center">
          <Lock className="w-8 h-8 text-[#CE1126] dark:text-[#FCD116] mx-auto" aria-hidden="true" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
            Album unavailable
          </h1>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
            {error || 'This album does not exist or its privacy settings restrict access.'}
          </p>
          <button
            type="button"
            onClick={onBack}
            style={{ backgroundColor: 'var(--accent)' }}
            className="mt-6 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1360px] mx-auto px-6 sm:px-8 pt-8 pb-24">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-sm font-medium text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        <span>Back</span>
      </button>

      {/* Album Monograph Header */}
      <header className="mt-6 pb-8 border-b border-[#E2DCC8] dark:border-[#2A3124] flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div className="flex flex-col sm:flex-row items-start gap-5 max-w-3xl">
          {/* Album Cover Thumbnail */}
          <div className="w-28 h-24 sm:w-36 sm:h-28 rounded-xl overflow-hidden bg-[#EFEBD9] dark:bg-[#1A2016] border border-[#E2DCC8] dark:border-[#2A3124] shrink-0 relative group">
            {album.coverUrl ? (
              <img
                src={resolveProtectedUrl(album.coverUrl)}
                alt={`Cover for ${album.title}`}
                className="w-full h-full object-cover"
              />
            ) : media[0] ? (
              <MediaSurface
                src={media[0].posterUrl || (media[0].kind === 'photo' ? media[0].mediaUrl : '')}
                videoSrc={media[0].kind === 'video' ? media[0].mediaUrl : undefined}
                alt={`Cover for ${album.title}`}
                kind={media[0].kind}
                showVideoBadge={false}
                className="w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-[#787B6E] dark:text-[#8E9384]">
                <ImageIcon className="w-5 h-5" aria-hidden="true" />
                <span className="mt-1 text-[10px]">No Cover</span>
              </div>
            )}
            {access?.canEdit && onChangeCover && (
              <button
                type="button"
                onClick={() => onChangeCover(album)}
                aria-label={`Change cover photo for ${album.title}`}
                className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center text-[11px] font-semibold text-white"
              >
                Change Cover
              </button>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#151811] dark:text-[#F5F3EA]">
                {album.visibility === 'private' ? (
                  <>
                    <Lock className="w-3.5 h-3.5 text-[#CE1126] dark:text-[#F87171]" aria-hidden="true" />
                    Private Album
                  </>
                ) : album.visibility === 'unlisted' ? (
                  <>
                    <Link2 className="w-3.5 h-3.5 text-[#B88200] dark:text-[#FCD116]" aria-hidden="true" />
                    Unlisted Share Link
                  </>
                ) : (
                  <>
                    <Globe className="w-3.5 h-3.5 text-[#008732] dark:text-[#4ADE80]" aria-hidden="true" />
                    Public Album
                  </>
                )}
              </span>
              {album.hasPasscode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-[#B88200] dark:text-[#FCD116] font-medium">
                    <KeyRound className="w-3 h-3" aria-hidden="true" />
                    Passcode protected
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>By {album.ownerName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">
                {media.length.toLocaleString()} {media.length === 1 ? 'item' : 'items'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">{formatBytes(album.totalBytes)}</span>
            </div>

            <h1 className="mt-2.5 font-serif-editorial text-3xl sm:text-4xl font-medium tracking-tight text-[#151811] dark:text-[#F5F3EA] text-balance">
              {album.title}
            </h1>

            {album.description && (
              <p className="mt-2.5 text-sm sm:text-[15px] leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
                {album.description}
              </p>
            )}
          </div>
        </div>

        {/* Owner / Contributor / Viewer Controls */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {access?.canDownload && media.length > 0 && (
            <button
              type="button"
              data-testid="download-all-zip-btn"
              onClick={handleDownloadAll}
              disabled={isZipping}
              aria-label={`Download all ${media.length} media files from ${album.title} as ZIP`}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {zipMode === 'all' ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {zipMode === 'all' && zipProgress
                  ? `Zipping ${zipProgress.overallPercent}%`
                  : 'Download All'}
              </span>
            </button>
          )}
          {currentUser && currentUser.uid !== album.ownerId && onMessageUser && (
            <button
              type="button"
              onClick={() => onMessageUser(album.ownerId)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-4 h-4" aria-hidden="true" />
              <span>Message Creator</span>
            </button>
          )}
          {access?.canUpload && (
            <button
              type="button"
              onClick={() => onUploadToAlbum(album.id)}
              style={{ backgroundColor: 'var(--accent)' }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Add Media</span>
            </button>
          )}
          {access?.canEdit && (
            <>
              {onChangeCover && (
                <button
                  type="button"
                  onClick={() => onChangeCover(album)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors whitespace-nowrap shrink-0"
                >
                  <ImageIcon className="w-4 h-4" aria-hidden="true" />
                  <span>Change Cover</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenShareModal(album)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors whitespace-nowrap shrink-0"
              >
                <Share2 className="w-4 h-4" aria-hidden="true" />
                <span>Share & Privacy</span>
              </button>
              <button
                type="button"
                onClick={() => onEditAlbum(album)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors whitespace-nowrap shrink-0"
              >
                <Edit3 className="w-4 h-4" aria-hidden="true" />
                <span>Edit</span>
              </button>
            </>
          )}
          {canSelectItems && (
            <button
              type="button"
              data-testid="toggle-select-mode-btn"
              onClick={() => {
                setSelectMode((prev) => !prev);
                setSelectedIds(new Set());
              }}
              className={`px-3.5 py-2 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                selectMode
                  ? 'text-[#008732] dark:text-[#FCD116] bg-white dark:bg-[#151912] border-[#008732] dark:border-[#FCD116]'
                  : 'text-[#5A5E52] dark:text-[#A6AA9C] border-transparent hover:text-[#151811] dark:hover:text-white'
              }`}
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          )}
        </div>
      </header>

      {/* Browser ZIP Progress Banner */}
      {zipProgress && (
        <div
          data-testid="zip-progress-banner"
          aria-live="polite"
          className="mt-5 px-5 py-4 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-[#151811] dark:text-[#F5F3EA]">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#008732] dark:text-[#FCD116]" aria-hidden="true" />
              <span>{zipProgress.statusText}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono-tabular text-[#5A5E52] dark:text-[#A6AA9C]">
                {zipProgress.overallPercent}%
              </span>
              {isZipping && (
                <button
                  type="button"
                  onClick={handleCancelZip}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#CE1126] dark:text-[#F87171] hover:underline"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </div>
          <div
            role="progressbar"
            aria-label="ZIP archive creation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={zipProgress.overallPercent}
            className="mt-2.5 h-2 w-full rounded-full overflow-hidden bg-[#EFEBD9] dark:bg-[#22281D]"
          >
            <div
              style={{ width: `${Math.max(2, zipProgress.overallPercent)}%` }}
              className="h-full rounded-full bg-[#008732] dark:bg-[#4ADE80] transition-[width] duration-200 ease-out"
            />
          </div>
        </div>
      )}

      {downloadError && (
        <div
          role="alert"
          className="mt-5 px-4 py-3 text-sm text-[#CE1126] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/40 border border-[#FECACA] dark:border-red-900 rounded-xl"
        >
          {downloadError}
        </div>
      )}

      {/* Batch Action Bar */}
      {selectMode && canSelectItems && (
        <div
          data-testid="batch-action-bar"
          className="mt-6 px-5 py-3.5 bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-xl flex flex-wrap items-center justify-between gap-4"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm text-[#151811] dark:text-[#F5F3EA]">
            <span data-testid="batch-selected-count" className="font-medium font-mono-tabular">
              {selectedIds.size.toLocaleString()} of {media.length.toLocaleString()} selected
            </span>
            {selectedIds.size > 0 && (
              <>
                <span aria-hidden="true" className="text-[#C8C2AE] dark:text-[#3A4332]">
                  ·
                </span>
                <span className="text-xs font-mono-tabular text-[#5A5E52] dark:text-[#A6AA9C]">
                  {formatBytes(selectedBytes)}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="select-all-media-btn"
              onClick={() =>
                setSelectedIds(allSelected ? new Set() : new Set(media.map((m) => m.id)))
              }
              className="text-xs font-medium text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white transition-colors"
            >
              {allSelected ? 'Clear selection' : `Select all (${media.length.toLocaleString()})`}
            </button>

            {totalPages > 1 && (
              <button
                type="button"
                onClick={() =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (pageAllSelected) {
                      for (const item of visibleMedia) next.delete(item.id);
                    } else {
                      for (const item of visibleMedia) next.add(item.id);
                    }
                    return next;
                  })
                }
                className="text-xs font-medium text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white transition-colors"
              >
                {pageAllSelected ? 'Deselect page' : 'Select page'}
              </button>
            )}

            {access?.canDownload && (
              <button
                type="button"
                data-testid="batch-download-selected-btn"
                disabled={selectedIds.size === 0 || isZipping}
                onClick={handleDownloadSelected}
                style={{ backgroundColor: 'var(--accent)' }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0"
              >
                {zipMode === 'selected' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {zipMode === 'selected' && zipProgress
                    ? `Zipping ${zipProgress.overallPercent}%`
                    : selectedIds.size > 0
                      ? `Download ZIP (${selectedIds.size})`
                      : 'Download ZIP'}
                </span>
              </button>
            )}

            {access?.canEdit && (
              <button
                type="button"
                disabled={selectedIds.size === 0 || deletingBatch || isZipping}
                onClick={async () => {
                  setDeletingBatch(true);
                  try {
                    await onBatchDeleteMedia(Array.from(selectedIds));
                    setSelectedIds(new Set());
                    setSelectMode(false);
                  } finally {
                    setDeletingBatch(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-[#CE1126] rounded-lg hover:bg-[#AE0E20] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{deletingBatch ? 'Deleting...' : 'Delete Selected'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Media Grid (Paginated for 5,000+ file albums!) */}
      {media.length === 0 ? (
        <div className="mt-10 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-14 text-center">
          <h2 className="font-serif-editorial text-xl font-medium text-[#151811] dark:text-[#F5F3EA]">
            This album is empty
          </h2>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
            Upload 5,000+ photos or full-length videos of any size into this album.
          </p>
          {access?.canUpload && (
            <button
              type="button"
              onClick={() => onUploadToAlbum(album.id)}
              style={{ backgroundColor: 'var(--accent)' }}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Upload Photos or Videos</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleMedia.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <article key={item.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (selectMode) toggleSelect(item.id);
                      else onOpenMedia(item, media);
                    }}
                    aria-label={
                      selectMode
                        ? `${isSelected ? 'Deselect' : 'Select'} ${item.title}`
                        : `Inspect ${item.kind} ${item.title}`
                    }
                    className={`block w-full text-left rounded-2xl transition-all ${
                      isSelected ? 'ring-2 ring-[#FCD116] ring-offset-2 dark:ring-offset-[#0D0F0B]' : ''
                    }`}
                  >
                    <div className="relative">
                      <MediaSurface
                        src={item.posterUrl || (item.kind === 'photo' ? item.mediaUrl : '')}
                        videoSrc={item.kind === 'video' ? item.mediaUrl : undefined}
                        alt={item.title}
                        kind={item.kind}
                        durationSec={item.durationSec}
                        className="aspect-[4/3] rounded-2xl border border-[#E2DCC8] dark:border-[#2A3124]"
                        imgClassName="group-hover:scale-[1.03]"
                      />
                      {selectMode && (
                        <span className="absolute top-3 left-3 w-7 h-7 rounded-md bg-white/95 dark:bg-[#151912]/95 border border-[#D8D1BC] dark:border-[#2E3627] flex items-center justify-center">
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-[#008732] dark:text-[#FCD116]" aria-hidden="true" />
                          ) : (
                            <Square className="w-4 h-4 text-[#5A5E52] dark:text-[#A6AA9C]" aria-hidden="true" />
                          )}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 flex items-baseline justify-between gap-3">
                      <h3 className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] group-hover:text-[#008732] dark:group-hover:text-[#FCD116] transition-colors truncate">
                        {item.title}
                      </h3>
                      <span className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C] shrink-0">
                        {formatBytes(item.fileSize)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                      <span className="capitalize">{item.kind}</span>
                      {item.width > 0 && item.height > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-tabular">
                            {item.width}×{item.height}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{formatRelativeDate(item.createdAt)}</span>
                    </div>
                  </button>
                </article>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              <p className="font-mono-tabular">
                Showing {((safePage - 1) * GALLERY_PAGE_SIZE + 1).toLocaleString()}–
                {Math.min(safePage * GALLERY_PAGE_SIZE, media.length).toLocaleString()} of{' '}
                {media.length.toLocaleString()} files
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2A3124] rounded-lg disabled:opacity-40"
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
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2A3124] rounded-lg disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
