import React, { useState } from 'react';
import {
  Check,
  Copy,
  Globe,
  KeyRound,
  Link2,
  Lock,
  RefreshCw,
  ShieldOff,
  UserPlus,
  X,
} from 'lucide-react';
import type { Album, AlbumMember, AlbumVisibility, MemberRole } from '../types/media';

interface SharePrivacyModalProps {
  album: Album;
  members: AlbumMember[];
  onClose: () => void;
  onUpdateSettings: (
    albumId: string,
    payload: {
      visibility?: AlbumVisibility;
      allowDownloads?: boolean;
      passcode?: string;
      clearPasscode?: boolean;
      regenerateShareToken?: boolean;
      revokeShareToken?: boolean;
    }
  ) => Promise<void>;
  onAddMember: (albumId: string, identifier: string, role: MemberRole) => Promise<void>;
  onRemoveMember: (albumId: string, memberId: string) => Promise<void>;
  onOpenSharePreview: (shareToken: string) => void;
}

export function SharePrivacyModal({
  album,
  members,
  onClose,
  onUpdateSettings,
  onAddMember,
  onRemoveMember,
  onOpenSharePreview,
}: SharePrivacyModalProps) {
  const [passcodeInput, setPasscodeInput] = useState('');
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const shareUrl = album.shareToken
    ? `${window.location.origin}/?share=${encodeURIComponent(album.shareToken)}`
    : '';

  const runAction = async (fn: () => Promise<void>, successText?: string) => {
    setError('');
    setStatusMessage('');
    setBusy(true);
    try {
      await fn();
      if (successText) setStatusMessage(successText);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteIdentifier.trim()) {
      setError('Enter an email address or account handle.');
      return;
    }
    await runAction(async () => {
      await onAddMember(album.id, inviteIdentifier.trim(), inviteRole);
      setInviteIdentifier('');
    }, 'Collaborator access granted.');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Share and privacy controls for ${album.title}`}
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />
        <div className="flex items-start justify-between gap-4 p-6 border-b border-[#ECE8D9] dark:border-[#262C21]">
          <div>
            <p className="text-xs font-medium text-[#008732] dark:text-[#FCD116]">
              Album Access & Sharing
            </p>
            <h2 className="mt-1 font-serif-editorial text-2xl font-medium text-[#151811] dark:text-[#F5F3EA]">
              {album.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share settings"
            className="p-2 text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white rounded-lg hover:bg-[#EFEBD9] dark:hover:bg-[#1E2418]"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-7">
          {error && (
            <p
              role="alert"
              className="text-xs font-medium text-[#CE1126] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-900 rounded-lg px-3.5 py-2.5"
            >
              {error}
            </p>
          )}
          {statusMessage && (
            <p
              role="status"
              className="text-xs font-medium text-[#008732] dark:text-[#4ADE80] bg-[#F0FDF4] dark:bg-emerald-950/50 border border-[#BBF7D0] dark:border-emerald-900 rounded-lg px-3.5 py-2.5"
            >
              {statusMessage}
            </p>
          )}

          {/* 1. Visibility Tier Selector */}
          <section>
            <h3 className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">Privacy Tier</h3>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(
                [
                  {
                    id: 'private' as const,
                    title: 'Private',
                    desc: 'Only you, invited collaborators, or holders of an active share link.',
                    icon: Lock,
                  },
                  {
                    id: 'unlisted' as const,
                    title: 'Unlisted Link',
                    desc: 'Hidden from Explore. Accessible to anyone with your share link.',
                    icon: Link2,
                  },
                  {
                    id: 'public' as const,
                    title: 'Public',
                    desc: 'Published in the public Explore gallery and open to everyone.',
                    icon: Globe,
                  },
                ]
              ).map((opt) => {
                const Icon = opt.icon;
                const active = album.visibility === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () => onUpdateSettings(album.id, { visibility: opt.id }),
                        `Album visibility set to ${opt.title}.`
                      )
                    }
                    className={`text-left p-3.5 rounded-xl border transition-colors ${
                      active
                        ? 'border-[#008732] dark:border-[#FCD116] bg-[#008732]/10 dark:bg-[#FCD116]/10'
                        : 'border-[#E2DCC8] dark:border-[#2A3124] bg-white dark:bg-[#0D0F0B] hover:border-[#009B3A] dark:hover:border-[#FCD116]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        className={`w-4 h-4 ${
                          active
                            ? 'text-[#008732] dark:text-[#FCD116]'
                            : 'text-[#5A5E52] dark:text-[#A6AA9C]'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA]">
                        {opt.title}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
                      {opt.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2. Share Link & Revocation */}
          <section className="pt-6 border-t border-[#ECE8D9] dark:border-[#262C21]">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Direct Share Link
              </h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      () => onUpdateSettings(album.id, { regenerateShareToken: true }),
                      'Generated a new share link. Previous links are now invalidated.'
                    )
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#008732] dark:text-[#FCD116] hover:underline"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{album.shareToken ? 'Regenerate Link' : 'Generate Link'}</span>
                </button>
                {album.shareToken && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(
                        () => onUpdateSettings(album.id, { revokeShareToken: true }),
                        'Share link revoked. External link holders can no longer access this album.'
                      )
                    }
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#CE1126] dark:text-red-400 hover:underline"
                  >
                    <ShieldOff className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Revoke</span>
                  </button>
                )}
              </div>
            </div>

            {shareUrl ? (
              <div className="mt-3 flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  readOnly
                  aria-label="Album share link URL"
                  value={shareUrl}
                  className="flex-1 px-3 py-2 text-xs font-mono-tabular bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    style={{ backgroundColor: 'var(--accent)' }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 whitespace-nowrap"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy Link'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenSharePreview(album.shareToken)}
                    className="px-3 py-2 text-xs font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#1D2318] border border-[#D8D1BC] dark:border-[#343D2C] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] whitespace-nowrap"
                  >
                    Preview
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-2.5 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Share link is currently revoked. Click “Generate Link” above to issue a fresh URL.
              </p>
            )}
          </section>

          {/* 3. Passcode Protection & Downloads */}
          <section className="pt-6 border-t border-[#ECE8D9] dark:border-[#262C21] grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <div className="flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[#B88200] dark:text-[#FCD116]" aria-hidden="true" />
                <h3 className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                  Passcode Lock ({album.hasPasscode ? 'Active' : 'Off'})
                </h3>
              </div>
              <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Require a passcode before external share-link visitors can view media.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="password"
                  value={passcodeInput}
                  onChange={(e) => setPasscodeInput(e.target.value)}
                  aria-label="Set album passcode"
                  placeholder={album.hasPasscode ? 'New passcode (min 4 chars)' : 'Set passcode (min 4 chars)'}
                  className="flex-1 min-w-0 px-3 py-1.5 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
                />
                <button
                  type="button"
                  disabled={busy || passcodeInput.trim().length < 4}
                  onClick={() =>
                    void runAction(async () => {
                      await onUpdateSettings(album.id, { passcode: passcodeInput.trim() });
                      setPasscodeInput('');
                    }, 'Album passcode updated.')
                  }
                  style={{ backgroundColor: 'var(--accent)' }}
                  className="px-3 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-40 whitespace-nowrap"
                >
                  Save
                </button>
              </div>
              {album.hasPasscode && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      () => onUpdateSettings(album.id, { clearPasscode: true }),
                      'Album passcode removed.'
                    )
                  }
                  className="mt-2 text-xs font-medium text-[#CE1126] dark:text-red-400 hover:underline"
                >
                  Remove passcode
                </button>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Original File Downloads
              </h3>
              <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Control whether viewers can download full-resolution photo and video originals.
              </p>
              <label className="mt-3 inline-flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={album.allowDownloads}
                  disabled={busy}
                  onChange={(e) =>
                    void runAction(
                      () => onUpdateSettings(album.id, { allowDownloads: e.target.checked }),
                      e.target.checked
                        ? 'Original downloads enabled.'
                        : 'Original downloads restricted to owner and contributors.'
                    )
                  }
                  className="w-4 h-4 rounded accent-[#008732]"
                />
                <span className="text-xs font-medium text-[#151811] dark:text-[#F5F3EA]">
                  Allow viewers to download originals
                </span>
              </label>
            </div>
          </section>

          {/* 4. Collaborators */}
          <section className="pt-6 border-t border-[#ECE8D9] dark:border-[#262C21]">
            <h3 className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Invited Collaborators
            </h3>
            <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              Grant specific accounts persistent access to private albums as Viewer or Contributor.
            </p>

            <form onSubmit={handleInvite} className="mt-3 flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={inviteIdentifier}
                onChange={(e) => setInviteIdentifier(e.target.value)}
                aria-label="Collaborator email or handle"
                placeholder="Email address or @handle"
                className="flex-1 px-3 py-2 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as MemberRole)}
                aria-label="Collaborator role"
                className="px-3 py-2 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              >
                <option value="viewer">Viewer</option>
                <option value="contributor">Contributor (Can Upload)</option>
              </select>
              <button
                type="submit"
                disabled={busy}
                style={{ backgroundColor: 'var(--accent)' }}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 whitespace-nowrap"
              >
                <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Invite</span>
              </button>
            </form>

            {members.length > 0 && (
              <ul className="mt-4 divide-y divide-[#ECE8D9] dark:divide-[#262C21] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl">
                {members.map((m) => (
                  <li key={m.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium text-[#151811] dark:text-[#F5F3EA] truncate">
                        {m.memberName}
                      </p>
                      <p className="text-[#5A5E52] dark:text-[#A6AA9C] truncate">
                        {m.email} · <span className="capitalize">{m.role}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(
                          () => onRemoveMember(album.id, m.id),
                          `Revoked access for ${m.memberName}.`
                        )
                      }
                      aria-label={`Remove collaborator ${m.memberName}`}
                      className="text-xs font-medium text-[#CE1126] dark:text-red-400 hover:underline shrink-0"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
