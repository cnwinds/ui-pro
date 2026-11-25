import { type Codec, jsonCodec } from '../schema/codec';
import { type ScreenDoc, ScreenDocSchema, ScreenNodesSchema, type UINode } from '../schema/screen';
import { allIdsInOrder } from './tree';

const codec = jsonCodec(ScreenDocSchema, { preserveOrder: new Set([ScreenNodesSchema]) });

/** Canonical bytes of a screen document: identical documents always serialize identically. */
export function serializeScreen(doc: ScreenDoc): string {
  const nodes: Record<string, UINode> = {};
  for (const id of allIdsInOrder(doc)) {
    const node = doc.nodes[id];
    if (node) nodes[id] = node;
  }
  return codec.serialize({ ...doc, nodes });
}

export function parseScreen(text: string, label = 'screen.uir.json'): ScreenDoc {
  return codec.parse(text, label);
}

export const screenCodec: Codec<ScreenDoc> = { parse: parseScreen, serialize: serializeScreen };
