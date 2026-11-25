import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const fixture = process.argv[2] ?? 'effects';
const dir = `D:/workspace/ui-pro/benchmark/psd-fixtures/ag-psd/${fixture}`;
const out = join(process.cwd(), 'out', fixture);
mkdirSync(out, { recursive: true });

const html = `<!doctype html><html><body style="margin:0"><iframe id="pp" src="https://www.photopea.com#%7B%22environment%22%3A%7B%22intro%22%3Afalse%7D%7D" style="width:1200px;height:800px;border:0"></iframe>
<script>
  window.inbox = [];
  window.addEventListener('message', (e) => { window.inbox.push(e.data); });
  window.toB64 = (buf) => { let s=''; const b=new Uint8Array(buf); for (let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000)); return btoa(s); };
  window.call = (payload) => new Promise((resolve, reject) => {
    const start = window.inbox.length;
    const t0 = Date.now();
    const timer = setInterval(() => {
      const msgs = window.inbox.slice(start);
      if (msgs.includes('done')) { clearInterval(timer); resolve(msgs.filter((m) => m !== 'done').map((m) => typeof m === 'string' ? m : { b64: window.toB64(m) })); }
      else if (Date.now() - t0 > 30000) { clearInterval(timer); reject(new Error('timeout; got ' + msgs.length + ' msgs: ' + msgs.map((m) => typeof m === 'string' ? m.slice(0, 80) : '[bin]').join(','))); }
    }, 50);
    document.getElementById('pp').contentWindow.postMessage(payload, '*');
  });
</script></body></html>`;
const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const headless = process.env.HEADED !== '1';
const browser = await chromium.launch({ channel: 'msedge', headless, args: ['--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, userAgent: ua });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const t0 = Date.now();
await page.waitForFunction(() => window.inbox.includes('done'), null, { timeout: 90000 });
console.log('photopea ready in', Date.now() - t0, 'ms');

const psdB64 = readFileSync(join(dir, 'src.psd')).toString('base64');
await page.evaluate((b64) => {
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return window.call(u.buffer);
}, psdB64);
console.log('psd opened in', Date.now() - t0, 'ms');

const listScript = `
  function walk(ls, path, acc) { for (var i = 0; i < ls.length; i++) { var l = ls[i]; acc.push({ path: path.concat([i]), name: l.name, kind: l.typename, visible: l.visible }); if (l.typename === 'LayerSet') walk(l.layers, path.concat([i]), acc); } return acc; }
  var d = app.activeDocument; app.echoToOE(JSON.stringify({ w: d.width, h: d.height, layers: walk(d.layers, [], []) }));`;
const [infoJson] = await page.evaluate((s) => window.call(s), listScript);
const info = JSON.parse(infoJson);
console.log('doc', info.w, 'x', info.h, 'layers:', info.layers.map((l) => `${l.path.join('.')}:${l.kind}:${l.name}:${l.visible ? 'v' : 'h'}`).join(' | '));

const t2 = Date.now();
const full = await page.evaluate((s) => window.call(s), 'app.activeDocument.saveToOE("png");');
console.log('full export', Date.now() - t2, 'ms');
writeFileSync(join(out, 'photopea-full.png'), Buffer.from(full[0].b64, 'base64'));

const isolate = (target) => `try {
  var d = app.activeDocument;
  function get(path) { var l = d.layers[path[0]]; for (var i = 1; i < path.length; i++) l = l.layers[path[i]]; return l; }
  function all(ls, acc) { for (var i = 0; i < ls.length; i++) { acc.push(ls[i]); if (ls[i].typename === 'LayerSet') all(ls[i].layers, acc); } return acc; }
  var every = all(d.layers, []);
  var saved = []; for (var i = 0; i < every.length; i++) saved.push(every[i].visible);
  var target = ${JSON.stringify(target)};
  for (var i = 0; i < every.length; i++) every[i].visible = false;
  for (var k = 1; k <= target.length; k++) get(target.slice(0, k)).visible = true;
  var t = get(target); if (t.typename === 'LayerSet') { var sub = all(t.layers, []); for (var i = 0; i < sub.length; i++) sub[i].visible = true; }
  d.saveToOE("png");
  for (var i = 0; i < every.length; i++) every[i].visible = saved[i];
} catch (e) { app.echoToOE("ERR " + e); }`;

for (const layer of info.layers.filter((l) => l.kind === 'ArtLayer' && l.visible)) {
  const t1 = Date.now();
  const res = await page.evaluate((s) => window.call(s), isolate(layer.path));
  const png = res.find((r) => typeof r === 'object');
  if (!png) { console.log('no png for', layer.name, res); continue; }
  const file = join(out, `layer-${layer.path.join('_')}.png`);
  writeFileSync(file, Buffer.from(png.b64, 'base64'));
  const m = await sharp(file).metadata();
  console.log('layer', layer.name, `${m.width}x${m.height}`, 'alpha', m.hasAlpha, Date.now() - t1, 'ms');
}

async function compare(label, file) {
  const ref = await sharp(join(dir, 'canvas.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const got = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (ref.info.width !== got.info.width || ref.info.height !== got.info.height) return console.log(label, 'size mismatch', ref.info, got.info);
  let sum = 0, max = 0, bad = 0;
  for (let i = 0; i < ref.data.length; i++) { const d = Math.abs(ref.data[i] - got.data[i]); sum += d; if (d > max) max = d; if (d > 16) bad++; }
  console.log(label, 'vs Photoshop composite: meanAbs', (sum / ref.data.length).toFixed(3), 'max', max, 'channels>16:', bad, 'of', ref.data.length);
}
await compare('photopea full render', join(out, 'photopea-full.png'));

const layerFiles = info.layers.filter((l) => l.kind === 'ArtLayer' && l.visible).map((l) => join(out, `layer-${l.path.join('_')}.png`));
const base = sharp({ create: { width: info.w, height: info.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
const order = [...layerFiles].reverse();
await base.composite(order.map((f) => ({ input: f, blend: 'over' }))).png().toFile(join(out, 'recomposed.png'));
await compare('per-layer recomposite', join(out, 'recomposed.png'));

await browser.close();
server.close();
