import React, { useRef, useState } from 'react';
import { Image as ImageIcon, Upload, X } from 'lucide-react';
import type { Album, AlbumVisibility } from '../types/media';
import { sanitizeTags, validateAlbumInput } from '../utils/albumLogic';
import { resolveProtectedUrl } from '../lib/api';
import { prepareImageDataUrl } from '../utils/imageUpload';

interface CreateEditAlbumModalProps {
  existingAlbum?: Album | null;
  defaultVisibility?: AlbumVisibility;
  defaultAllowDownloads?: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    title: string;
    description: string;
    visibility: AlbumVisibility;
    allowDownloads: boolean;
    passcode?: string;
    tags?: string[];
    coverDataUrl?: string;
  }) => Promise<void>;
}

export function CreateEditAlbumModal({
  existingAlbum,
  defaultVisibility = 'private',
  defaultAllowDownloads = true,
  onClose,
  onSubmit,
}: CreateEditAlbumModalProps) {
  const [title, setTitle] = useState(existingAlbum?.title || '');
  const [description, setDescription] = useState(existingAlbum?.description || '');
  const [visibility, setVisibility] = useState<AlbumVisibility>(
    existingAlbum?.visibility || defaultVisibility
  );
  const [allowDownloads, setAllowDownloads] = useState<boolean>(
    existingAlbum?.allowDownloads ?? defaultAllowDownloads
  );
  const [passcode, setPasscode] = useState('');
  const [tagsInput, setTagsInput] = useState(
    (existingAlbum?.ownTags ?? existingAlbum?.tags ?? []).join(', ')
  );
  const [coverDataUrl, setCoverDataUrl] = useState<string>('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const previewCoverSrc =
    coverDataUrl || (existingAlbum?.coverUrl ? resolveProtectedUrl(existingAlbum.coverUrl) : '');

  const handleCoverPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const prepared = await prepareImageDataUrl(file, {
        maxDimension: 1600,
        squareCrop: false,
        quality: 0.86,
      });
      setCoverDataUrl(prepared);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read cover image.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const check = validateAlbumInput({ title, description, visibility, passcode });
    if (!check.valid) {
      setError(check.errors[0]);
      return;
    }

    const parsedTags = sanitizeTags(
      tagsInput
        .split(',')
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean)
    );

    setSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        visibility,
        allowDownloads,
        passcode: passcode.trim() || undefined,
        tags: parsedTags,
        coverDataUrl: coverDataUrl || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save album.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={existingAlbum ? `Edit album ${existingAlbum.title}` : 'Create new album'}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden my-auto">
        <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#E1EAE3] dark:border-[#262C21]">
          <h2 className="font-display text-xl font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
            {existingAlbum ? 'Edit Album' : 'Create Album'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close album form"
            className="p-2 text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white rounded-lg hover:bg-[#E8EFEA] dark:hover:bg-[#1E2418]"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {error && (
            <p
              role="alert"
              className="text-xs font-medium text-[#E11D32] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {error}
            </p>
          )}

          {/* Optional Album Cover Photo */}
          <div className="flex items-center gap-4 p-3 rounded-xl bg-[#F3F6F4] dark:bg-[#060807] border border-[#D4DFD7] dark:border-[#1C2A21]">
            <div className="w-24 h-16 rounded-lg overflow-hidden bg-[#E8EFEA] dark:bg-[#1B2117] border border-[#C6D5CA] dark:border-[#24382B] flex items-center justify-center shrink-0">
              {previewCoverSrc ? (
                <img
                  src={previewCoverSrc}
                  alt="Album cover preview"
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon className="w-5 h-5 text-[#6A7B6F]" aria-hidden="true" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Album Cover Photo (optional)
              </p>
              <input
                ref={coverInputRef}
                id="album-form-cover-input"
                type="file"
                accept="image/*"
                onChange={handleCoverPick}
                className="sr-only"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600]"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{previewCoverSrc ? 'Change Cover Photo' : 'Choose Cover Photo'}</span>
                </button>
                {coverDataUrl && (
                  <button
                    type="button"
                    onClick={() => setCoverDataUrl('')}
                    className="text-xs text-[#E11D32] dark:text-red-400 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="album-form-title" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Album Title
            </label>
            <input
              id="album-form-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Full Drop 2026"
              maxLength={120}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
            />
          </div>

          <div>
            <label htmlFor="album-form-desc" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Description (optional)
            </label>
            <textarea
              id="album-form-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes or album description..."
              maxLength={600}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
            />
          </div>

          <div>
            <label htmlFor="album-form-tags" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Tags (optional, comma-separated)
            </label>
            <input
              id="album-form-tags"
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g., roots, 4K, street, backstage"
              maxLength={240}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
            />
          </div>

          <div>
            <label htmlFor="album-form-vis" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Privacy Setting
            </label>
            <select
              id="album-form-vis"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as AlbumVisibility)}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
            >
              <option value="private">Private — Only you & invited accounts</option>
              <option value="unlisted">Unlisted — Accessible via direct share link</option>
              <option value="public">Public — Visible in Explore gallery</option>
            </select>
          </div>

          {!existingAlbum && visibility !== 'public' && (
            <div>
              <label htmlFor="album-form-passcode" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Optional Share Link Passcode
              </label>
              <input
                id="album-form-passcode"
                type="password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Leave blank for no passcode (min 4 chars)"
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
              />
            </div>
          )}

          <label className="pt-1 inline-flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={allowDownloads}
              onChange={(e) => setAllowDownloads(e.target.checked)}
              className="w-4 h-4 rounded accent-[#00A846]"
            />
            <span className="text-xs font-medium text-[#0C120E] dark:text-[#EEF4F0]">
              Allow viewers to download original photo & video files
            </span>
          </label>

          <div className="pt-4 border-t border-[#E1EAE3] dark:border-[#262C21] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-5 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? 'Saving...' : existingAlbum ? 'Save Changes' : 'Create Album'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
