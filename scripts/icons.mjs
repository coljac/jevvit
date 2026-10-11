// Draws the extension icon (a funnel on an indigo tile) at the sizes the browsers want.
// Pure Node, no dependencies: a supersampled rasteriser and a minimal PNG writer.
//
//   node scripts/icons.mjs        -> src/icons/icon-{16,32,48,128}.png

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // subsamples per axis

const TILE = [0x4f, 0x46, 0xe5]; // indigo
const TILE_LIGHT = [0x7c, 0x6c, 0xf5];
const WHITE = [255, 255, 255];
const AMBER = [0xfb, 0xbf, 0x24];

const FUNNEL = [
  [0.2, 0.27],
  [0.8, 0.27],
  [0.56, 0.54],
  [0.56, 0.74],
  [0.44, 0.67],
  [0.44, 0.54],
];

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Colour at a point in unit space, or null where the icon is transparent. */
function sample(x, y) {
  if (!inRoundedSquare(x, y, 0.22)) return null;
  if (inPolygon(x, y, FUNNEL)) return WHITE;
  if ((x - 0.5) ** 2 + (y - 0.84) ** 2 <= 0.055 ** 2) return AMBER;
  const t = (x + y) / 2; // a gentle diagonal gradient
  return TILE.map((c, i) => Math.round(c + (TILE_LIGHT[i] - c) * (1 - t) * 0.8));
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxl + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (py * size + pxl) * 4;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
