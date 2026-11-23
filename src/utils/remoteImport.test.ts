import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectMediaKindFromUrlOrMime,
  extractMediaCandidatesFromHtml,
  inferFilenameFromUrl,
  isBlockedIpAddress,
  parseLinkListInput,
  validateExternalImportUrl,
} from './remoteImport.ts';

test('validateExternalImportUrl accepts public http and https links', () => {
  const a = validateExternalImportUrl('https://images.example.com/gallery/photo-01.jpg');
  assert.equal(a.ok, true);
  assert.equal(a.url?.hostname, 'images.example.com');

  const b = validateExternalImportUrl('http://cdn.example.org/videos/clip.mp4?token=abc');
  assert.equal(b.ok, true);
});

test('validateExternalImportUrl blocks dangerous schemes, localhost, internal domains, and private IPs', () => {
  const blockedUrls = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://example.com/photo.jpg',
    'http://localhost:3000/api/settings',
    'http://sub.localhost/a.jpg',
    'http://myserver.local/a.jpg',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://127.0.0.1/secret.jpg',
    'http://10.0.0.5/photo.png',
    'http://172.16.10.2/video.mp4',
    'http://192.168.1.50/cam.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/internal.jpg',
    'http://[::1]:3000/api/settings',
    'http://[fe80::1]/img.jpg',
    'http://[fc00::1]/img.jpg',
    'http://[::ffff:127.0.0.1]/img.jpg',
    'http://user:pass@example.com/a.jpg',
    'http://2130706433/a.jpg',
    'http://intranet/photo.jpg',
  ];

  for (const url of blockedUrls) {
    const result = validateExternalImportUrl(url);
    assert.equal(result.ok, false, `Expected URL to be blocked: ${url}`);
  }
});

test('isBlockedIpAddress accurately separates private/loopback/metadata IPs from public IPs', () => {
  assert.equal(isBlockedIpAddress('127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('10.20.30.40'), true);
  assert.equal(isBlockedIpAddress('172.31.255.1'), true);
  assert.equal(isBlockedIpAddress('192.168.0.1'), true);
  assert.equal(isBlockedIpAddress('169.254.169.254'), true);
  assert.equal(isBlockedIpAddress('100.64.12.3'), true);
  assert.equal(isBlockedIpAddress('0.0.0.0'), true);
  assert.equal(isBlockedIpAddress('::1'), true);
  assert.equal(isBlockedIpAddress('::'), true);
  assert.equal(isBlockedIpAddress('fe80::1234'), true);
  assert.equal(isBlockedIpAddress('fd12:3456::1'), true);
  assert.equal(isBlockedIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('::ffff:169.254.169.254'), true);

  assert.equal(isBlockedIpAddress('8.8.8.8'), false);
  assert.equal(isBlockedIpAddress('1.1.1.1'), false);
  assert.equal(isBlockedIpAddress('93.184.216.34'), false);
  assert.equal(isBlockedIpAddress('172.32.0.1'), false);
  assert.equal(isBlockedIpAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('extractMediaCandidatesFromHtml parses album title, videos, high-res images, and filters unsafe/icon URLs', () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Summer Rooftop Session | Gallery</title>
        <meta property="og:title" content="Summer Rooftop Session" />
        <meta property="og:description" content="Full high-res photo and video drop" />
        <meta property="og:image" content="https://cdn.example.com/hero.jpg" />
        <meta property="og:video:secure_url" content="https://cdn.example.com/reel.mp4" />
      </head>
      <body>
        <img src="/icons/favicon.ico" width="16" height="16" />
        <img src="/logo.svg" />
        <img src="http://127.0.0.1/private.jpg" />
        <img
          src="/thumbs/shot1-small.jpg"
          data-original="/full/shot1.jpg"
          alt="Sunset Skyline"
        />
        <img
          srcset="https://cdn.example.com/shot2-400.webp 400w, https://cdn.example.com/shot2-1600.webp 1600w"
          alt="Neon Stage"
        />
        <video controls>
          <source src="/clips/encore.webm" type="video/webm" />
        </video>
        <a href="/downloads/raw-clip.mov" title="Raw Encore Clip">Download MOV</a>
      </body>
    </html>
  `;

  const result = extractMediaCandidatesFromHtml(html, 'https://gallery.example.com/albums/rooftop/');
  assert.equal(result.mode, 'album_page');
  assert.equal(result.pageTitle, 'Summer Rooftop Session');
  assert.equal(result.pageDescription, 'Full high-res photo and video drop');

  const urls = result.items.map((item) => item.url);
  assert.ok(urls.includes('https://cdn.example.com/reel.mp4'));
  assert.ok(urls.includes('https://gallery.example.com/clips/encore.webm'));
  assert.ok(urls.includes('https://gallery.example.com/downloads/raw-clip.mov'));
  assert.ok(urls.includes('https://gallery.example.com/full/shot1.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/shot2-1600.webp'));
  assert.ok(urls.includes('https://cdn.example.com/hero.jpg'));

  // Icons, SVGs, and internal SSRF targets must be excluded
  assert.ok(!urls.some((u) => u.includes('favicon.ico')));
  assert.ok(!urls.some((u) => u.includes('logo.svg')));
  assert.ok(!urls.some((u) => u.includes('127.0.0.1')));
  assert.equal(result.skippedCount, 1);

  const videoCount = result.items.filter((i) => i.kind === 'video').length;
  const photoCount = result.items.filter((i) => i.kind === 'photo').length;
  assert.equal(videoCount, 3);
  assert.equal(photoCount, 3);
});

test('detectMediaKindFromUrlOrMime and inferFilenameFromUrl handle MIME and Content-Disposition', () => {
  const vid = detectMediaKindFromUrlOrMime('video/mp4; charset=binary', 'https://cdn.example.com/stream?id=42');
  assert.deepEqual(vid, { kind: 'video', mimeType: 'video/mp4' });

  const img = detectMediaKindFromUrlOrMime('application/octet-stream', 'https://cdn.example.com/file/night_shot.webp');
  assert.deepEqual(img, { kind: 'photo', mimeType: 'image/webp' });

  const inferred = inferFilenameFromUrl(
    'https://cdn.example.com/download?id=99',
    'video/mp4',
    'Rooftop Clip',
    'attachment; filename="Rooftop_Night.mp4"'
  );
  assert.equal(inferred.fileName, 'Rooftop_Night.mp4');
  assert.equal(inferred.title, 'Rooftop Clip');
});

test('parseLinkListInput splits multi-line and comma-separated URLs and deduplicates', () => {
  const list = parseLinkListInput(`
    https://example.com/a.jpg
    https://example.com/b.mp4, https://example.com/a.jpg
    https://example.com/album
  `);
  assert.deepEqual(list, [
    'https://example.com/a.jpg',
    'https://example.com/b.mp4',
    'https://example.com/album',
  ]);
});
