import { useMemo, useState } from 'react';
import { ArrowUpRight, Globe, Play, Search, X } from 'lucide-react';
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
        : 'Search public albums, photos, and videos by title or #tag...';

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
    <div className="max-w-[1360px] mx-auto px-6 sm:px-8 pt-8 sm:pt-10 pb-24">
      {/* Split-Screen Editorial Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-stretch">
        <div className="lg:col-span-5 flex flex-col justify-between py-1">
          <div>
            <p className="text-sm font-medium text-[#008732] dark:text-[#FCD116] tracking-normal">
              {siteSettings.heroKicker}
            </p>
            <h1 className="mt-3.5 font-display text-[clamp(2.2rem,3.5vw,3.15rem)] leading-[1.06] font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA] text-balance">
              {siteSettings.heroHeadline}
            </h1>
            <p className="mt-4 text-[15px] sm:text-base leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C] max-w-[46ch]">
              {siteSettings.heroSubheadline}
            </p>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3.5">
            <button
              type="button"
              onClick={user ? onStartUpload : onSignIn}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
            >
              {user ? 'Bulk Upload Media' : 'Create Free Account'}
            </button>
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('public-albums-section');
                el?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="px-5 py-2.5 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors whitespace-nowrap shrink-0"
            >
              Browse Public Albums
            </button>
          </div>
        </div>

        <div className="lg:col-span-7">
          <button
            type="button"
            onClick={() => {
              if (heroMedia) onOpenMedia(heroMedia, media);
            }}
            aria-label={heroMedia ? `Inspect featured work ${heroMedia.title}` : 'Featured showcase'}
            className="group relative block w-full aspect-[16/10] lg:aspect-auto lg:h-[450px] rounded-2xl overflow-hidden text-left bg-[#11140E] border border-[#E2DCC8] dark:border-[#2A3124]"
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
              imgClassName="group-hover:scale-[1.02]"
            />
            <div className="absolute inset-x-0 bottom-0 p-6 sm:p-7 bg-gradient-to-t from-black/85 via-black/45 to-transparent text-white">
              <p className="font-serif-editorial text-xl sm:text-2xl font-medium tracking-tight">
                {heroMedia?.title || 'Ridge Observatory at Blue Hour'}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-white/80">
                {heroMedia?.kind === 'video' && (
                  <>
                    <span className="inline-flex items-center gap-1 text-[#FCD116] font-medium">
                      <Play className="w-3 h-3 fill-current" aria-hidden="true" />
                      Video{heroMedia.durationSec > 0 ? ` · ${formatDuration(heroMedia.durationSec)}` : ''}
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>{heroMedia?.ownerName || 'Maren Lindqvist'}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular text-[#FCD116]">
                  {heroMedia ? formatBytes(heroMedia.fileSize) : '38.4 MB'}
                </span>
                {(heroMedia ? heroMedia.cameraMeta : 'Hasselblad X2D 100C · 38mm') && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{heroMedia ? heroMedia.cameraMeta : 'Hasselblad X2D 100C · 38mm'}</span>
                  </>
                )}
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* Full-width 4-column architecture strip below the split */}
      <section
        aria-label="Platform capabilities"
        className="mt-10 pt-7 border-t border-[#E2DCC8] dark:border-[#2A3124] grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8"
      >
        <div>
          <p className="font-mono-tabular text-lg font-medium text-[#008732] dark:text-[#4ADE80]">
            5,000+ Files
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
            Drop entire folders and thousands of photos or clips at once with parallel worker streaming.
          </p>
        </div>
        <div>
          <p className="font-mono-tabular text-lg font-medium text-[#B88200] dark:text-[#FCD116]">
            No Size Cap
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
            Resumable chunked streaming accepts multi-gigabyte 4K/8K videos with zero album file limits.
          </p>
        </div>
        <div>
          <p className="font-mono-tabular text-lg font-medium text-[#CE1126] dark:text-[#F87171]">
            3 Privacy Tiers
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
            Private vault, unlisted passcode-locked share links, and public gallery albums.
          </p>
        </div>
        <div>
          <p className="font-mono-tabular text-lg font-medium text-[#151811] dark:text-[#F5F3EA]">
            HTTP 206
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
            Instant byte-range video scrubbing and full-bitrate original file downloads.
          </p>
        </div>
      </section>

      {/* Unified Explore Search Bar (Filters Public Albums + Public Media by Title or Tag) */}
      <section
        aria-label="Search public collections and media"
        className="mt-10 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-4 sm:p-5"
      >
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <label htmlFor="explore-search-input" className="sr-only">
              Search public albums and media by title or tag
            </label>
            <Search
              className="w-4 h-4 text-[#5A5E52] dark:text-[#A6AA9C] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
              className="w-full pl-10 pr-10 py-2.5 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-xl text-[#151811] dark:text-[#F5F3EA] placeholder:text-[#787B6E] dark:placeholder:text-[#8E9384] focus:border-[#009B3A] dark:focus:border-[#FCD116] focus:outline-none"
            />
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear explore search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-[#F5F3EA] rounded-md"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between md:justify-end gap-3 shrink-0">
            <div
              role="group"
              aria-label="Search filter field"
              className="inline-flex items-center p-1 bg-[#EFEBD9] dark:bg-[#0D0F0B] border border-[#E2DCC8] dark:border-[#2A3124] rounded-lg"
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
                      ? 'bg-white dark:bg-[#232B1E] text-[#151811] dark:text-[#FCD116] shadow-xs'
                      : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white'
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
                  className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C]"
                >
                  {filteredAlbums.length} {filteredAlbums.length === 1 ? 'album' : 'albums'} ·{' '}
                  {filteredMedia.length} {filteredMedia.length === 1 ? 'item' : 'items'}
                </p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-xs font-medium text-[#CE1126] dark:text-[#F87171] hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>

        {popularTags.length > 0 ? (
          <div className="mt-3 pt-3 border-t border-[#ECE8D9] dark:border-[#242B1F] flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <span className="text-[#787B6E] dark:text-[#8E9384] font-medium">Tags:</span>
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
                      ? 'text-[#008732] dark:text-[#FCD116] font-semibold underline underline-offset-4'
                      : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#008732] dark:hover:text-[#FCD116]'
                  }`}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-[#787B6E] dark:text-[#8E9384]">
            <span>Tip: Filter albums and media by title, creator, or #tag prefix.</span>
          </div>
        )}
      </section>

      {/* Curated Public Albums */}
      <section id="public-albums-section" className="mt-12">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-[#E2DCC8] dark:border-[#2A3124]">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA]">
              Public Albums
            </h2>
            <p className="mt-1.5 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
              Openly shared photography and video collections published on {siteSettings.siteName}.
            </p>
          </div>
          <p className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
            {hasActiveSearch
              ? `${filteredAlbums.length} of ${albums.length} public albums`
              : `${albums.length} ${albums.length === 1 ? 'public album' : 'public albums'}`}
          </p>
        </div>

        {loading ? (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[1, 2, 3].map((n) => (
              <div key={n} className="animate-pulse">
                <div className="aspect-[4/3] rounded-2xl bg-[#ECE8D9] dark:bg-[#1B2017]" />
                <div className="mt-4 h-5 w-2/3 bg-[#ECE8D9] dark:bg-[#1B2017] rounded" />
                <div className="mt-2 h-3.5 w-1/2 bg-[#ECE8D9] dark:bg-[#1B2017] rounded" />
              </div>
            ))}
          </div>
        ) : filteredAlbums.length === 0 ? (
          <div className="mt-8 py-14 text-center bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl">
            <p className="font-serif-editorial text-xl text-[#151811] dark:text-[#F5F3EA]">
              {hasActiveSearch ? 'No matching public albums' : 'No public albums yet'}
            </p>
            <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
              {hasActiveSearch
                ? `No public album titles or tags matched "${searchQuery.trim()}".`
                : 'Create an account and publish the first public photo or video collection.'}
            </p>
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-4 px-4 py-2 text-xs font-medium text-[#151811] dark:text-[#F5F3EA] bg-[#F8F6EE] dark:bg-[#1D2318] border border-[#D8D1BC] dark:border-[#343D2C] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116]"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filteredAlbums.map((album) => (
              <article key={album.id} className="group flex flex-col">
                <button
                  type="button"
                  onClick={() => onOpenAlbum(album.id)}
                  aria-label={`Open public album ${album.title}`}
                  className="text-left focus-visible:rounded-2xl"
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
                    className="aspect-[4/3] rounded-2xl border border-[#E2DCC8] dark:border-[#2A3124]"
                    imgClassName="group-hover:scale-[1.03]"
                    showVideoBadge={false}
                  />
                  <div className="mt-4 flex items-start justify-between gap-3">
                    <h3 className="font-serif-editorial text-xl font-medium text-[#151811] dark:text-[#F5F3EA] group-hover:text-[#008732] dark:group-hover:text-[#FCD116] transition-colors">
                      {album.title}
                    </h3>
                    <ArrowUpRight
                      className="w-4 h-4 mt-1.5 text-[#5A5E52] dark:text-[#A6AA9C] group-hover:text-[#008732] dark:group-hover:text-[#FCD116] shrink-0 transition-colors"
                      aria-hidden="true"
                    />
                  </div>
                  {album.description && (
                    <p className="mt-1.5 text-sm leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C] line-clamp-2">
                      {album.description}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                    <span className="inline-flex items-center gap-1 text-[#008732] dark:text-[#4ADE80] font-medium">
                      <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                      Public
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{album.ownerName}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">
                      {album.itemCount.toLocaleString()} {album.itemCount === 1 ? 'item' : 'items'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">{formatBytes(album.totalBytes)}</span>
                  </div>
                </button>
                {album.tags && album.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono-tabular text-[#787B6E] dark:text-[#8E9384]">
                    {album.tags.slice(0, 4).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleToggleTag(tag)}
                        className="hover:text-[#008732] dark:hover:text-[#FCD116] transition-colors"
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
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[#E2DCC8] dark:border-[#2A3124]">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA]">
              Recent Public Frames & Reels
            </h2>
            <p className="mt-1 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
              Click any item to inspect full-resolution media, stream video, or view capture details.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              {hasActiveSearch || kindFilter !== 'all'
                ? `${filteredMedia.length} of ${media.length} ${media.length === 1 ? 'item' : 'items'}`
                : `${media.length} ${media.length === 1 ? 'item' : 'items'}`}
            </p>
            <div
              role="group"
              aria-label="Filter media by type"
              className="inline-flex items-center p-1 bg-[#EFEBD9] dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-lg"
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
                      ? 'bg-white dark:bg-[#232B1E] text-[#151811] dark:text-[#FCD116] shadow-xs'
                      : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {filteredMedia.length === 0 ? (
          <div className="mt-8 py-14 text-center bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl">
            <p className="text-sm font-medium text-[#151811] dark:text-[#F5F3EA]">
              No matching public media
            </p>
            <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              Try clearing your search query or switching the media filter.
            </p>
            {(hasActiveSearch || kindFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setKindFilter('all');
                }}
                className="mt-4 px-4 py-2 text-xs font-medium text-[#151811] dark:text-[#F5F3EA] bg-[#F8F6EE] dark:bg-[#1D2318] border border-[#D8D1BC] dark:border-[#343D2C] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116]"
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
                  className={isFeatureWide ? 'sm:col-span-2' : ''}
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
                      className={`rounded-2xl border border-[#E2DCC8] dark:border-[#2A3124] ${
                        isFeatureWide ? 'aspect-[16/9]' : 'aspect-[4/3]'
                      }`}
                      imgClassName="group-hover:scale-[1.03]"
                    />
                    <div className="mt-3 flex items-baseline justify-between gap-4">
                      <h3 className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] group-hover:text-[#008732] dark:group-hover:text-[#FCD116] transition-colors truncate">
                        {item.title}
                      </h3>
                      <span className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C] shrink-0">
                        {formatBytes(item.fileSize)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                      <span>{item.ownerName}</span>
                      {item.albumTitle && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[180px]">{item.albumTitle}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{formatRelativeDate(item.createdAt)}</span>
                    </div>
                  </button>
                  {item.tags && item.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono-tabular text-[#787B6E] dark:text-[#8E9384]">
                      {item.tags.slice(0, 4).map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => handleToggleTag(tag)}
                          className="hover:text-[#008732] dark:hover:text-[#FCD116] transition-colors"
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
