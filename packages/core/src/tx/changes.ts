import { isDeepStrictEqual } from 'node:util';
import { type ScreenDoc, ScreenDocSchema, UINODE_FIELDS } from '../schema/screen';
import { allIdsInOrder } from '../screen/tree';

/** Key in `ScreenChanges.modified` for changes outside `nodes` (e.g. `components`). */
export const SCREEN_LEVEL_KEY = '$screen';

const SCREEN_LEVEL_FIELDS = (Object.keys(ScreenDocSchema.shape) as Array<keyof ScreenDoc>).filter(
  (field) => field !== 'nodes',
);

export interface ScreenChanges {
  added: string[];
  removed: string[];
  /** Node id -> names of the fields that changed. */
  modified: Record<string, string[]>;
}

export interface ChangeSet {
  /** Project-relative paths of the documents that changed, sorted. */
  docs: string[];
  screens: Record<string, ScreenChanges>;
}

/** Compares two versions of a screen; `before` is `undefined` for a newly created screen. */
export function diffScreens(before: ScreenDoc | undefined, after: ScreenDoc): ScreenChanges {
  const added: string[] = [];
  const modified: Record<string, string[]> = {};

  for (const id of allIdsInOrder(after)) {
    const node = after.nodes[id];
    if (!node) continue;
    const old = before?.nodes[id];
    if (!old) {
      added.push(id);
      continue;
    }
    const fields = UINODE_FIELDS.filter((field) => !isDeepStrictEqual(old[field], node[field]));
    if (fields.length > 0) modified[id] = fields;
  }

  const removed = before ? allIdsInOrder(before).filter((id) => !(id in after.nodes)) : [];

  if (before) {
    const fields = SCREEN_LEVEL_FIELDS.filter(
      (field) => !isDeepStrictEqual(before[field], after[field]),
    );
    if (fields.length > 0) modified[SCREEN_LEVEL_KEY] = fields;
  }
  return { added, removed, modified };
}
