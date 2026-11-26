import type { AssetHole, AssetUse } from '@ui-pro/core';
import {
  IDENTICAL_DIFF,
  NEAR_SSIM,
  PHASH_MAX_DISTANCE,
  SHARE_INSET_TOLERANCE,
  SHARE_SIZE_TOLERANCE,
  TINT_MAX_ERROR,
} from './constants';
import type { Approximation, BuiltAsset, FinalAsset } from './model';
import { showRatio } from './nine-slice';
import {
  hashDistance,
  meanDifference,
  perceptualHash,
  resizeImage,
  sharpness,
  ssim,
} from './raster';
import { fitTint, tintAcceptable } from './tint';

export interface DedupeResult {
  /** In drawing order of the first node that uses each. */
  assets: FinalAsset[];
  /** What dedupe found different between instances and their master. */
  notes: Approximation[];
}

const WHITE = '#ffffff';

function close(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= Math.max(1, tolerance * Math.max(Math.abs(a), Math.abs(b)));
}

function sameMargins(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  return a !== undefined && b !== undefined && a.every((value, index) => value === b[index]);
}

/** Whether `member` is drawn the same size as `master`, so sharing its picture changes no layout. */
function shareable(master: BuiltAsset, member: BuiltAsset): boolean {
  if (
    member.inset.some(
      (value, index) => Math.abs(value - (master.inset[index] ?? 0)) > SHARE_INSET_TOLERANCE,
    )
  ) {
    return false;
  }
  if ((master.nineSlice === undefined) !== (member.nineSlice === undefined)) return false;
  if (master.nineSlice !== undefined) {
    return (
      sameMargins(master.nineSlice, member.nineSlice) &&
      master.image.width === member.image.width &&
      master.image.height === member.image.height
    );
  }
  return (
    close(master.image.width, member.image.width, SHARE_SIZE_TOLERANCE) &&
    close(master.image.height, member.image.height, SHARE_SIZE_TOLERANCE) &&
    close(master.plan.rect[2], member.plan.rect[2], SHARE_SIZE_TOLERANCE) &&
    close(master.plan.rect[3], member.plan.rect[3], SHARE_SIZE_TOLERANCE)
  );
}

function brightness(asset: BuiltAsset): number {
  let sum = 0;
  let weight = 0;
  const { data } = asset.image;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    sum +=
      alpha * (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
    weight += alpha;
  }
  return weight === 0 ? 0 : sum / weight;
}

/**
 * The best picture to share: the one with the fewest invented pixels (least covered), then the
 * crispest, then the brightest (a multiply colour can only darken), then the earliest drawn.
 */
function pickMaster(candidates: readonly BuiltAsset[], order: ReadonlyMap<BuiltAsset, number>) {
  const scored = candidates.map((asset) => ({
    asset,
    invented: asset.invented,
    sharp: sharpness(asset.image),
    bright: brightness(asset),
  }));
  scored.sort(
    (a, b) =>
      a.invented - b.invented ||
      b.sharp - a.sharp ||
      b.bright - a.bright ||
      (order.get(a.asset) ?? 0) - (order.get(b.asset) ?? 0),
  );
  const [best] = scored;
  if (best === undefined) throw new Error('pickMaster 需要至少一个候选');
  return best.asset;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function holesUnion(assets: readonly BuiltAsset[]): AssetHole[] {
  const seen = new Set<string>();
  const holes: AssetHole[] = [];
  for (const asset of assets) {
    for (const hole of asset.holes) {
      const key = `${hole.node}|${hole.handling}`;
      if (seen.has(key)) continue;
      seen.add(key);
      holes.push(hole);
    }
  }
  return holes;
}

interface Attached {
  member: BuiltAsset;
  tint?: string;
  note?: string;
}

function finalOf(
  master: BuiltAsset,
  attached: readonly Attached[],
  extra: readonly string[],
  screen: string,
): FinalAsset {
  const members = [master, ...attached.map((entry) => entry.member)];
  const uses: AssetUse[] = [
    {
      node: master.node,
      ...(master.plan.variant === 'tint' && attached.length > 0 ? { tint: WHITE } : {}),
    },
    ...attached.map((entry) => ({
      node: entry.member.node,
      ...(entry.tint === undefined ? {} : { tint: entry.tint }),
    })),
  ];
  const atlas = master.plan.atlas;
  return {
    origin: master.origin,
    image: master.image,
    inset: master.inset,
    nineSlice: master.nineSlice,
    holes: holesUnion(members),
    steps: master.steps,
    approximations: unique([
      ...members.flatMap((member) => member.approximations),
      ...extra,
      ...attached.flatMap((entry) => (entry.note === undefined ? [] : [entry.note])),
    ]),
    uses,
    atlas: atlas === undefined ? undefined : atlas === 'screen' ? screen : 'shared',
    owner: master.plan,
  };
}

/**
 * DESIGN §6.5 去重: instances of one cluster or component that look the same share one picture.
 * Identical ones always do; a `variant.mode: tint` instance does when one multiply colour turns the
 * master into it; a near-identical one of a `repeat.mode: component` does too, and the difference
 * is recorded. Everything else keeps a picture of its own.
 */
export async function dedupeAssets(
  built: readonly BuiltAsset[],
  screen: string,
): Promise<DedupeResult> {
  const order = new Map(built.map((asset, index) => [asset, index]));
  const finals: Array<{ at: number; asset: FinalAsset }> = [];
  const notes: Approximation[] = [];
  const groups = new Map<string, BuiltAsset[]>();
  for (const asset of built) {
    if (asset.plan.group === undefined) {
      finals.push({ at: order.get(asset) ?? 0, asset: finalOf(asset, [], [], screen) });
    } else {
      groups.set(asset.plan.group, [...(groups.get(asset.plan.group) ?? []), asset]);
    }
  }

  for (const members of groups.values()) {
    const failures = new Map<BuiltAsset, string>();
    let remaining = [...members];
    while (remaining.length > 0) {
      const master = pickMaster(remaining, order);
      const attached: Attached[] = [];
      const rest: BuiltAsset[] = [];
      for (const member of remaining) {
        if (member === master) continue;
        if (!shareable(master, member)) {
          if (member.plan.variant === 'tint') {
            failures.set(
              member,
              `variant.mode：#${member.node} 与母版 #${master.node} 的尺寸、边距或九宫不同，不能用乘色共用一张图，改为各存一张`,
            );
          }
          rest.push(member);
          continue;
        }
        const candidate = await resizeImage(member.image, master.image.width, master.image.height);
        if (meanDifference(master.image, candidate) <= IDENTICAL_DIFF) {
          attached.push({ member, tint: member.plan.variant === 'tint' ? WHITE : undefined });
          failures.delete(member);
          continue;
        }
        if (member.plan.variant === 'tint') {
          const fit = fitTint(master.image, candidate);
          if (fit !== undefined && tintAcceptable(fit)) {
            attached.push({ member, tint: fit.color });
            failures.delete(member);
            continue;
          }
          failures.set(
            member,
            fit === undefined
              ? `variant.mode：#${member.node} 与母版 #${master.node} 的形状不同，不能用乘色表示，改为各存一张`
              : `variant.mode：#${member.node} 相对母版 #${master.node} 的乘色拟合误差 ${fit.error.toFixed(1)}（上限 ${TINT_MAX_ERROR}），色差过大，改为各存一张`,
          );
        }
        if (member.plan.repeat === 'component') {
          const similarity = ssim(master.image, candidate);
          const distance = hashDistance(perceptualHash(master.image), perceptualHash(candidate));
          if (distance <= PHASH_MAX_DISTANCE && similarity >= NEAR_SSIM) {
            const note = `repeat.mode：#${member.node} 与母版 #${master.node} 的结构相似度 ${showRatio(similarity)}，共用母版的图`;
            attached.push({ member, note });
            notes.push({ node: member.node, message: note });
            failures.delete(member);
            continue;
          }
        }
        rest.push(member);
      }
      // No member could share the first master's picture either: say so for it too.
      const failure =
        failures.get(master) ??
        (master.plan.variant === 'tint' && attached.length === 0 && members.length > 1
          ? `variant.mode：#${master.node} 的同簇实例没有一个能用乘色与它共用一张图，各存一张`
          : undefined);
      if (failure !== undefined) notes.push({ node: master.node, message: failure });
      const at = Math.min(
        order.get(master) ?? 0,
        ...attached.map((entry) => order.get(entry.member) ?? 0),
      );
      finals.push({
        at,
        asset: finalOf(master, attached, failure === undefined ? [] : [failure], screen),
      });
      remaining = rest;
    }
  }

  finals.sort((a, b) => a.at - b.at);
  return { assets: finals.map((entry) => entry.asset), notes };
}
