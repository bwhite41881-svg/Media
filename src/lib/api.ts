import type {
  AdminOverview,
  Album,
  AlbumMember,
  AlbumVisibility,
  ChatConversation,
  ChatMessage,
  MediaComment,
  MediaItem,
  MemberRole,
  PublicUserSummary,
  SiteSettings,
  UserAccount,
} from '../types/media';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  computeChunkCount,
  getChunkRange,
  shouldRetryUploadRequest,
} from '../utils/albumLogic';

class ApiRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

const SESSION_STORAGE_KEY = 'bbl_session_token_v1';
const UNLOCK_STORAGE_KEY = 'bbl_unlock_token_v1';

let memorySessionToken: string | null = null;
let memoryUnlockToken: string | null = null;

export function getSessionToken(): string | null {
  if (memorySessionToken) return memorySessionToken;
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      memorySessionToken = stored;
      return stored;
    }
  } catch {
    // localStorage can be unavailable in restricted contexts
  }
  return null;
}

export function setSessionToken(token: string | null): void {
  memorySessionToken = token;
  try {
    if (token) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

export function getUnlockToken(): string | null {
  if (memoryUnlockToken) return memoryUnlockToken;
  try {
    const stored = window.localStorage.getItem(UNLOCK_STORAGE_KEY);
    if (stored) {
      memoryUnlockToken = stored;
      return stored;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setUnlockToken(token: string | null): void {
  memoryUnlockToken = token;
  try {
    if (token) {
      window.localStorage.setItem(UNLOCK_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(UNLOCK_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Appends auth / unlock tokens to protected /api/media and /api/poster URLs so
 * <img>, <video>, and download links work even when third-party cookies are
 * blocked inside mobile Safari / cross-site preview iframes.
 */
export function resolveProtectedUrl(url: string): string {
  if (!url) return '';
  if (
    !url.startsWith('/api/media/') &&
    !url.startsWith('/api/poster/') &&
    !url.startsWith('/api/covers/') &&
    !url.startsWith('/api/albums/') &&
    !url.startsWith('/api/admin/')
  ) {
    return url;
  }
  const params: string[] = [];
  const token = getSessionToken();
  const unlock = getUnlockToken();
  if (token && !url.includes('auth=')) {
    params.push(`auth=${encodeURIComponent(token)}`);
  }
  if (unlock && !url.includes('unlock=')) {
    params.push(`unlock=${encodeURIComponent(unlock)}`);
  }
  if (params.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${params.join('&')}`;
}

function buildAuthHeaders(extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (extra) {
    if (extra instanceof Headers) {
      extra.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(extra)) {
      for (const [k, v] of extra) headers[k] = v;
    } else {
      Object.assign(headers, extra);
    }
  }
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const unlock = getUnlockToken();
  if (unlock) {
    headers['X-Unlock-Token'] = unlock;
  }
  return headers;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = buildAuthHeaders({
    'Content-Type': 'application/json',
    ...(init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : {}),
  });
  const res = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiRequestError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  // --- Public Site Settings ---
  getSiteSettings: () => apiJson<{ settings: SiteSettings }>('/api/settings'),

  // --- Auth ---
  getMe: async () => {
    const res = await apiJson<{ user: UserAccount | null; sessionToken?: string }>('/api/auth/me');
    if (res.sessionToken) {
      setSessionToken(res.sessionToken);
    } else if (!res.user) {
      setSessionToken(null);
    }
    return { user: res.user };
  },

  register: async (payload: {
    displayName: string;
    handle?: string;
    email: string;
    password: string;
  }) => {
    const res = await apiJson<{ user: UserAccount; sessionToken?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return { user: res.user };
  },

  login: async (payload: { identifier: string; password: string }) => {
    const res = await apiJson<{ user: UserAccount; sessionToken?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return { user: res.user };
  },

  syncGoogleAccount: async (payload: {
    uid: string;
    displayName: string;
    email: string;
    avatarUrl: string;
  }) => {
    const res = await apiJson<{ user: UserAccount; sessionToken?: string }>('/api/auth/google-sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    return { user: res.user };
  },

  updateProfile: (payload: { displayName: string; handle: string; bio: string }) =>
    apiJson<{ user: UserAccount }>('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  uploadAvatar: (dataUrl: string) =>
    apiJson<{ user: UserAccount }>('/api/auth/avatar', {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),

  removeAvatar: () =>
    apiJson<{ user: UserAccount }>('/api/auth/avatar', {
      method: 'DELETE',
    }),

  logout: async () => {
    setSessionToken(null);
    return apiJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },

  // --- Admin cPanel ---
  getAdminOverview: () => apiJson<AdminOverview>('/api/admin/overview'),

  getAdminAppExportUrl: (includeMedia = false) =>
    resolveProtectedUrl(`/api/admin/export-app${includeMedia ? '?includeMedia=1' : ''}`),

  checkAdminAppExport: async (includeMedia = false) => {
    const res = await fetch(`/api/admin/export-app${includeMedia ? '?includeMedia=1' : ''}`, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ApiRequestError('Administrator privileges are required to export the app.', res.status);
      }
      throw new ApiRequestError(`Unable to prepare app ZIP export (HTTP ${res.status}).`, res.status);
    }
  },

  updateAdminSettings: (payload: Partial<SiteSettings>) =>
    apiJson<{ settings: SiteSettings }>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  adminUpdateAlbum: (
    albumId: string,
    payload: {
      title?: string;
      description?: string;
      visibility?: AlbumVisibility;
      allowDownloads?: boolean;
    }
  ) =>
    apiJson<{ album: Album }>(`/api/admin/albums/${encodeURIComponent(albumId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  adminDeleteAlbum: (albumId: string) =>
    apiJson<{ ok: boolean }>(`/api/admin/albums/${encodeURIComponent(albumId)}`, {
      method: 'DELETE',
    }),

  adminUpdateUserRole: (uid: string, isAdmin: boolean) =>
    apiJson<{ user: UserAccount }>(`/api/admin/users/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isAdmin }),
    }),

  // --- Explore & Albums ---
  getExplore: () => apiJson<{ albums: Album[]; media: MediaItem[] }>('/api/explore'),

  getMyAlbums: () => apiJson<{ owned: Album[]; sharedWithMe: Album[] }>('/api/albums'),

  createAlbum: (payload: {
    title: string;
    description: string;
    visibility: AlbumVisibility;
    allowDownloads: boolean;
    passcode?: string;
    tags?: string[];
  }) =>
    apiJson<{ album: Album }>('/api/albums', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getAlbumDetail: (albumId: string, shareToken?: string | null) => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    return apiJson<{
      album: Album;
      media: MediaItem[];
      members: AlbumMember[];
      access: {
        canEdit: boolean;
        canUpload: boolean;
        canDownload: boolean;
        reason: string;
      };
    }>(`/api/albums/${encodeURIComponent(albumId)}${query}`);
  },

  updateAlbum: (
    albumId: string,
    payload: {
      title?: string;
      description?: string;
      visibility?: AlbumVisibility;
      allowDownloads?: boolean;
      coverUrl?: string;
      tags?: string[];
      passcode?: string;
      clearPasscode?: boolean;
      regenerateShareToken?: boolean;
      revokeShareToken?: boolean;
    }
  ) =>
    apiJson<{ album: Album }>(`/api/albums/${encodeURIComponent(albumId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteAlbum: (albumId: string) =>
    apiJson<{ ok: boolean }>(`/api/albums/${encodeURIComponent(albumId)}`, {
      method: 'DELETE',
    }),

  uploadAlbumCover: (albumId: string, dataUrl: string) =>
    apiJson<{ album: Album }>(`/api/albums/${encodeURIComponent(albumId)}/cover`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),

  removeAlbumCover: (albumId: string) =>
    apiJson<{ album: Album }>(`/api/albums/${encodeURIComponent(albumId)}/cover`, {
      method: 'DELETE',
    }),

  addAlbumMember: (albumId: string, payload: { identifier: string; role: MemberRole }) =>
    apiJson<{ member: AlbumMember }>(`/api/albums/${encodeURIComponent(albumId)}/members`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  removeAlbumMember: (albumId: string, memberId: string) =>
    apiJson<{ ok: boolean }>(
      `/api/albums/${encodeURIComponent(albumId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' }
    ),

  // --- Share Link Resolution & Passcode Gate ---
  resolveShareLink: (token: string) =>
    apiJson<
      | {
          locked: true;
          albumId: string;
          albumTitle: string;
          ownerName: string;
          itemCount: number;
        }
      | {
          locked: false;
          album: Album;
          media: MediaItem[];
          access: { canEdit: boolean; canUpload: boolean; canDownload: boolean; reason: string };
        }
    >(`/api/share/${encodeURIComponent(token)}`),

  unlockShareLink: async (token: string, passcode: string) => {
    const res = await apiJson<{
      locked: false;
      album: Album;
      media: MediaItem[];
      access: { canEdit: boolean; canUpload: boolean; canDownload: boolean; reason: string };
      unlockToken?: string;
    }>(`/api/share/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    });
    if (res.unlockToken) setUnlockToken(res.unlockToken);
    return res;
  },

  // --- Media Mutations ---
  updateMedia: (
    mediaId: string,
    payload: {
      title?: string;
      caption?: string;
      cameraMeta?: string;
      tags?: string[];
      albumId?: string;
    }
  ) =>
    apiJson<{ media: MediaItem }>(`/api/media/${encodeURIComponent(mediaId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteMedia: (mediaId: string) =>
    apiJson<{ ok: boolean }>(`/api/media/${encodeURIComponent(mediaId)}`, {
      method: 'DELETE',
    }),

  getAlbumDownloadAllUrl: (albumId: string, shareToken?: string | null) => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    return resolveProtectedUrl(`/api/albums/${encodeURIComponent(albumId)}/download${query}`);
  },

  checkAlbumDownloadAll: async (albumId: string, shareToken?: string | null) => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    const res = await fetch(`/api/albums/${encodeURIComponent(albumId)}/download${query}`, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      if (res.status === 403) {
        throw new ApiRequestError('Downloads are disabled or restricted for this album.', 403);
      }
      if (res.status === 404) {
        throw new ApiRequestError('No downloadable media files were found in this album.', 404);
      }
      throw new ApiRequestError(`Unable to prepare ZIP download (HTTP ${res.status}).`, res.status);
    }
    return {
      fileCount: Number(res.headers.get('X-Album-File-Count') || '0'),
    };
  },

  // --- Photo & Video Comments ---
  getMediaComments: (mediaId: string, shareToken?: string | null) => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    return apiJson<{ comments: MediaComment[] }>(
      `/api/media/${encodeURIComponent(mediaId)}/comments${query}`
    );
  },

  postMediaComment: (mediaId: string, body: string, shareToken?: string | null) => {
    const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : '';
    return apiJson<{ comment: MediaComment }>(
      `/api/media/${encodeURIComponent(mediaId)}/comments${query}`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
      }
    );
  },

  deleteMediaComment: (mediaId: string, commentId: string) =>
    apiJson<{ ok: boolean }>(
      `/api/media/${encodeURIComponent(mediaId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    ),

  // --- User Directory & Direct Messages ---
  getUserDirectory: () => apiJson<{ users: PublicUserSummary[] }>('/api/users/directory'),

  getConversations: () =>
    apiJson<{ conversations: ChatConversation[]; unreadTotal: number }>('/api/messages/conversations'),

  getConversationMessages: (otherUid: string) =>
    apiJson<{
      conversationId: string;
      otherUser: PublicUserSummary;
      messages: ChatMessage[];
    }>(`/api/messages/${encodeURIComponent(otherUid)}`),

  sendMessage: (otherUid: string, body: string) =>
    apiJson<{ message: ChatMessage }>(`/api/messages/${encodeURIComponent(otherUid)}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  markConversationRead: (otherUid: string) =>
    apiJson<{ ok: boolean }>(`/api/messages/${encodeURIComponent(otherUid)}/read`, {
      method: 'POST',
    }),

  // --- Unlimited-Size Resumable Chunked Upload ---
  initUpload: (payload: {
    albumId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    title: string;
    caption: string;
    cameraMeta: string;
    tags: string[];
    width: number;
    height: number;
    durationSec: number;
    posterDataUrl?: string;
    preferredMediaId?: string;
    createdAt?: string;
  }) =>
    apiJson<{ uploadId: string; chunkSize: number }>('/api/uploads/init', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  uploadChunk: async (
    uploadId: string,
    chunkIndex: number,
    chunkBlob: Blob,
    signal?: AbortSignal
  ): Promise<{ receivedBytes: number }> => {
    const res = await fetch(
      `/api/uploads/${encodeURIComponent(uploadId)}/chunk/${chunkIndex}`,
      {
        method: 'PUT',
        credentials: 'include',
        cache: 'no-store',
        headers: buildAuthHeaders({
          'Content-Type': 'application/octet-stream',
        }),
        body: chunkBlob,
        signal,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiRequestError(
        data.error || `Chunk ${chunkIndex} failed (${res.status})`,
        res.status
      );
    }
    return data as { receivedBytes: number };
  },

  completeUpload: (uploadId: string) =>
    apiJson<{ media: MediaItem; album: Album }>(
      `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST' }
    ),

  abortUpload: (uploadId: string) =>
    fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildAuthHeaders(),
    }).catch(() => undefined),

  getVaultInventory: () =>
    apiJson<{ albumIds: string[]; mediaIds: string[] }>('/api/vault/inventory'),

  reconcileFromFirestore: (payload: {
    albums: Array<Partial<Album> & { id: string; ownerId: string; title: string }>;
    media: Array<Partial<MediaItem> & { id: string; albumId: string; ownerId: string; title: string }>;
  }) =>
    apiJson<{ restoredAlbums: number; restoredMedia: number }>('/api/sync/reconcile', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

async function retryUploadStep<T>(
  step: () => Promise<T>,
  abortSignal?: AbortSignal,
  maxAttempts = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await step();
    } catch (err) {
      lastError = err;
      const isAborted =
        Boolean(abortSignal?.aborted) ||
        (err instanceof DOMException && err.name === 'AbortError');
      const statusCode = err instanceof ApiRequestError ? err.status : undefined;
      if (attempt >= maxAttempts || !shouldRetryUploadRequest(statusCode, isAborted)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 600));
    }
  }
  throw lastError;
}

export async function runChunkedUpload(params: {
  file: Blob & { name?: string };
  fileName?: string;
  mimeType?: string;
  albumId: string;
  title: string;
  caption: string;
  cameraMeta: string;
  tags: string[];
  width: number;
  height: number;
  durationSec: number;
  posterDataUrl?: string;
  preferredMediaId?: string;
  createdAt?: string;
  chunkSizeBytes?: number;
  existingUploadId?: string;
  startChunkIndex?: number;
  shouldPause: () => boolean;
  shouldCancel: () => boolean;
  abortSignal?: AbortSignal;
  onSessionInit?: (uploadId: string, totalChunks: number) => void;
  onProgress: (info: {
    uploadedBytes: number;
    totalBytes: number;
    completedChunks: number;
    totalChunks: number;
    speedBytesPerSec: number;
  }) => void;
}): Promise<
  { paused: true; uploadId: string; nextChunk: number } | { paused: false; media: MediaItem; album: Album }
> {
  const chunkSize = params.chunkSizeBytes || DEFAULT_CHUNK_SIZE_BYTES;
  const totalChunks = computeChunkCount(params.file.size, chunkSize);

  const executeUpload = async (
    initialUploadId: string | undefined,
    initialStartIndex: number
  ): Promise<
    { paused: true; uploadId: string; nextChunk: number } | { paused: false; media: MediaItem; album: Album }
  > => {
    let uploadId = initialUploadId;
    if (!uploadId) {
      const initRes = await retryUploadStep(
        () =>
          api.initUpload({
            albumId: params.albumId,
            fileName: params.fileName || params.file.name || 'untitled',
            mimeType: params.mimeType || params.file.type || 'application/octet-stream',
            fileSize: params.file.size,
            chunkSize,
            totalChunks,
            title: params.title,
            caption: params.caption,
            cameraMeta: params.cameraMeta,
            tags: params.tags,
            width: params.width,
            height: params.height,
            durationSec: params.durationSec,
            posterDataUrl: params.posterDataUrl,
            preferredMediaId: params.preferredMediaId,
            createdAt: params.createdAt,
          }),
        params.abortSignal
      );
      uploadId = initRes.uploadId;
      params.onSessionInit?.(uploadId, totalChunks);
    }

    const startIndex = initialStartIndex;
    let uploadedBytes = Math.min(startIndex * chunkSize, params.file.size);

    for (let i = startIndex; i < totalChunks; i++) {
      if (params.shouldCancel()) {
        await api.abortUpload(uploadId);
        throw new Error('Upload cancelled');
      }
      if (params.shouldPause()) {
        return { paused: true, uploadId, nextChunk: i };
      }

      const range = getChunkRange(params.file.size, i, chunkSize);
      const blob = params.file.slice(range.start, range.end);
      const t0 = performance.now();
      await retryUploadStep(
        () => api.uploadChunk(uploadId!, i, blob, params.abortSignal),
        params.abortSignal
      );
      const elapsedSec = Math.max((performance.now() - t0) / 1000, 0.001);
      uploadedBytes += range.size;

      params.onProgress({
        uploadedBytes,
        totalBytes: params.file.size,
        completedChunks: i + 1,
        totalChunks,
        speedBytesPerSec: range.size / elapsedSec,
      });
    }

    const completed = await retryUploadStep(
      () => api.completeUpload(uploadId!),
      params.abortSignal
    );
    return { paused: false, media: completed.media, album: completed.album };
  };

  try {
    return await executeUpload(params.existingUploadId, params.startChunkIndex ?? 0);
  } catch (err) {
    // If an existing/resumed upload session expired (404), seamlessly re-initialize from chunk 0
    if (err instanceof ApiRequestError && err.status === 404 && !params.shouldCancel()) {
      return executeUpload(undefined, 0);
    }
    throw err;
  }
}
