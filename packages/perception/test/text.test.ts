import type { Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/image';
import { createOcrEngine, type OcrEngine, type OcrLine } from '../src/ocr';
import { mergePieces, ocrScales, recognizeText, splitRow, type TextPiece } from '../src/text';
import { edgeGap, imageFromSvg, inkBounds, SVG_FONT, svgDocument } from './helpers';

function line(text: string, box: Rect, confidence = 0.95): OcrLine {
  const [x, y, w, h] = box;
  return {
    text,
    confidence,
    box,
    polygon: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  };
}

function piece(text: string, box: Rect, scale: number, confidence = 0.95): TextPiece {
  return { text, confidence, box, scale };
}

describe('ocrScales', () => {
  it('reads small pictures enlarged and big ones as they are', () => {
    expect(ocrScales(438, 652)).toEqual([1, 2, 4]);
    expect(ocrScales(1080, 1920)).toEqual([1]);
  });
});

describe('mergePieces', () => {
  it('merges readings of one text at several scales into one candidate', () => {
    const merged = mergePieces([
      piece('+5', [100, 50, 20, 12], 1, 0.7),
      piece('+5', [101, 51, 18, 12], 2, 0.9),
      piece('+5', [102, 50, 18, 14], 4, 0.95),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('+5');
    expect(merged[0]?.support).toBe(3);
    expect(merged[0]?.bbox[0]).toBeCloseTo(101, 5);
  });

  it('lets the reading with the most confidence decide what the text says', () => {
    const merged = mergePieces([
      piece('1,980', [10, 10, 40, 14], 1, 0.9),
      piece('1,98O', [10, 10, 40, 14], 2, 0.62),
      piece('1,980', [11, 10, 40, 14], 4, 0.95),
    ]);

    expect(merged.map((candidate) => candidate.text)).toEqual(['1,980']);
  });

  it('keeps a lone reading only when it is almost certain', () => {
    const merged = mergePieces([
      piece('maybe', [0, 0, 30, 10], 4, 0.8),
      piece('sure', [0, 40, 30, 10], 4, 0.99),
    ]);

    expect(merged.map((candidate) => candidate.text)).toEqual(['sure']);
  });

  it('drops symbols that carry no text', () => {
    expect(
      mergePieces([piece('★★★★', [0, 0, 60, 14], 1), piece('★★★★', [0, 0, 60, 14], 2)]),
    ).toEqual([]);
  });

  it('keeps separate texts separate and orders them top to bottom, left to right', () => {
    const merged = mergePieces([
      piece('b', [100, 10, 20, 10], 1),
      piece('b', [100, 10, 20, 10], 2),
      piece('a', [10, 10, 20, 10], 1),
      piece('a', [10, 10, 20, 10], 2),
      piece('c', [10, 40, 20, 10], 1),
      piece('c', [10, 40, 20, 10], 2),
    ]);

    expect(merged.map((candidate) => candidate.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('splitRow', () => {
  async function blank(): Promise<RgbaImage> {
    return imageFromSvg(svgDocument(240, 120, ''));
  }
  const row: Rect = [20, 50, 160, 20];

  it('hands back one box per text when the tilted reading separates them', async () => {
    const engine: OcrEngine = {
      detect: async () => [line('CD', [300, 110, 90, 60]), line('AB', [60, 100, 90, 60])],
    };

    const tokens = await splitRow(await blank(), engine, row, 'AB CD');

    expect(tokens?.map((token) => token.text)).toEqual(['AB', 'CD']);
    const [first, second] = tokens ?? [];
    expect((first?.box[0] ?? 0) < (second?.box[0] ?? 0)).toBe(true);
  });

  it('gives up when the re-reading does not spell the same text', async () => {
    const engine: OcrEngine = {
      detect: async () => [line('AB', [60, 100, 90, 60]), line('XX', [300, 110, 90, 60])],
    };

    expect(await splitRow(await blank(), engine, row, 'AB CD')).toBeNull();
  });

  it('gives up when the texts are still joined, after trying both tilts', async () => {
    let calls = 0;
    const engine: OcrEngine = {
      detect: async () => {
        calls++;
        return [line('AB CD', [60, 100, 300, 60])];
      },
    };

    expect(await splitRow(await blank(), engine, row, 'AB CD')).toBeNull();
    expect(calls).toBe(2);
  });
});

describe('recognizeText with a stand-in engine', () => {
  it('converts boxes from the enlarged picture back to source pixels', async () => {
    const image = await imageFromSvg(svgDocument(120, 80, ''));
    let call = 0;
    const engine: OcrEngine = {
      // Reads "HELLO" at source box [40, 20, 60, 16] in whatever picture it is handed.
      detect: async () => {
        const factor = [1, 2][call++] ?? 1;
        return [line('HELLO', [40 * factor, 20 * factor, 60 * factor, 16 * factor])];
      },
    };

    const texts = await recognizeText(image, engine, { scales: [1, 2] });

    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe('HELLO');
    expect(texts[0]?.support).toBe(2);
    expect(texts[0]?.bbox).toEqual([40, 20, 60, 16]);
  });

  it('gives each text of a joined row its own candidate', async () => {
    const image = await imageFromSvg(svgDocument(240, 120, ''));
    let call = 0;
    const engine: OcrEngine = {
      detect: async () => {
        call++;
        // First the whole picture at both scales (one joined row), then the tilted re-readings.
        if (call <= 2) return [line('AB CD', [20 * call, 50 * call, 160 * call, 20 * call])];
        return [line('CD', [300, 110, 90, 60]), line('AB', [60, 100, 90, 60])];
      },
    };

    const texts = await recognizeText(image, engine, { scales: [1, 2] });

    const leftToRight = [...texts].sort((a, b) => a.bbox[0] - b.bbox[0]);
    expect(leftToRight.map((text) => text.text)).toEqual(['AB', 'CD']);
  });
});

describe('recognizeText with the real recogniser', () => {
  const body = ['ATK', 'DEF']
    .map(
      (word, index) =>
        `<text x="24" y="${60 + index * 60}" font-family="${SVG_FONT}" font-size="30" font-weight="bold" fill="#4a2410">${word}</text>` +
        `<text x="150" y="${60 + index * 60}" font-family="${SVG_FONT}" font-size="30" font-weight="bold" fill="#4a2410">${index === 0 ? '3,260' : '1,980'}</text>`,
    )
    .join('');

  it('separates texts the recogniser joins into one line, with boxes within 3 px of the ink', async () => {
    const image = await imageFromSvg(svgDocument(300, 150, body));

    const texts = await recognizeText(image, createOcrEngine());

    const byText = new Map(texts.map((text) => [text.text, text]));
    for (const [word, region] of [
      ['ATK', [10, 25, 120, 45]],
      ['3,260', [140, 25, 150, 45]],
      ['DEF', [10, 85, 120, 45]],
      ['1,980', [140, 85, 150, 45]],
    ] as [string, Rect][]) {
      const found = byText.get(word);
      expect(found, `text ${word}`).toBeDefined();
      const ink = inkBounds(image, region);
      expect(ink).not.toBeNull();
      if (found && ink) expect(edgeGap(found.bbox, ink)).toBeLessThanOrEqual(3);
    }
  }, 60_000);
});
