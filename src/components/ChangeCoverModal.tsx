import React, { useRef, useState } from 'react';
import { Check, Image as ImageIcon, Trash2, Upload, X } from 'lucide-react';
import type { Album, MediaItem } from '../types/media';
import { resolveProtectedUrl } from '../lib/api';
import { prepareImageDataUrl } from '../utils/imageUpload';

interface ChangeCoverModalProps {
  album: Album;
  media: MediaItem[];
  onClose: () => void;
  onUploadCoverFile: (albumId: string, dataUrl: string) => Promise<void>;
  onSelectMediaCover: (albumId: string, coverUrl: string) => Promise<void>;
  onRemoveCover: (albumId: string) => Promise<void>;
}

export function ChangeCoverModal({
  album,
  media,
  onClose,
  onUploadCoverFile,
  onSelectMediaCover,
  onRemoveCover,
}: ChangeCoverModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectableMedia = media.filter((m) => Boolean(m.posterUrl || m.kind === 'photo'));

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const dataUrl = await prepareImageDataUrl(file, {
        maxDimension: 1600,
        squareCrop: false,
        quality: 0.86,
      });
      await onUploadCoverFile(album.id, dataUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload cover photo.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectExisting = async (coverUrl: string) => {
    setError('');
    setBusy(true);
    try {
      await onSelectMediaCover(album.id, coverUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update album cover.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setError('');
    setBusy(true);
    try {
      await onRemoveCover(album.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset cover photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Change cover photo for ${album.title}`}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden my-auto">
        <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#E1EAE3] dark:border-[#262C21]">
          <div>
            <h2 className="font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Change Album Cover Photo
            </h2>
            <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">
              Upload a custom cover image or pick a frame from “{album.title}”.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cover photo dialog"
            className="p-2 text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white rounded-lg hover:bg-[#E8EFEA] dark:hover:bg-[#1E2418]"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {error && (
            <p
              role="alert"
              className="text-xs font-medium text-[#E11D32] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {error}
            </p>
          )}

          {/* Current Cover Preview + Upload Custom Photo */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 p-4 rounded-xl bg-[#F3F6F4] dark:bg-[#060807] border border-[#D4DFD7] dark:border-[#1C2A21]">
            <div className="w-full sm:w-44 aspect-[16/10] rounded-lg overflow-hidden bg-[#E8EFEA] dark:bg-[#1B2117] border border-[#C6D5CA] dark:border-[#24382B] flex items-center justify-center shrink-0">
              {album.coverUrl ? (
                <img
                  src={resolveProtectedUrl(album.coverUrl)}
                  alt={`Current cover for ${album.title}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center px-3">
                  <ImageIcon className="w-6 h-6 mx-auto text-[#6A7B6F]" aria-hidden="true" />
                  <span className="mt-1 block text-[11px] text-[#6A7B6F]">No cover yet</span>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Upload Custom Cover Photo
              </h3>
              <p className="mt-1 text-xs text-[#526056] dark:text-[#8FA395]">
                Choose any JPEG, PNG, or WebP photo from your phone or computer.
              </p>

              <input
                ref={fileInputRef}
                id="album-cover-file-input"
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="sr-only"
              />

              <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ backgroundColor: 'var(--accent)' }}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{busy ? 'Uploading...' : 'Upload New Cover'}</span>
                </button>

                {album.coverUrl && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRemove()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#E11D32] dark:text-red-400 hover:bg-red-500/10 rounded-lg disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Reset Cover</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Choose from existing photos/video posters in this album */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#526056] dark:text-[#8FA395]">
              Or Choose From Album Media ({selectableMedia.length})
            </h3>

            {selectableMedia.length === 0 ? (
              <p className="mt-2 text-xs text-[#6A7B6F] dark:text-[#6E8575]">
                No photos or video thumbnails in this album yet — upload a custom cover photo above.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {selectableMedia.slice(0, 24).map((item) => {
                  const candidateUrl = item.posterUrl || item.mediaUrl;
                  const isActive = album.coverUrl === candidateUrl;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSelectExisting(candidateUrl)}
                      aria-label={`Set ${item.title} as album cover`}
                      className={`group relative aspect-[4/3] rounded-xl overflow-hidden border text-left transition-all ${
                        isActive
                          ? 'border-[#00E676] dark:border-[#FFD600] ring-2 ring-[#00E676] dark:ring-[#FFD600]'
                          : 'border-[#D4DFD7] dark:border-[#1C2A21] hover:border-[#00E676] dark:hover:border-[#FFD600]'
                      }`}
                    >
                      <img
                        src={resolveProtectedUrl(candidateUrl)}
                        alt={item.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2.5 py-2 text-[11px] font-medium text-white truncate">
                        {item.title}
                      </span>
                      {isActive && (
                        <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#00A846] dark:bg-[#FFD600] text-white dark:text-[#0C120E] flex items-center justify-center shadow">
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
