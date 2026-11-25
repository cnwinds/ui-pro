import Ocr from '@gutenye/ocr-node';

const image = process.argv[2] ?? 'D:/workspace/ui-pro/benchmark/samples/candy-knight/ui.png';
try {
  const t0 = Date.now();
  const ocr = await Ocr.create();
  console.log('ocr ready in', Date.now() - t0, 'ms');
  const t1 = Date.now();
  const result = await ocr.detect(image);
  console.log('resized', result.resizedImageWidth, 'x', result.resizedImageHeight);
  console.log('detected', result.texts.length, 'lines in', Date.now() - t1, 'ms');
  for (const line of result.texts) {
    console.log(JSON.stringify(line));
  }
  process.exit(0);
} catch (err) {
  console.error('PROBE FAILED', err);
  process.exit(1);
}
