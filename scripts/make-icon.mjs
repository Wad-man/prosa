// Generates app-icon.png (1024x1024 RGBA): rounded violet square with a blocky "P".
// Zero dependencies: hand-rolled PNG encoder (zlib is a Node builtin).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const RADIUS = 230;
const SS = 4; // supersampling for the rounded-corner mask

const TOP = [0x5b, 0x4f, 0xc4]; // #5B4FC4
const BOTTOM = [0x8d, 0x80, 0xf2]; // #8D80F2
const WHITE = [0xff, 0xff, 0xff];

// rounded-rect signed distance: negative = inside
function sdRoundBox(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const hx = SIZE / 2, hy = SIZE / 2;
  const qx = Math.abs(x - cx) - (hx - RADIUS);
  const qy = Math.abs(y - cy) - (hy - RADIUS);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0) - RADIUS + Math.min(Math.max(qx, qy), 0) * 0;
}

function insideRoundedRect(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const qx = Math.abs(x - cx) - (SIZE / 2 - RADIUS);
  const qy = Math.abs(y - cy) - (SIZE / 2 - RADIUS);
  const outer = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outer <= RADIUS || (qx < 0 && qy < 0);
}

function coverage(px, py) {
  let hit = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      if (insideRoundedRect(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hit++;
    }
  }
  return hit / (SS * SS);
}

// blocky letter P (straight edges, no AA needed)
function insideP(x, y) {
  const stem = x >= 350 && x < 480 && y >= 300 && y < 790;
  const bowlOuter = x >= 480 && x < 760 && y >= 300 && y < 590;
  const hole = x >= 560 && x < 680 && y >= 390 && y < 500;
  return (stem || bowlOuter) && !hole;
}

// ---- PNG encoding ----
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  const t = y / (SIZE - 1);
  const bg = [
    Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
  ];
  for (let x = 0; x < SIZE; x++) {
    const o = rowStart + 1 + x * 4;
    const cov = coverage(x, y);
    if (cov === 0) {
      raw[o + 3] = 0;
      continue;
    }
    let rgb = bg;
    if (insideP(x, y)) rgb = WHITE;
    raw[o] = rgb[0];
    raw[o + 1] = rgb[1];
    raw[o + 2] = rgb[2];
    raw[o + 3] = Math.round(cov * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'app-icon.png');
writeFileSync(outPath, png);
console.log(`written ${outPath} (${png.length} bytes)`);
