import type { MediaKind } from '../types/media.ts';

export interface RemoteMediaCandidate {
  url: string;
  kind: MediaKind;
  title: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  previewUrl?: string;
}

export interface RemoteInspectResult {
  mode: 'direct' | 'album_page' | 'batch_links';
  sourceUrl: string;
  pageTitle: string;
  pageDescription: string;
  items: RemoteMediaCandidate[];
  skippedCount?: number;
}

export interface UrlValidationResult {
  ok: boolean;
  url?: URL;
  error?: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.ogv',
  '.3gp',
  '.ts',
  '.m2ts',
]);

const SKIP_ICON_EXTENSIONS = new Set(['.svg', '.ico', '.cur', '.css', '.js', '.json', '.xml']);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/ogg': '.ogv',
  'video/3gpp': '.3gp',
};

function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (this network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918 private)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918 private)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918 private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function expandIpv6HexGroups(raw: string): number[] | null {
  const cleaned = raw.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!cleaned.includes(':')) return null;

  // Handle IPv4-mapped / IPv4-embedded IPv6 suffix (e.g., ::ffff:127.0.0.1)
  let working = cleaned;
  const lastColon = working.lastIndexOf(':');
  if (lastColon >= 0 && working.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(working.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      out.push(parseInt(token, 16));
    }
    return out;
  };

  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Checks whether an IPv4 or IPv6 address points to a private, loopback, link-local,
 * cloud metadata, multicast, or otherwise non-public address.
 */
export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = String(rawIp || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!ip) return true;

  const v4 = parseIpv4Octets(ip);
  if (v4) {
    return isBlockedIpv4(v4);
  }

  const groups = expandIpv6HexGroups(ip);
  if (!groups) {
    // Unknown or malformed IP literal — fail closed.
    return true;
  }

  // :: (unspecified) and ::1 (loopback)
  const isAllZeroPrefix = groups.slice(0, 7).every((g) => g === 0);
  if (isAllZeroPrefix && (groups[7] === 0 || groups[7] === 1)) {
    return true;
  }

  // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    const mappedV4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return isBlockedIpv4(mappedV4);
  }

  // Unique Local Addresses fc00::/7 (fc00..fdff)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return true;
  // Site-local deprecated fec0::/10
  if ((groups[0] & 0xffc0) === 0xfec0) return true;
  // Documentation 2001:db8::/32
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  return false;
}

/**
 * Validates that a user-supplied URL is a public http:// or https:// URL
 * and does not target localhost, internal hostnames, or private IP literals.
 */
export function validateExternalImportUrl(rawInput: string): UrlValidationResult {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Please paste a website, photo, or video link.' };
  }
  if (trimmed.length > 2048) {
    return { ok: false, error: 'Link is too long (maximum 2,048 characters).' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Please enter a valid link starting with https:// or http://.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only public http:// and https:// links are allowed.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Links containing embedded usernames or passwords are not allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    return { ok: false, error: 'Link must include a valid domain name.' };
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata' ||
    hostname === 'ip6-localhost' ||
    hostname === 'ip6-loopback'
  ) {
    return { ok: false, error: 'Local and private network links cannot be imported.' };
  }

  // Block integer/hex/octal obfuscated IPv4 hostnames (e.g., 2130706433, 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    return { ok: false, error: 'Numeric IP shortcuts are not allowed.' };
  }

  // Check explicit IPv4 or IPv6 literal hostnames
  const unbracketed = hostname.replace(/^\[|\]$/g, '');
  if (parseIpv4Octets(unbracketed) || unbracketed.includes(':')) {
    if (isBlockedIpAddress(unbracketed)) {
      return { ok: false, error: 'Private, loopback, or local network addresses cannot be imported.' };
    }
  } else if (!hostname.includes('.')) {
    // Reject bare single-label hostnames like http://intranet/file.jpg
    return { ok: false, error: 'Please provide a full public website domain (for example, https://example.com/...).' };
  }

  return { ok: true, url: parsed };
}

export function getUrlFileExtension(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || '';
    const lastSegment = pathname.split('/').pop() || '';
    const dotIdx = lastSegment.lastIndexOf('.');
    if (dotIdx <= 0) return '';
    return lastSegment.slice(dotIdx).toLowerCase().replace(/[^a-z0-9.]/g, '');
  } catch {
    return '';
  }
}

export function detectMediaKindFromUrlOrMime(
  mimeType: string,
  rawUrl: string
): { kind: MediaKind; mimeType: string } | null {
  const cleanMime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (cleanMime.startsWith('video/')) {
    return { kind: 'video', mimeType: cleanMime };
  }
  if (cleanMime.startsWith('image/') && cleanMime !== 'image/svg+xml' && cleanMime !== 'image/x-icon' && cleanMime !== 'image/vnd.microsoft.icon') {
    return { kind: 'photo', mimeType: cleanMime };
  }

  const ext = getUrlFileExtension(rawUrl);
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { kind: 'video', mimeType: MIME_BY_EXTENSION[ext] || 'video/mp4' };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { kind: 'photo', mimeType: MIME_BY_EXTENSION[ext] || 'image/jpeg' };
  }

  return null;
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function sanitizeBaseName(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120);
}

export function inferFilenameFromUrl(
  rawUrl: string,
  mimeType?: string,
  fallbackTitle?: string,
  contentDisposition?: string
): { fileName: string; title: string } {
  const cleanMime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mimeExt = EXTENSION_BY_MIME[cleanMime] || '';

  let rawCandidate = '';
  if (contentDisposition) {
    const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    const plainMatch = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    const picked = utf8Match?.[1] || plainMatch?.[1] || '';
    if (picked) {
      try {
        rawCandidate = decodeURIComponent(picked.trim());
      } catch {
        rawCandidate = picked.trim();
      }
    }
  }

  if (!rawCandidate) {
    try {
      const parsed = new URL(rawUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      if (last) {
        try {
          rawCandidate = decodeURIComponent(last);
        } catch {
          rawCandidate = last;
        }
      }
    } catch {
      // ignore
    }
  }

  const safeCandidate = sanitizeBaseName(rawCandidate);
  const dotIdx = safeCandidate.lastIndexOf('.');
  let stem = dotIdx > 0 ? safeCandidate.slice(0, dotIdx) : safeCandidate;
  let ext = dotIdx > 0 ? safeCandidate.slice(dotIdx).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';

  if (!IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) {
    ext = mimeExt || '.bin';
  }

  if (!stem || stem.length < 2) {
    stem = sanitizeBaseName(fallbackTitle || 'imported-media') || 'imported-media';
  }

  const safeFileName = `${stem.replace(/\s+/g, '_')}${ext}`;
  const humanTitle = sanitizeBaseName(
    fallbackTitle && fallbackTitle.trim().length > 1
      ? fallbackTitle
      : stem.replace(/[_-]+/g, ' ')
  ) || 'Imported Media';

  return { fileName: safeFileName, title: humanTitle };
}

function parseTagAttributes(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagBody)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(val.trim());
  }
  return attrs;
}

function pickBestSrcsetUrl(srcset: string): string {
  const entries = srcset
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0] || '';
      const descriptor = parts[1] || '1x';
      let score = 1;
      if (descriptor.endsWith('w')) {
        score = parseFloat(descriptor) || 1;
      } else if (descriptor.endsWith('x')) {
        score = (parseFloat(descriptor) || 1) * 1000;
      }
      return { url, score };
    })
    .filter((item) => item.url && !item.url.startsWith('data:'));

  if (entries.length === 0) return '';
  entries.sort((a, b) => b.score - a.score);
  return entries[0].url;
}

function isLikelyUiNoiseImage(urlStr: string, attrs?: Record<string, string>): boolean {
  const lower = urlStr.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('javascript:')) {
    return true;
  }
  const ext = getUrlFileExtension(urlStr);
  if (SKIP_ICON_EXTENSIONS.has(ext)) return true;

  if (
    /favicon|sprite|spacer|pixel|tracking|analytics|badge-icon|apple-touch-icon|1x1/i.test(lower)
  ) {
    return true;
  }

  if (attrs) {
    const w = Number(attrs.width);
    const h = Number(attrs.height);
    if ((Number.isFinite(w) && w > 0 && w < 64) || (Number.isFinite(h) && h > 0 && h < 64)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts album metadata (page title/description) and all valid public photo/video
 * candidates from an external HTML page.
 */
export function extractMediaCandidatesFromHtml(
  html: string,
  baseUrl: string,
  maxItems = 200
): RemoteInspectResult {
  const safeHtml = String(html || '');
  let pageTitle = '';
  let pageDescription = '';

  const ogMeta: Record<string, string[]> = {};
  const metaRegex = /<meta\b([^>]*?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRegex.exec(safeHtml)) !== null) {
    const attrs = parseTagAttributes(m[1]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    const content = attrs.content || '';
    if (!key || !content) continue;
    if (!ogMeta[key]) ogMeta[key] = [];
    ogMeta[key].push(content);
  }

  const titleMatch = safeHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle =
    ogMeta['og:title']?.[0] ||
    ogMeta['twitter:title']?.[0] ||
    (titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '');
  pageTitle = sanitizeBaseName(rawTitle);
  pageDescription = sanitizeBaseName(
    ogMeta['og:description']?.[0] ||
      ogMeta['description']?.[0] ||
      ogMeta['twitter:description']?.[0] ||
      ''
  );

  if (!pageTitle) {
    try {
      const parsed = new URL(baseUrl);
      pageTitle = sanitizeBaseName(parsed.hostname.replace(/^www\./, '')) || 'Imported Album';
    } catch {
      pageTitle = 'Imported Album';
    }
  }

  const seen = new Set<string>();
  const items: RemoteMediaCandidate[] = [];
  let skippedCount = 0;

  const addCandidate = (
    rawHref: string,
    forcedKind?: MediaKind,
    hintTitle?: string,
    mimeHint?: string,
    attrs?: Record<string, string>
  ) => {
    if (!rawHref || items.length >= maxItems) return;
    const trimmed = rawHref.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) {
      return;
    }

    let resolved: URL;
    try {
      resolved = new URL(trimmed, baseUrl);
    } catch {
      return;
    }
    resolved.hash = '';
    const normalizedUrl = resolved.toString();

    const validation = validateExternalImportUrl(normalizedUrl);
    if (!validation.ok) {
      skippedCount++;
      return;
    }

    if (seen.has(normalizedUrl)) return;

    const detected = detectMediaKindFromUrlOrMime(mimeHint || '', normalizedUrl);
    const kind: MediaKind | null = forcedKind || detected?.kind || null;
    if (!kind) return;

    if (kind === 'photo' && isLikelyUiNoiseImage(normalizedUrl, attrs)) {
      return;
    }

    const mimeType =
      detected?.mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    const { fileName, title } = inferFilenameFromUrl(normalizedUrl, mimeType, hintTitle);

    seen.add(normalizedUrl);
    items.push({
      url: normalizedUrl,
      kind,
      title,
      fileName,
      mimeType,
      previewUrl: kind === 'photo' ? normalizedUrl : undefined,
    });
  };

  // 1. OpenGraph / Twitter video metadata
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
    for (const val of ogMeta[key] || []) {
      const ext = getUrlFileExtension(val);
      if (VIDEO_EXTENSIONS.has(ext) || key === 'twitter:player:stream' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(val)) {
        addCandidate(val, 'video', pageTitle);
      }
    }
  }

  // 2. <video> and <source> tags
  const videoTagRegex = /<video\b([^>]*?)>/gi;
  while ((m = videoTagRegex.exec(safeHtml)) !== null) {
    const attrs = parseTagAttributes(m[1]);
    const src = attrs.src || attrs['data-src'] || '';
    if (src) addCandidate(src, 'video', attrs.title || attrs['aria-label'] || '');
  }

  const sourceTagRegex = /<source\b([^>]*?)>/gi;
  while ((m = sourceTagRegex.exec(safeHtml)) !== null) {
    const attrs = parseTagAttributes(m[1]);
    const type = (attrs.type || '').toLowerCase();
    if (attrs.src) {
      if (type.startsWith('video/') || VIDEO_EXTENSIONS.has(getUrlFileExtension(attrs.src))) {
        addCandidate(attrs.src, 'video', '', type);
      } else if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(getUrlFileExtension(attrs.src))) {
        addCandidate(attrs.src, 'photo', '', type);
      }
    } else if (attrs.srcset) {
      const best = pickBestSrcsetUrl(attrs.srcset);
      if (best) addCandidate(best, 'photo', '', type);
    }
  }

  // 3. Direct media <a href="...(.mp4|.jpg|.png|...)"> gallery links (often full-res originals!)
  const anchorRegex = /<a\b([^>]*?)>/gi;
  while ((m = anchorRegex.exec(safeHtml)) !== null) {
    const attrs = parseTagAttributes(m[1]);
    const href = attrs.href || '';
    if (!href) continue;
    const detected = detectMediaKindFromUrlOrMime('', href.startsWith('http') ? href : `https://placeholder.local/${href.replace(/^\/+/, '')}`);
    if (detected) {
      addCandidate(href, detected.kind, attrs.title || attrs['aria-label'] || '', detected.mimeType);
    }
  }

  // 4. <img> tags (prefer high-res data-original / data-src / largest srcset over thumbnail src)
  const imgRegex = /<img\b([^>]*?)>/gi;
  while ((m = imgRegex.exec(safeHtml)) !== null) {
    const attrs = parseTagAttributes(m[1]);
    const bestFromSrcset =
      (attrs['data-srcset'] && pickBestSrcsetUrl(attrs['data-srcset'])) ||
      (attrs.srcset && pickBestSrcsetUrl(attrs.srcset)) ||
      '';
    const picked =
      attrs['data-original'] ||
      attrs['data-full'] ||
      attrs['data-large-src'] ||
      bestFromSrcset ||
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs.src ||
      '';
    if (picked) {
      addCandidate(picked, 'photo', attrs.alt || attrs.title || '', '', attrs);
    }
  }

  // 5. OpenGraph / Twitter image fallback (good for single-photo pages where <img> is JS-rendered)
  for (const key of ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image:src', 'twitter:image']) {
    for (const val of ogMeta[key] || []) {
      addCandidate(val, 'photo', pageTitle);
    }
  }

  return {
    mode: 'album_page',
    sourceUrl: baseUrl,
    pageTitle,
    pageDescription,
    items,
    skippedCount,
  };
}

/**
 * Splits a single-line or multi-line textarea input into clean, deduplicated URL strings.
 */
export function parseLinkListInput(rawText: string): string[] {
  const lines = String(rawText || '')
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      unique.push(line);
    }
  }
  return unique;
}
