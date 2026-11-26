import type { RgbaImage } from './image';
import { isDefaultVisible, type LayerVisit, type PsdDocument, type PsdLayer } from './model';
import { isIgnored } from './structure';

/**
 * One image a renderer must produce: the canvas with only `show` visible. Layers clipped to a
 * layer cannot be shown without it, so a base layer and its clipped layers are one unit, saved
 * under the base's id.
 */
export interface RenderUnit {
  id: number;
  /** Ids of the layers shown, bottom to top; always starts with `id`. */
  show: readonly number[];
  /** Shown in the PSD's saved state, so part of the recomposition; hidden state layers are not. */
  visible: boolean;
  /** Inside a `#` group: rendered only so the recomposition matches the composite. */
  ignored: boolean;
}

export interface RendererCapabilities {
  /** The renderer talks to a service over the network. */
  network: boolean;
}

export interface RenderStats {
  renderer: string;
  /** Launching the browser and loading the renderer; 0 when it was already running. */
  startupMs: number;
  /** Opening the PSD in the renderer. */
  openMs: number;
  units: number;
  /** Rendering all units, after the PSD was open. */
  renderMs: number;
  /**
   * Whether the browser kept its cache between runs (`persistent`) or started clean
   * (`temporary`); only browser-based renderers report it.
   */
  profile?: 'persistent' | 'temporary';
}

export interface RenderRequest {
  document: PsdDocument;
  units: readonly RenderUnit[];
  /** Receives each unit's canvas-sized RGBA image as soon as it is done, in any order. */
  onRendered(unit: RenderUnit, image: RgbaImage): Promise<void>;
}

/** The Provider for per-layer rendering (§6.8): layer pixels including styles and blending. */
export interface LayerRenderer {
  readonly name: string;
  readonly capabilities: RendererCapabilities;
  render(request: RenderRequest): Promise<RenderStats>;
  /** Releases everything the renderer started; safe to call more than once. */
  close(): Promise<void>;
}

interface PendingUnit {
  visit: LayerVisit;
  members: PsdLayer[];
}

function planList(layers: readonly PsdLayer[], ancestors: PsdLayer[], out: PendingUnit[]): void {
  let base: PendingUnit | undefined;
  for (const layer of layers) {
    const visit = { layer, ancestors };
    if (layer.kind === 'group') {
      base = undefined;
      planList(layer.children ?? [], [...ancestors, layer], out);
      continue;
    }
    if (layer.clipping && base !== undefined) {
      base.members.push(layer);
      continue;
    }
    // An adjustment layer that is not clipped changes everything below it; it has no image.
    if (layer.adjustment) {
      base = undefined;
      continue;
    }
    base = { visit, members: [layer] };
    out.push(base);
  }
}

/**
 * The render units of a PSD in z-order (bottom to top): every non-group layer, with clipped
 * layers folded into their base. Hidden layers inside `#` groups are skipped.
 */
export function planRenderUnits(doc: PsdDocument): RenderUnit[] {
  const pending: PendingUnit[] = [];
  planList(doc.layers, [], pending);
  const units: RenderUnit[] = [];
  for (const { visit, members } of pending) {
    const visible = isDefaultVisible(visit);
    const ignored = visit.ancestors.some(isIgnored);
    if (ignored && !visible) continue;
    const shown = visible
      ? members.filter((member) => !member.hidden || member === visit.layer)
      : members;
    units.push({ id: visit.layer.id, show: shown.map((member) => member.id), visible, ignored });
  }
  return units;
}
