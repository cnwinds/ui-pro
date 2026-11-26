import type { Layer } from 'ag-psd';
import type { RgbaImage } from './image';
import { readAgPsd } from './parse';
import type { LayerRenderer, RenderRequest, RenderStats } from './renderer';

function* leaves(layers: readonly Layer[]): Generator<Layer> {
  for (const layer of layers) {
    if (layer.children) yield* leaves(layer.children);
    else yield layer;
  }
}

/** Draws `layer` onto `canvas` with source-over, scaling its alpha by the layer opacity. */
function drawLayer(canvas: RgbaImage, layer: Layer): void {
  const pixels = layer.imageData;
  if (pixels === undefined) return;
  const opacity = layer.opacity ?? 1;
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  for (let y = 0; y < pixels.height; y++) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < pixels.width; x++) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const from = (y * pixels.width + x) * 4;
      const sourceAlpha = ((pixels.data[from + 3] ?? 0) / 255) * opacity;
      if (sourceAlpha === 0) continue;
      const to = (targetY * canvas.width + targetX) * 4;
      const backdropAlpha = (canvas.data[to + 3] ?? 0) / 255;
      const alpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel++) {
        const source = pixels.data[from + channel] ?? 0;
        const backdrop = canvas.data[to + channel] ?? 0;
        const mixed = (source * sourceAlpha + backdrop * backdropAlpha * (1 - sourceAlpha)) / alpha;
        canvas.data[to + channel] = Math.round(mixed);
      }
      canvas.data[to + 3] = Math.round(alpha * 255);
    }
  }
}

/**
 * A renderer for tests and for PSDs without layer styles: the layer pixels as stored in the file,
 * with opacity applied. It ignores styles, masks and blend modes, so for a PSD that uses none of
 * them the recomposition equals the composite exactly.
 */
export class EmbeddedRenderer implements LayerRenderer {
  readonly name = 'embedded';
  readonly capabilities = { network: false };
  /** Units rendered over this renderer's lifetime, to let tests observe the render cache. */
  renderedUnits = 0;

  async render(request: RenderRequest): Promise<RenderStats> {
    const started = performance.now();
    const psd = readAgPsd(request.document.bytes, { skipCompositeImageData: true });
    const byId = new Map([...leaves(psd.children ?? [])].map((layer) => [layer.id, layer]));
    for (const unit of request.units) {
      const canvas: RgbaImage = {
        width: request.document.width,
        height: request.document.height,
        data: new Uint8Array(request.document.width * request.document.height * 4),
      };
      for (const id of unit.show) {
        const layer = byId.get(id);
        if (layer) drawLayer(canvas, layer);
      }
      await request.onRendered(unit, canvas);
      this.renderedUnits++;
    }
    return {
      renderer: this.name,
      startupMs: 0,
      openMs: 0,
      units: request.units.length,
      renderMs: Math.round(performance.now() - started),
    };
  }

  async close(): Promise<void> {}
}
