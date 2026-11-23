export type AlbumVisibility = 'private' | 'unlisted' | 'public';

export type MediaKind = 'photo' | 'video';

export type MemberRole = 'viewer' | 'contributor';

export type AuthProviderKind = 'google' | 'local';

export type ThemeMode = 'light' | 'dark';

export interface UserAccount {
  uid: string;
  displayName: string;
  handle: string;
  email: string;
  bio: string;
  avatarUrl: string;
  provider: AuthProviderKind;
  totalBytesUploaded: number;
  storageQuotaBytes?: number;
  isAdmin: boolean;
  createdAt: string;
}

export interface SiteSettings {
  siteName: string;
  heroKicker: string;
  heroHeadline: string;
  heroSubheadline: string;
  footerText: string;
  accentColor: string;
  themeMode: ThemeMode;
  announcementEnabled: boolean;
  announcementText: string;
  allowRegistrations: boolean;
  defaultAlbumVisibility: AlbumVisibility;
  defaultAllowDownloads: boolean;
  uploadConcurrency: number;
  chunkSizeMb: number;
  updatedAt: string;
}

export interface AdminOverview {
  stats: {
    totalUsers: number;
    totalAlbums: number;
    publicAlbums: number;
    unlistedAlbums: number;
    privateAlbums: number;
    totalMedia: number;
    totalBytes: number;
  };
  albums: Album[];
  users: UserAccount[];
}

export interface AlbumMember {
  id: string;
  uid: string;
  albumId: string;
  email: string;
  memberName: string;
  handle: string;
  role: MemberRole;
  createdAt: string;
}

export interface Album {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerHandle: string;
  title: string;
  description: string;
  visibility: AlbumVisibility;
  allowDownloads: boolean;
  shareToken: string;
  hasPasscode: boolean;
  coverUrl: string;
  itemCount: number;
  totalBytes: number;
  viewCount?: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  ownTags?: string[];
  members?: AlbumMember[];
  viewerRole?: 'owner' | 'contributor' | 'viewer' | 'public';
}

export interface MediaItem {
  id: string;
  albumId: string;
  albumTitle?: string;
  albumVisibility: AlbumVisibility;
  ownerId: string;
  ownerName: string;
  title: string;
  caption: string;
  kind: MediaKind;
  mimeType: string;
  fileName: string;
  fileSize: number;
  mediaUrl: string;
  posterUrl: string;
  width: number;
  height: number;
  durationSec: number;
  cameraMeta: string;
  tags: string[];
  commentCount?: number;
  viewCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaComment {
  id: string;
  mediaId: string;
  albumId: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string;
  body: string;
  createdAt: string;
}

export interface PublicUserSummary {
  uid: string;
  displayName: string;
  handle: string;
  bio: string;
  avatarUrl: string;
  isAdmin: boolean;
  online?: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderHandle: string;
  senderAvatarUrl: string;
  recipientId: string;
  body: string;
  createdAt: string;
  readAt?: string;
}

export interface ChatConversation {
  id: string;
  participantIds: [string, string];
  otherUser: PublicUserSummary;
  lastMessage?: ChatMessage;
  unreadCount: number;
  updatedAt: string;
}

export interface AlbumAccessDecision {
  allowed: boolean;
  reason: 'owner' | 'public' | 'collaborator' | 'share_link' | 'passcode_required' | 'denied';
  canEdit: boolean;
  canUpload: boolean;
  canDownload: boolean;
}

export interface UploadChunkPlan {
  chunkSize: number;
  totalChunks: number;
  chunks: Array<{ index: number; start: number; end: number; size: number }>;
}

export type UploadItemStatus =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled';

export interface UploadQueueItem {
  localId: string;
  file: File;
  kind: MediaKind;
  title: string;
  caption: string;
  cameraMeta: string;
  tags: string[];
  relativePath?: string;
  previewUrl?: string;
  posterDataUrl?: string;
  width: number;
  height: number;
  durationSec: number;
  status: UploadItemStatus;
  uploadId?: string;
  uploadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  speedBytesPerSec: number;
  error?: string;
  resultMedia?: MediaItem;
}

export interface BatchUploadStats {
  totalCount: number;
  queuedCount: number;
  activeCount: number;
  pausedCount: number;
  doneCount: number;
  errorCount: number;
  totalBytes: number;
  uploadedBytes: number;
  combinedSpeedBytesPerSec: number;
  overallPercent: number;
  etaSeconds: number | null;
}

export type AppView =
  | 'explore'
  | 'albums'
  | 'album-detail'
  | 'upload'
  | 'shared'
  | 'messages'
  | 'account'
  | 'cpanel';
