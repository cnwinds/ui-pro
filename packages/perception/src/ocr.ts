import Ocr from '@gutenye/ocr-node';
import { type Rect, UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from './errors';
import type { RgbaImage } from './image';
import { loadOpenCv } from './opencv';

type Point = [x: number, y: number];

/** One recognised line; geometry is in pixels of the image that was handed to the engine. */
export interface OcrLine {
  text: string;
  confidence: number;
  /** Axis-aligned bounds of `polygon`. */
  box: Rect;
  /** The text region's corners, which follow the text when it is rotated. */
  polygon: Point[];
}

export interface OcrEngine {
  detect(image: RgbaImage): Promise<OcrLine[]>;
}

interface RawOcrResult {
  texts: { text: string; mean: number; box?: Point[] }[];
  resizedImageWidth: number;
  resizedImageHeight: number;
}

interface RawOcr {
  detect(image: RgbaImage): Promise<RawOcrResult>;
}

export interface OcrGeometry {
  imageWidth: number;
  imageHeight: number;
  resizedWidth: number;
  resizedHeight: number;
}

/**
 * Maps a point from the space the OCR library reports (the input resized to a multiple of 32,
 * contained and centred, so possibly letterboxed) back to pixels of the input image.
 */
export function toImagePoint([x, y]: Point, geometry: OcrGeometry): Point {
  const { imageWidth, imageHeight, resizedWidth, resizedHeight } = geometry;
  const factor = Math.min(resizedWidth / imageWidth, resizedHeight / imageHeight);
  const offsetX = Math.floor((resizedWidth - Math.round(imageWidth * factor)) / 2);
  const offsetY = Math.floor((resizedHeight - Math.round(imageHeight * factor)) / 2);
  return [
    Math.min(imageWidth, Math.max(0, (x - offsetX) / factor)),
    Math.min(imageHeight, Math.max(0, (y - offsetY) / factor)),
  ];
}

/** The axis-aligned box around a polygon. */
export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
}

let shared: Promise<RawOcr> | undefined;

function ocrFailure(cause: unknown): UiProError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new UiProError(PerceptionErrorCodes.ocrFailed, `文字识别失败：${reason}`, {
    hint: '检查 @gutenye/ocr-node 与 onnxruntime 是否装好',
    cause,
  });
}

/** The PaddleOCR engine; its models load once per process. */
export function createOcrEngine(): OcrEngine {
  return {
    async detect(image) {
      let engine: RawOcr;
      try {
        // The library splits lines with the shared opencv runtime, which must be initialised.
        await loadOpenCv();
        shared ??= Ocr.create() as Promise<RawOcr>;
        engine = await shared;
      } catch (error) {
        shared = undefined;
        throw ocrFailure(error);
      }
      let result: RawOcrResult;
      try {
        result = await engine.detect(image);
      } catch (error) {
        throw ocrFailure(error);
      }
      const geometry: OcrGeometry = {
        imageWidth: image.width,
        imageHeight: image.height,
        resizedWidth: result.resizedImageWidth,
        resizedHeight: result.resizedImageHeight,
      };
      return result.texts.flatMap((line) => {
        const text = line.text.trim();
        if (!line.box || text === '') return [];
        const polygon = line.box.map((point) => toImagePoint(point, geometry));
        return [{ text, confidence: line.mean, box: boundsOf(polygon), polygon }];
      });
    },
  };
}
