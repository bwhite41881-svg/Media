import React, { useEffect, useRef, useState } from 'react';
import { Camera, LogOut, ShieldCheck, Sliders, Trash2, User as UserIcon } from 'lucide-react';
import type { Album, SiteSettings, UserAccount } from '../types/media';
import {
  computeStorageBreakdownByVisibility,
  computeStorageQuota,
  formatBytes,
  formatRelativeDate,
  getAllocatedStorageBytes,
} from '../utils/albumLogic';
import { prepareImageDataUrl } from '../utils/imageUpload';
import { UserAvatar } from './UserAvatar';

interface AccountViewProps {
  user: UserAccount | null;
  siteSettings: SiteSettings;
  ownedAlbums: Album[];
  onGoogleSignIn: () => Promise<void>;
  onLocalLogin: (identifier: string, password: string) => Promise<void>;
  onLocalRegister: (payload: {
    displayName: string;
    handle: string;
    email: string;
    password: string;
  }) => Promise<void>;
  onUpdateProfile: (payload: { displayName: string; handle: string; bio: string }) => Promise<void>;
  onUploadAvatar: (dataUrl: string) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onGoToAlbums: () => void;
  onGoToUpload: () => void;
  onGoToCPanel: () => void;
}

export function AccountView({
  user,
  siteSettings,
  ownedAlbums,
  onGoogleSignIn,
  onLocalLogin,
  onLocalRegister,
  onUpdateProfile,
  onUploadAvatar,
  onRemoveAvatar,
  onSignOut,
  onGoToAlbums,
  onGoToUpload,
  onGoToCPanel,
}: AccountViewProps) {
  const [authMode, setAuthMode] = useState<'register' | 'login'>(
    siteSettings.allowRegistrations ? 'register' : 'login'
  );
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  // Profile editor state
  const [editName, setEditName] = useState(user?.displayName || '');
  const [editHandle, setEditHandle] = useState(user?.handle || '');
  const [editBio, setEditBio] = useState(user?.bio || '');
  const [profileSaved, setProfileSaved] = useState('');

  useEffect(() => {
    if (user) {
      setEditName(user.displayName);
      setEditHandle(user.handle);
      setEditBio(user.bio || '');
    }
  }, [user?.uid, user?.displayName, user?.handle, user?.bio]);

  const handleAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setProfileSaved('');
    setAvatarBusy(true);
    try {
      const dataUrl = await prepareImageDataUrl(file, {
        maxDimension: 512,
        squareCrop: true,
        quality: 0.88,
      });
      await onUploadAvatar(dataUrl);
      setProfileSaved('Profile photo updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload profile photo.');
    } finally {
      setAvatarBusy(false);
    }
  };

  if (user) {
    const privateCount = ownedAlbums.filter((a) => a.visibility === 'private').length;
    const unlistedCount = ownedAlbums.filter((a) => a.visibility === 'unlisted').length;
    const publicCount = ownedAlbums.filter((a) => a.visibility === 'public').length;

    const breakdown = computeStorageBreakdownByVisibility(ownedAlbums);
    const effectiveUsedBytes = Math.max(user.totalBytesUploaded || 0, breakdown.totalAlbumBytes);
    const allocatedBytes = getAllocatedStorageBytes(user);
    const quota = computeStorageQuota(effectiveUsedBytes, allocatedBytes);

    const statusTextClass =
      quota.status === 'critical'
        ? 'text-[#E11D32] dark:text-[#FF4D5E]'
        : quota.status === 'warning'
          ? 'text-[#B88200] dark:text-[#FFD600]'
          : 'text-[#00A846] dark:text-[#00E676]';

    const statusBarClass =
      quota.status === 'critical'
        ? 'bg-[#E11D32] dark:bg-[#FF4D5E]'
        : quota.status === 'warning'
          ? 'bg-[#D99B00] dark:bg-[#FFD600]'
          : 'bg-[#00A846] dark:bg-[#00E676]';

    return (
      <div className="max-w-[1000px] mx-auto px-6 sm:px-8 pt-10 pb-24">
        <header className="pb-8 border-b border-[#D4DFD7] dark:border-[#1C2A21] flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="flex items-center gap-4 sm:gap-5">
            <UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size="xl" />
            <div>
              <p className="text-xs font-medium text-[#00A846] dark:text-[#FFD600]">
                Signed in via{' '}
                {user.provider === 'google'
                  ? 'Google Account (Cloud Sync)'
                  : `${siteSettings.siteName} Account`}
                {user.isAdmin ? ' · Site Admin' : ''}
              </p>
              <h1 className="mt-1.5 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
                {user.displayName}
              </h1>
              <p className="mt-1 text-sm text-[#526056] dark:text-[#8FA395]">
                @{user.handle} · {user.email} · Joined {formatRelativeDate(user.createdAt)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onSignOut()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#0C110E] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg hover:border-[#E11D32] transition-colors self-start sm:self-auto"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </header>

        {/* Storage & Privacy Summary */}
        <section className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-6 pb-8 border-b border-[#D4DFD7] dark:border-[#1C2A21]">
          <div>
            <p className="text-xs text-[#526056] dark:text-[#8FA395]">Archived Volume</p>
            <p className="mt-1 font-mono-tabular text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0]">
              {formatBytes(quota.usedBytes)}
            </p>
            <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">
              of {formatBytes(quota.allocatedBytes)} allocated
            </p>
          </div>
          <div>
            <p className="text-xs text-[#526056] dark:text-[#8FA395]">Private Albums</p>
            <p className="mt-1 font-mono-tabular text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0]">
              {privateCount}
            </p>
            <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">Owner & invited only</p>
          </div>
          <div>
            <p className="text-xs text-[#526056] dark:text-[#8FA395]">Unlisted Links</p>
            <p className="mt-1 font-mono-tabular text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0]">
              {unlistedCount}
            </p>
            <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">Token-gated</p>
          </div>
          <div>
            <p className="text-xs text-[#526056] dark:text-[#8FA395]">Public Albums</p>
            <p className="mt-1 font-mono-tabular text-xl font-medium text-[#0C120E] dark:text-[#EEF4F0]">
              {publicCount}
            </p>
            <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">Listed in Explore</p>
          </div>
        </section>

        {/* Visual Storage Quota Indicator */}
        <section
          aria-label="Storage quota utilization"
          data-testid="storage-quota-section"
          className="mt-8 tech-panel rounded-2xl p-5 sm:p-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
            <div>
              <p className="font-mono-tabular text-[10px] uppercase tracking-[0.14em] text-[#00A846] dark:text-[#00E676]">
                // VAULT TELEMETRY
              </p>
              <h2 className="mt-1 font-display text-base font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Storage Quota
              </h2>
              <p className="mt-0.5 text-xs text-[#526056] dark:text-[#8FA395]">
                <span className="font-mono-tabular font-medium text-[#0C120E] dark:text-[#EEF4F0]">
                  {formatBytes(quota.usedBytes)}
                </span>{' '}
                used of{' '}
                <span className="font-mono-tabular font-medium text-[#0C120E] dark:text-[#EEF4F0]">
                  {formatBytes(quota.allocatedBytes)}
                </span>{' '}
                {user.isAdmin ? 'studio allocation' : 'standard allocation'}
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs font-medium">
              <span
                className={`inline-block w-2 h-2 rounded-full ${statusBarClass}`}
                aria-hidden="true"
              />
              <span data-testid="storage-quota-status" className={statusTextClass}>
                {quota.statusLabel}
              </span>
              <span aria-hidden="true" className="text-[#B8C7BC] dark:text-[#294031]">
                ·
              </span>
              <span
                data-testid="storage-quota-percent"
                className="font-mono-tabular text-[#0C120E] dark:text-[#EEF4F0]"
              >
                {quota.percentLabel}
              </span>
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Storage quota utilization"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={quota.percentClamped}
            aria-valuetext={`${formatBytes(quota.usedBytes)} used of ${formatBytes(
              quota.allocatedBytes
            )} (${quota.percentLabel}, ${quota.statusLabel})`}
            className="mt-4 h-2.5 w-full rounded-full overflow-hidden bg-[#E8EFEA] dark:bg-[#132018] border border-transparent dark:border-[#1E3125]"
          >
            <div
              data-testid="storage-quota-bar"
              style={{ width: `${quota.percentBarWidth}%` }}
              className={`h-full rounded-full transition-[width] duration-300 ease-out shadow-[0_0_12px_rgba(0,230,118,0.5)] ${statusBarClass}`}
            />
          </div>

          <div className="mt-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-[#526056] dark:text-[#8FA395]">
            <p className="font-mono-tabular">
              {quota.isOverQuota
                ? `Quota exceeded by ${formatBytes(quota.usedBytes - quota.allocatedBytes)}`
                : `${formatBytes(quota.remainingBytes)} remaining`}
            </p>
            <p className="font-mono-tabular flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Public {formatBytes(breakdown.publicBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>Unlisted {formatBytes(breakdown.unlistedBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>Private {formatBytes(breakdown.privateBytes)}</span>
            </p>
          </div>
        </section>

        {/* Quick Actions + Profile Form */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6">
            <h2 className="font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
              Creator Profile
            </h2>
            <p className="mt-1 text-xs text-[#526056] dark:text-[#8FA395]">
              Your profile photo, display name, and handle appear on public albums, comments, and
              direct messages. Your email address remains strictly private.
            </p>

            {/* Profile Photo Uploader */}
            <div className="mt-5 p-4 rounded-xl bg-[#F3F6F4] dark:bg-[#060807] border border-[#D4DFD7] dark:border-[#1C2A21] flex flex-wrap items-center gap-4">
              <UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size="lg" />
              <div className="flex-1 min-w-[180px]">
                <p className="text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                  Profile Photo
                </p>
                <p className="mt-0.5 text-[11px] text-[#526056] dark:text-[#8FA395]">
                  JPEG, PNG, or WebP — cropped cleanly to a square avatar.
                </p>
                <input
                  ref={avatarInputRef}
                  id="profile-avatar-input"
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarSelected}
                  className="sr-only"
                />
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={avatarBusy}
                    onClick={() => avatarInputRef.current?.click()}
                    style={{ backgroundColor: 'var(--accent)' }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                  >
                    <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {avatarBusy
                        ? 'Uploading...'
                        : user.avatarUrl
                          ? 'Change Photo'
                          : 'Upload Photo'}
                    </span>
                  </button>
                  {user.avatarUrl && (
                    <button
                      type="button"
                      disabled={avatarBusy}
                      onClick={async () => {
                        setError('');
                        setProfileSaved('');
                        setAvatarBusy(true);
                        try {
                          await onRemoveAvatar();
                          setProfileSaved('Profile photo removed.');
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : 'Failed to remove profile photo.'
                          );
                        } finally {
                          setAvatarBusy(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#E11D32] dark:text-red-400 hover:bg-red-500/10 rounded-lg disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Remove</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError('');
                setProfileSaved('');
                setBusy(true);
                try {
                  await onUpdateProfile({
                    displayName: editName || user.displayName,
                    handle: editHandle || user.handle,
                    bio: editBio,
                  });
                  setProfileSaved('Profile updated.');
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Update failed.');
                } finally {
                  setBusy(false);
                }
              }}
              className="mt-5 space-y-4"
            >
              {error && (
                <p role="alert" className="text-xs text-[#E11D32] dark:text-red-400">
                  {error}
                </p>
              )}
              {profileSaved && (
                <p role="status" className="text-xs text-[#00A846] dark:text-[#00E676]">
                  {profileSaved}
                </p>
              )}

              <div>
                <label htmlFor="prof-name" className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]">
                  Display Name
                </label>
                <input
                  id="prof-name"
                  type="text"
                  value={editName || user.displayName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={80}
                  className="mt-1 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                />
              </div>

              <div>
                <label htmlFor="prof-handle" className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]">
                  Public Handle
                </label>
                <input
                  id="prof-handle"
                  type="text"
                  value={editHandle || user.handle}
                  onChange={(e) => setEditHandle(e.target.value)}
                  maxLength={40}
                  className="mt-1 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                />
              </div>

              <div>
                <label htmlFor="prof-bio" className="block text-xs font-medium text-[#526056] dark:text-[#8FA395]">
                  Bio (optional)
                </label>
                <textarea
                  id="prof-bio"
                  rows={3}
                  value={editBio}
                  onChange={(e) => setEditBio(e.target.value)}
                  maxLength={280}
                  placeholder="Creator bio or studio notes..."
                  className="mt-1 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                style={{ backgroundColor: 'var(--accent)' }}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Saving...' : 'Save Profile'}
              </button>
            </form>
          </div>

          <div className="lg:col-span-5 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6 flex flex-col justify-between gap-6">
            <div>
              <ShieldCheck className="w-6 h-6 text-[#00A846] dark:text-[#FFD600]" aria-hidden="true" />
              <h2 className="mt-3 font-display text-lg font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                Account Security
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-[#526056] dark:text-[#8FA395]">
                Private album files are protected at the media streaming layer. Direct file URLs
                return 403 Forbidden unless authenticated as the owner, invited collaborator, or
                unlocked via an active share link.
              </p>
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={onGoToUpload}
                style={{ backgroundColor: 'var(--accent)' }}
                className="w-full px-4 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90"
              >
                Open Bulk Upload Studio
              </button>
              <button
                type="button"
                onClick={onGoToAlbums}
                className="w-full px-4 py-2.5 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-[#F3F6F4] dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600]"
              >
                Manage My Albums
              </button>
              {user.isAdmin && (
                <button
                  type="button"
                  onClick={onGoToCPanel}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-[#0C120E] bg-[#FFD600] rounded-lg hover:bg-[#E6BE0E]"
                >
                  <Sliders className="w-4 h-4" aria-hidden="true" />
                  <span>Open Site cPanel</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 sm:px-8 pt-12 pb-24">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <div className="lg:col-span-5 pt-2">
          <UserIcon className="w-7 h-7 text-[#00A846] dark:text-[#FFD600]" aria-hidden="true" />
          <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0] text-balance">
            Your {siteSettings.siteName} vault, under your control.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[#526056] dark:text-[#8FA395]">
            Create an account to upload 5,000+ photos and full-length videos at once with zero file
            size caps, organize private and public albums, and issue revocable passcode-locked share
            links.
          </p>

          <div className="mt-8 pt-6 border-t border-[#D4DFD7] dark:border-[#1C2A21] space-y-4 text-xs text-[#526056] dark:text-[#8FA395]">
            <div>
              <p className="font-semibold text-[#0C120E] dark:text-[#FFD600]">
                5,000+ Files & Unlimited Size
              </p>
              <p className="mt-0.5">
                Parallel chunked streaming with folder drag-and-drop, pause, and resume.
              </p>
            </div>
            <div>
              <p className="font-semibold text-[#0C120E] dark:text-[#00E676]">
                Granular Album Privacy
              </p>
              <p className="mt-0.5">
                Private vaults, unlisted share links, passcodes, and collaborator roles.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-7 bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl p-6 sm:p-8">
          {/* Google Sign-In via Firebase Auth */}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setError('');
              setBusy(true);
              try {
                await onGoogleSignIn();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Google sign-in could not be completed.');
              } finally {
                setBusy(false);
              }
            }}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 text-sm font-medium text-[#0C120E] dark:text-[#EEF4F0] bg-white dark:bg-[#111A14] border border-[#C6D5CA] dark:border-[#294031] rounded-lg hover:border-[#00E676] dark:hover:border-[#FFD600] transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
              />
              <path
                fill="#34A853"
                d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.565 24 12.255 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
              />
              <path
                fill="#EA4335"
                d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.69 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          <div className="my-6 flex items-center gap-3 text-xs text-[#6A7B6F] dark:text-[#6E8575]">
            <span className="flex-1 h-px bg-[#E1EAE3] dark:bg-[#262C21]" />
            <span>or use email & password</span>
            <span className="flex-1 h-px bg-[#E1EAE3] dark:bg-[#262C21]" />
          </div>

          <div
            role="tablist"
            aria-label="Account authentication mode"
            className="grid grid-cols-2 p-1 bg-[#E8EFEA] dark:bg-[#060807] rounded-lg mb-5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'register'}
              onClick={() => {
                setAuthMode('register');
                setError('');
              }}
              className={`py-2 text-xs font-medium rounded-md transition-colors ${
                authMode === 'register'
                  ? 'bg-white dark:bg-[#132118] text-[#0C120E] dark:text-[#FFD600] shadow-xs'
                  : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
              }`}
            >
              Create Account
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'login'}
              onClick={() => {
                setAuthMode('login');
                setError('');
              }}
              className={`py-2 text-xs font-medium rounded-md transition-colors ${
                authMode === 'login'
                  ? 'bg-white dark:bg-[#132118] text-[#0C120E] dark:text-[#FFD600] shadow-xs'
                  : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-white'
              }`}
            >
              Sign In
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="mb-4 text-xs font-medium text-[#E11D32] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {error}
            </p>
          )}

          {authMode === 'register' ? (
            !siteSettings.allowRegistrations ? (
              <p className="text-sm text-[#526056] dark:text-[#8FA395] py-4">
                New local registrations are currently paused in the site cPanel. Please sign in with
                an existing account.
              </p>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError('');
                  setBusy(true);
                  try {
                    await onLocalRegister({ displayName, handle, email, password });
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Registration failed.');
                  } finally {
                    setBusy(false);
                  }
                }}
                className="space-y-4"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="reg-name" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                      Full Name
                    </label>
                    <input
                      id="reg-name"
                      type="text"
                      required
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Alex Rivera"
                      className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                    />
                  </div>
                  <div>
                    <label htmlFor="reg-handle" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                      Handle (optional)
                    </label>
                    <input
                      id="reg-handle"
                      type="text"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="alex.vault"
                      className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="reg-email" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                    Email Address
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@domain.com"
                    className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                  />
                </div>

                <div>
                  <label htmlFor="reg-pass" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                    Password (minimum 8 characters)
                  </label>
                  <input
                    id="reg-pass"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  style={{ backgroundColor: 'var(--accent)' }}
                  className="w-full px-4 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {busy ? 'Creating account...' : 'Create Account'}
                </button>
              </form>
            )
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError('');
                setBusy(true);
                try {
                  await onLocalLogin(identifier, password);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Sign in failed.');
                } finally {
                  setBusy(false);
                }
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="login-id" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                  Email or Handle
                </label>
                <input
                  id="login-id"
                  type="text"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="you@domain.com"
                  className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                />
              </div>

              <div>
                <label htmlFor="login-pass" className="block text-xs font-semibold text-[#0C120E] dark:text-[#EEF4F0]">
                  Password
                </label>
                <input
                  id="login-pass"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F3F6F4] dark:bg-[#060807] border border-[#C6D5CA] dark:border-[#24382B] rounded-lg text-[#0C120E] dark:text-[#EEF4F0]"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                style={{ backgroundColor: 'var(--accent)' }}
                className="w-full px-4 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {busy ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
