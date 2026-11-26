// Probe: can @napi-rs/canvas render the reference-renderer primitives on this machine?
import { writeFileSync } from 'node:fs';
import { createCanvas, GlobalFonts, loadImage } from '../../../../packages/renderer/node_modules/@napi-rs/canvas/index.js';

const t0 = performance.now();
const families = GlobalFonts.families.map((f: { family: string }) => f.family);
console.log('system families:', families.length, families.filter((f: string) => /YaHei|Hei|Song|Arial/i.test(f)).slice(0, 8));

const canvas = createCanvas(438, 200);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#7ec8f0';
ctx.fillRect(0, 0, 438, 200);

// stroked + shadowed CJK text
ctx.font = 'bold 36px "Microsoft YaHei"';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.shadowColor = 'rgba(0,0,0,0.5)';
ctx.shadowOffsetX = 0;
ctx.shadowOffsetY = 3;
ctx.shadowBlur = 2;
ctx.lineJoin = 'round';
ctx.lineWidth = 6;
ctx.strokeStyle = '#7a3b12';
ctx.strokeText('糖果骑士 Lv.36', 219, 50);
ctx.shadowColor = 'transparent';
ctx.fillStyle = '#fff4c2';
ctx.fillText('糖果骑士 Lv.36', 219, 50);
console.log('measure', ctx.measureText('糖果骑士 Lv.36').width);

// nine-slice from a source image crop
const src = await loadImage('D:/workspace/ui-pro/benchmark/samples/candy-knight/ui.png');
const [sx, sy, sw, sh, inset] = [40, 560, 120, 50, 16];
const [dx, dy, dw, dh] = [20, 110, 300, 70];
const cols = [
  [sx, inset, dx, inset],
  [sx + inset, sw - 2 * inset, dx + inset, dw - 2 * inset],
  [sx + sw - inset, inset, dx + dw - inset, inset],
];
const rows = [
  [sy, inset, dy, inset],
  [sy + inset, sh - 2 * inset, dy + inset, dh - 2 * inset],
  [sy + sh - inset, inset, dy + dh - inset, inset],
];
for (const [cx, cw, ox, ow] of cols) for (const [ry, rh, oy, oh] of rows) ctx.drawImage(src, cx, ry, cw, rh, ox, oy, ow, oh);

// tint via multiply + destination-in
const tint = createCanvas(60, 60);
const tctx = tint.getContext('2d');
tctx.drawImage(src, 200, 300, 60, 60, 0, 0, 60, 60);
tctx.globalCompositeOperation = 'multiply';
tctx.fillStyle = '#ff6060';
tctx.fillRect(0, 0, 60, 60);
tctx.globalCompositeOperation = 'destination-in';
tctx.drawImage(src, 200, 300, 60, 60, 0, 0, 60, 60);
ctx.drawImage(tint, 350, 120);

const png = await canvas.encode('png');
writeFileSync(new URL('./probe.png', import.meta.url), png);
const t1 = performance.now();
for (let i = 0; i < 50; i++) await canvas.encode('png');
console.log('first render+encode ms', Math.round(t1 - t0), 'per extra encode ms', Math.round((performance.now() - t1) / 50));
const raw = ctx.getImageData(0, 0, 438, 200);
console.log('getImageData', raw.width, raw.height, raw.data.length);
