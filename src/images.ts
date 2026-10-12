import sharp from 'sharp';
import { HttpError } from './types.ts';
export async function normalize(bytes: Buffer, upload = false): Promise<Buffer> {
  if (!bytes.length || (upload && bytes.length > 10 * 1024 * 1024)) throw new HttpError(413, 'Photos must be no larger than 10 MB.');
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) throw new Error('format');
    // Apply EXIF orientation, use identical dimensions, encoding, quality and color space.
    // Sharp strips EXIF/XMP/ICC by default. Decode and re-encode instead of trusting MIME.
    return await image.rotate().resize(768, 768, { fit: 'cover', position: 'centre' }).flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  } catch { throw new HttpError(400, 'Upload a valid, non-animated JPEG, PNG, or WebP photo (up to 40 megapixels).'); }
}
