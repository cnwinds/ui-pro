import type { DesignSize } from '@ui-pro/core';
import { layerPath, type PsdDocument, type PsdLayer, walkLayers } from './model';
import type { PrefixTable } from './prefixes';
import { isIgnored, isValidStateName, numberedName, stateNameOf } from './structure';

export type IssueSeverity = 'must' | 'should';
export type IssueCategory = 'file' | 'structure' | 'restore';

/** One finding of the PSD check, written for the artist who has to fix the file. */
export interface PsdIssue {
  /** `must` items of the delivery spec make the input grade C; `should` items are advice. */
  severity: IssueSeverity;
  category: IssueCategory;
  /** Stable machine-readable identifier of the kind of problem. */
  code: string;
  /** Layer path in the PSD; absent for problems of the whole file. */
  layer?: string;
  layerId?: number;
  message: string;
  fix: string;
}

export interface ComplianceResult {
  issues: PsdIssue[];
  /** Checks of the delivery spec this run could not make, with the reason. */
  unchecked: string[];
}

const COLOR_MODE_NAMES: Record<number, string> = {
  0: '位图',
  1: '灰度',
  2: '索引颜色',
  3: 'RGB',
  4: 'CMYK',
  7: '多通道',
  8: '双色调',
  9: 'Lab',
};
const RGB_COLOR_MODE = 3;

const BLEND_NAMES: Record<string, string> = {
  'pass through': '穿透',
  normal: '正常',
  dissolve: '溶解',
  darken: '变暗',
  multiply: '正片叠底',
  'color burn': '颜色加深',
  'linear burn': '线性加深',
  'darker color': '深色',
  lighten: '变亮',
  screen: '滤色',
  'color dodge': '颜色减淡',
  'linear dodge': '线性减淡（添加）',
  'lighter color': '浅色',
  overlay: '叠加',
  'soft light': '柔光',
  'hard light': '强光',
  'vivid light': '亮光',
  'linear light': '线性光',
  'pin light': '点光',
  'hard mix': '实色混合',
  difference: '差值',
  exclusion: '排除',
  subtract: '减去',
  divide: '划分',
  hue: '色相',
  saturation: '饱和度',
  color: '颜色',
  luminosity: '明度',
};

/** Between elements only these are allowed; groups default to pass through. */
const ELEMENT_BLENDS = new Set(['normal', 'pass through', 'multiply', 'linear dodge']);
const INNER_BLENDS = new Set(['normal', 'multiply', 'linear dodge']);

const BLEND_FIX =
  '元素之间只用“正常”混合（光效可用“线性减淡（添加）”，压暗可用“正片叠底”）；其他混合模式只在元素内部使用，并且剪贴到元素自己的底图上';

const UNCHECKED_GRANULARITY =
  '粒度：按项目规则应该独立的元素有没有和别的东西画在同一个图层里、被盖住的部分有没有画完整，需要感知模型和项目规则，本版本未检查';
const UNCHECKED_FONTS = '字体：项目里还没有字体清单，未检查文字用的字体';

/** Whether an ICC profile describes sRGB, judging by the name in its description. */
function isSrgbProfile(profile: Uint8Array): boolean {
  const text = Buffer.from(profile.buffer, profile.byteOffset, profile.byteLength);
  return text.includes('sRGB', 0, 'latin1') || text.includes('sRGB', 0, 'utf16le');
}

function blendLabel(mode: string): string {
  return BLEND_NAMES[mode] ?? mode;
}

class Collector {
  readonly issues: PsdIssue[] = [];

  file(code: string, severity: IssueSeverity, message: string, fix: string): void {
    this.issues.push({ severity, category: 'file', code, message, fix });
  }

  layer(
    layer: PsdLayer,
    code: string,
    severity: IssueSeverity,
    message: string,
    fix: string,
  ): void {
    this.issues.push({
      severity,
      category: 'structure',
      code,
      layer: layerPath(layer),
      layerId: layer.id,
      message,
      fix,
    });
  }
}

function checkFile(
  doc: PsdDocument,
  design: DesignSize | undefined,
  out: Collector,
  unchecked: string[],
): void {
  if (doc.composite === null) {
    out.file(
      'no-composite',
      'must',
      '文件没有可用的合成图（保存时没有开启“最大兼容”）',
      'Photoshop：编辑 > 首选项 > 文件处理 > 文件兼容性，把“最大兼容 PSD 和 PSB 文件”设为“总是”，然后重新保存',
    );
  }
  if (doc.colorMode !== RGB_COLOR_MODE) {
    const mode = COLOR_MODE_NAMES[doc.colorMode] ?? `模式 ${doc.colorMode}`;
    out.file(
      'color-mode',
      'must',
      `颜色模式是 ${mode}，交付规范要求 RGB`,
      '图像 > 模式 > RGB 颜色',
    );
  }
  if (doc.bitsPerChannel !== 8) {
    out.file(
      'bit-depth',
      'must',
      `位深是 ${doc.bitsPerChannel} 位/通道，交付规范要求 8 位/通道`,
      '图像 > 模式 > 8 位/通道',
    );
  }
  if (doc.iccProfile !== undefined && !isSrgbProfile(doc.iccProfile)) {
    out.file(
      'color-profile',
      'must',
      '颜色配置文件不是 sRGB',
      '编辑 > 转换为配置文件，目标配置文件选 sRGB IEC61966-2.1',
    );
  }
  if (design === undefined) {
    unchecked.push('画布尺寸：不在项目内，没有设计分辨率可以对照');
  } else if (doc.width !== design.width || doc.height !== design.height) {
    out.file(
      'canvas-size',
      'must',
      `画布尺寸是 ${doc.width}×${doc.height}，项目的设计分辨率是 ${design.width}×${design.height}`,
      `把画布调整为 ${design.width}×${design.height}（图像 > 图像大小 / 画布大小；界面内容按比例缩放，不要拉伸）`,
    );
  }
  if (doc.hasArtboards) {
    out.file(
      'artboards',
      'must',
      '文件使用了画板',
      '一个界面一个文件：把每个画板另存为单独的 PSD，不使用画板',
    );
  }
}

interface Scope {
  /** The nearest enclosing element group. */
  element?: PsdLayer;
  /** Inside a group that already got a naming problem; its contents are not reported again. */
  inBadGroup: boolean;
  inState: boolean;
  /** Every enclosing group is visible. */
  visible: boolean;
}

function containsText(layer: PsdLayer): boolean {
  return [...walkLayers(layer.children ?? [])].some((visit) => visit.layer.kind === 'text');
}

function checkName(layer: PsdLayer, prefixes: PrefixTable, out: Collector): void {
  if (prefixes.isWellFormed(layer.name)) return;
  out.layer(
    layer,
    'name-format',
    'must',
    `「${layer.name}」的名称部分不是小写英文、数字和下划线`,
    '名称会成为引擎里的节点名和代码里的变量名：只用小写英文、数字和下划线，例如 btn_upgrade',
  );
}

function checkStateLayer(layer: PsdLayer, scope: Scope, out: Collector): void {
  const state = stateNameOf(layer) ?? '';
  if (!isValidStateName(state)) {
    out.layer(
      layer,
      'state-name',
      'should',
      `状态图层「${layer.name}」的状态名不合法`,
      '@ 后面用小写英文、数字和下划线，例如 @pressed、@disabled、@selected、@empty、@locked',
    );
  }
  if (!layer.hidden) {
    out.layer(
      layer,
      'state-visible',
      'should',
      `状态图层「${layer.name}」保存时是可见的`,
      '状态图层应当隐藏，否则它会成为默认状态的一部分',
    );
  }
  if (scope.element === undefined && !scope.inBadGroup) {
    out.layer(
      layer,
      'state-orphan',
      'should',
      `状态图层「${layer.name}」不在任何元素的图层组里`,
      '把它放进所属元素的图层组',
    );
  }
}

function checkBlend(layer: PsdLayer, elementLevel: boolean, out: Collector): void {
  const allowed = elementLevel ? ELEMENT_BLENDS : INNER_BLENDS;
  if (allowed.has(layer.blendMode)) return;
  const mode = blendLabel(layer.blendMode);
  if (elementLevel) {
    out.layer(
      layer,
      'blend-element',
      'must',
      `元素「${layer.name}」用了“${mode}”混合模式`,
      BLEND_FIX,
    );
  } else if (!layer.clipping) {
    out.layer(
      layer,
      'blend-unclipped',
      'must',
      `图层「${layer.name}」用了“${mode}”混合模式，但没有剪贴到元素自己的底图上`,
      BLEND_FIX,
    );
  }
}

function checkLeaf(layer: PsdLayer, scope: Scope, prefixes: PrefixTable, out: Collector): void {
  if (layer.text?.mixedStyles) {
    out.layer(
      layer,
      'text-mixed',
      'should',
      `文字图层「${layer.name}」用了多种字体或字号`,
      '一个文字图层只用一种字体和字号，不同样式拆成多个文字图层',
    );
  }
  if (stateNameOf(layer) !== undefined) {
    checkStateLayer(layer, scope, out);
    return;
  }
  const entry = prefixes.match(layer.name);
  if (entry !== undefined) {
    checkName(layer, prefixes, out);
    if (entry.type === 'text' && layer.kind !== 'text') {
      out.layer(
        layer,
        'txt-raster',
        'must',
        `「${layer.name}」不是文字图层`,
        '会变的文字保持文字图层，不要栅格化，也不要转成形状',
      );
    }
    checkBlend(layer, true, out);
    return;
  }
  if (layer.adjustment && !layer.clipping) {
    out.layer(
      layer,
      'adjustment-unclipped',
      'must',
      `调整图层「${layer.name}」没有剪贴到被调整的图层上`,
      '调整图层只在元素内部使用，并且剪贴到被调整的图层上；不要使用盖住整个界面的调整图层',
    );
  }
  checkBlend(layer, false, out);
  if (layer.hidden) {
    if (!scope.inState) {
      out.layer(
        layer,
        'hidden-layer',
        'should',
        `隐藏的图层「${layer.name}」不是状态图层`,
        '如果它是按下、禁用等状态的外观，改名为 @pressed、@disabled、@selected、@empty、@locked 并放在所属元素的图层组里；不交付的内容请删除，或放进名字以 # 开头的组',
      );
    }
    return;
  }
  if (scope.element === undefined && !scope.inBadGroup && !scope.inState) {
    out.layer(
      layer,
      'loose-layer',
      'must',
      `图层「${layer.name}」不在任何元素的图层组里，也没有前缀命名`,
      '放进带前缀的图层组（每个元素一个组，例如 btn_upgrade），或者给图层加上前缀名称',
    );
  }
}

function checkGroup(
  layer: PsdLayer,
  scope: Scope,
  prefixes: PrefixTable,
  out: Collector,
): Scope | undefined {
  if (isIgnored(layer)) {
    if (!layer.hidden && scope.visible) {
      out.layer(
        layer,
        'ignored-visible',
        'should',
        `名字以 # 开头的组「${layer.name}」保存时是可见的，里面的内容会进入合成图`,
        '不交付的内容请隐藏这个组，或者直接删除',
      );
    }
    return undefined;
  }
  if (stateNameOf(layer) !== undefined) {
    checkStateLayer(layer, scope, out);
    return { ...scope, inState: true, visible: scope.visible && !layer.hidden };
  }
  const entry = prefixes.match(layer.name);
  if (entry === undefined) {
    const bare = prefixes.entries.some((candidate) => candidate.prefix === layer.name);
    out.layer(
      layer,
      bare ? 'group-name-missing' : 'group-prefix',
      'must',
      bare ? `图层组「${layer.name}」只有前缀，没有名称` : `图层组「${layer.name}」没有前缀`,
      bare
        ? `在前缀后面加上名称，例如 ${layer.name}main`
        : '改名为 前缀_名称：按钮 btn_、槽 slot_、文字 txt_、角标 badge_、背景 bg_ 等（完整前缀表见交付规范）；只起分组作用的组用 grp_；不交付的内容放进名字以 # 开头的组',
    );
    return { ...scope, inBadGroup: true, visible: scope.visible && !layer.hidden };
  }
  checkName(layer, prefixes, out);
  if (entry.type === 'text' && !containsText(layer)) {
    out.layer(
      layer,
      'txt-no-text',
      'must',
      `图层组「${layer.name}」里没有文字图层`,
      'txt_ 用于会变的文字，里面必须是文字图层（不要栅格化）；不是文字的内容请换成别的前缀',
    );
  }
  checkBlend(layer, true, out);
  return {
    element: layer,
    inBadGroup: false,
    inState: false,
    visible: scope.visible && !layer.hidden,
  };
}

/** A signature of a group's inner structure that ignores names of plain layers. */
function signatureOf(layer: PsdLayer, prefixes: PrefixTable): string {
  if (layer.kind !== 'group') {
    const state = stateNameOf(layer);
    const entry = prefixes.match(layer.name);
    return `${layer.kind}${state === undefined ? '' : `@${state}`}${entry === undefined ? '' : `:${entry.prefix}`}`;
  }
  const inner = (layer.children ?? [])
    .filter((child) => !isIgnored(child))
    .map((child) => signatureOf(child, prefixes))
    .join(',');
  const entry = prefixes.match(layer.name);
  const state = stateNameOf(layer);
  return `group${state === undefined ? '' : `@${state}`}${entry === undefined ? '' : `:${entry.prefix}`}(${inner})`;
}

function checkNumbered(layers: readonly PsdLayer[], prefixes: PrefixTable, out: Collector): void {
  const families = new Map<string, PsdLayer[]>();
  for (const layer of layers) {
    if (layer.kind !== 'group' || isIgnored(layer)) continue;
    const numbered = numberedName(layer.name);
    if (numbered === undefined) continue;
    families.set(numbered.base, [...(families.get(numbered.base) ?? []), layer]);
  }
  for (const [base, members] of families) {
    if (members.length < 2) continue;
    const bySignature = new Map<string, PsdLayer[]>();
    for (const member of members) {
      const signature = signatureOf(member, prefixes);
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), member]);
    }
    if (bySignature.size === 1) continue;
    // The most common structure is taken as the intended one; the first group wins a tie.
    const [common] = [...bySignature.values()].sort((a, b) => b.length - a.length);
    for (const member of members) {
      if (common?.includes(member)) continue;
      out.layer(
        member,
        'numbered-structure',
        'must',
        `「${member.name}」和同名加序号的其他组（${base}_序号）内部结构不一致`,
        '同名加序号的组内部的图层结构要完全相同（例如 slot_equip_1 到 slot_equip_6）：按多数组的结构补齐或删掉多出来的图层',
      );
    }
  }
  for (const layer of layers) {
    if (layer.children && !isIgnored(layer)) checkNumbered(layer.children, prefixes, out);
  }
}

function walkStructure(
  layers: readonly PsdLayer[],
  scope: Scope,
  prefixes: PrefixTable,
  out: Collector,
): void {
  for (const layer of layers) {
    if (layer.kind !== 'group') {
      checkLeaf(layer, scope, prefixes, out);
      continue;
    }
    const inner = checkGroup(layer, scope, prefixes, out);
    if (inner !== undefined) walkStructure(layer.children ?? [], inner, prefixes, out);
  }
}

/**
 * Checks the file, structure and naming parts of the delivery spec (§6.8, appendix C) that need
 * no pixels. `design` is the project's design resolution; without it the canvas size is not checked.
 */
export function checkCompliance(
  doc: PsdDocument,
  prefixes: PrefixTable,
  design?: DesignSize,
): ComplianceResult {
  const out = new Collector();
  const unchecked = [UNCHECKED_GRANULARITY, UNCHECKED_FONTS];
  checkFile(doc, design, out, unchecked);
  walkStructure(doc.layers, { inBadGroup: false, inState: false, visible: true }, prefixes, out);
  checkNumbered(doc.layers, prefixes, out);
  return { issues: out.issues, unchecked };
}
