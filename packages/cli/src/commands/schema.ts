import { defaultRegistry, describeOps, opJsonSchema, unknownOpError } from '@ui-pro/core';
import type { CommandModule } from './types';

export const schemaCommand: CommandModule = {
  name: 'schema',
  register(program, host) {
    program
      .command('schema')
      .description('列出所有操作；给出操作名时输出它的 JSON Schema')
      .argument('[op]', '操作名，如 node.add')
      .action(
        host.action(async (_ctx, op: string | undefined) => {
          if (op === undefined) {
            const ops = describeOps(defaultRegistry);
            return {
              summary: `共 ${ops.length} 个操作`,
              data: { ops },
              next: ['ui-pro schema <op>  # 查看某个操作的参数'],
            };
          }
          const definition = defaultRegistry.getOp(op);
          if (!definition) throw unknownOpError(defaultRegistry, op);
          return {
            summary: `${definition.name}：${definition.summary}`,
            data: {
              name: definition.name,
              family: definition.family,
              summary: definition.summary,
              schema: opJsonSchema(defaultRegistry, op),
            },
          };
        }),
      );
  },
};
