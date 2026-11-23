import React, { useEffect, useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  FolderKanban,
  HardDrive,
  Loader2,
  Moon,
  Package,
  Palette,
  RefreshCw,
  Shield,
  Sliders,
  Sun,
  Trash2,
  Users,
} from 'lucide-react';
import type {
  AdminOverview,
  AlbumVisibility,
  SiteSettings,
  ThemeMode,
  UserAccount,
} from '../types/media';
import { api } from '../lib/api';
import { buildAlbumZipFilename, formatBytes, formatRelativeDate } from '../utils/albumLogic';

interface CPanelViewProps {
  user: UserAccount | null;
  siteSettings: SiteSettings;
  onSaveSettings: (next: Partial<SiteSettings>) => Promise<SiteSettings>;
  onOpenAlbum: (albumId: string) => void;
  onAlbumsOrUsersChanged: () => Promise<void>;
  onGoToAccount: () => void;
}

const ACCENT_PRESETS = [
  { label: 'Rasta Green', hex: '#008732' },
  { label: 'Lion Gold', hex: '#C68B00' },
  { label: 'Rasta Crimson', hex: '#CE1126' },
  { label: 'Roots Amber', hex: '#B45309' },
  { label: 'Studio Cobalt', hex: '#1D4ED8' },
];

type CPanelTab = 'branding' | 'uploads' | 'albums' | 'users' | 'export';

export function CPanelView({
  user,
  siteSettings,
  onSaveSettings,
  onOpenAlbum,
  onAlbumsOrUsersChanged,
  onGoToAccount,
}: CPanelViewProps) {
  const [activeTab, setActiveTab] = useState<CPanelTab>('branding');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [albumSearch, setAlbumSearch] = useState('');

  // Editable form state synced from siteSettings
  const [siteName, setSiteName] = useState(siteSettings.siteName);
  const [heroKicker, setHeroKicker] = useState(siteSettings.heroKicker);
  const [heroHeadline, setHeroHeadline] = useState(siteSettings.heroHeadline);
  const [heroSubheadline, setHeroSubheadline] = useState(siteSettings.heroSubheadline);
  const [footerText, setFooterText] = useState(siteSettings.footerText);
  const [accentColor, setAccentColor] = useState(siteSettings.accentColor);
  const [themeMode, setThemeMode] = useState<ThemeMode>(siteSettings.themeMode);
  const [announcementEnabled, setAnnouncementEnabled] = useState(siteSettings.announcementEnabled);
  const [announcementText, setAnnouncementText] = useState(siteSettings.announcementText);

  const [uploadConcurrency, setUploadConcurrency] = useState(siteSettings.uploadConcurrency);
  const [chunkSizeMb, setChunkSizeMb] = useState(siteSettings.chunkSizeMb);
  const [allowRegistrations, setAllowRegistrations] = useState(siteSettings.allowRegistrations);
  const [defaultAlbumVisibility, setDefaultAlbumVisibility] = useState<AlbumVisibility>(
    siteSettings.defaultAlbumVisibility
  );
  const [defaultAllowDownloads, setDefaultAllowDownloads] = useState(
    siteSettings.defaultAllowDownloads
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exportingMode, setExportingMode] = useState<'code' | 'full' | null>(null);

  useEffect(() => {
    setSiteName(siteSettings.siteName);
    setHeroKicker(siteSettings.heroKicker);
    setHeroHeadline(siteSettings.heroHeadline);
    setHeroSubheadline(siteSettings.heroSubheadline);
    setFooterText(siteSettings.footerText);
    setAccentColor(siteSettings.accentColor);
    setThemeMode(siteSettings.themeMode);
    setAnnouncementEnabled(siteSettings.announcementEnabled);
    setAnnouncementText(siteSettings.announcementText);
    setUploadConcurrency(siteSettings.uploadConcurrency);
    setChunkSizeMb(siteSettings.chunkSizeMb);
    setAllowRegistrations(siteSettings.allowRegistrations);
    setDefaultAlbumVisibility(siteSettings.defaultAlbumVisibility);
    setDefaultAllowDownloads(siteSettings.defaultAllowDownloads);
  }, [siteSettings]);

  const loadOverview = async () => {
    if (!user?.isAdmin) return;
    setLoadingOverview(true);
    setError('');
    try {
      const data = await api.getAdminOverview();
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load cPanel overview.');
    } finally {
      setLoadingOverview(false);
    }
  };

  useEffect(() => {
    if (user?.isAdmin) {
      void loadOverview();
    }
  }, [user?.uid, user?.isAdmin]);

  if (!user || !user.isAdmin) {
    return (
      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 py-20">
        <div className="max-w-lg mx-auto bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-8 text-center">
          <Shield className="w-8 h-8 text-[#CE1126] dark:text-[#FCD116] mx-auto" aria-hidden="true" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
            Administrator Access Required
          </h1>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
            Sign in with an administrator account to customize site branding, theme, upload engine
            limits, albums, and user permissions in the cPanel.
          </p>
          <button
            type="button"
            onClick={onGoToAccount}
            style={{ backgroundColor: 'var(--accent)' }}
            className="mt-6 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90"
          >
            Go to Account
          </button>
        </div>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSavedNotice('');
    setSaving(true);
    try {
      await onSaveSettings({
        siteName,
        heroKicker,
        heroHeadline,
        heroSubheadline,
        footerText,
        accentColor,
        themeMode,
        announcementEnabled,
        announcementText,
        uploadConcurrency,
        chunkSizeMb,
        allowRegistrations,
        defaultAlbumVisibility,
        defaultAllowDownloads,
      });
      setSavedNotice('Site settings saved and applied live.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save site settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadAppZip = async (includeMedia: boolean) => {
    if (exportingMode) return;
    setError('');
    setSavedNotice('');
    setExportingMode(includeMedia ? 'full' : 'code');
    try {
      await api.checkAdminAppExport(includeMedia);
      const url = api.getAdminAppExportUrl(includeMedia);
      const baseName = buildAlbumZipFilename(siteSettings.siteName || 'app').replace(/\.zip$/i, '');
      const zipName = includeMedia ? `${baseName}-full-backup.zip` : `${baseName}-deploy-app.zip`;

      const link = document.createElement('a');
      link.href = url;
      link.download = zipName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setSavedNotice(
        includeMedia
          ? `Downloading ${zipName} (full app code + uploaded media backup).`
          : `Downloading ${zipName} (app source + production build ready to host).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to export application ZIP.');
    } finally {
      window.setTimeout(() => setExportingMode(null), 600);
    }
  };

  const filteredAlbums = (overview?.albums || []).filter((a) => {
    const q = albumSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      a.title.toLowerCase().includes(q) ||
      a.ownerName.toLowerCase().includes(q) ||
      a.visibility.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-[1360px] mx-auto px-6 sm:px-8 pt-10 pb-24">
      <header className="pb-8 border-b border-[#E2DCC8] dark:border-[#2A3124] flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#008732] dark:text-[#FCD116]">
            Administrator Control Panel · {user.email}
          </p>
          <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA]">
            Site cPanel
          </h1>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C]">
            Live-edit branding, Rasta theme mode, announcement banner, bulk upload concurrency,
            albums, and admin roles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => void handleDownloadAppZip(false)}
            disabled={exportingMode !== null}
            style={{ backgroundColor: 'var(--accent)' }}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-60 whitespace-nowrap"
          >
            {exportingMode === 'code' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>{exportingMode === 'code' ? 'Bundling ZIP...' : 'Download App ZIP'}</span>
          </button>
          <button
            type="button"
            onClick={() => void loadOverview()}
            disabled={loadingOverview}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-[#151811] dark:text-[#F5F3EA] bg-white dark:bg-[#151912] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingOverview ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh Stats</span>
          </button>
        </div>
      </header>

      {/* Platform Overview Strip */}
      {overview && (
        <section className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl p-4">
            <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C]">Total Archived Media</p>
            <p className="mt-1 font-mono-tabular text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
              {overview.stats.totalMedia.toLocaleString()}
            </p>
            <p className="mt-0.5 font-mono-tabular text-xs text-[#008732] dark:text-[#FCD116]">
              {formatBytes(overview.stats.totalBytes)} · No cap
            </p>
          </div>
          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl p-4">
            <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C]">Total Albums</p>
            <p className="mt-1 font-mono-tabular text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
              {overview.stats.totalAlbums.toLocaleString()}
            </p>
            <p className="mt-0.5 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              {overview.stats.publicAlbums} public · {overview.stats.privateAlbums} private
            </p>
          </div>
          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl p-4">
            <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C]">Registered Accounts</p>
            <p className="mt-1 font-mono-tabular text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
              {overview.stats.totalUsers.toLocaleString()}
            </p>
            <p className="mt-0.5 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              Sign-ups {allowRegistrations ? 'Open' : 'Paused'}
            </p>
          </div>
          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl p-4">
            <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C]">Bulk Upload Engine</p>
            <p className="mt-1 font-mono-tabular text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
              {uploadConcurrency}× Parallel
            </p>
            <p className="mt-0.5 font-mono-tabular text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
              {chunkSizeMb} MiB chunks · 5,000+ batch ready
            </p>
          </div>
        </section>
      )}

      {/* cPanel Tabs */}
      <div
        role="tablist"
        aria-label="cPanel sections"
        className="mt-8 inline-flex items-center p-1 bg-[#EFEBD9] dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-xl overflow-x-auto max-w-full"
      >
        {(
          [
            { id: 'branding', label: 'Site & Theme', icon: Palette },
            { id: 'uploads', label: 'Upload & Privacy', icon: Sliders },
            { id: 'albums', label: `Albums (${overview?.albums.length ?? 0})`, icon: FolderKanban },
            { id: 'users', label: `Users (${overview?.users.length ?? 0})`, icon: Users },
            { id: 'export', label: 'Export & Host', icon: Package },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                active
                  ? 'bg-white dark:bg-[#232B1E] text-[#151811] dark:text-[#FCD116] shadow-xs'
                  : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-5 text-xs font-medium text-[#CE1126] dark:text-red-300 bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-900 rounded-lg px-4 py-3"
        >
          {error}
        </p>
      )}
      {savedNotice && (
        <p
          role="status"
          className="mt-5 inline-flex items-center gap-2 text-xs font-medium text-[#008732] dark:text-[#4ADE80] bg-[#F0FDF4] dark:bg-emerald-950/50 border border-[#BBF7D0] dark:border-emerald-900 rounded-lg px-4 py-3"
        >
          <Check className="w-4 h-4" aria-hidden="true" />
          <span>{savedNotice}</span>
        </p>
      )}

      {/* TAB 1: Site & Theme */}
      {activeTab === 'branding' && (
        <form
          onSubmit={handleSave}
          className="mt-6 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-6 sm:p-8 space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label htmlFor="cp-site-name" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Website Name
              </label>
              <input
                id="cp-site-name"
                type="text"
                required
                maxLength={80}
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              />
            </div>

            <div>
              <label htmlFor="cp-hero-kicker" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Hero Kicker Label
              </label>
              <input
                id="cp-hero-kicker"
                type="text"
                maxLength={60}
                value={heroKicker}
                onChange={(e) => setHeroKicker(e.target.value)}
                className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cp-hero-headline" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Homepage Hero Headline
            </label>
            <input
              id="cp-hero-headline"
              type="text"
              required
              maxLength={160}
              value={heroHeadline}
              onChange={(e) => setHeroHeadline(e.target.value)}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
            />
          </div>

          <div>
            <label htmlFor="cp-hero-sub" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Homepage Hero Description
            </label>
            <textarea
              id="cp-hero-sub"
              rows={2}
              maxLength={400}
              value={heroSubheadline}
              onChange={(e) => setHeroSubheadline(e.target.value)}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
            />
          </div>

          <div>
            <label htmlFor="cp-footer-text" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Footer Text
            </label>
            <input
              id="cp-footer-text"
              type="text"
              maxLength={240}
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
            />
          </div>

          {/* Theme Mode + Accent Swatches */}
          <div className="pt-5 border-t border-[#ECE8D9] dark:border-[#262C21] grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Site Theme Mode (Rasta Palette)
              </p>
              <div className="mt-2.5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setThemeMode('dark')}
                  className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-left text-xs font-medium transition-colors ${
                    themeMode === 'dark'
                      ? 'border-[#FCD116] bg-[#1E2418] text-[#FCD116]'
                      : 'border-[#D8D1BC] dark:border-[#2E3627] text-[#5A5E52] dark:text-[#A6AA9C]'
                  }`}
                >
                  <Moon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Dark Rasta Obsidian</span>
                </button>
                <button
                  type="button"
                  onClick={() => setThemeMode('light')}
                  className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-left text-xs font-medium transition-colors ${
                    themeMode === 'light'
                      ? 'border-[#008732] bg-[#008732]/10 text-[#008732] dark:text-[#4ADE80]'
                      : 'border-[#D8D1BC] dark:border-[#2E3627] text-[#5A5E52] dark:text-[#A6AA9C]'
                  }`}
                >
                  <Sun className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Light Sunlit Roots</span>
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="cp-accent-hex" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Primary Button Accent Color
              </label>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => setAccentColor(preset.hex)}
                    title={preset.label}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium ${
                      accentColor.toLowerCase() === preset.hex.toLowerCase()
                        ? 'border-[#151811] dark:border-[#FCD116] text-[#151811] dark:text-[#F5F3EA]'
                        : 'border-[#D8D1BC] dark:border-[#2E3627] text-[#5A5E52] dark:text-[#A6AA9C]'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0"
                      style={{ backgroundColor: preset.hex }}
                    />
                    <span>{preset.label}</span>
                  </button>
                ))}
                <input
                  id="cp-accent-hex"
                  type="text"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  maxLength={7}
                  className="w-24 px-2.5 py-1.5 text-xs font-mono-tabular bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
                />
              </div>
            </div>
          </div>

          {/* Live Announcement Banner */}
          <div className="pt-5 border-t border-[#ECE8D9] dark:border-[#262C21] space-y-3">
            <label className="inline-flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={announcementEnabled}
                onChange={(e) => setAnnouncementEnabled(e.target.checked)}
                className="w-4 h-4 rounded accent-[#008732]"
              />
              <span className="text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Display site-wide announcement banner below the header
              </span>
            </label>
            <input
              type="text"
              aria-label="Announcement banner message"
              value={announcementText}
              onChange={(e) => setAnnouncementText(e.target.value)}
              maxLength={280}
              placeholder="e.g., Fresh drops live now — 5,000+ bulk upload enabled!"
              className="w-full px-3.5 py-2 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
            />
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-6 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Site Changes'}
            </button>
          </div>
        </form>
      )}

      {/* TAB 2: Upload & Privacy Defaults */}
      {activeTab === 'uploads' && (
        <form
          onSubmit={handleSave}
          className="mt-6 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-6 sm:p-8 space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="cp-concurrency" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Default Parallel Upload Streams (1–16)
              </label>
              <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Controls how many files stream concurrently during 5,000+ file drops.
              </p>
              <select
                id="cp-concurrency"
                value={uploadConcurrency}
                onChange={(e) => setUploadConcurrency(Number(e.target.value))}
                className="mt-2 w-full px-3.5 py-2.5 text-sm font-mono-tabular bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              >
                {[1, 2, 4, 6, 8, 12, 16].map((n) => (
                  <option key={n} value={n}>
                    {n} parallel streams
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="cp-chunk-size" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Chunk Stream Size (MiB)
              </label>
              <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Larger chunks speed up multi-gigabyte 4K/8K videos on fast connections.
              </p>
              <select
                id="cp-chunk-size"
                value={chunkSizeMb}
                onChange={(e) => setChunkSizeMb(Number(e.target.value))}
                className="mt-2 w-full px-3.5 py-2.5 text-sm font-mono-tabular bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              >
                {[2, 4, 8, 16, 32].map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MiB per chunk (Zero total size cap)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pt-5 border-t border-[#ECE8D9] dark:border-[#262C21] grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="cp-default-vis" className="block text-xs font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Default Visibility for New Albums
              </label>
              <select
                id="cp-default-vis"
                value={defaultAlbumVisibility}
                onChange={(e) => setDefaultAlbumVisibility(e.target.value as AlbumVisibility)}
                className="mt-2 w-full px-3.5 py-2.5 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              >
                <option value="private">Private (Owner & Invited)</option>
                <option value="unlisted">Unlisted (Share Link)</option>
                <option value="public">Public (Explore Gallery)</option>
              </select>
            </div>

            <div className="space-y-3 pt-1">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowRegistrations}
                  onChange={(e) => setAllowRegistrations(e.target.checked)}
                  className="w-4 h-4 rounded accent-[#008732]"
                />
                <span className="text-xs font-medium text-[#151811] dark:text-[#F5F3EA]">
                  Allow new user account registrations
                </span>
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={defaultAllowDownloads}
                  onChange={(e) => setDefaultAllowDownloads(e.target.checked)}
                  className="w-4 h-4 rounded accent-[#008732]"
                />
                <span className="text-xs font-medium text-[#151811] dark:text-[#F5F3EA]">
                  Enable original file downloads by default on new albums
                </span>
              </label>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              style={{ backgroundColor: 'var(--accent)' }}
              className="px-6 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Engine Settings'}
            </button>
          </div>
        </form>
      )}

      {/* TAB 3: Albums Moderation */}
      {activeTab === 'albums' && (
        <section className="mt-6 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-[#ECE8D9] dark:border-[#262C21] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="font-display text-base font-semibold text-[#151811] dark:text-[#F5F3EA]">
              All Site Albums ({filteredAlbums.length})
            </h2>
            <input
              type="search"
              value={albumSearch}
              onChange={(e) => setAlbumSearch(e.target.value)}
              placeholder="Search albums or owners..."
              className="px-3.5 py-2 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA] w-full sm:w-64"
            />
          </div>

          <div className="divide-y divide-[#ECE8D9] dark:divide-[#262C21]">
            {filteredAlbums.map((album) => (
              <div
                key={album.id}
                className="px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenAlbum(album.id)}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] hover:text-[#008732] dark:hover:text-[#FCD116]"
                  >
                    <span className="truncate">{album.title}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  </button>
                  <p className="mt-1 text-xs font-mono-tabular text-[#5A5E52] dark:text-[#A6AA9C]">
                    By {album.ownerName} · {album.itemCount.toLocaleString()} files ·{' '}
                    {formatBytes(album.totalBytes)} · Updated {formatRelativeDate(album.updatedAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <select
                    aria-label={`Visibility for ${album.title}`}
                    value={album.visibility}
                    disabled={busyId === album.id}
                    onChange={async (e) => {
                      const nextVis = e.target.value as AlbumVisibility;
                      setBusyId(album.id);
                      setError('');
                      try {
                        await api.adminUpdateAlbum(album.id, { visibility: nextVis });
                        await Promise.all([loadOverview(), onAlbumsOrUsersChanged()]);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Update failed.');
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    className="px-3 py-1.5 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>

                  <button
                    type="button"
                    disabled={busyId === album.id}
                    onClick={async () => {
                      setBusyId(album.id);
                      setError('');
                      try {
                        await api.adminDeleteAlbum(album.id);
                        await Promise.all([loadOverview(), onAlbumsOrUsersChanged()]);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Delete failed.');
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    aria-label={`Delete album ${album.title}`}
                    className="p-2 text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#CE1126] rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* TAB 4: Users & Roles */}
      {activeTab === 'users' && (
        <section className="mt-6 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl overflow-hidden divide-y divide-[#ECE8D9] dark:divide-[#262C21]">
          {(overview?.users || []).map((account) => (
            <div
              key={account.uid}
              className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] truncate">
                  {account.displayName}{' '}
                  <span className="font-normal text-[#5A5E52] dark:text-[#A6AA9C]">
                    @{account.handle}
                  </span>
                </p>
                <p className="mt-0.5 text-xs font-mono-tabular text-[#5A5E52] dark:text-[#A6AA9C]">
                  {account.email} · {account.provider} · {formatBytes(account.totalBytesUploaded)}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span
                  className={`text-xs font-medium ${
                    account.isAdmin
                      ? 'text-[#008732] dark:text-[#FCD116]'
                      : 'text-[#5A5E52] dark:text-[#A6AA9C]'
                  }`}
                >
                  {account.isAdmin ? 'Admin' : 'Member'}
                </span>
                <button
                  type="button"
                  disabled={busyId === account.uid}
                  onClick={async () => {
                    setBusyId(account.uid);
                    setError('');
                    try {
                      await api.adminUpdateUserRole(account.uid, !account.isAdmin);
                      await loadOverview();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Role update failed.');
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-[#151811] dark:text-[#F5F3EA] bg-[#F8F6EE] dark:bg-[#1D2318] border border-[#D8D1BC] dark:border-[#343D2C] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] disabled:opacity-50 whitespace-nowrap"
                >
                  {account.isAdmin ? 'Revoke Admin' : 'Make Admin'}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* TAB 5: Export & Self-Host App ZIP */}
      {activeTab === 'export' && (
        <section className="mt-6 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-6 flex flex-col justify-between gap-5">
              <div>
                <div className="inline-flex items-center gap-2 text-xs font-medium text-[#008732] dark:text-[#FCD116]">
                  <Package className="w-4 h-4" aria-hidden="true" />
                  <span>Recommended for Hosting</span>
                </div>
                <h2 className="mt-2 font-display text-xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
                  App Source &amp; Production Build (.zip)
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
                  Lightweight deployment package containing all frontend and backend source code,
                  the compiled <code className="font-mono-tabular">dist/</code> bundle, Firebase
                  config/rules, and a <code className="font-mono-tabular">DEPLOY_README.txt</code>{' '}
                  setup guide. Excludes <code className="font-mono-tabular">node_modules</code> and
                  secrets.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDownloadAppZip(false)}
                disabled={exportingMode !== null}
                style={{ backgroundColor: 'var(--accent)' }}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-60"
              >
                {exportingMode === 'code' ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {exportingMode === 'code' ? 'Preparing App ZIP...' : 'Download App ZIP (Code + Build)'}
                </span>
              </button>
            </div>

            <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-6 flex flex-col justify-between gap-5">
              <div>
                <div className="inline-flex items-center gap-2 text-xs font-medium text-[#B88200] dark:text-[#FCD116]">
                  <HardDrive className="w-4 h-4" aria-hidden="true" />
                  <span>
                    Complete Migration Backup
                    {overview ? ` · ~${formatBytes(overview.stats.totalBytes)}` : ''}
                  </span>
                </div>
                <h2 className="mt-2 font-display text-xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
                  Full Site + Uploaded Media Backup (.zip)
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#5A5E52] dark:text-[#A6AA9C]">
                  Includes everything in the deployment ZIP plus your vault database, all uploaded
                  videos and photos, video thumbnails, custom album covers, and profile avatars so
                  you can move your entire existing library to another server.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDownloadAppZip(true)}
                disabled={exportingMode !== null}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-[#151811] dark:text-[#F5F3EA] bg-[#F8F6EE] dark:bg-[#1D2318] border border-[#D8D1BC] dark:border-[#343D2C] rounded-lg hover:border-[#009B3A] dark:hover:border-[#FCD116] disabled:opacity-60"
              >
                {exportingMode === 'full' ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {exportingMode === 'full' ? 'Streaming Full Backup...' : 'Download Full Site + Media ZIP'}
                </span>
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-6">
            <h3 className="font-display text-lg font-semibold text-[#151811] dark:text-[#F5F3EA]">
              Quick Hosting Checklist
            </h3>
            <ol className="mt-3 space-y-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C] list-decimal list-inside">
              <li>
                Upload and unzip on a Node.js host (Render, Railway, Fly.io, DigitalOcean, VPS, or
                cPanel Node.js App — Node 20+ recommended).
              </li>
              <li>
                Run <code className="font-mono-tabular text-[#151811] dark:text-[#F5F3EA]">npm install</code>,{' '}
                <code className="font-mono-tabular text-[#151811] dark:text-[#F5F3EA]">npm run build</code>, and start with{' '}
                <code className="font-mono-tabular text-[#151811] dark:text-[#F5F3EA]">npx tsx server.ts</code>.
              </li>
              <li>
                If you connect a custom domain, add it under Firebase Console → Authentication →
                Settings → Authorized domains so Google Sign-In works on your live URL.
              </li>
            </ol>
          </div>
        </section>
      )}
    </div>
  );
}
