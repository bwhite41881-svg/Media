import { useMemo, useState } from 'react';
import {
  Eye,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Lock,
  Search,
  Share2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Album, AlbumVisibility, UserAccount } from '../types/media';
import {
  extractPopularTags,
  filterAlbumsByQuery,
  formatBytes,
  formatRelativeDate,
  type SearchMatchMode,
} from '../utils/albumLogic';
import { formatViewCount } from '../utils/viewCounts';
import { MediaSurface } from './MediaSurface';

interface AlbumsViewProps {
  user: UserAccount | null;
  ownedAlbums: Album[];
  sharedAlbums: Album[];
  loading: boolean;
  onSignIn: () => void;
  onCreateAlbum: () => void;
  onOpenAlbum: (albumId: string) => void;
  onOpenShareModal: (album: Album) => void;
  onChangeCover?: (album: Album) => void;
  onUploadToAlbum: (albumId: string) => void;
  onDeleteAlbum: (album: Album) => void;
  onQuickVisibilityChange: (album: Album, visibility: AlbumVisibility) => Promise<void>;
}

function VisibilityInline({ visibility, hasPasscode }: { visibility: AlbumVisibility; hasPasscode: boolean }) {
  if (visibility === 'private') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0]">
        <Lock className="w-3.5 h-3.5 text-[#E11D32] dark:text-[#FF4D5E]" aria-hidden="true" />
        <span>Private</span>
        {hasPasscode && <KeyRound className="w-3 h-3 text-[#B88200] dark:text-[#FFD600]" aria-label="Passcode locked" />}
      </span>
    );
  }
  if (visibility === 'unlisted') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0]">
        <Link2 className="w-3.5 h-3.5 text-[#B88200] dark:text-[#FFD600]" aria-hidden="true" />
        <span>Unlisted link</span>
        {hasPasscode && <KeyRound className="w-3 h-3 text-[#B88200] dark:text-[#FFD600]" aria-label="Passcode locked" />}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0]">
      <Globe className="w-3.5 h-3.5 text-[#00A846] dark:text-[#00E676]" aria-hidden="true" />
      <span>Public</span>
    </span>
  );
}

export function AlbumsView({
  user,
  ownedAlbums,
  sharedAlbums,
  loading,
  onSignIn,
  onCreateAlbum,
  onOpenAlbum,
  onOpenShareModal,
  onChangeCover,
  onUploadToAlbum,
  onDeleteAlbum,
  onQuickVisibilityChange,
}: AlbumsViewProps) {
  const [filter, setFilter] = useState<'all' | AlbumVisibility>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMatchMode>('all');
  const [changingId, setChangingId] = useState<string | null>(null);

  const filteredOwned = useMemo(
    () => filterAlbumsByQuery(ownedAlbums, searchQuery, filter, searchMode),
    [ownedAlbums, searchQuery, filter, searchMode]
  );

  const filteredShared = useMemo(
    () => filterAlbumsByQuery(sharedAlbums, searchQuery, 'all', searchMode),
    [sharedAlbums, searchQuery, searchMode]
  );

  const availableTags = useMemo(
    () => extractPopularTags([...ownedAlbums, ...sharedAlbums], [], 8),
    [ownedAlbums, sharedAlbums]
  );

  const hasActiveSearch = searchQuery.trim().length > 0;

  const searchPlaceholder =
    searchMode === 'title'
      ? 'Filter your albums by title...'
      : searchMode === 'tag'
        ? 'Filter your albums by tag (e.g. 4K, Private)...'
        : 'Search albums by title, #tag, or metadata...';

  const handleToggleTag = (tag: string) => {
    const token = `#${tag}`;
    setSearchQuery((prev) =>
      prev.trim().toLowerCase() === token.toLowerCase() ? '' : token
    );
  };

  const counts = useMemo(() => {
    return {
      all: ownedAlbums.length,
      private: ownedAlbums.filter((a) => a.visibility === 'private').length,
      unlisted: ownedAlbums.filter((a) => a.visibility === 'unlisted').length,
      public: ownedAlbums.filter((a) => a.visibility === 'public').length,
    };
  }, [ownedAlbums]);

  if (!user) {
    return (
      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 py-20">
        <div className="max-w-xl mx-auto bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-8 sm:p-10 text-center">
          <Lock className="w-8 h-8 text-[#00A846] dark:text-[#FFD600] mx-auto" aria-hidden="true" />
          <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
            Manage private and public albums
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Sign in or create an account to organize unlimited photo and video uploads into private
            vaults, passcode-locked share links, and public galleries.
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

  return (
    <div className="max-w-[1360px] mx-auto px-6 sm:px-8 pt-10 pb-24">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 pb-8 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
        <div>
          <p className="text-xs font-medium text-[#526056] dark:text-[#8FA395]">
            {user.displayName} · @{user.handle}
          </p>
          <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
            Album Management
          </h1>
          <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395]">
            Control privacy tiers, share links, passcodes, collaborator roles, and download access per album. Zero file limits per album.
          </p>
        </div>

        <button
          type="button"
          onClick={onCreateAlbum}
          style={{ backgroundColor: 'var(--accent)' }}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          <FolderPlus className="w-4 h-4" aria-hidden="true" />
          <span>New Album</span>
        </button>
      </div>

      {/* High-Tech Filter & Search Panel */}
      <section
        aria-label="Search and filter your albums"
        className="mt-7 tech-panel rounded-2xl p-4 sm:p-5 space-y-3.5"
      >
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <label htmlFor="albums-search-input" className="sr-only">
              Search your albums by title, tags, or metadata
            </label>
            <Search
              className="w-4 h-4 text-[#00A846] dark:text-[#00E676] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="albums-search-input"
              type="text"
              role="searchbox"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && hasActiveSearch) {
                  setSearchQuery('');
                }
              }}
              aria-label="Search your albums by title, tags, or metadata"
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-10 py-2.5 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#1F3126] rounded-xl text-[#0C120E] dark:text-[#EEF4F0] placeholder:text-[#6A7B6F] dark:placeholder:text-[#687E70] focus:border-[#00E676] dark:focus:border-[#FFD600] focus:outline-none transition-colors"
            />
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear album search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0] rounded-md"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between md:justify-end gap-3 shrink-0">
            <div
              role="group"
              aria-label="Album search filter field"
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
                  data-testid="albums-search-summary"
                  aria-live="polite"
                  className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]"
                >
                  {filteredOwned.length} of {ownedAlbums.length}{' '}
                  {ownedAlbums.length === 1 ? 'album' : 'albums'}
                  {sharedAlbums.length > 0 ? ` · ${filteredShared.length} shared` : ''}
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

        <div className="pt-3 border-t border-[#E0E9E2] dark:border-[#17241C] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Filter albums by privacy visibility"
              className="inline-flex items-center p-1 bg-[#E8EFEA] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#1C2A21] rounded-lg overflow-x-auto max-w-full"
            >
              {(
                [
                  { id: 'all', label: `All (${counts.all})` },
                  { id: 'private', label: `Private (${counts.private})` },
                  { id: 'unlisted', label: `Unlisted (${counts.unlisted})` },
                  { id: 'public', label: `Public (${counts.public})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 tabular-nums transition-colors ${
                    filter === tab.id
                      ? 'bg-white dark:bg-[#132118] text-[#00A846] dark:text-[#FFD600] shadow-xs'
                      : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {availableTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono-tabular text-[11px] uppercase tracking-wider text-[#6A7B6F] dark:text-[#6E8575]">
                  Tags:
                </span>
                {availableTags.map((tag) => {
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
            )}
          </div>

          <p className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395] shrink-0">
            Total archived: {formatBytes(user.totalBytesUploaded)} · Unlimited storage
          </p>
        </div>
      </section>

      {/* Owned Albums Grid */}
      {loading ? (
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-80 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : filteredOwned.length === 0 ? (
        <div className="mt-8 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-12 text-center">
          <h2 className="font-serif-editorial text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0]">
            {hasActiveSearch
              ? 'No matching albums'
              : filter === 'all'
                ? 'Create your first album'
                : `No ${filter} albums yet`}
          </h2>
          <p className="mt-2 text-sm text-[#526056] dark:text-[#8FA395] max-w-md mx-auto">
            {hasActiveSearch
              ? `No albums matched "${searchQuery.trim()}"${filter !== 'all' ? ` in ${filter} collections` : ''}.`
              : filter === 'all'
                ? 'Albums hold unlimited files and keep your private vaults separate from public galleries.'
                : 'Create a new album or adjust the privacy setting on an existing collection.'}
          </p>
          {hasActiveSearch ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setFilter('all');
              }}
              className="mt-6 px-4 py-2 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors"
            >
              Clear search & filters
            </button>
          ) : (
            <button
              type="button"
              onClick={onCreateAlbum}
              style={{ backgroundColor: 'var(--accent)' }}
              className="mt-6 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              Create Album
            </button>
          )}
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {filteredOwned.map((album) => (
            <article
              key={album.id}
              className="tech-panel rounded-2xl overflow-hidden flex flex-col hover:border-[#00E676]/55 dark:hover:border-[#FFD600]/55 transition-colors"
            >
              <button
                type="button"
                onClick={() => onOpenAlbum(album.id)}
                aria-label={`Open album ${album.title}`}
                className="group block text-left"
              >
                <MediaSurface
                  src={album.coverUrl}
                  alt={album.title}
                  className="aspect-[16/10] border-b border-[#D4DFD7] dark:border-[#1C2A21]"
                  imgClassName="group-hover:scale-[1.03]"
                  showVideoBadge={false}
                />
              </button>

              <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <VisibilityInline
                      visibility={album.visibility}
                      hasPasscode={album.hasPasscode}
                    />
                    <span className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]">
                      {album.itemCount.toLocaleString()} {album.itemCount === 1 ? 'file' : 'files'} · {formatBytes(album.totalBytes)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenAlbum(album.id)}
                    className="mt-2.5 block text-left font-serif-editorial text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0] hover:text-[#00A846] dark:hover:text-[#FFD600] transition-colors"
                  >
                    {album.title}
                  </button>

                  {album.description && (
                    <p className="mt-1 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395] line-clamp-2">
                      {album.description}
                    </p>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-[#6A7B6F] dark:text-[#6E8575]">
                    <span className="inline-flex items-center gap-1 font-mono-tabular text-[#00A846] dark:text-[#00E676]">
                      <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{formatViewCount(album.viewCount)}</span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Updated {formatRelativeDate(album.updatedAt)}
                      {album.members && album.members.length > 0
                        ? ` · ${album.members.length} ${album.members.length === 1 ? 'collaborator' : 'collaborators'}`
                        : ''}
                    </span>
                  </div>

                  {album.tags && album.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono-tabular text-[#6A7B6F] dark:text-[#6E8575]">
                      {album.tags.slice(0, 5).map((tag) => (
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
                </div>

                {/* Quick Visibility & Management Actions */}
                <div className="pt-4 border-t border-[#E1EAE3] dark:border-[#262C21] flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor={`vis-${album.id}`}
                      className="text-xs font-medium text-[#526056] dark:text-[#8FA395]"
                    >
                      Privacy
                    </label>
                    <select
                      id={`vis-${album.id}`}
                      value={album.visibility}
                      disabled={changingId === album.id}
                      onChange={async (e) => {
                        const nextVis = e.target.value as AlbumVisibility;
                        setChangingId(album.id);
                        try {
                          await onQuickVisibilityChange(album, nextVis);
                        } finally {
                          setChangingId(null);
                        }
                      }}
                      className="text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-md px-2.5 py-1.5"
                    >
                      <option value="private">Private (Owner & Invited)</option>
                      <option value="unlisted">Unlisted (Share Link)</option>
                      <option value="public">Public (Explore Gallery)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onUploadToAlbum(album.id)}
                        aria-label={`Upload media to ${album.title}`}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-md hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors whitespace-nowrap shrink-0"
                      >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Upload</span>
                      </button>
                      {onChangeCover && (
                        <button
                          type="button"
                          onClick={() => onChangeCover(album)}
                          aria-label={`Change cover photo for ${album.title}`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-md hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors whitespace-nowrap shrink-0"
                        >
                          <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Cover</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenShareModal(album)}
                        aria-label={`Share and privacy settings for ${album.title}`}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#00A846] dark:text-[#FFD600] bg-[#00A846]/10 dark:bg-[#FFD600]/10 border border-[#00A846]/30 dark:border-[#FFD600]/30 rounded-md hover:bg-[#00A846]/20 dark:hover:bg-[#FFD600]/20 transition-colors whitespace-nowrap shrink-0"
                      >
                        <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Share</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => onDeleteAlbum(album)}
                      aria-label={`Delete album ${album.title}`}
                      className="p-2 text-[#526056] dark:text-[#8FA395] hover:text-[#E11D32] dark:hover:text-red-400 hover:bg-[#FEF2F2] dark:hover:bg-red-950/40 rounded-md transition-colors"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Shared with Me Section */}
      {sharedAlbums.length > 0 && (
        <section className="mt-16 pt-10 border-t border-[#D4DFD7] dark:border-[#1C2A21]">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
                Shared with You
              </h2>
              <p className="mt-1 text-sm text-[#526056] dark:text-[#8FA395]">
                Private and unlisted albums where you have been granted viewer or contributor access.
              </p>
            </div>
            {hasActiveSearch && (
              <p className="font-mono-tabular text-xs text-[#526056] dark:text-[#8FA395]">
                {filteredShared.length} of {sharedAlbums.length} shared
              </p>
            )}
          </div>

          {filteredShared.length === 0 ? (
            <p className="mt-6 text-sm text-[#526056] dark:text-[#8FA395]">
              No shared albums matched &ldquo;{searchQuery.trim()}&rdquo;.
            </p>
          ) : (
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredShared.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  onClick={() => onOpenAlbum(album.id)}
                  aria-label={`Open shared album ${album.title}`}
                  className="group text-left bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl overflow-hidden hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors"
                >
                  <MediaSurface
                    src={album.coverUrl}
                    alt={album.title}
                    className="aspect-[16/10] border-b border-[#D4DFD7] dark:border-[#1C2A21]"
                    imgClassName="group-hover:scale-[1.03]"
                    showVideoBadge={false}
                  />
                  <div className="p-5">
                    <p className="font-serif-editorial text-lg font-medium text-[#0C120E] dark:text-[#EEF4F0]">
                      {album.title}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#526056] dark:text-[#8FA395]">
                      <span>By {album.ownerName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{album.viewerRole}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular">{album.itemCount.toLocaleString()} items</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1 font-mono-tabular text-[#00A846] dark:text-[#00E676]">
                        <Eye className="w-3 h-3" aria-hidden="true" />
                        <span>{formatViewCount(album.viewCount)}</span>
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
