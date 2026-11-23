import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Film,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Square,
  CheckSquare,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Album, AlbumVisibility, MediaItem, SiteSettings } from '../types/media';
import { formatBytes, runConcurrentPool, sanitizeTags } from '../utils/albumLogic';
import {
  parseLinkListInput,
  validateExternalImportUrl,
  type RemoteInspectResult,
  type RemoteMediaCandidate,
} from '../utils/remoteImport';

type ImportItemStatus = 'idle' | 'importing' | 'done' | 'error' | 'cancelled';

interface LinkImportRow extends RemoteMediaCandidate {
  id: string;
  selected: boolean;
  status: ImportItemStatus;
  error?: string;
  savedMediaId?: string;
  savedBytes?: number;
}

interface LinkImportPanelProps {
  albums: Album[];
  selectedAlbumId: string;
  concurrency: number;
  siteSettings: SiteSettings;
  onSelectAlbum: (albumId: string) => void;
  onCreateAlbumInline: (payload: {
    title: string;
    description: string;
    visibility: AlbumVisibility;
    allowDownloads: boolean;
  }) => Promise<Album>;
  onUploadCompleted: (media: MediaItem, updatedAlbum: Album, options?: { silent?: boolean }) => void;
  onBatchFinished: (completedCount: number, albumId: string) => void;
  onOpenAlbum: (albumId: string) => void;
}

export const LinkImportPanel: React.FC<LinkImportPanelProps> = ({
  albums,
  selectedAlbumId,
  concurrency,
  siteSettings,
  onSelectAlbum,
  onCreateAlbumInline,
  onUploadCompleted,
  onBatchFinished,
  onOpenAlbum,
}) => {
  const [urlInput, setUrlInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [inspectResult, setInspectResult] = useState<RemoteInspectResult | null>(null);
  const [rows, setRows] = useState<LinkImportRow[]>([]);
  const [kindFilter, setKindFilter] = useState<'all' | 'photo' | 'video'>('all');

  // Destination mode: existing album OR create a fresh album from the scanned link
  const [destinationMode, setDestinationMode] = useState<'existing' | 'new_album'>(
    albums.length > 0 ? 'existing' : 'new_album'
  );
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [newAlbumVisibility, setNewAlbumVisibility] = useState<AlbumVisibility>(
    siteSettings.defaultAlbumVisibility
  );
  const [customTagsInput, setCustomTagsInput] = useState('');

  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [lastCompletedAlbumId, setLastCompletedAlbumId] = useState('');
  const [brokenPreviewIds, setBrokenPreviewIds] = useState<Record<string, boolean>>({});

  const cancelRef = useRef(false);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const selectedRows = useMemo(() => rows.filter((r) => r.selected), [rows]);
  const photoCount = useMemo(() => rows.filter((r) => r.kind === 'photo').length, [rows]);
  const videoCount = useMemo(() => rows.filter((r) => r.kind === 'video').length, [rows]);
  const doneCount = useMemo(() => rows.filter((r) => r.status === 'done').length, [rows]);
  const errorCount = useMemo(() => rows.filter((r) => r.status === 'error').length, [rows]);
  const importingCount = useMemo(() => rows.filter((r) => r.status === 'importing').length, [rows]);

  const visibleRows = useMemo(() => {
    if (kindFilter === 'all') return rows;
    return rows.filter((r) => r.kind === kindFilter);
  }, [rows, kindFilter]);

  const handleScanLink = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (scanning || isImporting) return;

    setScanError('');
    setImportError('');
    setLastCompletedAlbumId('');

    const parsedUrls = parseLinkListInput(urlInput);
    if (parsedUrls.length === 0) {
      setScanError('Paste a link to an external album page, video, or photo to scan.');
      return;
    }

    // Immediate client-side check for clearly invalid or non-public links
    for (const candidateUrl of parsedUrls) {
      const check = validateExternalImportUrl(candidateUrl);
      if (!check.ok) {
        setScanError(check.error || 'Please enter a valid public http:// or https:// link.');
        return;
      }
    }

    setScanning(true);
    setInspectResult(null);
    setRows([]);
    setBrokenPreviewIds({});

    try {
      const result = await api.inspectExternalLink(
        parsedUrls.length === 1 ? { url: parsedUrls[0] } : { urls: parsedUrls }
      );
      setInspectResult(result);
      setKindFilter('all');
      setRows(
        result.items.map((item, idx) => ({
          ...item,
          id: `rem_${idx}_${Math.random().toString(36).slice(2, 8)}`,
          selected: true,
          status: 'idle',
        }))
      );

      if (result.pageTitle) {
        setNewAlbumTitle(result.pageTitle.slice(0, 120));
      }
      // If scanning an external album page with multiple items and user has no album yet, default to New Album
      if (albums.length === 0 || (result.mode === 'album_page' && result.items.length > 1 && !selectedAlbumId)) {
        setDestinationMode('new_album');
      }
    } catch (err) {
      setScanError(
        err instanceof Error
          ? err.message
          : 'Could not scan that link. Make sure the URL is public and reachable.'
      );
    } finally {
      setScanning(false);
    }
  };

  const toggleRowSelection = (id: string) => {
    if (isImporting) return;
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, selected: !row.selected } : row))
    );
  };

  const handleSelectAllVisible = (select: boolean) => {
    if (isImporting) return;
    const visibleIds = new Set(visibleRows.map((r) => r.id));
    setRows((prev) =>
      prev.map((row) => (visibleIds.has(row.id) ? { ...row, selected: select } : row))
    );
  };

  const handleCancelImport = () => {
    cancelRef.current = true;
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
  };

  const handleReset = () => {
    if (isImporting) return;
    setUrlInput('');
    setInspectResult(null);
    setRows([]);
    setScanError('');
    setImportError('');
    setLastCompletedAlbumId('');
    setBrokenPreviewIds({});
  };

  const handleStartImport = async (onlyFailed = false) => {
    if (isImporting) return;
    setImportError('');

    const targets = rows.filter((row) => {
      if (onlyFailed) return row.status === 'error';
      return row.selected && row.status !== 'done';
    });

    if (targets.length === 0) {
      setImportError('Select at least one photo or video to import.');
      return;
    }

    let targetAlbumId = selectedAlbumId;
    if (destinationMode === 'new_album') {
      const cleanTitle = newAlbumTitle.trim() || inspectResult?.pageTitle || 'Imported Album';
      try {
        const created = await onCreateAlbumInline({
          title: cleanTitle.slice(0, 120),
          description: inspectResult?.pageDescription || '',
          visibility: newAlbumVisibility,
          allowDownloads: siteSettings.defaultAllowDownloads,
        });
        targetAlbumId = created.id;
        onSelectAlbum(created.id);
        setDestinationMode('existing');
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Could not create the new album.');
        return;
      }
    } else if (!targetAlbumId) {
      setImportError('Please select a destination album or switch to "Create new album from link".');
      return;
    }

    const parsedTags = sanitizeTags(
      customTagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    );

    cancelRef.current = false;
    setIsImporting(true);
    let completedCount = 0;
    const isBatch = targets.length > 3;
    const remoteConcurrency = Math.max(1, Math.min(concurrency, 4));

    // Mark queued targets cleanly
    const targetIds = new Set(targets.map((t) => t.id));
    setRows((prev) =>
      prev.map((row) =>
        targetIds.has(row.id) ? { ...row, status: 'idle', error: undefined } : row
      )
    );

    try {
      await runConcurrentPool(
        targets,
        remoteConcurrency,
        async (row) => {
          if (cancelRef.current) {
            setRows((prev) =>
              prev.map((r) => (r.id === row.id ? { ...r, status: 'cancelled' } : r))
            );
            return;
          }

          const controller = new AbortController();
          abortControllersRef.current.set(row.id, controller);

          setRows((prev) =>
            prev.map((r) => (r.id === row.id ? { ...r, status: 'importing', error: undefined } : r))
          );

          try {
            const res = await api.importMediaFromUrl(
              {
                albumId: targetAlbumId,
                url: row.url,
                title: row.title,
                tags: parsedTags.length > 0 ? parsedTags : ['imported'],
                sourceUrl: inspectResult?.sourceUrl,
              },
              controller.signal
            );
            completedCount++;
            setRows((prev) =>
              prev.map((r) =>
                r.id === row.id
                  ? {
                      ...r,
                      status: 'done',
                      savedMediaId: res.media.id,
                      savedBytes: res.media.fileSize,
                    }
                  : r
              )
            );
            onUploadCompleted(res.media, res.album, { silent: isBatch });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Import failed';
            setRows((prev) =>
              prev.map((r) =>
                r.id === row.id
                  ? {
                      ...r,
                      status: cancelRef.current ? 'cancelled' : 'error',
                      error: cancelRef.current ? undefined : msg,
                    }
                  : r
              )
            );
          } finally {
            abortControllersRef.current.delete(row.id);
          }
        },
        () => cancelRef.current
      );
    } finally {
      setIsImporting(false);
      if (completedCount > 0) {
        setLastCompletedAlbumId(targetAlbumId);
        onBatchFinished(completedCount, targetAlbumId);
      }
    }
  };

  const pendingSelectedCount = selectedRows.filter((r) => r.status !== 'done').length;
  const totalSelectedCount = selectedRows.length;
  const progressPct =
    totalSelectedCount > 0 ? Math.min(100, Math.round((doneCount / totalSelectedCount) * 100)) : 0;

  const ctaLabel = (() => {
    if (isImporting) return `Importing (${doneCount}/${totalSelectedCount})...`;
    if (pendingSelectedCount === 0 && doneCount > 0) return 'All Selected Imported';
    if (destinationMode === 'new_album') {
      return `Create Album & Import (${pendingSelectedCount})`;
    }
    if (inspectResult?.mode === 'direct' && pendingSelectedCount === 1) {
      return selectedRows[0]?.kind === 'video' ? 'Import Video' : 'Import Photo';
    }
    return `Import Selected (${pendingSelectedCount})`;
  })();

  return (
    <div className="mt-6 space-y-6">
      {/* URL Scanner Input Card */}
      <section className="tech-panel bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#00A846] dark:text-[#00E676]">
              External URL Importer · Album · Video · Photo
            </p>
            <h2 className="mt-1 font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Import Media from Another Website
            </h2>
            <p className="mt-1 text-xs text-[#526056] dark:text-[#8FA395] max-w-2xl">
              Paste a direct photo link, a direct video link, a public gallery/album webpage URL,
              or multiple links (one per line). Files are pulled straight into your vault with no
              size limit.
            </p>
          </div>
          {inspectResult && !isImporting && (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#526056] dark:text-[#8FA395] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg hover:text-[#0C120E] dark:hover:text-[#EEF4F0] hover:border-[#00E676] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>New Link</span>
            </button>
          )}
        </div>

        <form onSubmit={handleScanLink} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="external-import-url-input"
              className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]"
            >
              External Link or Links (one per line)
            </label>
            <textarea
              id="external-import-url-input"
              rows={3}
              value={urlInput}
              disabled={scanning || isImporting}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (scanError) setScanError('');
              }}
              placeholder="https://example.com/gallery/summer-drop&#10;or https://cdn.example.com/clip.mp4&#10;or https://images.example.com/photo.jpg"
              className="mt-2 w-full px-3.5 py-2.5 text-sm font-mono text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg focus:outline-none focus:border-[#00E676] disabled:opacity-60 resize-y"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#526056] dark:text-[#8FA395]">
              <span className="inline-flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-[#00A846] dark:text-[#00E676]" aria-hidden="true" />
                Album webpages
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-[#D9A700] dark:text-[#FFD600]" aria-hidden="true" />
                Direct videos (.mp4, .mov, .webm)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-[#00A846] dark:text-[#00E676]" aria-hidden="true" />
                Direct photos (.jpg, .png, .webp, .gif)
              </span>
            </div>

            <button
              type="submit"
              disabled={scanning || isImporting || !urlInput.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#060807] bg-[#00E676] hover:bg-[#19FF8C] disabled:opacity-50 rounded-lg transition-colors"
            >
              {scanning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Scanning Link...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" aria-hidden="true" />
                  <span>Scan Link</span>
                </>
              )}
            </button>
          </div>
        </form>

        {scanError && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 px-4 py-3 text-xs text-[#FF2A3C] bg-[#FF2A3C]/10 border border-[#FF2A3C]/30 rounded-lg"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{scanError}</span>
          </div>
        )}
      </section>

      {/* Discovered Media & Destination Controls */}
      {inspectResult && rows.length > 0 && (
        <section className="tech-panel bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6 space-y-6">
          {/* Discovery Summary Bar */}
          <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-[#E1EAE3] dark:border-[#1C2A21]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono font-semibold uppercase tracking-wider text-[#060807] bg-[#FFD600] rounded-md">
                  <Link2 className="w-3 h-3" aria-hidden="true" />
                  {inspectResult.mode === 'direct'
                    ? rows[0]?.kind === 'video'
                      ? 'Direct Video'
                      : 'Direct Photo'
                    : inspectResult.mode === 'batch_links'
                      ? 'Multi-Link Batch'
                      : 'External Album Page'}
                </span>
                <span className="text-xs font-mono-tabular text-[#526056] dark:text-[#8FA395]">
                  {rows.length.toLocaleString()} {rows.length === 1 ? 'item' : 'items'} found
                  {photoCount > 0 ? ` · ${photoCount} photos` : ''}
                  {videoCount > 0 ? ` · ${videoCount} videos` : ''}
                </span>
              </div>
              <h3 className="mt-2 font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0] truncate">
                {inspectResult.pageTitle}
              </h3>
              <p className="mt-0.5 text-xs font-mono text-[#526056] dark:text-[#8FA395] truncate max-w-2xl">
                {inspectResult.sourceUrl}
              </p>
            </div>

            {lastCompletedAlbumId && !isImporting && (
              <button
                type="button"
                onClick={() => onOpenAlbum(lastCompletedAlbumId)}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-[#060807] bg-[#FFD600] hover:bg-[#FFE033] rounded-lg transition-colors"
              >
                <ExternalLink className="w-4 h-4" aria-hidden="true" />
                <span>Open Album</span>
              </button>
            )}
          </div>

          {/* Destination & Tag Configuration */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end bg-[#F3F6F4] dark:bg-[#060807] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-xl p-4">
            <div className="lg:col-span-4">
              <span className="block text-[11px] font-mono uppercase tracking-wider text-[#526056] dark:text-[#8FA395]">
                Destination
              </span>
              <div className="mt-2 grid grid-cols-2 gap-1.5 p-1 bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg">
                <button
                  type="button"
                  disabled={isImporting || albums.length === 0}
                  onClick={() => setDestinationMode('existing')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-40 ${
                    destinationMode === 'existing'
                      ? 'bg-[#00E676] text-[#060807] font-semibold'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0]'
                  }`}
                >
                  Selected Album
                </button>
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDestinationMode('new_album')}
                  className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    destinationMode === 'new_album'
                      ? 'bg-[#FFD600] text-[#060807] font-semibold'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0]'
                  }`}
                >
                  <FolderPlus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>New Album</span>
                </button>
              </div>
            </div>

            {destinationMode === 'new_album' ? (
              <>
                <div className="lg:col-span-4">
                  <label
                    htmlFor="link-import-new-album-title"
                    className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
                  >
                    New Album Title
                  </label>
                  <input
                    id="link-import-new-album-title"
                    type="text"
                    value={newAlbumTitle}
                    disabled={isImporting}
                    onChange={(e) => setNewAlbumTitle(e.target.value)}
                    placeholder="Album name..."
                    className="mt-1.5 w-full px-3 py-2 text-xs text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label
                    htmlFor="link-import-new-album-vis"
                    className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
                  >
                    Privacy
                  </label>
                  <select
                    id="link-import-new-album-vis"
                    value={newAlbumVisibility}
                    disabled={isImporting}
                    onChange={(e) => setNewAlbumVisibility(e.target.value as AlbumVisibility)}
                    className="mt-1.5 w-full px-2.5 py-2 text-xs text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg"
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                <div className="lg:col-span-2">
                  <label
                    htmlFor="link-import-tags"
                    className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
                  >
                    Tags (comma)
                  </label>
                  <input
                    id="link-import-tags"
                    type="text"
                    value={customTagsInput}
                    disabled={isImporting}
                    onChange={(e) => setCustomTagsInput(e.target.value)}
                    placeholder="imported, set"
                    className="mt-1.5 w-full px-3 py-2 text-xs text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="lg:col-span-5">
                  <span className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]">
                    Importing Into
                  </span>
                  <p className="mt-2 text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0] truncate">
                    {albums.find((a) => a.id === selectedAlbumId)?.title ||
                      'Select an album above'}
                  </p>
                </div>
                <div className="lg:col-span-3">
                  <label
                    htmlFor="link-import-tags-existing"
                    className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]"
                  >
                    Tags (optional, comma-separated)
                  </label>
                  <input
                    id="link-import-tags-existing"
                    type="text"
                    value={customTagsInput}
                    disabled={isImporting}
                    onChange={(e) => setCustomTagsInput(e.target.value)}
                    placeholder="imported, external"
                    className="mt-1.5 w-full px-3 py-2 text-xs text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg"
                  />
                </div>
              </>
            )}
          </div>

          {/* Progress Bar while importing or finished */}
          {(isImporting || doneCount > 0 || errorCount > 0) && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-mono-tabular text-[#0C120E] dark:text-[#EEF4F0]">
                  {isImporting
                    ? `Pulling media from external site · ${importingCount} active`
                    : `Import finished · ${doneCount} saved${errorCount > 0 ? ` · ${errorCount} failed` : ''}`}
                </span>
                <span className="font-mono-tabular font-semibold text-[#00A846] dark:text-[#00E676]">
                  {progressPct}%
                </span>
              </div>
              <div className="h-2 w-full bg-[#E1EAE3] dark:bg-[#152119] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#00E676] via-[#FFD600] to-[#00E676] transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {importError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 px-4 py-3 text-xs text-[#FF2A3C] bg-[#FF2A3C]/10 border border-[#FF2A3C]/30 rounded-lg"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{importError}</span>
            </div>
          )}

          {/* Filter & Action Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'photo', 'video'] as const).map((tab) => {
                const count =
                  tab === 'all' ? rows.length : tab === 'photo' ? photoCount : videoCount;
                const active = kindFilter === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setKindFilter(tab)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      active
                        ? 'bg-[#00E676]/15 text-[#00A846] dark:text-[#00E676] border-[#00E676]'
                        : 'text-[#526056] dark:text-[#8FA395] border-[#C6D5CA] dark:border-[#24382B] hover:border-[#00E676]'
                    }`}
                  >
                    {tab === 'all' ? 'All' : tab === 'photo' ? 'Photos' : 'Videos'} ({count})
                  </button>
                );
              })}

              <button
                type="button"
                disabled={isImporting}
                onClick={() => handleSelectAllVisible(true)}
                className="px-2.5 py-1.5 text-xs text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0] disabled:opacity-40"
              >
                Select All
              </button>
              <button
                type="button"
                disabled={isImporting}
                onClick={() => handleSelectAllVisible(false)}
                className="px-2.5 py-1.5 text-xs text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0] disabled:opacity-40"
              >
                Clear Selection
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {errorCount > 0 && !isImporting && (
                <button
                  type="button"
                  onClick={() => handleStartImport(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#FFD600] bg-[#FFD600]/10 border border-[#FFD600]/40 rounded-lg hover:bg-[#FFD600]/20 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Retry Failed ({errorCount})</span>
                </button>
              )}

              {isImporting ? (
                <button
                  type="button"
                  onClick={handleCancelImport}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#FF2A3C] hover:bg-[#E02030] rounded-lg transition-colors"
                >
                  <XCircle className="w-4 h-4" aria-hidden="true" />
                  <span>Cancel Import</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={pendingSelectedCount === 0}
                  onClick={() => handleStartImport(false)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#060807] bg-[#00E676] hover:bg-[#19FF8C] disabled:opacity-50 rounded-lg transition-colors"
                >
                  <Check className="w-4 h-4" aria-hidden="true" />
                  <span>{ctaLabel}</span>
                </button>
              )}
            </div>
          </div>

          {/* Discovered Media Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[540px] overflow-y-auto pr-1">
            {visibleRows.map((row) => {
              const isPreviewBroken = brokenPreviewIds[row.id];
              return (
                <div
                  key={row.id}
                  onClick={() => toggleRowSelection(row.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleRowSelection(row.id);
                    }
                  }}
                  className={`group flex items-start gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                    row.status === 'done'
                      ? 'bg-[#00E676]/10 border-[#00E676]/60'
                      : row.status === 'error'
                        ? 'bg-[#FF2A3C]/10 border-[#FF2A3C]/60'
                        : row.selected
                          ? 'bg-[#F3F6F4] dark:bg-[#101913] border-[#00E676]/50'
                          : 'bg-white dark:bg-[#080C0A] border-[#D4DFD7] dark:border-[#1C2A21] opacity-65'
                  }`}
                >
                  {/* Thumbnail or Media Type Preview */}
                  <div className="relative w-16 h-16 shrink-0 rounded-lg overflow-hidden bg-[#060807] border border-[#1C2A21] flex items-center justify-center">
                    {row.kind === 'photo' && row.previewUrl && !isPreviewBroken ? (
                      <img
                        src={row.previewUrl}
                        alt={row.title}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={() =>
                          setBrokenPreviewIds((prev) => ({ ...prev, [row.id]: true }))
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : row.kind === 'video' ? (
                      <Film className="w-6 h-6 text-[#FFD600]" aria-hidden="true" />
                    ) : (
                      <ImageIcon className="w-6 h-6 text-[#00E676]" aria-hidden="true" />
                    )}

                    <span className="absolute bottom-1 left-1 px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase bg-[#060807]/85 text-[#EEF4F0] rounded">
                      {row.kind === 'video' ? 'VID' : 'IMG'}
                    </span>
                  </div>

                  {/* Metadata & Status */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0] truncate">
                        {row.title}
                      </p>
                      <span className="shrink-0 mt-0.5">
                        {row.status === 'done' ? (
                          <CheckCircle2 className="w-4 h-4 text-[#00E676]" aria-label="Imported" />
                        ) : row.status === 'importing' ? (
                          <Loader2
                            className="w-4 h-4 text-[#FFD600] animate-spin"
                            aria-label="Importing"
                          />
                        ) : row.status === 'error' ? (
                          <AlertCircle className="w-4 h-4 text-[#FF2A3C]" aria-label="Error" />
                        ) : row.selected ? (
                          <CheckSquare className="w-4 h-4 text-[#00E676]" aria-hidden="true" />
                        ) : (
                          <Square className="w-4 h-4 text-[#526056] dark:text-[#8FA395]" aria-hidden="true" />
                        )}
                      </span>
                    </div>

                    <p className="mt-0.5 text-[11px] font-mono text-[#526056] dark:text-[#8FA395] truncate">
                      {row.fileName}
                    </p>

                    <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-[#526056] dark:text-[#8FA395]">
                      {row.savedBytes ? (
                        <span className="text-[#00A846] dark:text-[#00E676]">
                          Saved · {formatBytes(row.savedBytes)}
                        </span>
                      ) : row.fileSize ? (
                        <span>{formatBytes(row.fileSize)}</span>
                      ) : (
                        <span>{row.mimeType}</span>
                      )}
                    </div>

                    {row.error && (
                      <p className="mt-1 text-[11px] text-[#FF2A3C] line-clamp-2">{row.error}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
