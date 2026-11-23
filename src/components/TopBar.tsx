import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import type { AppView, SiteSettings, UserAccount } from '../types/media';
import { UserAvatar } from './UserAvatar';

interface TopBarProps {
  activeView: AppView;
  user: UserAccount | null;
  siteSettings: SiteSettings;
  unreadMessages?: number;
  onNavigate: (view: AppView) => void;
}

export function TopBar({
  activeView,
  user,
  siteSettings,
  unreadMessages = 0,
  onNavigate,
}: TopBarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems: Array<{ id: AppView; label: string; badge?: number }> = [
    { id: 'explore', label: 'Explore' },
    { id: 'albums', label: 'My Albums' },
    { id: 'shared', label: 'Shared' },
    { id: 'messages', label: 'Messages', badge: unreadMessages > 0 ? unreadMessages : undefined },
    ...(user?.isAdmin ? [{ id: 'cpanel' as const, label: 'cPanel' }] : []),
    { id: 'account', label: 'Account' },
  ];

  const handleNav = (view: AppView) => {
    setMobileMenuOpen(false);
    onNavigate(view);
  };

  return (
    <header className="sticky top-0 z-30 bg-[#F8F6EE]/95 dark:bg-[#0D0F0B]/95 backdrop-blur-sm border-b border-[#E2DCC8] dark:border-[#2A3124]">
      {/* Signature 3px Rasta Tricolor Ribbon */}
      <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />

      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 h-16 flex items-center justify-between gap-6">
        {/* Zone 1: Single-element Brand wordmark */}
        <button
          type="button"
          onClick={() => handleNav('explore')}
          className="font-display text-xl font-bold tracking-tight text-[#151811] dark:text-[#FCD116] whitespace-nowrap shrink-0 hover:opacity-85 transition-opacity"
        >
          {siteSettings.siteName}
        </button>

        {/* Zone 2: Concise single-line text nav links */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium"
        >
          {navItems.map((item) => {
            const isCurrent =
              activeView === item.id ||
              (item.id === 'albums' && activeView === 'album-detail');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNav(item.id)}
                aria-current={isCurrent ? 'page' : undefined}
                className={`relative py-1 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                  isCurrent
                    ? 'text-[#151811] dark:text-[#FCD116]'
                    : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-[#F5F3EA]'
                }`}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 min-w-[18px] text-center text-[10px] font-bold leading-none rounded-full bg-[#CE1126] text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
                {isCurrent && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-[21px] h-[2px] bg-[#008732] dark:bg-[#FCD116]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: User Avatar + Primary action */}
        <div className="flex items-center gap-3 shrink-0">
          {user && (
            <button
              type="button"
              onClick={() => handleNav('account')}
              aria-label={`Account profile for ${user.displayName}`}
              className="rounded-full focus:outline-none focus:ring-2 focus:ring-[#009B3A] dark:focus:ring-[#FCD116]"
            >
              <UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size="sm" />
            </button>
          )}

          <button
            type="button"
            onClick={() => handleNav(user ? 'upload' : 'account')}
            style={{ backgroundColor: 'var(--accent)' }}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
          >
            {user ? 'Upload' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-[#151811] dark:text-[#F5F3EA] hover:bg-[#ECE8D9] dark:hover:bg-[#1E2418] transition-colors"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Optional cPanel Announcement Bar */}
      {siteSettings.announcementEnabled && siteSettings.announcementText.trim() && (
        <div className="bg-[#151912] dark:bg-[#1B2216] border-t border-[#2A3124] px-6 py-2 text-center text-xs font-medium text-[#FCD116]">
          {siteSettings.announcementText}
        </div>
      )}

      {/* Compact mobile navigation drawer */}
      {mobileMenuOpen && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden bg-white dark:bg-[#151912] border-t border-[#E2DCC8] dark:border-[#2A3124] px-6 py-4 flex flex-col gap-1"
        >
          {navItems.map((item) => {
            const isCurrent = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNav(item.id)}
                aria-current={isCurrent ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'bg-[#EFEBD9] dark:bg-[#232B1E] text-[#151811] dark:text-[#FCD116]'
                    : 'text-[#5A5E52] dark:text-[#A6AA9C] hover:bg-[#F8F6EE] dark:hover:bg-[#1C2217] hover:text-[#151811] dark:hover:text-[#F5F3EA]'
                }`}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-[#CE1126] text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
}
