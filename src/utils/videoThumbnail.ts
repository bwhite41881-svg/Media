import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoPosterResult {
  posterCreated: boolean;
  width: number;
  height: number;
  durationSec: number;
}

/**
 * Picks a representative seek timestamp in seconds so video thumbnails skip
 * dark fade-in frames at 0.0s while staying safely inside short clips.
 */
export function computeThumbnailSeekSeconds(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0.5;
  if (durationSec < 0.8) return 0;
  if (durationSec < 2.5) return Number((durationSec * 0.25).toFixed(2));
  if (durationSec < 10) return 1.0;
  return Number(Math.min(3.0, durationSec * 0.15).toFixed(2));
}

interface FfprobeStream {
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number | string }>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/**
 * Probes video dimensions (accounting for phone rotation metadata) and duration using ffprobe.
 */
export async function probeVideoMetadata(
  videoPath: string
): Promise<{ width: number; height: number; durationSec: number }> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        videoPath,
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout || '{}') as FfprobeOutput;
    const stream = parsed.streams?.[0];
    let width = Math.max(0, Math.round(Number(stream?.width || 0)));
    let height = Math.max(0, Math.round(Number(stream?.height || 0)));

    const rawRotate =
      stream?.tags?.rotate ??
      stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
    const rotation = Math.abs(Number(rawRotate || 0)) % 360;
    if (rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    const durationRaw = Number(parsed.format?.duration || 0);
    const durationSec =
      Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : 0;

    return { width, height, durationSec };
  } catch {
    return { width: 0, height: 0, durationSec: 0 };
  }
}

async function runFfmpegFrameExtract(
  videoPath: string,
  tempOutPath: string,
  seekSeconds: number
): Promise<boolean> {
  try {
    const args: string[] = ['-y', '-loglevel', 'error'];
    if (seekSeconds > 0) {
      args.push('-ss', String(seekSeconds));
    }
    args.push(
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(960,iw)':-2",
      '-q:v',
      '3',
      '-f',
      'image2',
      tempOutPath
    );
    await execFileAsync('ffmpeg', args, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    if (!fs.existsSync(tempOutPath)) return false;
    const stat = fs.statSync(tempOutPath);
    return stat.size > 256;
  } catch {
    return false;
  }
}

/**
 * Extracts a JPEG preview frame and real dimensions/duration from a video file on disk.
 * Writes to a unique temp file and renames atomically so concurrent readers never see partial JPEGs.
 */
export async function generateVideoPoster(
  videoPath: string,
  posterOutPath: string
): Promise<VideoPosterResult> {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { posterCreated: false, width: 0, height: 0, durationSec: 0 };
  }

  const meta = await probeVideoMetadata(videoPath);
  const seekSec = computeThumbnailSeekSeconds(meta.durationSec);

  const dir = path.dirname(posterOutPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${posterOutPath}.${process.pid}.${Date.now()}.tmp.jpg`;

  try {
    let ok = await runFfmpegFrameExtract(videoPath, tempPath, seekSec);
    if (!ok && seekSec > 0) {
      // Fallback to first frame if keyframe/seek exceeded clip bounds
      ok = await runFfmpegFrameExtract(videoPath, tempPath, 0);
    }
    if (ok && fs.existsSync(tempPath)) {
      fs.renameSync(tempPath, posterOutPath);
      return {
        posterCreated: true,
        width: meta.width,
        height: meta.height,
        durationSec: meta.durationSec,
      };
    }
    return {
      posterCreated: false,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
    };
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
