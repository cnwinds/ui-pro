import type { Primitive } from '@ui-pro/core';
import type { Approximation, GodotClass, MissingAsset } from './plan';

/** What `builder.gd` wrote about a run. */
export interface BuilderResult {
  ok: boolean;
  created: string[];
  updated: { id: string; keys: string[] }[];
  removed: string[];
  conflicts: { id: string; key: string; design: unknown; scene: unknown; reason: string }[];
  errors: { code: string; message: string }[];
}

export interface ReportConflict {
  id: string;
  /** The property that disagrees, or `removal`, `class`, `parent`, `id`, `name`. */
  key: string;
  code: string;
  /** What happened and what the export did about it, in Simplified Chinese. */
  message: string;
  design: unknown;
  scene: unknown;
}

export interface ReportAsset {
  /** The asset's name in the manifest. */
  name: string;
  /** Path relative to the Godot project; one file however many nodes use it. */
  file: string;
  origin: string;
  /** Nodes that draw it. */
  nodes: string[];
  /** The manifest lists approximations for it. */
  approximate: boolean;
}

/** `export/<screen>.godot.json`: what one export wrote and where it fell short. */
export interface ExportReport {
  format: 'ui-pro/export-report';
  version: 1;
  engine: 'godot';
  screen: string;
  godotVersion: string;
  /** Scene path relative to the Godot project. */
  scene: string;
  /** Everything the export wrote, relative to the Godot project. */
  files: string[];
  nodes: { id: string; name: string; type: Primitive; godot: GodotClass; art?: string }[];
  /** Nodes exported as a bare `Control` because their primitive is not mapped yet. */
  placeholders: { id: string; type: Primitive }[];
  /** Nodes that should draw an asset but have none; they are empty in the scene. */
  missingAssets: MissingAsset[];
  assets: ReportAsset[];
  /** The manifest's approximations and the export's own, with the nodes concerned. */
  approximations: Approximation[];
  created: string[];
  updated: { id: string; keys: string[] }[];
  removed: string[];
  conflicts: ReportConflict[];
}

const CONFLICT_MESSAGES: Record<string, string> = {
  both_changed: 'Godot 场景和界面规格都改了这个属性，保留了场景里的值',
  shared_resource: '这个属性在共享资源里，导出不改共享资源，保留了场景里的值',
  name_taken: '节点名已被占用，Godot 自动改了名',
  class_kept: '节点的 Godot 类型需要变化，但它是场景根或挂了脚本，保留了原类型',
  moved_in_both: '节点在场景和界面规格里都被移到了别处，保留了场景里的位置',
  duplicate_id: '场景里有多个节点带同一个 ui_pro_id，只处理了第一个',
  removal_has_script: '界面规格已删除这个节点，但它挂了脚本，没有移除',
  removal_has_user_nodes: '界面规格已删除这个节点，但它下面有场景里自己加的节点，没有移除',
  removal_holds_nodes: '界面规格已删除这个节点，但它下面还有在用的节点，没有移除',
};

const BUILD_ERROR_MESSAGES: Record<string, string> = {
  scene_foreign: '场景文件已存在，但不是 ui-pro 导出的（根节点没有对应的 ui_pro_id）',
  scene_unloadable: '已有的场景文件加载失败',
  save_failed: '场景保存失败',
  texture_missing: '资产没有被 Godot 导入，找不到贴图',
  font_missing: '字体文件没有被 Godot 导入，找不到字体',
  class_unknown: '界面规格里有构建器不认识的 Godot 类型',
};

export function conflictMessage(code: string): string {
  return CONFLICT_MESSAGES[code] ?? `冲突（${code}）`;
}

export function buildErrorMessage(error: { code: string; message: string }): string {
  return `${BUILD_ERROR_MESSAGES[error.code] ?? '构建器报错'}：${error.message}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Parses the builder's result file; `undefined` when it is missing or not shaped as expected. */
export function parseBuilderResult(text: string): BuilderResult | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<Record<keyof BuilderResult, unknown>>;
  if (
    typeof value.ok !== 'boolean' ||
    !isStringArray(value.created) ||
    !isStringArray(value.removed) ||
    !Array.isArray(value.updated) ||
    !Array.isArray(value.conflicts) ||
    !Array.isArray(value.errors)
  ) {
    return undefined;
  }
  return value as BuilderResult;
}
