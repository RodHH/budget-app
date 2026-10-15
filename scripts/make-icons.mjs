// Renders the app icon SVG to the PNG sizes iOS and Android need (uses Playwright's Chromium).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a7d6e"/><stop offset="1" stop-color="#245a4e"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${pad})">
    <circle r="150" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="44"/>
    <path d="M0 -150 A150 150 0 1 1 -129.9 75" fill="none" stroke="#f6f1e4" stroke-width="44" stroke-linecap="round"/>
    <path d="M-34 8 L-8 34 L42 -24" fill="none" stroke="#f6f1e4" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
const out = path.join(root, 'web/icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.svg'), svg(1));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 1], ['icon-512.png', 512, 1], ['apple-touch-icon.png', 180, 1], ['icon-maskable-512.png', 512, 0.78]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: false });
}
await browser.close();
console.log('icons written');
