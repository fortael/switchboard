#!/usr/bin/env node
// Generates the tray icons into public/tray/.
//
// public/ rather than build/ on purpose: electron-builder's `files` list in
// package.json ships `public/**/*` but not `build/`, so an icon read at runtime has
// to live under public/ to exist inside the packaged asar.
//
// PNGs are encoded here with nothing but zlib. The other icon script uses
// @napi-rs/canvas, but three flat shapes do not need a canvas, and this way the
// assets can be regenerated in a checkout with no node_modules.
//
// Run: npm run generate-tray-icons

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'tray');

// The tray glyph carries the session state by weight, because a macOS template
// image is masked to the menu bar colour and cannot carry it by hue:
//   idle      thin ring          nothing wants anything
//   busy      ring plus a dot    work is happening inside
//   attention solid disc         the loudest shape available
// Colours (used on Windows and Linux, where the icon is drawn as-is) come from the
// app palette in public/style.css.
const STATES = {
  idle: { color: [0x8f, 0x8f, 0x9c], ring: 0.085, dot: 0, solid: false },
  busy: { color: [0x34, 0xd3, 0x99], ring: 0.095, dot: 0.115, solid: false },
  attention: { color: [0xf2, 0x88, 0x4b], ring: 0, dot: 0, solid: true },
};

const OUTER_RADIUS = 0.40;
const SUPERSAMPLE = 4;

// Coverage of one pixel by the glyph, sampled on a SUPERSAMPLE x SUPERSAMPLE grid.
// Cheaper than a real rasteriser and enough for shapes made of circles.
function coverage(px, py, size, state) {
  let inside = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = (px + (sx + 0.5) / SUPERSAMPLE) / size - 0.5;
      const y = (py + (sy + 0.5) / SUPERSAMPLE) / size - 0.5;
      const d = Math.sqrt(x * x + y * y);
      const inRing = state.solid
        ? d <= OUTER_RADIUS
        : (d <= OUTER_RADIUS && d >= OUTER_RADIUS - state.ring);
      const inDot = state.dot > 0 && d <= state.dot;
      if (inRing || inDot) inside++;
    }
  }
  return inside / (SUPERSAMPLE * SUPERSAMPLE);
}

function render(size, state, template) {
  const rgba = Buffer.alloc(size * size * 4);
  const [r, g, b] = template ? [0, 0, 0] : state.color;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = Math.round(coverage(x, y, size, state) * 255);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

// --- Minimal PNG encoder (8-bit RGBA, one IDAT) ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  // compression, filter and interlace methods are all 0

  // Each scanline is prefixed with its filter type; 0 means "store as is".
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Write every state at 1x and 2x, coloured and as a macOS template ---

fs.mkdirSync(OUT_DIR, { recursive: true });

const written = [];
for (const [name, state] of Object.entries(STATES)) {
  // Electron resolves the @2x file next to the 1x one by itself, and treats a name
  // ending in Template as a macOS template image.
  for (const template of [false, true]) {
    const base = template ? `${name}Template` : name;
    for (const [size, suffix] of [[16, ''], [32, '@2x']]) {
      const file = path.join(OUT_DIR, `${base}${suffix}.png`);
      fs.writeFileSync(file, encodePng(size, render(size, state, template)));
      written.push(path.relative(path.join(__dirname, '..'), file));
    }
  }
}

console.log(`Wrote ${written.length} tray icons:`);
for (const file of written) console.log(`  ${file} (${fs.statSync(path.join(__dirname, '..', file)).size} B)`);
