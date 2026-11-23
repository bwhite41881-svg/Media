import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Eye,
  Image as ImageIcon,
  MessageSquare,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import type { Album, MediaComment, MediaItem, UserAccount } from '../types/media';
import {
  formatBytes,
  formatDuration,
  formatRelativeDate,
  formatRelativeTime,
  mergeUniqueById,
  validateCommentBody,
} from '../utils/albumLogic';
import { formatViewCount } from '../utils/viewCounts';
import { api, resolveProtectedUrl } from '../lib/api';
import { deleteCommentFromFirestore, syncCommentToFirestore } from '../lib/firestoreSync';
import { getLocalMediaBackup } from '../lib/localMediaBackup';
import { realtimeClient } from '../lib/realtime';
import { UserAvatar } from './UserAvatar';

interface MediaLightboxProps {
  item: MediaItem;
  collection: MediaItem[];
  currentUser?: UserAccount | null;
  shareToken?: string | null;
  canEdit: boolean;
  canDownload: boolean;
  ownedAlbums: Album[];
  onClose: () => void;
  onSelect: (nextItem: MediaItem) => void;
  onSignIn?: () => void;
  onMessageUser?: (uid: string) => void;
  onUpdateMedia: (
    mediaId: string,
    payload: { title: string; caption: string; cameraMeta: string; tags: string[]; albumId?: string }
  ) => Promise<void>;
  onSetAlbumCover?: (albumId: string, coverUrl: string) => Promise<void>;
  onDeleteMedia: (mediaId: string) => Promise<void>;
  onMediaViewed?: (mediaId: string, viewCount: number) => void;
}

export function MediaLightbox({
  item,
  collection,
  currentUser,
  shareToken,
  canEdit,
  canDownload,
  ownedAlbums,
  onClose,
  onSelect,
  onSignIn,
  onMessageUser,
  onUpdateMedia,
  onSetAlbumCover,
  onDeleteMedia,
  onMediaViewed,
}: MediaLightboxProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [caption, setCaption] = useState(item.caption);
  const [cameraMeta, setCameraMeta] = useState(item.cameraMeta);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [targetAlbumId, setTargetAlbumId] = useState(item.albumId);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverSaved, setCoverSaved] = useState(false);
  const [localFallbackUrl, setLocalFallbackUrl] = useState<string | null>(null);
  const [mediaLoadError, setMediaLoadError] = useState(false);
  const [liveViewCount, setLiveViewCount] = useState<number>(Math.max(0, Number(item.viewCount) || 0));
  const fallbackAttemptedRef = useRef<string | null>(null);
  const onMediaViewedRef = useRef(onMediaViewed);
  onMediaViewedRef.current = onMediaViewed;

  // Real-time comments state
  const [comments, setComments] = useState<MediaComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [commentError, setCommentError] = useState('');

  const currentIdx = collection.findIndex((m) => m.id === item.id);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < collection.length - 1;

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setCoverSaved(false);
    setMediaLoadError(false);
    fallbackAttemptedRef.current = null;
    setLocalFallbackUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setTitle(item.title);
    setCaption(item.caption);
    setCameraMeta(item.cameraMeta);
    setTagsText(item.tags.join(', '));
    setTargetAlbumId(item.albumId);
    setLiveViewCount(Math.max(0, Number(item.viewCount) || 0));
    setCommentDraft('');
    setCommentError('');
  }, [item]);

  // Record a view whenever a photo or video is opened or stepped to in the lightbox
  useEffect(() => {
    let cancelled = false;
    api
      .recordMediaView(item.id, shareToken || undefined)
      .then((res) => {
        if (cancelled) return;
        setLiveViewCount(res.viewCount);
        onMediaViewedRef.current?.(item.id, res.viewCount);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item.id, shareToken]);

  useEffect(() => {
    return () => {
      if (localFallbackUrl) URL.revokeObjectURL(localFallbackUrl);
    };
  }, [localFallbackUrl]);

  const handleMediaError = () => {
    if (fallbackAttemptedRef.current === item.id) {
      setMediaLoadError(true);
      return;
    }
    fallbackAttemptedRef.current = item.id;
    void getLocalMediaBackup(item.id)
      .then((backup) => {
        if (backup?.blob) {
          const objectUrl = URL.createObjectURL(backup.blob);
          setLocalFallbackUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return objectUrl;
          });
          setMediaLoadError(false);
        } else {
          setMediaLoadError(true);
        }
      })
      .catch(() => setMediaLoadError(true));
  };

  // Load comments for current photo/video & subscribe to live WebSocket updates
  useEffect(() => {
    let cancelled = false;
    setLoadingComments(true);
    api
      .getMediaComments(item.id, shareToken || undefined)
      .then((res) => {
        if (!cancelled) setComments(res.comments);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingComments(false);
      });

    const unsub = realtimeClient.subscribe((event) => {
      if (event.type === 'comment:created' && event.mediaId === item.id) {
        setComments((prev) => mergeUniqueById(prev, event.comment));
      } else if (event.type === 'comment:deleted' && event.mediaId === item.id) {
        setComments((prev) => prev.filter((c) => c.id !== event.commentId));
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [item.id, shareToken]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (editing || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft' && hasPrev) onSelect(collection[currentIdx - 1]);
      if (e.key === 'ArrowRight' && hasNext) onSelect(collection[currentIdx + 1]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, editing, hasPrev, hasNext, collection, currentIdx, onSelect]);

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || postingComment) return;
    setCommentError('');
    const check = validateCommentBody(commentDraft);
    if (!check.valid) {
      setCommentError(check.error || 'Comment cannot be empty.');
      return;
    }
    setPostingComment(true);
    try {
      const { comment } = await api.postMediaComment(item.id, check.body, shareToken || undefined);
      setComments((prev) => mergeUniqueById(prev, comment));
      setCommentDraft('');
      void syncCommentToFirestore(comment, item.albumVisibility).catch(() => undefined);
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to post comment.');
    } finally {
      setPostingComment(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    setCommentError('');
    try {
      await api.deleteMediaComment(item.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      void deleteCommentFromFirestore(item.albumId, item.id, commentId).catch(() => undefined);
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to delete comment.');
    }
  };

  const resolvedMediaUrl = resolveProtectedUrl(item.mediaUrl);
  const resolvedPosterUrl = item.posterUrl ? resolveProtectedUrl(item.posterUrl) : '';
  const downloadHref = item.mediaUrl.startsWith('/api/media/')
    ? resolveProtectedUrl(`${item.mediaUrl}${item.mediaUrl.includes('?') ? '&' : '?'}download=1`)
    : item.mediaUrl;

  const handleCopyLink = async () => {
    const absoluteUrl = `${window.location.origin}${item.mediaUrl}`;
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${item.title}`}
      className="fixed inset-0 z-50 bg-[#050604] text-[#EEF4F0] flex flex-col lg:flex-row overflow-hidden"
    >
      {/* Main Media Stage */}
      <div className="relative flex-1 flex items-center justify-center min-h-[50vh] bg-[#050604] p-4 sm:p-10">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close media viewer"
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {hasPrev && (
          <button
            type="button"
            onClick={() => onSelect(collection[currentIdx - 1])}
            aria-label="Previous media item"
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        )}

        {hasNext && (
          <button
            type="button"
            onClick={() => onSelect(collection[currentIdx + 1])}
            aria-label="Next media item"
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <ChevronRight className="w-5 h-5" aria-hidden="true" />
          </button>
        )}

        {mediaLoadError ? (
          <div className="max-w-md w-full rounded-2xl border border-white/15 bg-white/5 p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-[#FFD600] mx-auto" aria-hidden="true" />
            <h3 className="mt-4 font-display text-lg font-semibold text-white">
              {item.kind === 'video' ? 'Video file unavailable' : 'Photo file unavailable'}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-white/70">
              This {item.kind} could not be loaded from the server. Re-upload it from your device to
              restore playback in this album.
            </p>
          </div>
        ) : item.kind === 'video' ? (
          <video
            key={`${item.id}:${localFallbackUrl ? 'local' : 'server'}`}
            src={localFallbackUrl || resolvedMediaUrl}
            poster={resolvedPosterUrl || undefined}
            controls
            playsInline
            preload="metadata"
            onError={handleMediaError}
            className="max-h-[82vh] max-w-full rounded-lg bg-black shadow-2xl"
          />
        ) : (
          <img
            key={`${item.id}:${localFallbackUrl ? 'local' : 'server'}`}
            src={localFallbackUrl || resolvedMediaUrl}
            alt={item.title}
            referrerPolicy="no-referrer"
            onError={handleMediaError}
            className="max-h-[85vh] max-w-full object-contain rounded-sm"
          />
        )}
      </div>

      {/* Archival Metadata & Controls Sidebar */}
      <aside className="w-full lg:w-[380px] bg-[#0E0E0D] border-t lg:border-t-0 lg:border-l border-white/10 p-6 sm:p-7 overflow-y-auto flex flex-col justify-between gap-6">
        <div>
          {!editing ? (
            <>
              <p className="text-xs text-white/60 tracking-wide">
                {item.kind === 'video' ? 'Video Reel' : 'Photograph'} · {formatRelativeDate(item.createdAt)}
              </p>
              <h2 className="mt-2 font-serif-editorial text-2xl font-medium text-white leading-snug text-balance">
                {item.title}
              </h2>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="text-xs text-white/65 truncate">
                  By {item.ownerName}
                  {item.albumTitle ? ` · ${item.albumTitle}` : ''}
                </p>
                {currentUser && currentUser.uid !== item.ownerId && onMessageUser && (
                  <button
                    type="button"
                    onClick={() => onMessageUser(item.ownerId)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-[#FFD600] bg-white/10 hover:bg-white/15 rounded-md shrink-0 transition-colors"
                  >
                    <MessageSquare className="w-3 h-3" aria-hidden="true" />
                    <span>Message</span>
                  </button>
                )}
              </div>

              {item.caption && (
                <p className="mt-4 text-sm leading-relaxed text-white/80">{item.caption}</p>
              )}

              <dl className="mt-6 pt-6 border-t border-white/10 space-y-3 text-xs">
                <div className="flex justify-between gap-4">
                  <dt className="text-white/55">Views</dt>
                  <dd
                    data-testid="lightbox-view-count"
                    className="inline-flex items-center gap-1.5 font-mono-tabular font-medium text-[#00E676]"
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{formatViewCount(liveViewCount)}</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-white/55">File Size</dt>
                  <dd className="font-mono-tabular text-white">{formatBytes(item.fileSize)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-white/55">Format</dt>
                  <dd className="font-mono-tabular text-white truncate max-w-[200px]">
                    {item.mimeType}
                  </dd>
                </div>
                {item.width > 0 && item.height > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-white/55">Resolution</dt>
                    <dd className="font-mono-tabular text-white">
                      {item.width} × {item.height}
                    </dd>
                  </div>
                )}
                {item.kind === 'video' && item.durationSec > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-white/55">Duration</dt>
                    <dd className="font-mono-tabular text-white">
                      {formatDuration(item.durationSec)}
                    </dd>
                  </div>
                )}
                {item.cameraMeta && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-white/55 shrink-0">Capture</dt>
                    <dd className="text-white text-right">{item.cameraMeta}</dd>
                  </div>
                )}
              </dl>

              {item.tags.length > 0 && (
                <div className="mt-5 pt-5 border-t border-white/10">
                  <p className="text-[11px] text-white/50">Tags</p>
                  <p className="mt-1.5 text-xs text-white/80 leading-relaxed">
                    {item.tags.join(' · ')}
                  </p>
                </div>
              )}

              {/* Comments on Photos & Videos */}
              <section
                aria-label="Comments"
                className="mt-6 pt-5 border-t border-white/10"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-white/75 flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-[#FFD600]" aria-hidden="true" />
                    <span>Comments ({comments.length})</span>
                  </h3>
                </div>

                {commentError && (
                  <p role="alert" className="mt-2 text-xs text-red-400">
                    {commentError}
                  </p>
                )}

                {currentUser ? (
                  <form onSubmit={handlePostComment} className="mt-3 flex items-center gap-2">
                    <input
                      id="media-comment-input"
                      type="text"
                      aria-label="Write a comment"
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      placeholder={`Comment on this ${item.kind}...`}
                      maxLength={600}
                      className="flex-1 px-3 py-2 text-xs bg-white/10 border border-white/15 rounded-lg text-white placeholder:text-white/45 focus:outline-none focus:border-[#FFD600]"
                    />
                    <button
                      type="submit"
                      disabled={postingComment || !commentDraft.trim()}
                      style={{ backgroundColor: 'var(--accent)' }}
                      aria-label="Post comment"
                      className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-40 shrink-0"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Post</span>
                    </button>
                  </form>
                ) : (
                  <div className="mt-3 flex items-center justify-between gap-2 p-2.5 rounded-lg bg-white/5 border border-white/10">
                    <p className="text-xs text-white/65">Sign in to comment on this {item.kind}.</p>
                    {onSignIn && (
                      <button
                        type="button"
                        onClick={onSignIn}
                        className="px-2.5 py-1 text-xs font-medium text-[#0C120E] bg-[#FFD600] rounded-md hover:bg-[#E5BD0E] shrink-0"
                      >
                        Sign in
                      </button>
                    )}
                  </div>
                )}

                <div data-testid="media-comments-list" className="mt-3.5 space-y-3 max-h-56 overflow-y-auto pr-1">
                  {loadingComments ? (
                    <p className="text-xs text-white/45">Loading comments...</p>
                  ) : comments.length === 0 ? (
                    <p className="text-xs text-white/45">
                      No comments yet. Be the first to share a thought.
                    </p>
                  ) : (
                    comments.map((c) => {
                      const canDeleteComment = Boolean(
                        currentUser &&
                          (currentUser.uid === c.authorId || canEdit || currentUser.isAdmin)
                      );
                      return (
                        <div
                          key={c.id}
                          className="flex items-start gap-2.5 p-2.5 rounded-lg bg-white/5 border border-white/10"
                        >
                          <UserAvatar
                            name={c.authorName}
                            avatarUrl={c.authorAvatarUrl}
                            size="xs"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-xs font-semibold text-white truncate">
                                {c.authorName}
                              </span>
                              <span className="text-[10px] text-white/45 shrink-0">
                                {formatRelativeTime(c.createdAt)}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-white/85 whitespace-pre-wrap break-words leading-relaxed">
                              {c.body}
                            </p>
                          </div>
                          {canDeleteComment && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteComment(c.id)}
                              aria-label={`Delete comment by ${c.authorName}`}
                              className="p-1 text-white/45 hover:text-red-400 transition-colors shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!title.trim()) return;
                setSaving(true);
                try {
                  await onUpdateMedia(item.id, {
                    title: title.trim(),
                    caption: caption.trim(),
                    cameraMeta: cameraMeta.trim(),
                    tags: tagsText
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                    albumId: targetAlbumId !== item.albumId ? targetAlbumId : undefined,
                  });
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
              className="space-y-4"
            >
              <h2 className="font-display text-lg font-semibold text-white">Edit Details</h2>
              <div>
                <label htmlFor="edit-media-title" className="block text-xs text-white/65">
                  Title
                </label>
                <input
                  id="edit-media-title"
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={140}
                  className="mt-1 w-full px-3 py-2 text-sm bg-white/10 border border-white/15 rounded-lg text-white"
                />
              </div>
              <div>
                <label htmlFor="edit-media-caption" className="block text-xs text-white/65">
                  Caption
                </label>
                <textarea
                  id="edit-media-caption"
                  rows={3}
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  maxLength={600}
                  className="mt-1 w-full px-3 py-2 text-sm bg-white/10 border border-white/15 rounded-lg text-white"
                />
              </div>
              <div>
                <label htmlFor="edit-media-camera" className="block text-xs text-white/65">
                  Camera / Codec Notes
                </label>
                <input
                  id="edit-media-camera"
                  type="text"
                  value={cameraMeta}
                  onChange={(e) => setCameraMeta(e.target.value)}
                  maxLength={160}
                  className="mt-1 w-full px-3 py-2 text-sm bg-white/10 border border-white/15 rounded-lg text-white"
                />
              </div>
              <div>
                <label htmlFor="edit-media-tags" className="block text-xs text-white/65">
                  Tags (comma separated)
                </label>
                <input
                  id="edit-media-tags"
                  type="text"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  className="mt-1 w-full px-3 py-2 text-sm bg-white/10 border border-white/15 rounded-lg text-white"
                />
              </div>
              {ownedAlbums.length > 1 && (
                <div>
                  <label htmlFor="edit-media-album" className="block text-xs text-white/65">
                    Move to Album
                  </label>
                  <select
                    id="edit-media-album"
                    value={targetAlbumId}
                    onChange={(e) => setTargetAlbumId(e.target.value)}
                    className="mt-1 w-full px-3 py-2 text-sm bg-[#1A1A18] border border-white/15 rounded-lg text-white"
                  >
                    {ownedAlbums.map((alb) => (
                      <option key={alb.id} value={alb.id}>
                        {alb.title} ({alb.visibility})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-medium text-white bg-[#2563EB] rounded-lg hover:bg-[#1D4ED8] disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-4 py-2 text-xs font-medium text-white/75 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Bottom Actions */}
        <div className="pt-5 border-t border-white/10 flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            {canDownload && (
              <a
                href={downloadHref}
                download={item.fileName}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-medium text-[#111110] bg-white rounded-lg hover:bg-white/90 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Download</span>
              </a>
            )}
            <button
              type="button"
              onClick={() => void handleCopyLink()}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-medium text-white bg-white/10 rounded-lg hover:bg-white/20 transition-colors whitespace-nowrap shrink-0"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Copy Link</span>
                </>
              )}
            </button>
          </div>

          {canEdit && !editing && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/80 hover:text-white bg-white/5 hover:bg-white/10 rounded-md transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Edit</span>
              </button>

              {onSetAlbumCover && (item.posterUrl || item.kind === 'photo') && (
                <button
                  type="button"
                  onClick={async () => {
                    await onSetAlbumCover(item.albumId, item.posterUrl || item.mediaUrl);
                    setCoverSaved(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/80 hover:text-white bg-white/5 hover:bg-white/10 rounded-md transition-colors"
                >
                  <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{coverSaved ? 'Cover Updated' : 'Set as Cover'}</span>
                </button>
              )}

              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/15 rounded-md transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Delete</span>
                </button>
              ) : (
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void onDeleteMedia(item.id)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md"
                  >
                    Confirm Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-1.5 text-xs text-white/70 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
