import type { OpDefinition } from '../tx/types';
import { componentExtract } from './component-extract';
import { conceptDefine } from './concept-define';
import { nodeAdd } from './node-add';
import { nodeMerge } from './node-merge';
import { nodeMove } from './node-move';
import { nodeRemove } from './node-remove';
import { nodeRename } from './node-rename';
import { nodeSet } from './node-set';
import { nodeSplit } from './node-split';
import { pinClear, pinSet } from './pin';
import { bindSet, layoutSet, stateSet } from './presentation';

/** Ops the kernel itself provides, in the order `ui-pro schema` lists them. */
export const builtinOps: readonly OpDefinition[] = [
  nodeAdd,
  nodeSet,
  nodeSplit,
  nodeMerge,
  nodeMove,
  nodeRemove,
  nodeRename,
  conceptDefine,
  componentExtract,
  pinSet,
  pinClear,
  layoutSet,
  stateSet,
  bindSet,
];
