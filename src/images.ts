import sharp from 'sharp';
import { HttpError } from './types.ts';
import type { ImageMetrics } from './types.ts';
export async function normalize(bytes: Buffer, upload = false): Promise<Buffer> {
  if (!bytes.length || (upload && bytes.length > 10 * 1024 * 1024))
    throw new HttpError(413, 'Photos must be no larger than 10 MB.');
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1)
      throw new Error('format');
    // Apply EXIF orientation, use identical dimensions, encoding, quality and color space.
    // Sharp strips EXIF/XMP/ICC by default. Decode and re-encode instead of trusting MIME.
    return await image
      .rotate()
      .resize(768, 768, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new HttpError(
      400,
      'Upload a valid, non-animated JPEG, PNG, or WebP photo (up to 40 megapixels).',
    );
  }
}
// Pixel-derived metrics captured before images are deleted. Expects a normalized image.
export async function analyze(bytes: Buffer): Promise<ImageMetrics> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info,
    pixels = width * height,
    grey = new Float64Array(pixels);
  let sum = 0,
    rgSum = 0,
    ybSum = 0,
    rgSq = 0,
    ybSq = 0;
  for (let i = 0; i < pixels; i++) {
    const r = data[i * channels],
      g = data[i * channels + Math.min(1, channels - 1)],
      b = data[i * channels + Math.min(2, channels - 1)];
    grey[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += grey[i];
    // Hasler–Süsstrunk colorfulness opponent channels.
    const rg = r - g,
      yb = 0.5 * (r + g) - b;
    rgSum += rg;
    ybSum += yb;
    rgSq += rg * rg;
    ybSq += yb * yb;
  }
  const brightness = sum / pixels;
  let variance = 0;
  for (const v of grey) variance += (v - brightness) ** 2;
  // Variance of the 4-neighbour Laplacian over interior pixels, computed unclamped in JS.
  let lapSum = 0,
    lapSq = 0,
    count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x,
        lap = grey[i - 1] + grey[i + 1] + grey[i - width] + grey[i + width] - 4 * grey[i];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  const rgMean = rgSum / pixels,
    ybMean = ybSum / pixels;
  return {
    width,
    height,
    dhash: await dhash(bytes),
    brightness,
    contrast: Math.sqrt(variance / pixels),
    sharpness: count ? lapSq / count - (lapSum / count) ** 2 : 0,
    colorfulness:
      Math.sqrt(rgSq / pixels - rgMean ** 2 + (ybSq / pixels - ybMean ** 2)) +
      0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2),
  };
}
// 64-bit difference hash as 16 hex digits: compares horizontally adjacent pixels of a 9×8 greyscale.
async function dhash(bytes: Buffer) {
  const px = await sharp(bytes).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}
