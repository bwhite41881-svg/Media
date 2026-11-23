import React, { useEffect, useState } from 'react';
import { ArrowRight, KeyRound, Link2, Lock, ShieldAlert } from 'lucide-react';
import type { Album, MediaItem } from '../types/media';
import { api } from '../lib/api';
import { formatBytes, formatRelativeDate } from '../utils/albumLogic';
import { MediaSurface } from './MediaSurface';

interface SharedLinkViewProps {
  initialToken: string;
  sharedAlbums: Album[];
  onOpenAlbum: (albumId: string) => void;
  onOpenMedia: (item: MediaItem, collection: MediaItem[], canDownload: boolean) => void;
  onTokenChange: (token: string) => void;
}

export function SharedLinkView({
  initialToken,
  sharedAlbums,
  onOpenAlbum,
  onOpenMedia,
  onTokenChange,
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

  const loadToken = async (raw: string) => {
    const cleaned = extractToken(raw);
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
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resolve share link.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTokenInput(initialToken);
    if (initialToken) {
      void loadToken(initialToken);
    } else {
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
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Incorrect passcode.');
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-6 sm:px-8 pt-10 pb-24">
      {/* Lookup Bar */}
      <section className="pb-8 border-b border-[#E2DCC8] dark:border-[#2A3124]">
        <p className="text-xs font-medium text-[#008732] dark:text-[#FCD116]">Direct Share Access</p>
        <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA]">
          Shared Albums & Links
        </h1>
        <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
          Paste an unlisted or private share link (or token) below to open a shared collection.
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
            className="flex-1 px-4 py-2.5 text-sm bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
          />
          <button
            type="submit"
            disabled={loading}
            style={{ backgroundColor: 'var(--accent)' }}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
          >
            <span>{loading ? 'Opening...' : 'Open Link'}</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </form>
      </section>

      {/* Error / Revoked Link State */}
      {error && (
        <div className="mt-8 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-8 max-w-lg">
          <ShieldAlert className="w-7 h-7 text-[#CE1126] dark:text-red-400" aria-hidden="true" />
          <h2 className="mt-3 font-display text-xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
            Access Restricted
          </h2>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">{error}</p>
        </div>
      )}

      {/* Passcode Gate */}
      {lockedMeta && (
        <div className="mt-8 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-8 max-w-md">
          <KeyRound className="w-7 h-7 text-[#008732] dark:text-[#FCD116]" aria-hidden="true" />
          <h2 className="mt-3 font-serif-editorial text-2xl font-medium text-[#151811] dark:text-[#F5F3EA]">
            {lockedMeta.albumTitle}
          </h2>
          <p className="mt-1.5 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
            Shared by {lockedMeta.ownerName} · {lockedMeta.itemCount.toLocaleString()}{' '}
            {lockedMeta.itemCount === 1 ? 'item' : 'items'}
          </p>
          <p className="mt-4 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
            The owner locked this album with a passcode. Enter it below to unlock the media.
          </p>

          <form onSubmit={handleUnlock} className="mt-5 space-y-3">
            <div>
              <label htmlFor="share-passcode-input" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Album Passcode
              </label>
              <input
                id="share-passcode-input"
                type="password"
                required
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Enter passcode"
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              />
            </div>

            {unlockError && (
              <p role="alert" className="text-xs font-medium text-[#CE1126] dark:text-red-400">
                {unlockError}
              </p>
            )}

            <button
              type="submit"
              disabled={unlocking}
              style={{ backgroundColor: 'var(--accent)' }}
              className="w-full px-4 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {unlocking ? 'Verifying...' : 'Unlock Album'}
            </button>
          </form>
        </div>
      )}

      {/* Unlocked Shared Album */}
      {resolved && (
        <section className="mt-8">
          <div className="pb-6 border-b border-[#E2DCC8] dark:border-[#2A3124]">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              <span className="inline-flex items-center gap-1 font-medium text-[#008732] dark:text-[#FCD116]">
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                Shared Link Unlocked
              </span>
              <span aria-hidden="true">·</span>
              <span>By {resolved.album.ownerName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">
                {resolved.media.length.toLocaleString()} {resolved.media.length === 1 ? 'item' : 'items'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">{formatBytes(resolved.album.totalBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{resolved.canDownload ? 'Downloads enabled' : 'View only'}</span>
            </div>

            <h2 className="mt-2 font-serif-editorial text-3xl font-medium text-[#151811] dark:text-[#F5F3EA]">
              {resolved.album.title}
            </h2>
            {resolved.album.description && (
              <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C] max-w-2xl">
                {resolved.album.description}
              </p>
            )}
          </div>

          {resolved.media.length === 0 ? (
            <div className="mt-8 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-12 text-center">
              <p className="text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
                No photos or videos in this shared album yet.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {resolved.media.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenMedia(item, resolved.media, resolved.canDownload)}
                  aria-label={`Open shared ${item.kind} ${item.title}`}
                  className="group text-left"
                >
                  <MediaSurface
                    src={item.posterUrl || (item.kind === 'photo' ? item.mediaUrl : '')}
                    alt={item.title}
                    kind={item.kind}
                    durationSec={item.durationSec}
                    className="aspect-[4/3] rounded-2xl border border-[#E2DCC8] dark:border-[#2A3124]"
                    imgClassName="group-hover:scale-[1.03]"
                  />
                  <div className="mt-3 flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] group-hover:text-[#008732] dark:group-hover:text-[#FCD116] truncate">
                      {item.title}
                    </h3>
                    <span className="font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C] shrink-0">
                      {formatBytes(item.fileSize)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                    {formatRelativeDate(item.createdAt)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Collaborator Shared Albums */}
      {sharedAlbums.length > 0 && (
        <section className="mt-14 pt-8 border-t border-[#E2DCC8] dark:border-[#2A3124]">
          <h2 className="font-display text-xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
            Collaborator Albums Shared with Your Account
          </h2>
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sharedAlbums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => onOpenAlbum(album.id)}
                className="group text-left bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl overflow-hidden hover:border-[#009B3A] dark:hover:border-[#FCD116] transition-colors"
              >
                <MediaSurface
                  src={album.coverUrl}
                  alt={album.title}
                  className="aspect-[16/10] border-b border-[#E2DCC8] dark:border-[#2A3124]"
                  imgClassName="group-hover:scale-[1.03]"
                  showVideoBadge={false}
                />
                <div className="p-4">
                  <p className="font-serif-editorial text-lg font-medium text-[#151811] dark:text-[#F5F3EA]">
                    {album.title}
                  </p>
                  <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C] inline-flex items-center gap-1.5">
                    <Lock className="w-3 h-3" aria-hidden="true" />
                    <span>
                      {album.ownerName} · {album.viewerRole} · {album.itemCount.toLocaleString()} items
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
