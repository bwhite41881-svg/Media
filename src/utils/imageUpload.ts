/**
 * Client-side image resizer/encoder for crisp, fast profile photos and album cover uploads.
 * Preserves aspect ratio (or center-crops to square for avatars) and falls back cleanly to
 * FileReader if Canvas decoding fails on an unusual format.
 */
export async function prepareImageDataUrl(
  file: File,
  options: { maxDimension: number; squareCrop?: boolean; quality?: number }
): Promise<string> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Please choose a valid image file (JPEG, PNG, WebP, or GIF).');
  }

  const maxDim = Math.max(64, options.maxDimension);
  const quality = options.quality ?? 0.86;

  // Read original as data URL first as a guaranteed fallback
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read selected image file.'));
    reader.readAsDataURL(file);
  });

  // Resize/normalize through an offscreen canvas so multi-megapixel phone photos upload cleanly
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image decode failed'));
      el.src = rawDataUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return rawDataUrl;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return rawDataUrl;

    if (options.squareCrop) {
      const side = Math.min(srcW, srcH);
      const sx = Math.floor((srcW - side) / 2);
      const sy = Math.floor((srcH - side) / 2);
      const target = Math.min(maxDim, side);
      canvas.width = target;
      canvas.height = target;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
    } else {
      const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
      canvas.width = Math.max(1, Math.round(srcW * scale));
      canvas.height = Math.max(1, Math.round(srcH * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }

    const encoded = canvas.toDataURL('image/jpeg', quality);
    if (encoded && encoded.startsWith('data:image/')) {
      return encoded;
    }
    return rawDataUrl;
  } catch {
    return rawDataUrl;
  }
}
