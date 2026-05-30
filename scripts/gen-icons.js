// Generates PNG icons from scratch (no deps) using Node's built-in zlib.
// Draws the Avalon mark: dark background, mint ring, mint centre dot, with
// distance-based anti-aliasing. Run: node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x0a, 0x0e, 0x0d];
const MINT = [0x2f, 0xf0, 0xa8];

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// coverage in [0,1] for a value crossing an edge at `edge`, aa width ~1px
function edgeCoverage(dist, edge, aa) { return 1 - smoothstep(edge - aa, edge + aa, dist); }

function drawIcon(size, scale = 1) {
  // scale shrinks the content for maskable safe-area.
  const cx = size / 2, cy = size / 2;
  const ringR = (size * 0.234) * scale;    // ring radius
  const ringW = (size * 0.035) * scale;     // ring half-thickness
  const dotR = (size * 0.066) * scale;      // centre dot radius
  const aa = size / 512 * 1.4;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let r = BG[0], g = BG[1], b = BG[2];

      // Ring: covered where |d - ringR| < ringW
      const ringDist = Math.abs(d - ringR);
      const ringCov = edgeCoverage(ringDist, ringW, aa);
      // Dot
      const dotCov = edgeCoverage(d, dotR, aa);
      const cov = Math.max(ringCov, dotCov);

      r = Math.round(r * (1 - cov) + MINT[0] * cov);
      g = Math.round(g * (1 - cov) + MINT[1] * cov);
      b = Math.round(b * (1 - cov) + MINT[2] * cov);

      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // rest 0 (compression, filter, interlace)

  // Filter each scanline with filter type 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'icon-maskable.png', size: 512, scale: 0.7 }, // shrink for safe area
];
for (const t of targets) {
  const png = encodePNG(drawIcon(t.size, t.scale), t.size);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
