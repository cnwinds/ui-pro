import {
  loadScreen,
  projectSelectorEnv,
  resolveSelector,
  type ScreenDoc,
  UINODE_FIELDS,
  type UINode,
} from '@ui-pro/core';
import { UsageError } from '../errors';
import { integerParser } from './options';
import type { CommandModule } from './types';

type NodeField = (typeof UINODE_FIELDS)[number];

interface QueryOptions {
  fields: string;
  limit: number;
  offset: number;
  tree?: boolean;
}

const DEFAULT_FIELDS = 'id,type,role,concept,rect';

function parseFields(text: string): NodeField[] {
  if (text === 'all') return [...UINODE_FIELDS];
  const fields: NodeField[] = ['id'];
  for (const raw of text.split(',')) {
    const name = raw.trim();
    const field = UINODE_FIELDS.find((candidate) => candidate === name);
    if (field === undefined) {
      throw new UsageError(`未知的字段：${name}`, `可用字段：${UINODE_FIELDS.join('、')}，或 all`);
    }
    if (!fields.includes(field)) fields.push(field);
  }
  return fields;
}

function pick(node: UINode, fields: readonly NodeField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const value = node[field];
    if (value !== undefined) row[field] = value;
  }
  return row;
}

/** One node projected onto `fields`; with `nested`, descendants replace the `children` id list. */
function describeNode(
  doc: ScreenDoc,
  id: string,
  fields: readonly NodeField[],
  nested: boolean,
): Record<string, unknown> {
  const node = doc.nodes[id];
  if (!node) return { id };
  const row = pick(node, fields);
  if (nested) {
    if (node.children.length > 0) {
      row.children = node.children.map((child) => describeNode(doc, child, fields, true));
    } else {
      delete row.children;
    }
  }
  return row;
}

function describePage(total: number, offset: number, shown: number): string {
  if (shown === total) return `匹配 ${total} 个节点`;
  if (shown === 0) return `匹配 ${total} 个节点，offset ${offset} 已超出范围`;
  return `匹配 ${total} 个节点，显示第 ${offset + 1}–${offset + shown} 个`;
}

export const queryCommand: CommandModule = {
  name: 'query',
  register(program, host) {
    program
      .command('query')
      .description('用选择器查询节点，例如 "#btn_shop"、"button[role^=badge]"、"*/concept:红点"')
      .argument('<selector>', 'CSS 风格选择器')
      .option('--fields <list>', '返回的字段，逗号分隔或 all（id 总会包含）', DEFAULT_FIELDS)
      .option('--limit <n>', '最多返回的节点数', integerParser(1), 100)
      .option('--offset <n>', '跳过前 n 个匹配', integerParser(0), 0)
      .option('--tree', '把每个匹配节点的子树嵌套在 children 里')
      .action(
        host.action(async (ctx, selector: string, options: QueryOptions) => {
          const fields = parseFields(options.fields);
          const project = ctx.openProject();

          const docs = new Map<string, ScreenDoc>();
          const load = (name: string): ScreenDoc => {
            let doc = docs.get(name);
            if (!doc) {
              doc = loadScreen(project, name);
              docs.set(name, doc);
            }
            return doc;
          };
          const env = {
            ...projectSelectorEnv(project, ctx.currentScreen(project)),
            loadScreen: load,
          };

          const refs = resolveSelector(selector, env);
          const page = refs.slice(options.offset, options.offset + options.limit);
          const items = page.map((ref) => ({
            screen: ref.screen,
            ...describeNode(load(ref.screen), ref.id, fields, options.tree === true),
          }));

          const end = options.offset + page.length;
          return {
            summary: describePage(refs.length, options.offset, page.length),
            data: { total: refs.length, offset: options.offset, limit: options.limit, items },
            next:
              end < refs.length
                ? [`ui-pro query ${JSON.stringify(selector)} --offset ${end}`]
                : undefined,
          };
        }),
      );
  },
};
