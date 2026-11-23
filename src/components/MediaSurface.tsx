import { useEffect, useState } from 'react';
import { Image as ImageIcon, Play } from 'lucide-react';
import type { MediaKind } from '../types/media';
import { formatDuration } from '../utils/albumLogic';
import { extractMediaIdFromApiUrl } from '../utils/backupSync';
import { resolveProtectedUrl } from '../lib/api';
import { getLocalMediaBackup } from '../lib/localMediaBackup';

interface MediaSurfaceProps {
  src?: string;
  videoSrc?: string;
  alt: string;
  kind?: MediaKind;
  durationSec?: number;
  className?: string;
  imgClassName?: string;
  showVideoBadge?: boolean;
}

export function MediaSurface({
  src,
  videoSrc,
  alt,
  kind = 'photo',
  durationSec = 0,
  className = '',
  imgClassName = '',
  showVideoBadge = true,
}: MediaSurfaceProps) {
  const [failed, setFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [localFallback, setLocalFallback] = useState<{
    imgUrl: string | null;
    videoUrl: string | null;
  }>({ imgUrl: null, videoUrl: null });

  useEffect(() => {
    setFailed(false);
    setVideoFailed(false);
    setLocalFallback((prev) => {
      if (prev.imgUrl?.startsWith('blob:')) URL.revokeObjectURL(prev.imgUrl);
      if (prev.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(prev.videoUrl);
      return { imgUrl: null, videoUrl: null };
    });
  }, [src, videoSrc]);

  useEffect(() => {
    const serverImageFailed = !src || failed;
    const serverVideoFailed = !videoSrc || videoFailed;
    if (!serverImageFailed || !serverVideoFailed) return;

    const mediaId = extractMediaIdFromApiUrl(src) || extractMediaIdFromApiUrl(videoSrc);
    if (!mediaId) return;

    let cancelled = false;
    let createdObjectUrl: string | null = null;

    void getLocalMediaBackup(mediaId)
      .then((backup) => {
        if (cancelled || !backup) return;
        if (backup.posterDataUrl) {
          setLocalFallback({ imgUrl: backup.posterDataUrl, videoUrl: null });
        } else if (backup.blob) {
          createdObjectUrl = URL.createObjectURL(backup.blob);
          if (kind === 'video') {
            setLocalFallback({ imgUrl: null, videoUrl: createdObjectUrl });
          } else {
            setLocalFallback({ imgUrl: createdObjectUrl, videoUrl: null });
          }
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [src, videoSrc, failed, videoFailed, kind]);

  const resolvedSrc = src ? resolveProtectedUrl(src) : '';
  const effectiveImgSrc =
    Boolean(resolvedSrc) && !failed ? resolvedSrc : localFallback.imgUrl || '';
  const hasImage = Boolean(effectiveImgSrc);
  const resolvedVideoSrc = videoSrc ? resolveProtectedUrl(videoSrc) : '';
  const effectiveVideoSrc =
    Boolean(resolvedVideoSrc) && !videoFailed ? resolvedVideoSrc : localFallback.videoUrl || '';
  const hasVideoFallback = !hasImage && Boolean(effectiveVideoSrc);

  return (
    <div className={`relative overflow-hidden bg-[#E1EAE3] dark:bg-[#1A1F16] ${className}`}>
      {hasImage ? (
        <img
          src={effectiveImgSrc}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => {
            if (effectiveImgSrc === resolvedSrc) {
              setFailed(true);
            } else {
              setLocalFallback((prev) => ({ ...prev, imgUrl: null }));
            }
          }}
          className={`w-full h-full object-cover transition-transform duration-300 ease-out ${imgClassName}`}
        />
      ) : hasVideoFallback ? (
        <video
          src={`${effectiveVideoSrc}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          aria-label={alt}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.currentTime === 0 && Number.isFinite(v.duration) && v.duration > 0.5) {
              try {
                v.currentTime = Math.min(1, v.duration * 0.25);
              } catch {
                // ignore seek error
              }
            }
          }}
          onError={() => {
            if (effectiveVideoSrc === resolvedVideoSrc) {
              setVideoFailed(true);
            } else {
              setLocalFallback((prev) => ({ ...prev, videoUrl: null }));
            }
          }}
          className={`w-full h-full object-cover pointer-events-none transition-transform duration-300 ease-out ${imgClassName}`}
        />
      ) : (
        <div className="w-full h-full min-h-[160px] flex flex-col items-center justify-center bg-gradient-to-br from-[#E8EFEA] to-[#D4DFD7] dark:from-[#0E1611] dark:to-[#070B08] px-6 pb-6 text-center">
          {kind === 'video' ? (
            <span className="w-11 h-11 rounded-full bg-black/55 border border-[#FFD600]/35 flex items-center justify-center shadow-lg">
              <Play className="w-4 h-4 fill-current text-[#FFD600] ml-0.5" aria-hidden="true" />
            </span>
          ) : (
            <ImageIcon className="w-7 h-7 text-[#526056] dark:text-[#00E676]/80" aria-hidden="true" />
          )}
          <span className="mt-3 text-xs font-medium text-[#526056] dark:text-[#8FA395] line-clamp-2 max-w-[200px]">
            {alt}
          </span>
        </div>
      )}

      {kind === 'video' && showVideoBadge && (
        <>
          {(hasImage || hasVideoFallback) && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="w-11 h-11 rounded-full bg-black/55 backdrop-blur-xs border border-white/25 flex items-center justify-center shadow-lg transition-transform duration-200 group-hover:scale-105">
                <Play className="w-4 h-4 fill-current text-[#FFD600] ml-0.5" aria-hidden="true" />
              </span>
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent text-white">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide">
              <Play className="w-3.5 h-3.5 fill-current text-[#FFD600]" aria-hidden="true" />
              <span>Video</span>
            </span>
            {durationSec > 0 && (
              <span className="font-mono-tabular text-xs text-white/95 bg-black/45 px-1.5 py-0.5 rounded">
                {formatDuration(durationSec)}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
