import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachChild,
  createScreenDoc,
  type NewNodeFields,
  newNode,
  type ScreenDoc,
  type UINode,
} from '@ui-pro/core';
import { afterEach } from 'vitest';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-godot-test-'));
    created.push(dir);
    return dir;
  };
}

export interface DocOptions {
  name?: string;
  scale?: number;
  size?: [number, number];
}

/** A screen whose nodes are given parents first; `parent` is the id of an earlier node. */
export function makeDoc(nodes: NewNodeFields[], options: DocOptions = {}): ScreenDoc {
  const size = options.size ?? [1080, 1920];
  const doc = createScreenDoc({
    name: options.name ?? 'main',
    source: {
      kind: 'flat',
      file: 'source/main.png',
      width: size[0],
      height: size[1],
      sha256: '0'.repeat(64),
    },
    scale: options.scale ?? 1,
    size,
  });
  for (const fields of nodes) {
    doc.nodes[fields.id] = newNode(fields);
    if (fields.parent !== null) attachChild(doc, fields.parent, fields.id);
  }
  return doc;
}

/** `[node ...]` header lines of a `.tscn` file with the property lines that follow each. */
export function parseTscnNodes(
  text: string,
): { name: string; type: string; parent: string | undefined; body: string }[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith('[node '))
    .map((block) => {
      const [header = '', ...rest] = block.split(/\r?\n/);
      return {
        name: /name="([^"]*)"/.exec(header)?.[1] ?? '',
        type: /type="([^"]*)"/.exec(header)?.[1] ?? '',
        parent: /parent="([^"]*)"/.exec(header)?.[1],
        body: rest.join('\n'),
      };
    });
}

export function nodeAt(doc: ScreenDoc, id: string): UINode {
  const node = doc.nodes[id];
  if (node === undefined) throw new Error(`no node ${id} in the screen`);
  return node;
}
