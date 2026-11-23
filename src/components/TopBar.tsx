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
    <header className="sticky top-0 z-30 bg-[#F3F6F4]/88 dark:bg-[#060807]/85 backdrop-blur-xl border-b border-[#D4DFD7] dark:border-[#1C2A21]">
      {/* Luminous 3px High-Tech Rasta Tricolor Laser */}
      <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />

      <div className="max-w-[1360px] mx-auto px-6 sm:px-8 h-16 flex items-center justify-between gap-6">
        {/* Zone 1: Brand Emblem + Wordmark */}
        <button
          type="button"
          onClick={() => handleNav('explore')}
          className="group inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 hover:opacity-90 transition-opacity"
        >
          <span
            aria-hidden="true"
            className="w-7 h-7 rounded-lg bg-[#0C120E] dark:bg-[#101813] border border-[#24382B] flex flex-col justify-center gap-[3px] px-1.5 shadow-xs"
          >
            <span className="h-[2px] w-full rounded-full bg-[#00E676]" />
            <span className="h-[2px] w-3/4 rounded-full bg-[#FFD600]" />
            <span className="h-[2px] w-1/2 rounded-full bg-[#FF2A3C]" />
          </span>
          <span className="font-display text-lg sm:text-xl font-bold tracking-tight text-[#0C120E] dark:text-[#EEF4F0] group-hover:text-[#00A846] dark:group-hover:text-[#FFD600] transition-colors">
            {siteSettings.siteName}
          </span>
        </button>

        {/* Zone 2: Concise single-line HUD nav links */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-[13px] font-medium tracking-wide"
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
                    ? 'text-[#0C120E] dark:text-[#FFD600]'
                    : 'text-[#526056] dark:text-[#8FA395] hover:text-[#0C120E] dark:hover:text-[#EEF4F0]'
                }`}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 min-w-[18px] text-center font-mono-tabular text-[10px] font-bold leading-none rounded-full bg-[#FF2A3C] text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
                {isCurrent && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-[22px] h-[2px] bg-[#00A846] dark:bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,0.85)]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: User Avatar + Glowing Primary CTA */}
        <div className="flex items-center gap-3 shrink-0">
          {user && (
            <button
              type="button"
              onClick={() => handleNav('account')}
              aria-label={`Account profile for ${user.displayName}`}
              className="rounded-full ring-1 ring-[#D4DFD7] dark:ring-[#24382B] hover:ring-[#00E676] dark:hover:ring-[#FFD600] transition-all focus:outline-none focus:ring-2 focus:ring-[#FFD600]"
            >
              <UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size="sm" />
            </button>
          )}

          <button
            type="button"
            onClick={() => handleNav(user ? 'upload' : 'account')}
            style={{ backgroundColor: 'var(--accent)' }}
            className="px-4 py-2 text-xs sm:text-sm font-semibold tracking-wide text-white rounded-lg tech-glow-green hover:brightness-110 transition-all whitespace-nowrap shrink-0"
          >
            {user ? 'Upload' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-[#0C120E] dark:text-[#EEF4F0] hover:bg-[#E4ECE6] dark:hover:bg-[#131E17] transition-colors"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Optional cPanel Announcement Bar */}
      {siteSettings.announcementEnabled && siteSettings.announcementText.trim() && (
        <div className="bg-[#0B110D] dark:bg-[#0B120E] border-t border-[#1C2A21] px-6 py-1.5 text-center font-mono-tabular text-[11px] font-medium tracking-wide text-[#FFD600]">
          {siteSettings.announcementText}
        </div>
      )}

      {/* Compact mobile navigation drawer */}
      {mobileMenuOpen && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden bg-white dark:bg-[#0B100D] border-t border-[#D4DFD7] dark:border-[#1C2A21] px-6 py-4 flex flex-col gap-1"
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
                    ? 'bg-[#E7F2EB] dark:bg-[#132118] text-[#00A846] dark:text-[#FFD600]'
                    : 'text-[#526056] dark:text-[#8FA395] hover:bg-[#F3F6F4] dark:hover:bg-[#111914] hover:text-[#0C120E] dark:hover:text-[#EEF4F0]'
                }`}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="px-2 py-0.5 font-mono-tabular text-[10px] font-bold rounded-full bg-[#FF2A3C] text-white">
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
