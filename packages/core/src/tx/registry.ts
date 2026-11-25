import type { z } from 'zod';
import { ErrorCodes, UiProError } from '../errors';
import type { DocKind, HookMap, HookName, OpDefinition } from './types';

/** Identity helper that infers the op's schema type while erasing it for storage. */
export function defineOp<S extends z.ZodType>(definition: OpDefinition<S>): OpDefinition {
  return definition;
}

function duplicate(what: string, name: string): UiProError {
  return new UiProError(ErrorCodes.invariant, `${what} ${name} 已被注册`);
}

/** Ops, document kinds and hooks. Packages extend the kernel by registering into one. */
export class Registry {
  readonly #ops = new Map<string, OpDefinition>();
  readonly #docKinds = new Map<string, DocKind>();
  readonly #hooks: { [N in HookName]: Set<HookMap[N]> } = {
    beforeCommit: new Set(),
    rename: new Set(),
  };

  /** Registering the same definition twice is a no-op; a different one under a taken name throws. */
  registerOp(definition: OpDefinition): void {
    const existing = this.#ops.get(definition.name);
    if (existing === definition) return;
    if (existing) throw duplicate('操作', definition.name);
    this.#ops.set(definition.name, definition);
  }

  getOp(name: string): OpDefinition | undefined {
    return this.#ops.get(name);
  }

  listOps(): OpDefinition[] {
    return [...this.#ops.values()];
  }

  registerDocKind(kind: DocKind): void {
    const existing = this.#docKinds.get(kind.kind);
    if (existing === kind) return;
    if (existing) throw duplicate('文档类型', kind.kind);
    this.#docKinds.set(kind.kind, kind);
  }

  getDocKind(kind: string): DocKind {
    const found = this.#docKinds.get(kind);
    if (!found) throw new UiProError(ErrorCodes.invariant, `未注册的文档类型：${kind}`);
    return found;
  }

  registerHook<N extends HookName>(name: N, hook: HookMap[N]): void {
    this.#hooks[name].add(hook);
  }

  hooks<N extends HookName>(name: N): ReadonlySet<HookMap[N]> {
    return this.#hooks[name];
  }
}
