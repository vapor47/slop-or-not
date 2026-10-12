import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalize } from '../src/images.ts';
test('normalization strips metadata and produces matching presentation', async () => {
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#f0a020' },
  })
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
  const output = await normalize(png, true),
    metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 768);
  assert.equal(metadata.height, 768);
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
});
test('content validation rejects disguised files and oversize uploads', async () => {
  await assert.rejects(() => normalize(Buffer.from('<svg></svg>'), true), /valid/);
  await assert.rejects(() => normalize(Buffer.from('not a jpeg'), true), /valid/);
  await assert.rejects(() => normalize(Buffer.alloc(10 * 1024 * 1024 + 1), true), /10 MB/);
});
