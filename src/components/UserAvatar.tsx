import { useState } from 'react';

interface UserAvatarProps {
  name: string;
  avatarUrl?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<UserAvatarProps['size']>, string> = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-lg',
  xl: 'w-20 h-20 text-2xl',
};

const DOT_CLASSES: Record<NonNullable<UserAvatarProps['size']>, string> = {
  xs: 'w-2 h-2',
  sm: 'w-2.5 h-2.5',
  md: 'w-2.5 h-2.5',
  lg: 'w-3.5 h-3.5',
  xl: 'w-4 h-4',
};

function getInitials(name: string): string {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function UserAvatar({
  name,
  avatarUrl,
  size = 'md',
  online,
  className = '',
}: UserAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = Boolean(avatarUrl && !imgFailed);

  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <span
        className={`${SIZE_CLASSES[size]} rounded-full overflow-hidden inline-flex items-center justify-center font-display font-semibold select-none border border-[#D8D1BC] dark:border-[#2E3627] bg-[#EFEBD9] dark:bg-[#1E2519] text-[#008732] dark:text-[#FCD116]`}
      >
        {showImage ? (
          <img
            src={avatarUrl}
            alt={name}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span aria-hidden="true">{getInitials(name)}</span>
        )}
      </span>
      {online && (
        <span
          aria-label="Online"
          className={`absolute bottom-0 right-0 ${DOT_CLASSES[size]} rounded-full bg-[#22C55E] ring-2 ring-[#F8F6EE] dark:ring-[#151912]`}
        />
      )}
    </span>
  );
}
