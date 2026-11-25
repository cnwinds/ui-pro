import { builtinOps } from '../ops';
import { builtinDocKinds } from '../project/docs';
import { Registry } from './registry';
import type { DocKind, HookMap, HookName, OpDefinition } from './types';

/** A registry holding exactly what the kernel provides. */
export function createCoreRegistry(): Registry {
  const registry = new Registry();
  for (const op of builtinOps) registry.registerOp(op);
  for (const kind of builtinDocKinds) registry.registerDocKind(kind);
  return registry;
}

/** The registry `applyOps` uses unless told otherwise; other packages register into it. */
export const defaultRegistry: Registry = createCoreRegistry();

export function registerOp(definition: OpDefinition): void {
  defaultRegistry.registerOp(definition);
}

export function registerDocKind(kind: DocKind): void {
  defaultRegistry.registerDocKind(kind);
}

export function registerHook<N extends HookName>(name: N, hook: HookMap[N]): void {
  defaultRegistry.registerHook(name, hook);
}

export function listOps(): OpDefinition[] {
  return defaultRegistry.listOps();
}

export function getOp(name: string): OpDefinition | undefined {
  return defaultRegistry.getOp(name);
}
