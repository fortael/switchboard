#!/usr/bin/env node
// Copies the bundled brand fonts into docs/ for the landing page.
//
// They are not imported from src/landing/main.js on purpose: vite's library
// mode inlines url() assets as base64, which quadrupled docs/landing.css.
// docs/index.html links docs/css/fonts-brand.css after landing.css instead,
// and the relative url('../fonts/…') inside it resolves to docs/fonts/.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_SRC = path.join(ROOT, 'public', 'css', 'fonts-brand.css');
const FONT_SRC = path.join(ROOT, 'public', 'fonts');
const CSS_OUT = path.join(ROOT, 'docs', 'css', 'fonts-brand.css');
const FONT_OUT = path.join(ROOT, 'docs', 'fonts');

if (!fs.existsSync(CSS_SRC)) {
  throw new Error('public/css/fonts-brand.css missing — run `npm run fonts:generate` first');
}

fs.mkdirSync(path.dirname(CSS_OUT), { recursive: true });
fs.mkdirSync(FONT_OUT, { recursive: true });
fs.copyFileSync(CSS_SRC, CSS_OUT);

const faces = fs.readFileSync(CSS_SRC, 'utf8')
  .matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g);

let copied = 0;
for (const [, file] of faces) {
  fs.copyFileSync(path.join(FONT_SRC, file), path.join(FONT_OUT, file));
  copied++;
}

console.log(`copied fonts-brand.css and ${copied} font files into docs/`);
