import { type NodeFacts, PIXEL_TYPES } from './facts';
import { POSITIONS } from './schema';

export interface DecisionPoint {
  /** The key in a node's `decisions`. */
  name: string;
  /** What is decided, in Simplified Chinese. */
  summary: string;
  /** Closed set of values; `null` for a naming template. */
  values: readonly string[] | null;
  /** Which nodes the point applies to, in Simplified Chinese. */
  scope: string;
  applies(facts: NodeFacts): boolean;
}

/** `{prefix}_{semantic}_{index}`: literal characters plus these three placeholders. */
export const NAMING_PLACEHOLDERS = ['prefix', 'semantic', 'index'] as const;
const NAMING_TEMPLATE = /^(?:[a-z0-9_-]|\{(?:prefix|semantic|index)\})+$/;

const ANCHORS = [...POSITIONS.filter((position) => position !== 'fill'), 'stretch'] as const;

const STRETCH_TYPES = new Set(['image', 'button', 'toggle', 'input']);

/** The catalog of DESIGN §5.2. Rules can only decide what is listed here. */
export const DECISION_POINTS: readonly DecisionPoint[] = [
  {
    name: 'attach.split',
    summary: '附着在宿主上的小元素是否独立',
    values: ['independent', 'baked'],
    scope: '附着在宿主上的节点（宿主是父节点，且不是根节点和纯分组的 container）',
    applies: (facts) => facts.attached,
  },
  {
    name: 'content.split',
    summary: '容器与里面的内容是否分开',
    values: ['separate', 'baked'],
    scope: '有子节点的节点，container 除外',
    applies: (facts) => facts.childCount > 0 && facts.type !== 'container',
  },
  {
    name: 'decor.merge',
    summary: '不变的装饰是否并入所在背景',
    values: ['merge', 'separate'],
    scope: 'image 节点，根节点除外',
    applies: (facts) => !facts.isRoot && facts.type === 'image',
  },
  {
    name: 'occlusion.fill',
    summary: '被独立元素遮住的区域是否补全',
    values: ['fill', 'none'],
    scope: '会遮住别的东西的节点：根节点和 container 以外的全部节点',
    applies: (facts) => !facts.isRoot && facts.type !== 'container',
  },
  {
    name: 'text.mode',
    summary: '文字怎么实现',
    values: ['dynamic', 'bitmap-font', 'bitmap'],
    scope: '文字节点（text）',
    applies: (facts) => facts.type === 'text',
  },
  {
    name: 'repeat.mode',
    summary: '重复元素怎么组织',
    values: ['component', 'independent'],
    scope: '属于相似簇或组件实例的节点',
    applies: (facts) => facts.grouped,
  },
  {
    name: 'variant.mode',
    summary: '同结构不同颜色的变体怎么做',
    values: ['tint', 'variant-assets'],
    scope: '属于相似簇或组件实例、自带像素的节点',
    applies: (facts) => facts.grouped && PIXEL_TYPES.has(facts.type),
  },
  {
    name: 'stretch.mode',
    summary: '底板怎么适应尺寸',
    values: ['nine-slice', 'three-slice', 'fixed'],
    scope: 'image、button、toggle、input 节点',
    applies: (facts) => STRETCH_TYPES.has(facts.type),
  },
  {
    name: 'fill.mode',
    summary: '进度类的填充方式',
    values: ['resize', 'clip', 'radial'],
    scope: '进度类节点（progress、slider）',
    applies: (facts) => facts.type === 'progress' || facts.type === 'slider',
  },
  {
    name: 'state.source',
    summary: '图里没画的状态从哪来',
    values: ['derive', 'generate', 'placeholder'],
    scope: '可交互，或可变性含“状态”的节点',
    applies: (facts) => facts.interactive || facts.varies.includes('state'),
  },
  {
    name: 'press.feedback',
    summary: '可点击元素的默认按压反馈',
    values: ['scale', 'tint', 'none'],
    scope: '可交互的节点',
    applies: (facts) => facts.interactive,
  },
  {
    name: 'hit.area',
    summary: '点击热区',
    values: ['visible', 'padded'],
    scope: '可交互的节点',
    applies: (facts) => facts.interactive,
  },
  {
    name: 'layout.anchor',
    summary: '锚定方式',
    values: ANCHORS,
    scope: '有父节点的节点（相对父节点）',
    applies: (facts) => !facts.isRoot,
  },
  {
    name: 'layout.flow',
    summary: '重复排列是否用自动布局',
    values: ['flow', 'absolute'],
    scope: '有两个以上子节点的节点',
    applies: (facts) => facts.childCount >= 2,
  },
  {
    name: 'scale.source',
    summary: '分辨率不够时怎么办',
    values: ['native', 'upscale', 'redraw'],
    scope: '自带像素的节点',
    applies: (facts) => PIXEL_TYPES.has(facts.type),
  },
  {
    name: 'atlas.group',
    summary: '资产归哪个图集',
    values: ['screen', 'shared'],
    scope: '自带像素的节点',
    applies: (facts) => PIXEL_TYPES.has(facts.type),
  },
  {
    name: 'naming.node',
    summary: '节点命名模板',
    values: null,
    scope: '全部节点',
    applies: () => true,
  },
  {
    name: 'naming.asset',
    summary: '资产命名模板',
    values: null,
    scope: '自带像素的节点',
    applies: (facts) => PIXEL_TYPES.has(facts.type),
  },
];

const POINTS_BY_NAME: ReadonlyMap<string, DecisionPoint> = new Map(
  DECISION_POINTS.map((point) => [point.name, point]),
);

export const POINT_NAMES: readonly string[] = DECISION_POINTS.map((point) => point.name);

export function getPoint(name: string): DecisionPoint | undefined {
  return POINTS_BY_NAME.get(name);
}

/** Why `value` cannot be decided at `point`; `undefined` when it can. */
export function valueProblem(point: string, value: string): string | undefined {
  const definition = POINTS_BY_NAME.get(point);
  if (!definition) return `未知的决策点：${point}`;
  if (definition.values === null) {
    return NAMING_TEMPLATE.test(value)
      ? undefined
      : `决策点 ${point} 的取值是命名模板，只能由小写字母、数字、下划线、连字符和 ${NAMING_PLACEHOLDERS.map((name) => `{${name}}`).join('、')} 组成：${value}`;
  }
  return definition.values.includes(value)
    ? undefined
    : `决策点 ${point} 没有取值 ${value}；可选：${definition.values.join('、')}`;
}

/** What to tell a user who named a point that does not exist. */
export function unknownPointHint(): string {
  return `决策点目录：${POINT_NAMES.join('、')}`;
}
