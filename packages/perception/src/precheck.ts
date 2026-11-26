import type { AskQuestion, CandidatesDoc, Rect, ScreenDoc } from '@ui-pro/core';
import type { RgbaImage } from './image';

export interface Precheck {
  /** Factor from source pixels to design pixels. */
  upscale: number;
  /** Risks to tell the user about, in Simplified Chinese. */
  risks: string[];
  ask: AskQuestion[];
}

const MAX_COMFORTABLE_UPSCALE = 1.5;
const EDGE_REACH = 6;
const MIN_RESIDUE_SIDE = 24;
const MAX_RESIDUE_SIDE = 120;
const MAX_GRAY_SATURATION = 0.2;

function isJpeg(file: string): boolean {
  return /\.jpe?g$/i.test(file);
}

/** Mean colour saturation (0..1) inside the ellipse that fills the box. */
function meanSaturation(image: RgbaImage, [left, top, width, height]: Rect): number {
  let total = 0;
  let count = 0;
  const cx = left + width / 2;
  const cy = top + height / 2;
  const rx = width / 2;
  const ry = height / 2;
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(image.height, top + height); y++) {
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(image.width, left + width); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
      const at = (y * image.width + x) * 4;
      const r = image.data[at] ?? 0;
      const g = image.data[at + 1] ?? 0;
      const b = image.data[at + 2] ?? 0;
      const high = Math.max(r, g, b);
      total += high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

/**
 * Gray round shapes pressed against the left or right edge: the system's back arrows that a
 * screenshot of a phone picks up. They are not part of the game's UI.
 */
function screenshotResidue(candidates: CandidatesDoc, image: RgbaImage): string[] {
  return candidates.candidates
    .filter((candidate) => {
      if (candidate.source !== 'cv') return false;
      const [x, , w, h] = candidate.bbox;
      const round = Math.abs(w - h) <= Math.max(3, 0.15 * Math.max(w, h));
      const sized = Math.min(w, h) >= MIN_RESIDUE_SIDE && Math.max(w, h) <= MAX_RESIDUE_SIDE;
      const atEdge = x <= EDGE_REACH || x + w >= image.width - EDGE_REACH;
      return (
        round && sized && atEdge && meanSaturation(image, candidate.bbox) <= MAX_GRAY_SATURATION
      );
    })
    .map((candidate) => candidate.id);
}

export function precheck(doc: ScreenDoc, candidates: CandidatesDoc, image: RgbaImage): Precheck {
  const risks: string[] = [];
  const ask: AskQuestion[] = [];
  if (doc.scale > MAX_COMFORTABLE_UPSCALE) {
    risks.push(
      `源文件宽 ${doc.source.width}px，小于设计宽度，要放大 ${doc.scale.toFixed(2)} 倍（超过 ${MAX_COMFORTABLE_UPSCALE} 倍），边缘会变软，构建出的资产清晰度不足`,
    );
  }
  if (isJpeg(doc.source.file)) {
    risks.push('源文件是 JPEG，带有压缩痕迹，色块边缘有噪点，小元素的框可能不够准');
  }
  const residue = screenshotResidue(candidates, image);
  if (residue.length > 0) {
    ask.push({
      id: 'exclude-screenshot-residue',
      question: `拍平图两侧贴边处有 ${residue.length} 个灰色圆形（${residue.join('、')}），像是系统返回箭头，不属于界面本身，要排除吗？`,
      options: ['排除', '保留'],
      default: '排除',
    });
  }
  return { upscale: doc.scale, risks, ask };
}
