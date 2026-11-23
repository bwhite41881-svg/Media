import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { BLUEPRINT_LIMITS, buildConversationId, sanitizeHandle, sanitizeTags } from '../utils/albumLogic';
import type {
  Album,
  AlbumVisibility,
  ChatMessage,
  MediaComment,
  MediaItem,
  SiteSettings,
  UserAccount,
} from '../types/media';

// Per-path promise chain so concurrent sync triggers never race create vs update
const docLocks = new Map<string, Promise<unknown>>();

function withDocLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = docLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tracked = next.finally(() => {
    if (docLocks.get(key) === tracked) {
      docLocks.delete(key);
    }
  });
  docLocks.set(key, tracked);
  return next;
}

function canSyncToFirestore(uid?: string): boolean {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return false;
  if (uid && user.uid !== uid) return false;
  return true;
}

export async function syncUserProfileToFirestore(user: UserAccount): Promise<void> {
  if (!canSyncToFirestore(user.uid)) return;

  const publicPath = `users_public/${user.uid}`;
  const privatePath = `users_private/${user.uid}`;

  const safeDisplayName =
    user.displayName.trim().slice(0, BLUEPRINT_LIMITS.displayNameMaxLength) || 'Creator';
  const safeHandle = sanitizeHandle(user.handle || safeDisplayName);
  const safeBio = (user.bio || '').slice(0, BLUEPRINT_LIMITS.bioMaxLength);
  const safeAvatar = (user.avatarUrl || '').slice(0, 500);

  await withDocLock(publicPath, async () => {
    const publicRef = doc(db, 'users_public', user.uid);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(publicRef);
        if (snap.exists()) {
          op = OperationType.UPDATE;
          tx.update(publicRef, {
            displayName: safeDisplayName,
            handle: safeHandle,
            bio: safeBio,
            avatarUrl: safeAvatar,
            updatedAt: serverTimestamp(),
          });
        } else {
          op = OperationType.CREATE;
          tx.set(publicRef, {
            uid: user.uid,
            displayName: safeDisplayName,
            handle: safeHandle,
            bio: safeBio,
            avatarUrl: safeAvatar,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, publicPath);
    }
  });

  await withDocLock(privatePath, async () => {
    const privateRef = doc(db, 'users_private', user.uid);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(privateRef);
        if (snap.exists()) {
          op = OperationType.UPDATE;
          tx.update(privateRef, {
            email: user.email.slice(0, 254),
            totalBytesUploaded: Math.max(0, user.totalBytesUploaded || 0),
            updatedAt: serverTimestamp(),
          });
        } else {
          op = OperationType.CREATE;
          tx.set(privateRef, {
            uid: user.uid,
            email: user.email.slice(0, 254),
            totalBytesUploaded: Math.max(0, user.totalBytesUploaded || 0),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, privatePath);
    }
  });
}

export async function syncAlbumToFirestore(album: Album): Promise<void> {
  if (!canSyncToFirestore(album.ownerId)) return;
  const path = `albums/${album.id}`;

  await withDocLock(path, async () => {
    const ref = doc(db, 'albums', album.id);
    let op: OperationType = OperationType.WRITE;
    try {
      const existed = await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          op = OperationType.CREATE;
          tx.set(ref, {
            id: album.id,
            ownerId: album.ownerId,
            ownerName: album.ownerName.slice(0, BLUEPRINT_LIMITS.displayNameMaxLength),
            title: album.title.slice(0, BLUEPRINT_LIMITS.albumTitleMaxLength),
            description: (album.description || '').slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
            visibility: album.visibility,
            allowDownloads: Boolean(album.allowDownloads),
            shareToken: (album.shareToken || '').slice(0, BLUEPRINT_LIMITS.shareTokenMaxLength),
            hasPasscode: Boolean(album.hasPasscode),
            coverUrl: (album.coverUrl || '').slice(0, 500),
            itemCount: Math.max(0, album.itemCount || 0),
            totalBytes: Math.max(0, album.totalBytes || 0),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return false;
        }
        return true;
      });

      if (existed) {
        // Apply action-scoped updates matching firestore.rules affectedKeys().hasOnly(...) branches
        op = OperationType.UPDATE;
        await updateDoc(ref, {
          title: album.title.slice(0, BLUEPRINT_LIMITS.albumTitleMaxLength),
          description: (album.description || '').slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
          coverUrl: (album.coverUrl || '').slice(0, 500),
          ownerName: album.ownerName.slice(0, BLUEPRINT_LIMITS.displayNameMaxLength),
          updatedAt: serverTimestamp(),
        });
        await updateDoc(ref, {
          visibility: album.visibility,
          allowDownloads: Boolean(album.allowDownloads),
          shareToken: (album.shareToken || '').slice(0, BLUEPRINT_LIMITS.shareTokenMaxLength),
          hasPasscode: Boolean(album.hasPasscode),
          updatedAt: serverTimestamp(),
        });
        await updateDoc(ref, {
          itemCount: Math.max(0, album.itemCount || 0),
          totalBytes: Math.max(0, album.totalBytes || 0),
          coverUrl: (album.coverUrl || '').slice(0, 500),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, op, path);
    }
  });
}

export async function deleteAlbumFromFirestore(albumId: string, ownerId: string): Promise<void> {
  if (!canSyncToFirestore(ownerId)) return;
  const path = `albums/${albumId}`;
  await withDocLock(path, async () => {
    try {
      const ref = doc(db, 'albums', albumId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await deleteDoc(ref);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  });
}

export async function syncMediaToFirestore(media: MediaItem): Promise<void> {
  if (!canSyncToFirestore(media.ownerId)) return;
  const path = `albums/${media.albumId}/media/${media.id}`;

  await withDocLock(path, async () => {
    const ref = doc(db, 'albums', media.albumId, 'media', media.id);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          op = OperationType.CREATE;
          tx.set(ref, {
            id: media.id,
            albumId: media.albumId,
            albumVisibility: media.albumVisibility,
            ownerId: media.ownerId,
            ownerName: media.ownerName.slice(0, BLUEPRINT_LIMITS.displayNameMaxLength),
            title: media.title.slice(0, BLUEPRINT_LIMITS.mediaTitleMaxLength),
            caption: (media.caption || '').slice(0, BLUEPRINT_LIMITS.captionMaxLength),
            kind: media.kind,
            mimeType: (media.mimeType || 'application/octet-stream').slice(0, 100),
            fileName: media.fileName.slice(0, 200),
            fileSize: Math.max(0, media.fileSize || 0),
            mediaUrl: media.mediaUrl.slice(0, 500),
            posterUrl: (media.posterUrl || '').slice(0, 500),
            width: Math.max(0, media.width || 0),
            height: Math.max(0, media.height || 0),
            durationSec: Math.max(0, media.durationSec || 0),
            cameraMeta: (media.cameraMeta || '').slice(0, BLUEPRINT_LIMITS.cameraMetaMaxLength),
            tags: sanitizeTags(media.tags || []),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          op = OperationType.UPDATE;
          tx.update(ref, {
            title: media.title.slice(0, BLUEPRINT_LIMITS.mediaTitleMaxLength),
            caption: (media.caption || '').slice(0, BLUEPRINT_LIMITS.captionMaxLength),
            cameraMeta: (media.cameraMeta || '').slice(0, BLUEPRINT_LIMITS.cameraMetaMaxLength),
            tags: sanitizeTags(media.tags || []),
            posterUrl: (media.posterUrl || '').slice(0, 500),
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, path);
    }
  });
}

export async function deleteMediaFromFirestore(
  albumId: string,
  mediaId: string,
  ownerId: string
): Promise<void> {
  if (!canSyncToFirestore(ownerId)) return;
  const path = `albums/${albumId}/media/${mediaId}`;
  await withDocLock(path, async () => {
    try {
      const ref = doc(db, 'albums', albumId, 'media', mediaId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await deleteDoc(ref);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  });
}

export async function syncSiteSettingsToFirestore(settings: SiteSettings): Promise<void> {
  if (!canSyncToFirestore()) return;
  const path = 'site_settings/main';
  await withDocLock(path, async () => {
    const ref = doc(db, 'site_settings', 'main');
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(ref);
        const updatePayload = {
          siteName: settings.siteName.slice(0, BLUEPRINT_LIMITS.siteNameMaxLength),
          heroKicker: settings.heroKicker.slice(0, BLUEPRINT_LIMITS.heroKickerMaxLength),
          heroHeadline: settings.heroHeadline.slice(0, BLUEPRINT_LIMITS.heroHeadlineMaxLength),
          heroSubheadline: settings.heroSubheadline.slice(0, BLUEPRINT_LIMITS.heroSubheadlineMaxLength),
          footerText: settings.footerText.slice(0, BLUEPRINT_LIMITS.footerTextMaxLength),
          accentColor: settings.accentColor,
          themeMode: settings.themeMode,
          announcementEnabled: Boolean(settings.announcementEnabled),
          announcementText: settings.announcementText.slice(0, BLUEPRINT_LIMITS.announcementTextMaxLength),
          allowRegistrations: Boolean(settings.allowRegistrations),
          defaultAlbumVisibility: settings.defaultAlbumVisibility,
          defaultAllowDownloads: Boolean(settings.defaultAllowDownloads),
          uploadConcurrency: Math.max(1, Math.min(16, Math.round(settings.uploadConcurrency || 6))),
          chunkSizeMb: Math.max(1, Math.min(64, Math.round(settings.chunkSizeMb || 4))),
          updatedAt: serverTimestamp(),
        };
        if (snap.exists()) {
          op = OperationType.UPDATE;
          tx.update(ref, updatePayload);
        } else {
          op = OperationType.CREATE;
          tx.set(ref, {
            id: 'main',
            ...updatePayload,
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, path);
    }
  });
}

export async function syncCommentToFirestore(
  comment: MediaComment,
  albumVisibility: AlbumVisibility
): Promise<void> {
  if (!canSyncToFirestore(comment.authorId)) return;
  const path = `albums/${comment.albumId}/media/${comment.mediaId}/comments/${comment.id}`;
  await withDocLock(path, async () => {
    const ref = doc(db, 'albums', comment.albumId, 'media', comment.mediaId, 'comments', comment.id);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          op = OperationType.CREATE;
          tx.set(ref, {
            id: comment.id,
            albumId: comment.albumId,
            mediaId: comment.mediaId,
            albumVisibility,
            authorId: comment.authorId,
            authorName:
              comment.authorName.trim().slice(0, BLUEPRINT_LIMITS.displayNameMaxLength) || 'Creator',
            authorHandle: sanitizeHandle(comment.authorHandle || comment.authorName),
            authorAvatarUrl: (comment.authorAvatarUrl || '').slice(0, 500),
            body: comment.body.trim().slice(0, BLUEPRINT_LIMITS.commentMaxLength),
            createdAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, path);
    }
  });
}

export async function deleteCommentFromFirestore(
  albumId: string,
  mediaId: string,
  commentId: string
): Promise<void> {
  if (!canSyncToFirestore()) return;
  const path = `albums/${albumId}/media/${mediaId}/comments/${commentId}`;
  await withDocLock(path, async () => {
    try {
      const ref = doc(db, 'albums', albumId, 'media', mediaId, 'comments', commentId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await deleteDoc(ref);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  });
}

export async function syncChatMessageToFirestore(message: ChatMessage): Promise<void> {
  if (!canSyncToFirestore(message.senderId)) return;
  const [participantA, participantB] =
    message.senderId < message.recipientId
      ? [message.senderId, message.recipientId]
      : [message.recipientId, message.senderId];
  const conversationId = buildConversationId(participantA, participantB);
  const convPath = `conversations/${conversationId}`;
  const msgPath = `${convPath}/messages/${message.id}`;
  const preview = message.body.trim().slice(0, 200);

  await withDocLock(convPath, async () => {
    const convRef = doc(db, 'conversations', conversationId);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(convRef);
        if (!snap.exists()) {
          op = OperationType.CREATE;
          tx.set(convRef, {
            id: conversationId,
            participantA,
            participantB,
            lastMessagePreview: preview,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          op = OperationType.UPDATE;
          tx.update(convRef, {
            lastMessagePreview: preview,
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, convPath);
    }
  });

  await withDocLock(msgPath, async () => {
    const msgRef = doc(db, 'conversations', conversationId, 'messages', message.id);
    let op: OperationType = OperationType.WRITE;
    try {
      await runTransaction(db, async (tx) => {
        op = OperationType.GET;
        const snap = await tx.get(msgRef);
        if (!snap.exists()) {
          op = OperationType.CREATE;
          tx.set(msgRef, {
            id: message.id,
            conversationId,
            senderId: message.senderId,
            recipientId: message.recipientId,
            senderName:
              message.senderName.trim().slice(0, BLUEPRINT_LIMITS.displayNameMaxLength) || 'Creator',
            senderHandle: sanitizeHandle(message.senderHandle || message.senderName),
            senderAvatarUrl: (message.senderAvatarUrl || '').slice(0, 500),
            body: message.body.trim().slice(0, BLUEPRINT_LIMITS.messageMaxLength),
            createdAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, op, msgPath);
    }
  });
}

function timestampToIso(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      // fall through
    }
  }
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

/**
 * Fetches the signed-in user's owned albums and their media metadata from Firestore
 * so any server metadata drift can be safely reconciled against binaries on disk.
 */
export async function fetchOwnedVaultFromFirestore(uid: string): Promise<{
  albums: Array<Partial<Album> & { id: string; ownerId: string; title: string }>;
  media: Array<Partial<MediaItem> & { id: string; albumId: string; ownerId: string; title: string }>;
}> {
  if (!canSyncToFirestore(uid)) {
    return { albums: [], media: [] };
  }

  const albums: Array<Partial<Album> & { id: string; ownerId: string; title: string }> = [];
  const media: Array<
    Partial<MediaItem> & { id: string; albumId: string; ownerId: string; title: string }
  > = [];

  try {
    const albumQuery = query(collection(db, 'albums'), where('ownerId', '==', uid));
    const albumSnap = await getDocs(albumQuery);

    for (const albumDoc of albumSnap.docs) {
      const data = albumDoc.data();
      const albumId = typeof data.id === 'string' && data.id ? data.id : albumDoc.id;
      albums.push({
        id: albumId,
        ownerId: String(data.ownerId || uid),
        ownerName: String(data.ownerName || 'Creator'),
        title: String(data.title || 'Untitled Album'),
        description: String(data.description || ''),
        visibility:
          data.visibility === 'public' || data.visibility === 'unlisted'
            ? data.visibility
            : 'private',
        allowDownloads: Boolean(data.allowDownloads ?? true),
        shareToken: typeof data.shareToken === 'string' ? data.shareToken : '',
        hasPasscode: Boolean(data.hasPasscode),
        coverUrl: typeof data.coverUrl === 'string' ? data.coverUrl : '',
        itemCount: Number(data.itemCount) || 0,
        totalBytes: Number(data.totalBytes) || 0,
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
      });

      try {
        const mediaQuery = query(
          collection(db, 'albums', albumId, 'media'),
          where('ownerId', '==', uid)
        );
        const mediaSnap = await getDocs(mediaQuery);
        for (const mediaDoc of mediaSnap.docs) {
          const m = mediaDoc.data();
          media.push({
            id: typeof m.id === 'string' && m.id ? m.id : mediaDoc.id,
            albumId: String(m.albumId || albumId),
            albumVisibility:
              m.albumVisibility === 'public' || m.albumVisibility === 'unlisted'
                ? m.albumVisibility
                : 'private',
            ownerId: String(m.ownerId || uid),
            ownerName: String(m.ownerName || 'Creator'),
            title: String(m.title || m.fileName || 'Untitled'),
            caption: String(m.caption || ''),
            kind: m.kind === 'video' ? 'video' : 'photo',
            mimeType: String(m.mimeType || 'application/octet-stream'),
            fileName: String(m.fileName || `${mediaDoc.id}`),
            fileSize: Number(m.fileSize) || 0,
            mediaUrl: String(m.mediaUrl || `/api/media/${mediaDoc.id}`),
            posterUrl: typeof m.posterUrl === 'string' ? m.posterUrl : '',
            width: Number(m.width) || 0,
            height: Number(m.height) || 0,
            durationSec: Number(m.durationSec) || 0,
            cameraMeta: String(m.cameraMeta || ''),
            tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
            createdAt: timestampToIso(m.createdAt),
            updatedAt: timestampToIso(m.updatedAt),
          });
        }
      } catch {
        // Ignore individual album media query errors
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'albums');
  }

  return { albums, media };
}


