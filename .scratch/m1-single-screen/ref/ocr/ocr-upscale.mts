import Ocr from '@gutenye/ocr-node';
import sharp from 'sharp';

const image = 'D:/workspace/ui-pro/benchmark/samples/candy-knight/ui.png';
try {
  const ocr = await Ocr.create();
  for (const scale of [2, 3]) {
    const scaled = `D:/workspace/ui-pro/packages/perception/.probe/ui-x${scale}.png`;
    const info = await sharp(image).resize({ width: 438 * scale, kernel: 'lanczos3' }).png().toFile(scaled);
    const t = Date.now();
    const result = await ocr.detect(scaled);
    const sx = info.width / result.resizedImageWidth;
    const sy = info.height / result.resizedImageHeight;
    console.log(`--- scale ${scale}: ${info.width}x${info.height}, resized ${result.resizedImageWidth}x${result.resizedImageHeight}, ${result.texts.length} lines in ${Date.now() - t} ms`);
    for (const line of result.texts) {
      const xs = line.box.map((p) => (p[0] * sx) / scale);
      const ys = line.box.map((p) => (p[1] * sy) / scale);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
      console.log(JSON.stringify({ text: line.text, mean: Number(line.mean.toFixed(3)), box }));
    }
  }
  process.exit(0);
} catch (err) {
  console.error('PROBE FAILED', err);
  process.exit(1);
}
