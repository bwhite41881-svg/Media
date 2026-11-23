import { useMemo, useState } from 'react';
import { ArrowUpRight, Eye, Globe, Play, Search, X } from 'lucide-react';
import type { Album, MediaItem, SiteSettings, UserAccount } from '../types/media';
import {
  extractPopularTags,
  filterAlbumsByQuery,
  filterMediaByQuery,
  formatBytes,
  formatDuration,
  formatRelativeDate,
  type SearchMatchMode,
} from '../utils/albumLogic';
import { formatViewCount } from '../utils/viewCounts';
import { MediaSurface } from './MediaSurface';

interface ExploreViewProps {
  user: UserAccount | null;
  siteSettings: SiteSettings;
  albums: Album[];
  media: MediaItem[];
  loading: boolean;
  onOpenAlbum: (albumId: string) => void;
  onOpenMedia: (item: MediaItem, collection: MediaItem[]) => void;
  onStartUpload: () => void;
  onSignIn: () => void;
}

export function ExploreView({
  user,
  siteSettings,
  albums,
  media,
  loading,
  onOpenAlbum,
  onOpenMedia,
  onStartUpload,
  onSignIn,
}: ExploreViewProps) {
  const [kindFilter, setKindFilter] = useState<'all' | 'photo' | 'video'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMatchMode>('all');

  const filteredAlbums = useMemo(
    () => filterAlbumsByQuery(albums, searchQuery, 'all', searchMode),
    [albums, searchQuery, searchMode]
  );

  const filteredMedia = useMemo(
    () => filterMediaByQuery(media, searchQuery, kindFilter, searchMode),
    [media, searchQuery, kindFilter, searchMode]
  );

  const popularTags = useMemo(
    () => extractPopularTags(albums, media, 8),
    [albums, media]
  );

  const hasActiveSearch = searchQuery.trim().length > 0;

  const handleToggleTag = (tag: string) => {
    const token = `#${tag}`;
    setSearchQuery((prev) =>
      prev.trim().toLowerCase() === token.toLowerCase() ? '' : token
    );
  };

  const searchPlaceholder =
    searchMode === 'title'
      ? 'Filter public albums, photos, and videos by title...'
      : searchMode === 'tag'
        ? 'Filter public albums, photos, and videos by tag (e.g. 4K, Live)...'
        : 'Search public albums, photos, and videos by title, #tag, or metadata...';

  const heroMedia = useMemo(
    () => media.find((m) => m.width > m.height) || media[0],
    [media]
  );

  const albumPreviewMedia = useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const item of media) {
      if (!map.has(item.albumId)) {
        map.set(item.albumId, item);
      }
    }
    return map;
  }, [media]);

  return (
    <div className="max-w-[1360px] mx-auto px-6 sm:px-8 pt-8 sm:pt-11 pb-24">
      {/* Split-Screen High-Tech Rasta Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
        <div className="lg:col-span-5 flex flex-col justify-between py-1">
          <div>
            <div className="inline-flex items-center gap-2.5 font-mono-tabular text-xs font-medium uppercase tracking-[0.14em] text-[#00A846] dark:text-[#00E676]">
              <span className="inline-flex items-center gap-1" aria-hidden="true">
                <span className="w-2 h-2 rounded-full bg-[#00E676]" />
                <span className="w-2 h-2 rounded-full bg-[#FFD600]" />
                <span className="w-2 h-2 rounded-full bg-[#FF2A3C]" />
              </span>
              <span>{siteSettings.heroKicker}</span>
            </div>

            <h1 className="mt-4 font-display text-[clamp(2.25rem,3.6vw,3.25rem)] leading-[1.04] font-bold tracking-tight text-[#0C120E] dark:text-[#EEF4F0] text-balance">
              {siteSettings.heroHeadline}
            </h1>

            <p className="mt-4 text-[15px] sm:text-base leading-relaxed text-[#526056] dark:text-[#8FA395] max-w-[46ch]">
              {siteSettings.heroSubheadline}
            </p>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3.5">
            <button
              type="button"
              onClick={user ? onStartUpload : onSignIn}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-5 py-2.5 text-sm font-semibold tracking-wide text-white rounded-lg tech-glow-green hover:brightness-110 transition-all whitespace-nowrap shrink-0"
            >
              {user ? 'Bulk Upload Media' : 'Create Free Account'}
            </button>
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('public-albums-section');
                el?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="px-5 py-2.5 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-white/90 dark:bg-[#0C110E]/90 border border-[#C6D5CA] dark:border-[#24382B] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors whitespace-nowrap shrink-0"
            >
              Browse Public Albums
            </button>
          </div>
        </div>

        {/* Optical Showcase Viewport */}
        <div className="lg:col-span-7">
          <button
            type="button"
            onClick={() => {
              if (heroMedia) onOpenMedia(heroMedia, media);
            }}
            aria-label={heroMedia ? `Inspect featured work ${heroMedia.title}` : 'Featured showcase'}
            className="tech-reticle group relative block w-full aspect-[16/10] lg:aspect-auto lg:h-[450px] rounded-2xl overflow-hidden text-left bg-[#060907] border border-[#C6D5CA] dark:border-[#1F3126] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.75)] hover:border-[#00E676]/60 dark:hover:border-[#FFD600]/60 transition-colors"
          >
            <MediaSurface
              src={
                heroMedia
                  ? heroMedia.posterUrl || (heroMedia.kind === 'photo' ? heroMedia.mediaUrl : '')
                  : '/src/assets/images/hero_alpine_cinema_1795068077664.jpg'
              }
              videoSrc={heroMedia?.kind === 'video' ? heroMedia.mediaUrl : undefined}
              alt={heroMedia?.title || 'Ridge Observatory at Blue Hour'}
              kind={heroMedia?.kind || 'photo'}
              showVideoBadge={false}
              className="w-full h-full"
              imgClassName="group-hover:scale-[1.025]"
            />
            <div className="absolute inset-x-0 bottom-0 p-6 sm:p-7 bg-gradient-to-t from-[#050806]/95 via-[#050806]/55 to-transparent text-white">
              <p className="font-display text-xl sm:text-2xl font-semibold tracking-tight text-[#EEF4F0]">
                {heroMedia?.title || 'Ridge Observatory at Blue Hour'}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono-tabular text-xs text-white/80">
                {heroMedia?.kind === 'video' && (
                  <>
                    <span className="inline-flex items-center gap-1 text-[#00E676] font-semibold">
                      <Play className="w-3 h-3 fill-current" aria-hidden="true" />
                      VIDEO{heroMedia.durationSec > 0 ? ` · ${formatDuration(heroMedia.durationSec)}` : ''}
                    </span>
                    <span aria-hidden="true" className="text-white/35">·</span>
                  </>
                )}
                <span>{heroMedia?.ownerName || 'Maren Lindqvist'}</span>
                <span aria-hidden="true" className="text-white/35">·</span>
                <span className="text-[#FFD600] font-medium">
                  {heroMedia ? formatBytes(heroMedia.fileSize) : '38.4 MB'}
                </span>
                {(heroMedia ? heroMedia.cameraMeta : 'Hasselblad X2D 100C · 38mm') && (
                  <>
                    <span aria-hidden="true" className="text-white/35">·</span>
                    <span className="text-white/75">
                      {heroMedia ? heroMedia.cameraMeta : 'Hasselblad X2D 100C · 38mm'}
                    </span>
                  </>
                )}
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* Precision 4-Column Hardware Spec Readout Strip */}
      <section
        aria-label="Platform capabilities"
        className="mt-10 tech-panel rounded-2xl p-5 sm:p-6 grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8"
      >
        <div>
          <p className="font-mono-tabular text-[10px] uppercase tracking-[0.14em] text-[#526056] dark:text-[#6E8575]">
            01 // BATCH ENGINE
          </p>
          <p className="mt-1 font-mono-tabular text-lg font-semibold text-[#00A846] dark:text-[#00E676]">
            5,000+ Files
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Drop entire folders and thousands of photos or clips at once with parallel worker streaming.
          </p>
        </div>
        <div className="lg:border-l lg:border-[#D4DFD7] lg:dark:border-[#1C2A21] lg:pl-7">
          <p className="font-mono-tabular text-[10px] uppercase tracking-[0.14em] text-[#526056] dark:text-[#6E8575]">
            02 // CHUNKED STREAM
          </p>
          <p className="mt-1 font-mono-tabular text-lg font-semibold text-[#B88600] dark:text-[#FFD600]">
            No Size Cap
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Resumable chunked streaming accepts multi-gigabyte 4K/8K videos with zero album file limits.
          </p>
        </div>
        <div className="lg:border-l lg:border-[#D4DFD7] lg:dark:border-[#1C2A21] lg:pl-7">
          <p className="font-mono-tabular text-[10px] uppercase tracking-[0.14em] text-[#526056] dark:text-[#6E8575]">
            03 // ACCESS CONTROL
          </p>
          <p className="mt-1 font-mono-tabular text-lg font-semibold text-[#E11D32] dark:text-[#FF2A3C]">
            3 Privacy Tiers
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Private vault, unlisted passcode-locked share links, and public gallery albums.
          </p>
        </div>
        <div className="lg:border-l lg:border-[#D4DFD7] lg:dark:border-[#1C2A21] lg:pl-7">
          <p className="font-mono-tabular text-[10px] uppercase tracking-[0.14em] text-[#526056] dark:text-[#6E8575]">
            04 // DIRECT STREAM
          </p>
          <p className="mt-1 font-mono-tabular text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            HTTP 206
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Instant byte-range video scrubbing and lossless full-bitrate ZIP downloads.
          </p>
        </div>
      </section>

      {/* Unified High-Tech Explore Search Bar */}
      <section
        aria-label="Search public collections and media"
        className="mt-8 tech-panel rounded-2xl p-4 sm:p-5"
      >
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <label htmlFor="explore-search-input" className="sr-only">
              Search public albums and media by title or tag
            </label>
            <Search
              className="w-4 h-4 text-[#00A846] dark:text-[#00E676] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="explore-search-input"
              type="text"
              role="searchbox"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && hasActiveSearch) {
                  setSearchQuery('');
                }
              }}
              aria-label="Search public collections and media by title or tag"
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-10 py-2.5 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#1F3126] rounded-xl text-[#0C120E] dark:text-[#EEF4F0] placeholder:text-[#6A7B6F] dark:placeholder:text-[#687E70] focus:border-[#00E676] dark:focus:border-[#FFD600] focus:outline-none transition-colors"
            />
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear explore search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0] rounded-md"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between md:justify-end gap-3 shrink-0">
            <div
              role="group"
              aria-label="Search filter field"
              className="inline-flex items-center p-1 bg-[#E8EFEA] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#1C2A21] rounded-lg"
            >
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'title', label: 'Titles' },
                  { id: 'tag', label: 'Tags' },
                ] as const
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setSearchMode(mode.id)}
                  aria-pressed={searchMode === mode.id}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
                    searchMode === mode.id
                      ? 'bg-white dark:bg-[#132118] text-[#00A846] dark:text-[#FFD600] shadow-xs'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {hasActiveSearch && (
              <div className="flex items-center gap-2.5 shrink-0">
                <p
                  data-testid="explore-search-summary"
                  aria-live="polite"
                  className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]"
                >
                  {filteredAlbums.length} {filteredAlbums.length === 1 ? 'album' : 'albums'} ·{' '}
                  {filteredMedia.length} {filteredMedia.length === 1 ? 'item' : 'items'}
                </p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-xs font-semibold text-[#E11D32] dark:text-[#FF2A3C] hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>

        {popularTags.length > 0 ? (
          <div className="mt-3 pt-3 border-t border-[#E0E9E2] dark:border-[#17241C] flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <span className="font-mono-tabular text-[11px] uppercase tracking-wider text-[#6A7B6F] dark:text-[#6E8575]">
              Tags:
            </span>
            {popularTags.map((tag) => {
              const isSelected = searchQuery.trim().toLowerCase() === `#${tag.toLowerCase()}`;
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleToggleTag(tag)}
                  aria-pressed={isSelected}
                  className={`font-mono-tabular transition-colors ${
                    isSelected
                      ? 'text-[#00A846] dark:text-[#FFD600] font-semibold underline underline-offset-4'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#00A846] dark:hover:text-[#00E676]'
                  }`}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[11px] text-[#6A7B6F] dark:text-[#6E8575]">
            <span>Tip: Filter albums and media by title, creator, or #tag prefix.</span>
          </div>
        )}
      </section>

      {/* Curated Public Albums */}
      <section id="public-albums-section" className="mt-14">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
          <div>
            <p className="font-mono-tabular text-[11px] uppercase tracking-[0.14em] text-[#00A846] dark:text-[#00E676]">
              // PUBLIC VAULT INDEX
            </p>
            <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
              Public Albums
            </h2>
            <p className="mt-1 text-sm text-[#526056] dark:text-[#8FA395]">
              Openly shared photography and video collections published on {siteSettings.siteName}.
            </p>
          </div>
          <p className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]">
            {hasActiveSearch
              ? `${filteredAlbums.length} of ${albums.length} public albums`
              : `${albums.length} ${albums.length === 1 ? 'public album' : 'public albums'}`}
          </p>
        </div>

        {loading ? (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[1, 2, 3].map((n) => (
              <div key={n} className="animate-pulse">
                <div className="aspect-[4/3] rounded-2xl bg-[#E1EAE3] dark:bg-[#101813]" />
                <div className="mt-4 h-5 w-2/3 bg-[#E1EAE3] dark:bg-[#101813] rounded" />
                <div className="mt-2 h-3.5 w-1/2 bg-[#E1EAE3] dark:bg-[#101813] rounded" />
              </div>
            ))}
          </div>
        ) : filteredAlbums.length === 0 ? (
          <div className="mt-8 py-14 text-center tech-panel rounded-2xl">
            <p className="font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              {hasActiveSearch ? 'No matching public albums' : 'No public albums yet'}
            </p>
            <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395]">
              {hasActiveSearch
                ? `No public album titles or tags matched "${searchQuery.trim()}".`
                : 'Create an account and publish the first public photo or video collection.'}
            </p>
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-4 px-4 py-2 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#131F17] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600]"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
            {filteredAlbums.map((album) => (
              <article
                key={album.id}
                className="group tech-panel rounded-2xl p-3.5 flex flex-col hover:border-[#00E676]/60 dark:hover:border-[#FFD600]/55 transition-all"
              >
                <button
                  type="button"
                  onClick={() => onOpenAlbum(album.id)}
                  aria-label={`Open public album ${album.title}`}
                  className="text-left focus-visible:rounded-xl"
                >
                  <MediaSurface
                    src={
                      album.coverUrl ||
                      albumPreviewMedia.get(album.id)?.posterUrl ||
                      (albumPreviewMedia.get(album.id)?.kind === 'photo'
                        ? albumPreviewMedia.get(album.id)?.mediaUrl
                        : '')
                    }
                    videoSrc={
                      !album.coverUrl && albumPreviewMedia.get(album.id)?.kind === 'video'
                        ? albumPreviewMedia.get(album.id)?.mediaUrl
                        : undefined
                    }
                    kind={
                      album.coverUrl
                        ? 'photo'
                        : albumPreviewMedia.get(album.id)?.kind || 'photo'
                    }
                    alt={album.title}
                    className="aspect-[4/3] rounded-xl border border-[#D4DFD7] dark:border-[#1B2B21]"
                    imgClassName="group-hover:scale-[1.03]"
                    showVideoBadge={false}
                  />
                  <div className="mt-4 px-1 flex items-start justify-between gap-3">
                    <h3 className="font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0] group-hover:text-[#00A846] dark:group-hover:text-[#FFD600] transition-colors">
                      {album.title}
                    </h3>
                    <ArrowUpRight
                      className="w-4 h-4 mt-1 text-[#526056] dark:text-[#8FA395] group-hover:text-[#00A846] dark:group-hover:text-[#00E676] shrink-0 transition-colors"
                      aria-hidden="true"
                    />
                  </div>
                  {album.description && (
                    <p className="mt-1.5 px-1 text-xs sm:text-sm leading-relaxed text-[#526056] dark:text-[#8FA395] line-clamp-2">
                      {album.description}
                    </p>
                  )}
                  <div className="mt-3 px-1 flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-[#526056] dark:text-[#8FA395]">
                    <span className="inline-flex items-center gap-1 text-[#00A846] dark:text-[#00E676] font-medium">
                      <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                      Public
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{album.ownerName}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {album.itemCount.toLocaleString()} {album.itemCount === 1 ? 'item' : 'items'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#B88600] dark:text-[#FFD600]">{formatBytes(album.totalBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-[#00A846] dark:text-[#00E676]">
                      <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{formatViewCount(album.viewCount)}</span>
                    </span>
                  </div>
                </button>
                {album.tags && album.tags.length > 0 && (
                  <div className="mt-2.5 pt-2.5 px-1 border-t border-[#E4ECE6] dark:border-[#17241C] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono-tabular text-[#6A7B6F] dark:text-[#6E8575]">
                    {album.tags.slice(0, 4).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleToggleTag(tag)}
                        className="hover:text-[#00A846] dark:hover:text-[#FFD600] transition-colors"
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Public Media Feed */}
      <section className="mt-20">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
          <div>
            <p className="font-mono-tabular text-[11px] uppercase tracking-[0.14em] text-[#B88600] dark:text-[#FFD600]">
              // LIVE MEDIA STREAM
            </p>
            <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
              Recent Public Frames & Reels
            </h2>
            <p className="mt-1 text-sm text-[#526056] dark:text-[#8FA395]">
              Click any item to inspect full-resolution media, stream video, or view capture details.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]">
              {hasActiveSearch || kindFilter !== 'all'
                ? `${filteredMedia.length} of ${media.length} ${media.length === 1 ? 'item' : 'items'}`
                : `${media.length} ${media.length === 1 ? 'item' : 'items'}`}
            </p>
            <div
              role="group"
              aria-label="Filter media by type"
              className="inline-flex items-center p-1 bg-[#E8EFEA] dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#1C2A21] rounded-lg"
            >
              {(
                [
                  { id: 'all', label: 'All Media' },
                  { id: 'photo', label: 'Photos' },
                  { id: 'video', label: 'Videos' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setKindFilter(tab.id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
                    kindFilter === tab.id
                      ? 'bg-white dark:bg-[#132118] text-[#00A846] dark:text-[#FFD600] shadow-xs'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {filteredMedia.length === 0 ? (
          <div className="mt-8 py-14 text-center tech-panel rounded-2xl">
            <p className="text-sm font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              No matching public media
            </p>
            <p className="mt-1 text-xs text-[#526056] dark:text-[#8FA395]">
              Try clearing your search query or switching the media filter.
            </p>
            {(hasActiveSearch || kindFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setKindFilter('all');
                }}
                className="mt-4 px-4 py-2 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#131F17] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600]"
              >
                Reset search & filter
              </button>
            )}
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredMedia.map((item, idx) => {
              const isFeatureWide = idx === 0 && filteredMedia.length >= 4;
              return (
                <article
                  key={item.id}
                  className={`tech-panel rounded-2xl p-3 hover:border-[#00E676]/60 dark:hover:border-[#FFD600]/55 transition-all ${
                    isFeatureWide ? 'sm:col-span-2' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onOpenMedia(item, filteredMedia)}
                    aria-label={`Open ${item.kind} ${item.title}`}
                    className="group block w-full text-left"
                  >
                    <MediaSurface
                      src={item.posterUrl || (item.kind === 'photo' ? item.mediaUrl : '')}
                      videoSrc={item.kind === 'video' ? item.mediaUrl : undefined}
                      alt={item.title}
                      kind={item.kind}
                      durationSec={item.durationSec}
                      className={`rounded-xl border border-[#D4DFD7] dark:border-[#1B2B21] ${
                        isFeatureWide ? 'aspect-[16/9]' : 'aspect-[4/3]'
                      }`}
                      imgClassName="group-hover:scale-[1.03]"
                    />
                    <div className="mt-3 px-1 flex items-baseline justify-between gap-4">
                      <h3 className="text-sm font-semibold text-[#0C120E] dark:text-[#EEF4F0] group-hover:text-[#00A846] dark:group-hover:text-[#FFD600] transition-colors truncate">
                        {item.title}
                      </h3>
                      <span className="font-mono-tabular text-xs text-[#B88600] dark:text-[#FFD600] shrink-0">
                        {formatBytes(item.fileSize)}
                      </span>
                    </div>
                    <div className="mt-1 px-1 flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-[#526056] dark:text-[#8FA395]">
                      <span>{item.ownerName}</span>
                      {item.albumTitle && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[180px]">{item.albumTitle}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{formatRelativeDate(item.createdAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1 text-[#00A846] dark:text-[#00E676]">
                        <Eye className="w-3 h-3" aria-hidden="true" />
                        <span>{formatViewCount(item.viewCount)}</span>
                      </span>
                    </div>
                  </button>
                  {item.tags && item.tags.length > 0 && (
                    <div className="mt-2.5 pt-2 px-1 border-t border-[#E4ECE6] dark:border-[#17241C] flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono-tabular text-[#6A7B6F] dark:text-[#6E8575]">
                      {item.tags.slice(0, 4).map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => handleToggleTag(tag)}
                          className="hover:text-[#00A846] dark:hover:text-[#FFD600] transition-colors"
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
