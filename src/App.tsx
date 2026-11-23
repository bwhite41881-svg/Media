import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { auth, googleProvider } from './lib/firebase';
import {
  deleteAlbumFromFirestore,
  deleteMediaFromFirestore,
  fetchOwnedVaultFromFirestore,
  syncAlbumToFirestore,
  syncMediaToFirestore,
  syncSiteSettingsToFirestore,
  syncUserProfileToFirestore,
} from './lib/firestoreSync';
import { api, getSessionToken, runChunkedUpload } from './lib/api';
import {
  deleteLocalMediaBackup,
  deleteLocalMediaBackupsByAlbum,
  listLocalMediaBackupsForOwner,
  updateLocalMediaBackupMeta,
} from './lib/localMediaBackup';
import { realtimeClient } from './lib/realtime';
import { DEFAULT_SITE_SETTINGS, mergeUniqueById, upsertAlbumInList } from './utils/albumLogic';
import { findMissingBackedUpMedia } from './utils/backupSync';
import type {
  Album,
  AlbumMember,
  AlbumVisibility,
  AppView,
  MediaItem,
  MemberRole,
  SiteSettings,
  UserAccount,
} from './types/media';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { ExploreView } from './components/ExploreView';
import { AlbumsView } from './components/AlbumsView';
import { AlbumDetailView } from './components/AlbumDetailView';
import { UploadStudio } from './components/UploadStudio';
import { AccountView } from './components/AccountView';
import { SharedLinkView } from './components/SharedLinkView';
import { CPanelView } from './components/CPanelView';
import { MessagesView } from './components/MessagesView';
import { MediaLightbox } from './components/MediaLightbox';
import { SharePrivacyModal } from './components/SharePrivacyModal';
import { CreateEditAlbumModal } from './components/CreateEditAlbumModal';
import { ChangeCoverModal } from './components/ChangeCoverModal';

function getInitialShareToken(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get('share') || '').trim();
}

function BigBzLeaksApp() {
  const initialToken = getInitialShareToken();
  const [view, setView] = useState<AppView>(initialToken ? 'shared' : 'explore');
  const [shareTokenParam, setShareTokenParam] = useState<string>(initialToken);

  const [siteSettings, setSiteSettings] = useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [exploreAlbums, setExploreAlbums] = useState<Album[]>([]);
  const [exploreMedia, setExploreMedia] = useState<MediaItem[]>([]);
  const [exploreLoading, setExploreLoading] = useState(true);

  const [ownedAlbums, setOwnedAlbums] = useState<Album[]>([]);
  const [sharedAlbums, setSharedAlbums] = useState<Album[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);

  // Active album detail state
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null);
  const [previousView, setPreviousView] = useState<AppView>('explore');
  const [albumDetail, setAlbumDetail] = useState<{
    album: Album | null;
    media: MediaItem[];
    members: AlbumMember[];
    access: { canEdit: boolean; canUpload: boolean; canDownload: boolean; reason: string } | null;
    loading: boolean;
    error: string | null;
  }>({
    album: null,
    media: [],
    members: [],
    access: null,
    loading: false,
    error: null,
  });

  const [uploadTargetAlbumId, setUploadTargetAlbumId] = useState<string | null>(null);

  const [lightboxState, setLightboxState] = useState<{
    item: MediaItem;
    collection: MediaItem[];
    canEdit: boolean;
    canDownload: boolean;
  } | null>(null);

  const [shareModalAlbumId, setShareModalAlbumId] = useState<string | null>(null);
  const [coverModalAlbumId, setCoverModalAlbumId] = useState<string | null>(null);
  const [albumFormState, setAlbumFormState] = useState<{ open: boolean; editing: Album | null }>({
    open: false,
    editing: null,
  });
  const [deleteConfirmAlbum, setDeleteConfirmAlbum] = useState<Album | null>(null);
  const [unreadMessages, setUnreadMessages] = useState<number>(0);
  const [messageTargetUid, setMessageTargetUid] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => {
      setToast((prev) => (prev === message ? null : prev));
    }, 3200);
  }, []);

  // Apply live cPanel theme, accent color, and document title immediately
  useEffect(() => {
    document.title = `${siteSettings.siteName} — Unlimited Photo & Video Vault`;
    document.documentElement.classList.toggle('dark', siteSettings.themeMode === 'dark');
    document.documentElement.style.setProperty('--accent', siteSettings.accentColor || '#008732');
    try {
      window.localStorage.setItem('bigbz_theme_mode', siteSettings.themeMode);
    } catch {
      // ignore restricted storage contexts
    }
  }, [siteSettings]);

  const refreshSiteSettings = useCallback(async () => {
    try {
      const { settings } = await api.getSiteSettings();
      if (settings) setSiteSettings(settings);
    } catch {
      // keep default Rasta Big B'z Leaks settings
    }
  }, []);

  const refreshExplore = useCallback(async () => {
    try {
      const data = await api.getExplore();
      setExploreAlbums(data.albums);
      setExploreMedia(data.media);
    } catch (err) {
      console.error('Failed to load explore feed:', err);
    } finally {
      setExploreLoading(false);
    }
  }, []);

  const refreshMyAlbums = useCallback(async () => {
    setAlbumsLoading(true);
    try {
      const data = await api.getMyAlbums();
      setOwnedAlbums(data.owned);
      setSharedAlbums(data.sharedWithMe);
    } catch {
      setOwnedAlbums([]);
      setSharedAlbums([]);
    } finally {
      setAlbumsLoading(false);
    }
  }, []);

  const refreshUserAndData = useCallback(async () => {
    try {
      const { user: me } = await api.getMe();
      setUser(me);
      if (me) {
        await refreshMyAlbums();
      } else {
        setOwnedAlbums([]);
        setSharedAlbums([]);
      }
    } catch {
      setUser(null);
    }
  }, [refreshMyAlbums]);

  const loadAlbumDetail = useCallback(async (albumId: string) => {
    setAlbumDetail((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.getAlbumDetail(albumId);
      setAlbumDetail({
        album: res.album,
        media: res.media,
        members: res.members,
        access: res.access,
        loading: false,
        error: null,
      });
    } catch (err) {
      setAlbumDetail({
        album: null,
        media: [],
        members: [],
        access: null,
        loading: false,
        error: err instanceof Error ? err.message : 'Unable to open album.',
      });
    }
  }, []);

  useEffect(() => {
    void refreshSiteSettings();
    void refreshExplore();
    void refreshUserAndData();
  }, [refreshSiteSettings, refreshExplore, refreshUserAndData]);

  // Listen to Firebase Auth state for seamless Google session restoration + Firestore reconciliation
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser && fbUser.email) {
        try {
          const { user: synced } = await api.syncGoogleAccount({
            uid: fbUser.uid,
            displayName: fbUser.displayName || fbUser.email.split('@')[0],
            email: fbUser.email,
            avatarUrl: fbUser.photoURL || '',
          });
          setUser(synced);
          await refreshMyAlbums();
          void syncUserProfileToFirestore(synced).catch(() => undefined);

          // Reconcile any Firestore album/media records whose binaries exist on disk
          void fetchOwnedVaultFromFirestore(synced.uid)
            .then(async (vault) => {
              if (vault.albums.length === 0 && vault.media.length === 0) return;
              const result = await api.reconcileFromFirestore(vault);
              if (result.restoredAlbums > 0 || result.restoredMedia > 0) {
                await Promise.all([refreshMyAlbums(), refreshExplore()]);
              }
            })
            .catch(() => undefined);
        } catch (err) {
          console.error('Google session sync error:', err);
        }
      }
    });
    return () => unsub();
  }, [refreshMyAlbums, refreshExplore]);

  const viewRef = useRef<AppView>(view);
  viewRef.current = view;
  const activeAlbumIdRef = useRef<string | null>(activeAlbumId);
  activeAlbumIdRef.current = activeAlbumId;
  const chunkSizeMbRef = useRef<number>(siteSettings.chunkSizeMb || 4);
  chunkSizeMbRef.current = siteSettings.chunkSizeMb || 4;
  const backupSyncRunningRef = useRef<string | null>(null);

  // Self-healing auto-restore: if the preview server dropped local disk files across restarts,
  // automatically re-upload any missing videos/photos from this device's IndexedDB backup.
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) return;
    if (backupSyncRunningRef.current === uid) return;

    let cancelled = false;
    backupSyncRunningRef.current = uid;

    const runSelfHeal = async () => {
      try {
        const [inventory, cached] = await Promise.all([
          api.getVaultInventory(),
          listLocalMediaBackupsForOwner(uid),
        ]);
        if (cancelled || cached.length === 0) return;

        const missing = findMissingBackedUpMedia(
          cached,
          inventory.albumIds,
          inventory.mediaIds,
          uid
        );
        if (missing.length === 0) return;

        showToast(
          `Restoring ${missing.length} saved ${missing.length === 1 ? 'file' : 'files'} from device backup…`
        );

        let restoredCount = 0;
        const touchedAlbums = new Set<string>();
        const chunkSizeBytes = Math.max(1, chunkSizeMbRef.current) * 1024 * 1024;

        for (const record of missing) {
          if (cancelled || !record.blob) break;
          try {
            const res = await runChunkedUpload({
              file: record.blob,
              fileName: record.fileName,
              mimeType: record.mimeType,
              albumId: record.albumId,
              title: record.title,
              caption: record.caption,
              cameraMeta: record.cameraMeta,
              tags: record.tags,
              width: record.width,
              height: record.height,
              durationSec: record.durationSec,
              posterDataUrl: record.posterDataUrl,
              preferredMediaId: record.mediaId,
              createdAt: record.createdAt,
              chunkSizeBytes,
              shouldPause: () => false,
              shouldCancel: () => cancelled,
              onProgress: () => undefined,
            });
            if (!res.paused) {
              restoredCount++;
              touchedAlbums.add(res.album.id);
              void syncAlbumToFirestore(res.album)
                .then(() => syncMediaToFirestore(res.media))
                .catch(() => undefined);
            }
          } catch {
            // Skip individual restore errors without interrupting remaining files
          }
        }

        if (!cancelled && restoredCount > 0) {
          await Promise.all([refreshMyAlbums(), refreshExplore()]);
          if (activeAlbumIdRef.current && touchedAlbums.has(activeAlbumIdRef.current)) {
            await loadAlbumDetail(activeAlbumIdRef.current);
          }
          showToast(
            `Restored ${restoredCount} ${restoredCount === 1 ? 'file' : 'files'} from device backup`
          );
        }
      } catch {
        // Non-fatal if inventory or IndexedDB is unavailable
      } finally {
        if (backupSyncRunningRef.current === uid) {
          backupSyncRunningRef.current = null;
        }
      }
    };

    void runSelfHeal();

    return () => {
      cancelled = true;
      if (backupSyncRunningRef.current === uid) {
        backupSyncRunningRef.current = null;
      }
    };
  }, [user?.uid, refreshMyAlbums, refreshExplore, loadAlbumDetail, showToast]);

  // Manage real-time WebSocket connection & live unread DM badge for signed-in users
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) {
      realtimeClient.disconnect();
      setUnreadMessages(0);
      return;
    }

    realtimeClient.connect(getSessionToken());

    api
      .getConversations()
      .then((res) => setUnreadMessages(res.unreadTotal))
      .catch(() => undefined);

    const unsub = realtimeClient.subscribe((event) => {
      if (event.type === 'chat:message' && event.message.recipientId === uid) {
        api
          .getConversations()
          .then((res) => setUnreadMessages(res.unreadTotal))
          .catch(() => undefined);
        if (viewRef.current !== 'messages') {
          showToast(`New message from ${event.message.senderName}`);
        }
      }
    });

    return () => {
      unsub();
    };
  }, [user?.uid, showToast]);

  const handleMessageUser = (recipientUid: string) => {
    if (!user) {
      setLightboxState(null);
      setView('account');
      showToast('Sign in to send messages');
      return;
    }
    setLightboxState(null);
    setMessageTargetUid(recipientUid);
    setView('messages');
  };

  const handleOpenAlbum = (albumId: string) => {
    if (view !== 'album-detail') setPreviousView(view);
    setActiveAlbumId(albumId);
    setView('album-detail');
    void loadAlbumDetail(albumId);
  };

  const handleGoogleSignIn = async () => {
    const credential = await signInWithPopup(auth, googleProvider);
    const fbUser = credential.user;
    if (!fbUser.email) throw new Error('Google account did not return an email address.');
    const { user: synced } = await api.syncGoogleAccount({
      uid: fbUser.uid,
      displayName: fbUser.displayName || fbUser.email.split('@')[0],
      email: fbUser.email,
      avatarUrl: fbUser.photoURL || '',
    });
    setUser(synced);
    await refreshMyAlbums();
    setView('albums');
    showToast(`Signed in as ${synced.displayName}`);
  };

  const handleLocalRegister = async (payload: {
    displayName: string;
    handle: string;
    email: string;
    password: string;
  }) => {
    const { user: created } = await api.register(payload);
    setUser(created);
    await refreshMyAlbums();
    setView('albums');
    showToast(`Welcome to ${siteSettings.siteName}, ${created.displayName}`);
  };

  const handleLocalLogin = async (identifier: string, password: string) => {
    const { user: loggedIn } = await api.login({ identifier, password });
    setUser(loggedIn);
    await refreshMyAlbums();
    setView('albums');
    showToast(`Signed in as ${loggedIn.displayName}`);
  };

  const handleSignOut = async () => {
    await api.logout();
    if (auth.currentUser) {
      await firebaseSignOut(auth).catch(() => undefined);
    }
    setUser(null);
    setOwnedAlbums([]);
    setSharedAlbums([]);
    setView('explore');
    showToast('Signed out');
  };

  const handleSaveSiteSettings = async (patch: Partial<SiteSettings>): Promise<SiteSettings> => {
    const { settings } = await api.updateAdminSettings(patch);
    setSiteSettings(settings);
    void syncSiteSettingsToFirestore(settings).catch(() => undefined);
    showToast('Site cPanel settings saved');
    return settings;
  };

  const handleCreateOrUpdateAlbum = async (payload: {
    title: string;
    description: string;
    visibility: AlbumVisibility;
    allowDownloads: boolean;
    passcode?: string;
    tags?: string[];
    coverDataUrl?: string;
  }) => {
    const { coverDataUrl, ...albumPayload } = payload;
    if (albumFormState.editing) {
      let { album: updated } = await api.updateAlbum(albumFormState.editing.id, albumPayload);
      if (coverDataUrl) {
        const coverRes = await api.uploadAlbumCover(updated.id, coverDataUrl);
        updated = coverRes.album;
      }
      void syncAlbumToFirestore(updated).catch(() => undefined);
      await Promise.all([refreshMyAlbums(), refreshExplore()]);
      if (activeAlbumId === updated.id) await loadAlbumDetail(updated.id);
      showToast(`Updated "${updated.title}"`);
    } else {
      let { album: created } = await api.createAlbum(albumPayload);
      if (coverDataUrl) {
        const coverRes = await api.uploadAlbumCover(created.id, coverDataUrl);
        created = coverRes.album;
      }
      void syncAlbumToFirestore(created).catch(() => undefined);
      await Promise.all([refreshMyAlbums(), refreshExplore()]);
      showToast(`Created ${created.visibility} album "${created.title}"`);
    }
  };

  const handleUpdateAlbumSettings = async (
    albumId: string,
    payload: {
      visibility?: AlbumVisibility;
      allowDownloads?: boolean;
      coverUrl?: string;
      passcode?: string;
      clearPasscode?: boolean;
      regenerateShareToken?: boolean;
      revokeShareToken?: boolean;
    }
  ) => {
    const { album: updated } = await api.updateAlbum(albumId, payload);
    void syncAlbumToFirestore(updated).catch(() => undefined);
    await Promise.all([refreshMyAlbums(), refreshExplore()]);
    if (activeAlbumId === albumId) await loadAlbumDetail(albumId);
  };

  const handleDeleteAlbumConfirmed = async () => {
    if (!deleteConfirmAlbum) return;
    const target = deleteConfirmAlbum;
    setDeleteConfirmAlbum(null);
    await api.deleteAlbum(target.id);
    void deleteLocalMediaBackupsByAlbum(target.id).catch(() => undefined);
    void deleteAlbumFromFirestore(target.id, target.ownerId).catch(() => undefined);
    await Promise.all([refreshMyAlbums(), refreshExplore(), refreshUserAndData()]);
    if (activeAlbumId === target.id) {
      setActiveAlbumId(null);
      setView('albums');
    }
    showToast(`Deleted album "${target.title}"`);
  };

  const handleUpdateMedia = async (
    mediaId: string,
    payload: { title: string; caption: string; cameraMeta: string; tags: string[]; albumId?: string }
  ) => {
    const { media: updated } = await api.updateMedia(mediaId, payload);
    void updateLocalMediaBackupMeta(mediaId, {
      title: updated.title,
      caption: updated.caption,
      cameraMeta: updated.cameraMeta,
      tags: updated.tags,
      albumId: updated.albumId,
    }).catch(() => undefined);
    void syncMediaToFirestore(updated).catch(() => undefined);
    setLightboxState((prev) =>
      prev && prev.item.id === mediaId
        ? {
            ...prev,
            item: updated,
            collection: prev.collection.map((m) => (m.id === mediaId ? updated : m)),
          }
        : prev
    );
    await Promise.all([refreshMyAlbums(), refreshExplore()]);
    if (activeAlbumId) await loadAlbumDetail(activeAlbumId);
    showToast('Media details updated');
  };

  const handleDeleteMedia = async (mediaId: string) => {
    const currentItem = lightboxState?.item;
    await api.deleteMedia(mediaId);
    void deleteLocalMediaBackup(mediaId).catch(() => undefined);
    if (currentItem) {
      void deleteMediaFromFirestore(currentItem.albumId, mediaId, currentItem.ownerId).catch(
        () => undefined
      );
    }
    setLightboxState(null);
    await Promise.all([refreshMyAlbums(), refreshExplore(), refreshUserAndData()]);
    if (activeAlbumId) await loadAlbumDetail(activeAlbumId);
    showToast('Media deleted');
  };

  const shareModalAlbum = shareModalAlbumId
    ? ownedAlbums.find((a) => a.id === shareModalAlbumId) ||
      (albumDetail.album?.id === shareModalAlbumId ? albumDetail.album : null)
    : null;

  const shareModalMembers = shareModalAlbum
    ? shareModalAlbum.members ||
      (albumDetail.album?.id === shareModalAlbum.id ? albumDetail.members : [])
    : [];

  const coverModalAlbum = coverModalAlbumId
    ? ownedAlbums.find((a) => a.id === coverModalAlbumId) ||
      (albumDetail.album?.id === coverModalAlbumId ? albumDetail.album : null)
    : null;

  const coverModalMedia =
    coverModalAlbum && albumDetail.album?.id === coverModalAlbum.id ? albumDetail.media : [];

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F6EE] dark:bg-[#0D0F0B] text-[#151811] dark:text-[#F5F3EA]">
      <TopBar
        activeView={view}
        user={user}
        siteSettings={siteSettings}
        unreadMessages={unreadMessages}
        onNavigate={(nextView) => {
          setView(nextView);
          if (nextView === 'albums' && user) void refreshMyAlbums();
          if (nextView === 'explore') void refreshExplore();
        }}
      />

      <main className="flex-1">
        {view === 'explore' && (
          <ExploreView
            user={user}
            siteSettings={siteSettings}
            albums={exploreAlbums}
            media={exploreMedia}
            loading={exploreLoading}
            onOpenAlbum={handleOpenAlbum}
            onOpenMedia={(item, collection) => {
              const parentAlbum = exploreAlbums.find((a) => a.id === item.albumId);
              const isOwner = Boolean(user && user.uid === item.ownerId);
              setLightboxState({
                item,
                collection,
                canEdit: isOwner,
                canDownload: isOwner || Boolean(parentAlbum?.allowDownloads ?? true),
              });
            }}
            onStartUpload={() => {
              setUploadTargetAlbumId(ownedAlbums[0]?.id || null);
              setView('upload');
            }}
            onSignIn={() => setView('account')}
          />
        )}

        {view === 'albums' && (
          <AlbumsView
            user={user}
            ownedAlbums={ownedAlbums}
            sharedAlbums={sharedAlbums}
            loading={albumsLoading}
            onSignIn={() => setView('account')}
            onCreateAlbum={() => setAlbumFormState({ open: true, editing: null })}
            onOpenAlbum={handleOpenAlbum}
            onOpenShareModal={(album) => setShareModalAlbumId(album.id)}
            onChangeCover={(album) => setCoverModalAlbumId(album.id)}
            onUploadToAlbum={(albumId) => {
              setUploadTargetAlbumId(albumId);
              setView('upload');
            }}
            onDeleteAlbum={(album) => setDeleteConfirmAlbum(album)}
            onQuickVisibilityChange={async (album, nextVis) => {
              await handleUpdateAlbumSettings(album.id, { visibility: nextVis });
              showToast(`"${album.title}" is now ${nextVis}`);
            }}
          />
        )}

        {view === 'album-detail' && (
          <AlbumDetailView
            album={albumDetail.album}
            media={albumDetail.media}
            currentUser={user}
            access={albumDetail.access}
            loading={albumDetail.loading}
            error={albumDetail.error}
            onBack={() => setView(previousView === 'album-detail' ? 'albums' : previousView)}
            onOpenMedia={(item, collection) =>
              setLightboxState({
                item,
                collection,
                canEdit: Boolean(albumDetail.access?.canEdit || (user && user.uid === item.ownerId)),
                canDownload: Boolean(albumDetail.access?.canDownload),
              })
            }
            onUploadToAlbum={(albumId) => {
              setUploadTargetAlbumId(albumId);
              setView('upload');
            }}
            onOpenShareModal={(album) => setShareModalAlbumId(album.id)}
            onEditAlbum={(album) => setAlbumFormState({ open: true, editing: album })}
            onChangeCover={(album) => setCoverModalAlbumId(album.id)}
            onMessageUser={handleMessageUser}
            onNotify={showToast}
            onBatchDeleteMedia={async (mediaIds) => {
              for (const id of mediaIds) {
                await api.deleteMedia(id);
                void deleteLocalMediaBackup(id).catch(() => undefined);
              }
              await Promise.all([refreshMyAlbums(), refreshExplore(), refreshUserAndData()]);
              if (activeAlbumId) await loadAlbumDetail(activeAlbumId);
              showToast(`Deleted ${mediaIds.length} items`);
            }}
          />
        )}

        {view === 'upload' && (
          <UploadStudio
            user={user}
            albums={ownedAlbums}
            siteSettings={siteSettings}
            initialAlbumId={uploadTargetAlbumId}
            onSignIn={() => setView('account')}
            onCreateAlbumInline={async (payload) => {
              const { album: created } = await api.createAlbum(payload);
              void syncAlbumToFirestore(created).catch(() => undefined);
              await Promise.all([refreshMyAlbums(), refreshExplore()]);
              return created;
            }}
            onUploadCompleted={(media, album, options) => {
              void syncAlbumToFirestore(album)
                .then(() => syncMediaToFirestore(media))
                .catch(() => undefined);
              // Immediately reflect saved item & counts in local state even during massive batches
              setOwnedAlbums((prev) => upsertAlbumInList(prev, album));
              if (album.visibility === 'public') {
                setExploreAlbums((prev) => upsertAlbumInList(prev, album));
                setExploreMedia((prev) => mergeUniqueById(prev, media));
              }
              setAlbumDetail((prev) =>
                prev.album?.id === album.id
                  ? {
                      ...prev,
                      album: { ...prev.album, ...album },
                      media: mergeUniqueById(prev.media, media),
                    }
                  : prev
              );
              if (!options?.silent) {
                void refreshMyAlbums();
                void refreshExplore();
                void refreshUserAndData();
                showToast(`Saved "${media.title}" to "${album.title}"`);
              }
            }}
            onBatchFinished={(completedCount, albumId) => {
              void refreshMyAlbums();
              void refreshExplore();
              void refreshUserAndData();
              if (activeAlbumId && activeAlbumId === albumId) {
                void loadAlbumDetail(albumId);
              }
              showToast(
                `Saved ${completedCount.toLocaleString()} ${completedCount === 1 ? 'file' : 'files'} permanently`
              );
            }}
            onOpenAlbum={handleOpenAlbum}
          />
        )}

        {view === 'shared' && (
          <SharedLinkView
            initialToken={shareTokenParam}
            sharedAlbums={sharedAlbums}
            onOpenAlbum={handleOpenAlbum}
            onOpenMedia={(item, collection, canDownload) =>
              setLightboxState({
                item,
                collection,
                canEdit: false,
                canDownload,
              })
            }
            onTokenChange={(tok) => {
              setShareTokenParam(tok);
              const url = new URL(window.location.href);
              if (tok) url.searchParams.set('share', tok);
              else url.searchParams.delete('share');
              window.history.replaceState({}, '', url.toString());
            }}
          />
        )}

        {view === 'cpanel' && (
          <CPanelView
            user={user}
            siteSettings={siteSettings}
            onSaveSettings={handleSaveSiteSettings}
            onOpenAlbum={handleOpenAlbum}
            onAlbumsOrUsersChanged={async () => {
              await Promise.all([refreshMyAlbums(), refreshExplore(), refreshUserAndData()]);
            }}
            onGoToAccount={() => setView('account')}
          />
        )}

        {view === 'messages' && (
          <MessagesView
            user={user}
            initialRecipientUid={messageTargetUid}
            onSignIn={() => setView('account')}
            onUnreadTotalChange={setUnreadMessages}
            onClearInitialRecipient={() => setMessageTargetUid(null)}
          />
        )}

        {view === 'account' && (
          <AccountView
            user={user}
            siteSettings={siteSettings}
            ownedAlbums={ownedAlbums}
            onGoogleSignIn={handleGoogleSignIn}
            onLocalLogin={handleLocalLogin}
            onLocalRegister={handleLocalRegister}
            onUpdateProfile={async (payload) => {
              const { user: updated } = await api.updateProfile(payload);
              setUser(updated);
              void syncUserProfileToFirestore(updated).catch(() => undefined);
              await Promise.all([refreshMyAlbums(), refreshExplore()]);
            }}
            onUploadAvatar={async (dataUrl) => {
              const { user: updated } = await api.uploadAvatar(dataUrl);
              setUser(updated);
              void syncUserProfileToFirestore(updated).catch(() => undefined);
              showToast('Profile photo updated');
            }}
            onRemoveAvatar={async () => {
              const { user: updated } = await api.removeAvatar();
              setUser(updated);
              void syncUserProfileToFirestore(updated).catch(() => undefined);
              showToast('Profile photo removed');
            }}
            onSignOut={handleSignOut}
            onGoToAlbums={() => setView('albums')}
            onGoToUpload={() => setView('upload')}
            onGoToCPanel={() => setView('cpanel')}
          />
        )}
      </main>

      {/* Quiet Editorial Footer with subtle Rasta hairline */}
      <footer className="border-t border-[#E2DCC8] dark:border-[#2A3124] bg-[#F8F6EE] dark:bg-[#0D0F0B] py-8 px-6 sm:px-8">
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
          <p>{siteSettings.footerText}</p>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => setView('explore')}
              className="hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
            >
              Explore
            </button>
            <button
              type="button"
              onClick={() => setView('albums')}
              className="hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
            >
              Albums
            </button>
            <button
              type="button"
              onClick={() => setView('shared')}
              className="hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
            >
              Share Lookup
            </button>
            <button
              type="button"
              onClick={() => setView('messages')}
              className="hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
            >
              Messages
            </button>
            {user?.isAdmin && (
              <button
                type="button"
                onClick={() => setView('cpanel')}
                className="hover:text-[#151811] dark:hover:text-[#FCD116] transition-colors"
              >
                cPanel
              </button>
            )}
          </div>
        </div>
      </footer>

      {/* Lightbox */}
      {lightboxState && (
        <MediaLightbox
          item={lightboxState.item}
          collection={lightboxState.collection}
          currentUser={user}
          shareToken={view === 'shared' ? shareTokenParam : null}
          canEdit={lightboxState.canEdit}
          canDownload={lightboxState.canDownload}
          ownedAlbums={ownedAlbums}
          onClose={() => setLightboxState(null)}
          onSelect={(nextItem) =>
            setLightboxState((prev) => (prev ? { ...prev, item: nextItem } : null))
          }
          onSignIn={() => {
            setLightboxState(null);
            setView('account');
          }}
          onMessageUser={handleMessageUser}
          onUpdateMedia={handleUpdateMedia}
          onSetAlbumCover={async (albumId, coverUrl) => {
            await handleUpdateAlbumSettings(albumId, { coverUrl });
            showToast('Album cover updated');
          }}
          onDeleteMedia={handleDeleteMedia}
        />
      )}

      {/* Change Album Cover Photo Modal */}
      {coverModalAlbum && (
        <ChangeCoverModal
          album={coverModalAlbum}
          media={coverModalMedia}
          onClose={() => setCoverModalAlbumId(null)}
          onUploadCoverFile={async (albumId, dataUrl) => {
            const { album: updated } = await api.uploadAlbumCover(albumId, dataUrl);
            void syncAlbumToFirestore(updated).catch(() => undefined);
            await Promise.all([refreshMyAlbums(), refreshExplore()]);
            if (activeAlbumId === albumId) await loadAlbumDetail(albumId);
            showToast('Album cover photo updated');
          }}
          onSelectMediaCover={async (albumId, coverUrl) => {
            await handleUpdateAlbumSettings(albumId, { coverUrl });
            showToast('Album cover photo updated');
          }}
          onRemoveCover={async (albumId) => {
            const { album: updated } = await api.removeAlbumCover(albumId);
            void syncAlbumToFirestore(updated).catch(() => undefined);
            await Promise.all([refreshMyAlbums(), refreshExplore()]);
            if (activeAlbumId === albumId) await loadAlbumDetail(albumId);
            showToast('Album cover photo reset');
          }}
        />
      )}

      {/* Share & Privacy Modal */}
      {shareModalAlbum && (
        <SharePrivacyModal
          album={shareModalAlbum}
          members={shareModalMembers}
          onClose={() => setShareModalAlbumId(null)}
          onUpdateSettings={handleUpdateAlbumSettings}
          onAddMember={async (albumId, identifier, role: MemberRole) => {
            await api.addAlbumMember(albumId, { identifier, role });
            await refreshMyAlbums();
            if (activeAlbumId === albumId) await loadAlbumDetail(albumId);
          }}
          onRemoveMember={async (albumId, memberId) => {
            await api.removeAlbumMember(albumId, memberId);
            await refreshMyAlbums();
            if (activeAlbumId === albumId) await loadAlbumDetail(albumId);
          }}
          onOpenSharePreview={(token) => {
            setShareModalAlbumId(null);
            setShareTokenParam(token);
            setView('shared');
          }}
        />
      )}

      {/* Create / Edit Album Modal */}
      {albumFormState.open && (
        <CreateEditAlbumModal
          existingAlbum={albumFormState.editing}
          defaultVisibility={siteSettings.defaultAlbumVisibility}
          defaultAllowDownloads={siteSettings.defaultAllowDownloads}
          onClose={() => setAlbumFormState({ open: false, editing: null })}
          onSubmit={handleCreateOrUpdateAlbum}
        />
      )}

      {/* Accessible Delete Album Confirmation Dialog */}
      {deleteConfirmAlbum && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm delete album ${deleteConfirmAlbum.title}`}
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-4"
        >
          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <h2 className="font-display text-lg font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Delete “{deleteConfirmAlbum.title}”?
            </h2>
            <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
              This permanently removes the album, revokes its share link, and deletes all{' '}
              {deleteConfirmAlbum.itemCount.toLocaleString()}{' '}
              {deleteConfirmAlbum.itemCount === 1 ? 'file' : 'files'} inside it.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteConfirmAlbum(null)}
                className="px-4 py-2 text-sm font-medium text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteAlbumConfirmed()}
                className="px-4 py-2 text-sm font-medium text-white bg-[#CE1126] rounded-lg hover:bg-[#AE0E20]"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtle Toast Notification */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 bg-[#151912] dark:bg-[#FCD116] text-[#F5F3EA] dark:text-[#151811] border border-[#2A3124] dark:border-transparent text-xs font-semibold px-4 py-3 rounded-lg shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BigBzLeaksApp />
    </ErrorBoundary>
  );
}
