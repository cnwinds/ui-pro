import { z } from 'zod';
import { readFileIfExistsSync } from '../fs/files';
import { scratchPath } from '../paths';
import { parseWithSchema } from '../schema/codec';
import { ScreenNameSchema } from '../schema/common';
import type { Selection } from '../selector/resolve';
import type { Project } from './project';

const SelectionSchema = z.strictObject({
  screen: ScreenNameSchema,
  ids: z.array(z.string()),
});

/** The user's current Studio selection, or `null` when nothing was selected yet. */
export function readSelection(project: Project): Selection | null {
  const path = scratchPath(project.root, 'selection.json');
  const bytes = readFileIfExistsSync(path);
  if (bytes === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    // Studio rewrites this file while running; a copy caught mid-write counts as no selection.
    return null;
  }
  return parseWithSchema(SelectionSchema, raw, '.ui-pro/selection.json');
}
