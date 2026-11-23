import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { computeThumbnailSeekSeconds, generateVideoPoster } from './videoThumbnail';

const execFileAsync = promisify(execFile);

test('computeThumbnailSeekSeconds chooses representative non-black timestamps across clip lengths', () => {
  assert.equal(computeThumbnailSeekSeconds(0), 0.5);
  assert.equal(computeThumbnailSeekSeconds(0.4), 0);
  assert.equal(computeThumbnailSeekSeconds(2), 0.5);
  assert.equal(computeThumbnailSeekSeconds(6), 1.0);
  assert.equal(computeThumbnailSeekSeconds(30), 3.0);
  assert.equal(computeThumbnailSeekSeconds(12), 1.8);
});

test('generateVideoPoster extracts a real JPEG preview frame and metadata from a video file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-poster-test-'));
  const sampleVideo = path.join(tmpDir, 'sample.mp4');
  const outPoster = path.join(tmpDir, 'sample.jpg');

  try {
    // Generate a tiny real 2-second 320x240 MP4 clip via ffmpeg
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=15',
        '-pix_fmt',
        'yuv420p',
        sampleVideo,
      ],
      { timeout: 15000 }
    );

    const result = await generateVideoPoster(sampleVideo, outPoster);
    assert.equal(result.posterCreated, true);
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.durationSec, 2);

    assert.equal(fs.existsSync(outPoster), true);
    const bytes = fs.readFileSync(outPoster);
    assert.ok(bytes.length > 500, 'JPEG poster should contain real image data');
    // Verify JPEG magic header FF D8 FF
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.equal(bytes[2], 0xff);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
