import { analyzeCommand } from './analyze';
import { applyCommand } from './apply';
import { buildCommand } from './build';
import { doctorCommand } from './doctor';
import { exportCommand } from './export';
import { historyCommand } from './history';
import { initCommand } from './init';
import { lookCommand } from './look';
import { psdCommand } from './psd';
import { queryCommand } from './query';
import { rulesCommand } from './rules';
import { schemaCommand } from './schema';
import { skillCommand } from './skill';
import { snapCommand } from './snap';
import type { CommandModule } from './types';
import { verifyCommand } from './verify';

/** Every top-level command, in the order `--help` lists them. */
export const commandModules: readonly CommandModule[] = [
  initCommand,
  doctorCommand,
  analyzeCommand,
  lookCommand,
  snapCommand,
  psdCommand,
  queryCommand,
  applyCommand,
  rulesCommand,
  buildCommand,
  verifyCommand,
  exportCommand,
  historyCommand,
  schemaCommand,
  skillCommand,
];
