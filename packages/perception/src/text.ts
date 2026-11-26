import type { Rect } from '@ui-pro/core';
import { clipToImage, expandBox, iou } from './geometry';
import { type RgbaImage, rotatedCrop, scaleAndPad } from './image';
import { type EdgeMap, edgeStrength, tightenToInk } from './ink';
import { boundsOf, type OcrEngine } from './ocr';

export interface TextCandidate {
  text: string;
  /** Mean recogniser confidence of the readings that agree on the text. */
  confidence: number;
  /** Source pixels. */
  bbox: Rect;
  /** Number of enlargement factors at which this text was read. */
  support: number;
}

export interface TextOptions {
  /** Enlargement factors to read the whole image at; defaults to `ocrScales`. */
  scales?: readonly number[];
}

const OCR_MULTIPLE = 32;
const MAX_SCALED_SIDE = 2800;
const CANDIDATE_SCALES = [1, 2, 4];
const SAME_TEXT_IOU = 0.4;
const SAME_LINE_IOU = 0.5;
const SURE_CONFIDENCE = 0.97;
const MIN_CONFIDENCE = 0.6;
const ROW_TILTS = [12, -12];
const ROW_TEXT_HEIGHT = 48;

/**
 * Small text is missed at the native size, so the image is also read enlarged. Factors are
 * dropped once the enlarged image would be too big to recognise in reasonable time.
 */
export function ocrScales(width: number, height: number): number[] {
  const longSide = Math.max(width, height);
  const fitting = CANDIDATE_SCALES.filter((scale) => scale * longSide <= MAX_SCALED_SIDE);
  return fitting.length > 0 ? fitting : [1];
}

/** Text that says something: has a letter, a digit or a CJK character, not only symbols. */
export function isReadable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== '');
}

function squeeze(text: string): string {
  return words(text).join('');
}

function readingOrder(a: Rect, b: Rect): number {
  return a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** One line as one scale's reading saw it. */
interface Reading {
  text: string;
  confidence: number;
  box: Rect;
  scale: number;
}

interface Token {
  text: string;
  confidence: number;
  box: Rect;
}

export interface TextPiece extends Reading {}

/**
 * Re-reads one recognised row on its own, tilted so that the texts in it end up at different
 * heights. The recogniser joins texts that share a height into one line, so tilting is what hands
 * each text back with a box of its own. Returns `null` unless the tilted reading spells exactly
 * the same text and really separates it.
 */
export async function splitRow(
  image: RgbaImage,
  engine: OcrEngine,
  box: Rect,
  text: string,
): Promise<Token[] | null> {
  const factor = Math.min(4, Math.max(1, Math.round(ROW_TEXT_HEIGHT / box[3])));
  const region = expandBox(box, Math.max(3, Math.round(box[3] * 0.6)));
  for (const tilt of ROW_TILTS) {
    const crop = await rotatedCrop(image, region, factor, tilt);
    if (!crop) return null;
    const tokens = (await engine.detect(crop.image))
      .map((line) => ({
        text: line.text,
        confidence: line.confidence,
        box: boundsOf(line.polygon.map((point) => crop.toSource(point))),
      }))
      .sort((a, b) => a.box[0] - b.box[0]);
    if (
      tokens.length >= 2 &&
      squeeze(tokens.map((token) => token.text).join('')) === squeeze(text)
    ) {
      return tokens;
    }
  }
  return null;
}

/** Readings of the same row at different scales, which may share one box. */
function groupReadings(readings: readonly Reading[]): Reading[][] {
  const groups: Reading[][] = [];
  for (const reading of [...readings].sort((a, b) => readingOrder(a.box, b.box))) {
    const group = groups.find((members) =>
      members.some((member) => iou(member.box, reading.box) >= SAME_LINE_IOU),
    );
    if (group) group.push(reading);
    else groups.push([reading]);
  }
  return groups;
}

function winningText(readings: readonly Reading[]): string {
  const weights = new Map<string, number>();
  for (const reading of readings) {
    weights.set(reading.text, (weights.get(reading.text) ?? 0) + reading.confidence);
  }
  const ranked = [...weights].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return ranked[0]?.[0] ?? '';
}

/**
 * Pieces that cover the same place, read at different factors, become one candidate: the text
 * most confidently read there wins, and its box is the average of the boxes that read it.
 */
export function mergePieces(pieces: readonly TextPiece[]): TextCandidate[] {
  const groups: TextPiece[][] = [];
  for (const piece of [...pieces].sort((a, b) => readingOrder(a.box, b.box))) {
    const group = groups.find((members) =>
      members.some((member) => iou(member.box, piece.box) >= SAME_TEXT_IOU),
    );
    if (group) group.push(piece);
    else groups.push([piece]);
  }

  const merged: TextCandidate[] = [];
  for (const members of groups) {
    const text = winningText(members);
    const winners = members.filter((member) => member.text === text);
    const support = new Set(winners.map((winner) => winner.scale)).size;
    const confidence = mean(winners.map((winner) => winner.confidence));
    const sure = support >= 2 ? confidence >= MIN_CONFIDENCE : confidence >= SURE_CONFIDENCE;
    if (!isReadable(text) || !sure) continue;
    merged.push({
      text,
      confidence,
      support,
      bbox: [
        mean(winners.map((w) => w.box[0])),
        mean(winners.map((w) => w.box[1])),
        mean(winners.map((w) => w.box[2])),
        mean(winners.map((w) => w.box[3])),
      ],
    });
  }

  const kept: TextCandidate[] = [];
  const strongestFirst = merged.sort(
    (a, b) => b.support - a.support || b.confidence - a.confidence || readingOrder(a.bbox, b.bbox),
  );
  for (const candidate of strongestFirst) {
    if (!kept.some((other) => iou(other.bbox, candidate.bbox) >= SAME_TEXT_IOU)) {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => readingOrder(a.bbox, b.bbox));
}

/**
 * Finds the text in an image. The whole image is read at several enlargements, because small
 * text is missed at its native size; every recognised row that spans several texts is read again
 * on its own to give each text a box; boxes are then tightened to the ink; and what the readings
 * agree on is merged. Boxes are in pixels of `image`.
 */
export async function recognizeText(
  image: RgbaImage,
  engine: OcrEngine,
  options: TextOptions = {},
): Promise<TextCandidate[]> {
  const edges: EdgeMap = {
    strength: edgeStrength(image),
    width: image.width,
    height: image.height,
  };
  const scales = options.scales ?? ocrScales(image.width, image.height);
  const readings: Reading[] = [];
  for (const scale of scales) {
    const enlarged = await scaleAndPad(image, scale, OCR_MULTIPLE);
    for (const line of await engine.detect(enlarged)) {
      const box = clipToImage(
        [line.box[0] / scale, line.box[1] / scale, line.box[2] / scale, line.box[3] / scale],
        image.width,
        image.height,
      );
      if (box[2] > 0 && box[3] > 0) {
        readings.push({ text: line.text, confidence: line.confidence, box, scale });
      }
    }
  }

  const pieces: TextPiece[] = [];
  for (const group of groupReadings(readings)) {
    const text = winningText(group);
    const agreeing = group.filter((reading) => reading.text === text);
    const box = [0, 1, 2, 3].map((axis) => mean(agreeing.map((reading) => reading.box[axis] ?? 0)));
    const tokens =
      words(text).length >= 2 ? await splitRow(image, engine, box as Rect, text) : null;
    if (tokens) {
      const seenAt = new Set(group.map((reading) => reading.scale));
      for (const token of tokens) {
        const tight = tightenToInk(edges, token.box);
        for (const scale of seenAt) pieces.push({ ...token, box: tight, scale });
      }
    } else {
      for (const reading of group) {
        pieces.push({ ...reading, box: tightenToInk(edges, reading.box) });
      }
    }
  }
  return mergePieces(pieces);
}
