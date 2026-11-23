import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckSquare,
  Download,
  Eye,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import type { Album, MediaItem } from '../types/media';
import { api, resolveProtectedUrl } from '../lib/api';
import { formatBytes, formatRelativeDate } from '../utils/albumLogic';
import { formatViewCount } from '../utils/viewCounts';
import {
  computeSelectedBytes,
  createBrowserMediaZip,
  resolveMediaDownloadUrl,
  triggerBlobDownload,
  type BatchZipProgressState,
} from '../utils/batchZip';
import { MediaSurface } from './MediaSurface';

interface SharedLinkViewProps {
  initialToken: string;
  sharedAlbums: Album[];
  onOpenAlbum: (albumId: string) => void;
  onOpenMedia: (item: MediaItem, collection: MediaItem[], canDownload: boolean) => void;
  onTokenChange: (token: string) => void;
  onNotify?: (message: string) => void;
  onAlbumViewed?: (albumId: string, viewCount: number) => void;
  lastViewedMedia?: { mediaId: string; viewCount: number } | null;
}

export function SharedLinkView({
  initialToken,
  sharedAlbums,
  onOpenAlbum,
  onOpenMedia,
  onTokenChange,
  onNotify,
  onAlbumViewed,
  lastViewedMedia,
}: SharedLinkViewProps) {
  const [tokenInput, setTokenInput] = useState(initialToken);
  const [activeToken, setActiveToken] = useState(initialToken);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [lockedMeta, setLockedMeta] = useState<{
    albumId: string;
    albumTitle: string;
    ownerName: string;
    itemCount: number;
  } | null>(null);
  const [passcode, setPasscode] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const [resolved, setResolved] = useState<{
    album: Album;
    media: MediaItem[];
    canDownload: boolean;
  } | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [zipMode, setZipMode] = useState<'all' | 'selected' | null>(null);
  const [zipProgress, setZipProgress] = useState<BatchZipProgressState | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const zipAbortRef = useRef<AbortController | null>(null);

  const isZipping = zipMode !== null;

  const resetZipAndSelection = () => {
    zipAbortRef.current?.abort();
    zipAbortRef.current = null;
    setSelectMode(false);
    setSelectedIds(new Set());
    setZipMode(null);
    setZipProgress(null);
    setDownloadError(null);
  };

  useEffect(() => {
    return () => {
      zipAbortRef.current?.abort();
      zipAbortRef.current = null;
    };
  }, []);

  const loadToken = async (raw: string) => {
    const cleaned = extractToken(raw);
    resetZipAndSelection();
    if (!cleaned) {
      setResolved(null);
      setLockedMeta(null);
      setError('');
      return;
    }

    setActiveToken(cleaned);
    onTokenChange(cleaned);
    setLoading(true);
    setError('');
    setUnlockError('');
    setLockedMeta(null);
    setResolved(null);

    try {
      const res = await api.resolveShareLink(cleaned);
      if (res.locked) {
        setLockedMeta({
          albumId: res.albumId,
          albumTitle: res.albumTitle,
          ownerName: res.ownerName,
          itemCount: res.itemCount,
        });
      } else {
        setResolved({
          album: res.album,
          media: res.media,
          canDownload: res.access.canDownload,
        });
        void api
          .recordAlbumView(res.album.id, cleaned)
          .then((viewRes) => {
            setResolved((prev) =>
              prev && prev.album.id === viewRes.albumId
                ? { ...prev, album: { ...prev.album, viewCount: viewRes.viewCount } }
                : prev
            );
            onAlbumViewed?.(viewRes.albumId, viewRes.viewCount);
          })
          .catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resolve share link.');
    } finally {
      setLoading(false);
    }
  };

  // Sync live media view count updates back into the unlocked shared album grid
  useEffect(() => {
    if (!lastViewedMedia) return;
    setResolved((prev) =>
      prev
        ? {
            ...prev,
            media: prev.media.map((m) =>
              m.id === lastViewedMedia.mediaId
                ? { ...m, viewCount: lastViewedMedia.viewCount }
                : m
            ),
          }
        : prev
    );
  }, [lastViewedMedia]);

  useEffect(() => {
    setTokenInput(initialToken);
    if (initialToken) {
      void loadToken(initialToken);
    } else {
      resetZipAndSelection();
      setResolved(null);
      setLockedMeta(null);
      setError('');
    }
  }, [initialToken]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() || !activeToken) {
      setUnlockError('Enter the album passcode.');
      return;
    }
    setUnlocking(true);
    setUnlockError('');
    try {
      const res = await api.unlockShareLink(activeToken, passcode.trim());
      setLockedMeta(null);
      setPasscode('');
      setResolved({
        album: res.album,
        media: res.media,
        canDownload: res.access.canDownload,
      });
      void api
        .recordAlbumView(res.album.id, activeToken)
        .then((viewRes) => {
          setResolved((prev) =>
            prev && prev.album.id === viewRes.albumId
              ? { ...prev, album: { ...prev.album, viewCount: viewRes.viewCount } }
              : prev
          );
          onAlbumViewed?.(viewRes.albumId, viewRes.viewCount);
        })
        .catch(() => undefined);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Incorrect passcode.');
    } finally {
      setUnlocking(false);
    }
  };

  const runSharedZipDownload = async (itemsToZip: MediaItem[], mode: 'all' | 'selected') => {
    if (!resolved || !resolved.canDownload || itemsToZip.length === 0 || isZipping) return;

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
      const result = await createBrowserMediaZip({
        items: itemsToZip,
        albumTitle: resolved.album.title,
        totalAlbumItems: resolved.media.length,
        shareToken: activeToken || resolved.album.shareToken || undefined,
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
        onNotify?.('Shared page ZIP download cancelled.');
      } else {
        const msg =
          err instanceof Error ? err.message : 'Unable to create shared album ZIP archive.';
        setDownloadError(msg);
        onNotify?.(msg);
      }
    } finally {
      if (zipAbortRef.current === controller) {
        zipAbortRef.current = null;
      }
      setZipMode(null);
      window.setTimeout(() => {
        setZipProgress(null);
      }, 450);
    }
  };

  const handleDownloadAll = () => {
    if (!resolved) return;
    void runSharedZipDownload(resolved.media, 'all');
  };

  const handleDownloadSelected = () => {
    if (!resolved) return;
    const selectedItems = resolved.media.filter((item) => selectedIds.has(item.id));
    if (selectedItems.length === 0) return;
    void runSharedZipDownload(selectedItems, 'selected');
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedBytes = useMemo(
    () => (resolved ? computeSelectedBytes(resolved.media, selectedIds) : 0),
    [resolved, selectedIds]
  );

  const allSelected = Boolean(
    resolved && resolved.media.length > 0 && selectedIds.size === resolved.media.length
  );

  return (
    <div className="max-w-[1200px] mx-auto px-6 sm:px-8 pt-10 pb-24">
      {/* Lookup Bar */}
      <section className="pb-8 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
        <p className="font-mono-tabular text-[11px] uppercase tracking-[0.14em] text-[#00A846] dark:text-[#00E676]">
          // DIRECT SHARE ACCESS
        </p>
        <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
          Shared Albums & Links
        </h1>
        <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395]">
          Paste an unlisted or private share link (or token) below to open and download photos and videos from a shared collection.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadToken(tokenInput);
          }}
          className="mt-5 flex flex-col sm:flex-row gap-3 max-w-2xl"
        >
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            aria-label="Share link URL or token"
            placeholder="Paste a share URL (e.g., .../?share=token) or token"
            className="flex-1 px-4 py-2.5 text-sm bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-xl text-[#0C120E] dark:text-[#EEF4F0] focus:border-[#00E676] dark:focus:border-[#FFD600] focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            style={{ backgroundColor: 'var(--accent)' }}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-xl tech-glow-green hover:brightness-110 disabled:opacity-50 whitespace-nowrap transition-all"
          >
            <span>{loading ? 'Opening...' : 'Open Link'}</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </form>
      </section>

      {/* Error / Revoked Link State */}
      {error && (
        <div className="mt-8 tech-panel rounded-2xl p-8 max-w-lg">
          <ShieldAlert className="w-7 h-7 text-[#E11D32] dark:text-[#FF4D5E]" aria-hidden="true" />
          <h2 className="mt-3 font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            Access Restricted
          </h2>
          <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395]">{error}</p>
        </div>
      )}

      {/* Passcode Gate */}
      {lockedMeta && (
        <div className="mt-8 tech-panel rounded-2xl p-8 max-w-md">
          <KeyRound className="w-7 h-7 text-[#00A846] dark:text-[#FFD600]" aria-hidden="true" />
          <h2 className="mt-3 font-display text-2xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            {lockedMeta.albumTitle}
          </h2>
          <p className="mt-1.5 text-xs text-[#526056] dark:text-[#8FA395]">
            Shared by {lockedMeta.ownerName} · {lockedMeta.itemCount.toLocaleString()}{' '}
            {lockedMeta.itemCount === 1 ? 'item' : 'items'}
          </p>
          <p className="mt-4 text-sm text-[#526056] dark:text-[#8FA395]">
            The owner locked this album with a passcode. Enter it below to unlock the media.
          </p>

          <form onSubmit={handleUnlock} className="mt-5 space-y-3">
            <div>
              <label htmlFor="share-passcode-input" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Album Passcode
              </label>
              <input
                id="share-passcode-input"
                type="password"
                required
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Enter passcode"
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
              />
            </div>

            {unlockError && (
              <p role="alert" className="text-xs font-medium text-[#E11D32] dark:text-[#FF4D5E]">
                {unlockError}
              </p>
            )}

            <button
              type="submit"
              disabled={unlocking}
              style={{ backgroundColor: 'var(--accent)' }}
              className="w-full px-4 py-2.5 text-sm font-semibold text-white rounded-lg tech-glow-green hover:brightness-110 disabled:opacity-50"
            >
              {unlocking ? 'Verifying...' : 'Unlock Album'}
            </button>
          </form>
        </div>
      )}

      {/* Unlocked Shared Album */}
      {resolved && (
        <section className="mt-8">
          <div className="pb-6 border-b border-[#D4DFD7] dark:border-[#1C2A21] flex flex-col lg:flex-row lg:items-end justify-between gap-5">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#526056] dark:text-[#8FA395]">
                <span className="inline-flex items-center gap-1 font-medium text-[#00A846] dark:text-[#00E676]">
                  <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Shared Link Unlocked
                </span>
                <span aria-hidden="true">·</span>
                <span>By {resolved.album.ownerName}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">
                  {resolved.media.length.toLocaleString()}{' '}
                  {resolved.media.length === 1 ? 'item' : 'items'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular text-[#B88600] dark:text-[#FFD600]">
                  {formatBytes(resolved.album.totalBytes)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-mono-tabular font-medium text-[#00A846] dark:text-[#00E676]">
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{formatViewCount(resolved.album.viewCount)}</span>
                </span>
                <span aria-hidden="true">·</span>
                <span>{resolved.canDownload ? 'Downloads enabled' : 'View only'}</span>
              </div>

              <h2 className="mt-2 font-display text-3xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                {resolved.album.title}
              </h2>
              {resolved.album.description && (
                <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395] max-w-2xl">
                  {resolved.album.description}
                </p>
              )}
            </div>

            {resolved.canDownload && resolved.media.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  data-testid="shared-download-all-btn"
                  onClick={handleDownloadAll}
                  disabled={isZipping}
                  aria-label={`Download all ${resolved.media.length} photos and videos from ${resolved.album.title} as ZIP`}
                  style={{ backgroundColor: 'var(--accent)' }}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white rounded-xl tech-glow-green hover:brightness-110 disabled:opacity-60 transition-all whitespace-nowrap shrink-0"
                >
                  {zipMode === 'all' ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>
                    {zipMode === 'all' && zipProgress
                      ? `Zipping ${zipProgress.overallPercent}%`
                      : `Download All (${resolved.media.length.toLocaleString()})`}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="shared-toggle-select-btn"
                  onClick={() => {
                    setSelectMode((prev) => !prev);
                    setSelectedIds(new Set());
                  }}
                  className={`px-3.5 py-2.5 text-sm font-medium rounded-xl border transition-colors whitespace-nowrap shrink-0 ${
                    selectMode
                      ? 'text-[#00A846] dark:text-[#FFD600] bg-white dark:bg-[#0C110E] border-[#00A846] dark:border-[#FFD600]'
                      : 'text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border-[#C6D5CA] dark:border-[#24382B] hover:border-[#00E676] dark:hover:border-[#FFD600]'
                  }`}
                >
                  {selectMode ? 'Done' : 'Select Files'}
                </button>
              </div>
            )}
          </div>

          {/* Browser ZIP Progress Banner */}
          {zipProgress && (
            <div
              data-testid="shared-zip-progress-banner"
              aria-live="polite"
              className="mt-5 px-5 py-4 tech-panel rounded-xl"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 font-medium text-[#0C120E] dark:text-[#EEF4F0]">
                  <Loader2
                    className="w-3.5 h-3.5 animate-spin text-[#00A846] dark:text-[#FFD600]"
                    aria-hidden="true"
                  />
                  <span>{zipProgress.statusText}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono-tabular text-[#526056] dark:text-[#8FA395]">
                    {zipProgress.overallPercent}%
                  </span>
                  {isZipping && (
                    <button
                      type="button"
                      onClick={() => zipAbortRef.current?.abort()}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#E11D32] dark:text-[#FF4D5E] hover:underline"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Cancel</span>
                    </button>
                  )}
                </div>
              </div>
              <div
                role="progressbar"
                aria-label="Shared page ZIP download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={zipProgress.overallPercent}
                className="mt-2.5 h-2 w-full rounded-full overflow-hidden bg-[#E8EFEA] dark:bg-[#132018]"
              >
                <div
                  style={{ width: `${Math.max(2, zipProgress.overallPercent)}%` }}
                  className="h-full rounded-full bg-[#00A846] dark:bg-[#00E676] shadow-[0_0_12px_rgba(0,230,118,0.55)] transition-[width] duration-200 ease-out"
                />
              </div>
            </div>
          )}

          {downloadError && (
            <div
              role="alert"
              className="mt-5 px-4 py-3 text-sm text-[#E11D32] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/40 border border-[#FECACA] dark:border-red-900 rounded-xl"
            >
              {downloadError}
            </div>
          )}

          {/* Selection Action Bar */}
          {selectMode && resolved.canDownload && resolved.media.length > 0 && (
            <div
              data-testid="shared-batch-bar"
              className="mt-5 px-5 py-3.5 tech-panel rounded-xl flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-[#0C120E] dark:text-[#EEF4F0]">
                <span data-testid="shared-selected-count" className="font-medium font-mono-tabular">
                  {selectedIds.size.toLocaleString()} of {resolved.media.length.toLocaleString()}{' '}
                  selected
                </span>
                {selectedIds.size > 0 && (
                  <>
                    <span aria-hidden="true" className="text-[#B8C7BC] dark:text-[#294031]">
                      ·
                    </span>
                    <span className="text-xs font-mono-tabular text-[#526056] dark:text-[#8FA395]">
                      {formatBytes(selectedBytes)}
                    </span>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="shared-select-all-btn"
                  onClick={() =>
                    setSelectedIds(
                      allSelected ? new Set() : new Set(resolved.media.map((m) => m.id))
                    )
                  }
                  className="text-xs font-medium text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white transition-colors"
                >
                  {allSelected
                    ? 'Clear selection'
                    : `Select all (${resolved.media.length.toLocaleString()})`}
                </button>

                <button
                  type="button"
                  data-testid="shared-download-selected-btn"
                  disabled={selectedIds.size === 0 || isZipping}
                  onClick={handleDownloadSelected}
                  style={{ backgroundColor: 'var(--accent)' }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white rounded-lg hover:brightness-110 disabled:opacity-40 transition-all whitespace-nowrap shrink-0"
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
              </div>
            </div>
          )}

          {resolved.media.length === 0 ? (
            <div className="mt-8 tech-panel rounded-2xl p-12 text-center">
              <p className="text-sm text-[#526056] dark:text-[#8FA395]">
                No photos or videos in this shared album yet.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {resolved.media.map((item) => {
                const isSelected = selectedIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    className={`tech-panel rounded-2xl p-3 transition-all ${
                      isSelected
                        ? 'ring-2 ring-[#FFD600] ring-offset-2 dark:ring-offset-[#060807]'
                        : 'hover:border-[#00E676]/60 dark:hover:border-[#FFD600]/55'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (selectMode) toggleSelect(item.id);
                        else onOpenMedia(item, resolved.media, resolved.canDownload);
                      }}
                      aria-label={
                        selectMode
                          ? `${isSelected ? 'Deselect' : 'Select'} ${item.title}`
                          : `Open shared ${item.kind} ${item.title}`
                      }
                      className="group block w-full text-left"
                    >
                      <div className="relative">
                        <MediaSurface
                          src={
                            item.posterUrl
                              ? resolveMediaDownloadUrl(item.posterUrl, activeToken || resolved.album.shareToken)
                              : item.kind === 'photo'
                                ? resolveMediaDownloadUrl(item.mediaUrl, activeToken || resolved.album.shareToken)
                                : ''
                          }
                          videoSrc={
                            item.kind === 'video'
                              ? resolveMediaDownloadUrl(item.mediaUrl, activeToken || resolved.album.shareToken)
                              : undefined
                          }
                          alt={item.title}
                          kind={item.kind}
                          durationSec={item.durationSec}
                          className="aspect-[4/3] rounded-xl border border-[#D4DFD7] dark:border-[#1B2B21]"
                          imgClassName="group-hover:scale-[1.03]"
                        />
                        {selectMode && (
                          <span className="absolute top-3 left-3 w-7 h-7 rounded-md bg-white/95 dark:bg-[#0C110E]/95 border border-[#C6D5CA] dark:border-[#24382B] flex items-center justify-center">
                            {isSelected ? (
                              <CheckSquare
                                className="w-4 h-4 text-[#00A846] dark:text-[#FFD600]"
                                aria-hidden="true"
                              />
                            ) : (
                              <Square
                                className="w-4 h-4 text-[#526056] dark:text-[#8FA395]"
                                aria-hidden="true"
                              />
                            )}
                          </span>
                        )}
                      </div>
                      <div className="mt-3 px-1 flex items-baseline justify-between gap-2">
                        <h3 className="text-sm font-semibold text-[#0C120E] dark:text-[#EEF4F0] group-hover:text-[#00A846] dark:group-hover:text-[#FFD600] truncate">
                          {item.title}
                        </h3>
                        <span className="font-mono-tabular text-xs text-[#B88600] dark:text-[#FFD600] shrink-0">
                          {formatBytes(item.fileSize)}
                        </span>
                      </div>
                      <div className="mt-1 px-1 flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-[#526056] dark:text-[#8FA395]">
                        <span className="capitalize">{item.kind}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeDate(item.createdAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 text-[#00A846] dark:text-[#00E676]">
                          <Eye className="w-3 h-3" aria-hidden="true" />
                          <span>{formatViewCount(item.viewCount)}</span>
                        </span>
                      </div>
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Collaborator Shared Albums */}
      {sharedAlbums.length > 0 && (
        <section className="mt-14 pt-8 border-t border-[#D4DFD7] dark:border-[#1C2A21]">
          <h2 className="font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            Collaborator Albums Shared with Your Account
          </h2>
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sharedAlbums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => onOpenAlbum(album.id)}
                className="group text-left tech-panel rounded-2xl overflow-hidden hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors"
              >
                <MediaSurface
                  src={album.coverUrl}
                  alt={album.title}
                  className="aspect-[16/10] border-b border-[#D4DFD7] dark:border-[#1C2A21]"
                  imgClassName="group-hover:scale-[1.03]"
                  showVideoBadge={false}
                />
                <div className="p-4">
                  <p className="font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                    {album.title}
                  </p>
                  <p className="mt-1 text-xs text-[#526056] dark:text-[#8FA395] inline-flex flex-wrap items-center gap-1.5">
                    <Lock className="w-3 h-3" aria-hidden="true" />
                    <span>
                      {album.ownerName} · {album.viewerRole} · {album.itemCount.toLocaleString()} items
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 font-mono-tabular text-[#00A846] dark:text-[#00E676]">
                      <Eye className="w-3 h-3" aria-hidden="true" />
                      <span>{formatViewCount(album.viewCount)}</span>
                    </span>
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function extractToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.includes('://') || trimmed.includes('?share=')) {
      const url = new URL(trimmed, window.location.origin);
      const param = url.searchParams.get('share');
      if (param) return param.trim();
    }
  } catch {
    // treat as raw token
  }
  return trimmed;
}
