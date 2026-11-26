import {
  glossaryCodec,
  isUiProError,
  listScreens,
  loadScreen,
  PROJECT_FILES,
  type Project,
  parseRef,
  readFileIfExistsSync,
  resolveInside,
  type ScreenDoc,
  SINGLETON_KEY,
  screenRelPath,
} from '@ui-pro/core';
import { whenKey } from './condition';
import { projectRulesKind, screenRulesKind } from './docs';
import { evaluate } from './evaluate';
import type { RuleInputs } from './inputs';
import { buildRuleIndex, defaultPack, entryOf, isFallback, type Layer } from './layers';
import { DECISION_POINTS, getPoint, POINT_NAMES, valueProblem } from './points';
import { isKnownRolePattern } from './roles';
import type { NodeException, ProjectRules, Rule, ScreenRules } from './schema';

export interface LintProblem {
  severity: 'error' | 'warning';
  /** Project-relative path of the file the problem is in. */
  file: string;
  rule?: string;
  message: string;
}

export const DEFAULT_PACK_FILE = 'packages/rules/pack/default.rules.yaml';

/** Words of game genres; the default rule pack must stay free of them. */
const GENRE_WORDS =
  /英雄|装备|背包|道具|技能|副本|关卡|抽卡|公会|战斗|商城|怪物|坐骑|宠物|\b(?:hero|equip(?:ment)?|inventory|skill|gacha|quest|guild|dungeon|monster)\b/i;

/** Pixel sizes, coordinates and positions; geometry belongs to measurements, not to rules. */
const COORDINATES = [
  /\d+\s*[x×]\s*\d+/i,
  /\b[xywh]\s*[=:]\s*-?\d+/i,
  /\d+\s*px\b/i,
  /\(\s*-?\d+\s*,\s*-?\d+\s*\)/,
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

export interface LintSetOptions {
  layer: Layer;
  file: string;
  /** The rules are in the pending area: say so in messages. */
  pending?: boolean;
}

/** Checks one list of rules of one layer; knows nothing about screens or the glossary. */
export function lintRuleSet(rules: readonly Rule[], options: LintSetOptions): LintProblem[] {
  const { layer, file } = options;
  const problems: LintProblem[] = [];
  const note = options.pending ? '待定区：' : '';
  const add = (severity: LintProblem['severity'], rule: string | undefined, message: string) =>
    problems.push({ severity, file, rule, message: `${note}${message}` });

  for (const rule of rules) {
    const point = getPoint(rule.point);
    if (!point) {
      add('error', rule.id, `引用了不存在的决策点 ${rule.point}；可用：${POINT_NAMES.join('、')}`);
    } else {
      const problem = valueProblem(rule.point, rule.value);
      if (problem !== undefined) add('error', rule.id, problem);
    }
    if (layer === 'default') lintGenerality(rule, add);
  }

  const seen = new Map<string, Rule>();
  for (const rule of rules) {
    const key = `${rule.point}|${whenKey(rule.when)}`;
    const other = seen.get(key);
    if (!other) {
      seen.set(key, rule);
    } else if (other.value !== rule.value) {
      add(
        'error',
        rule.id,
        `与规则 ${other.id} 条件完全相同而取值不同（${other.value} / ${rule.value}），命中的节点必然有歧义`,
      );
    } else {
      add('warning', rule.id, `与规则 ${other.id} 条件和取值都相同，重复`);
    }
  }

  if (layer === 'default') lintFallbacks(rules, add);
  return problems;
}

type AddProblem = (
  severity: LintProblem['severity'],
  rule: string | undefined,
  message: string,
) => void;

/** The generality constraint of DESIGN §5.4. */
function lintGenerality(rule: Rule, add: AddProblem): void {
  if (rule.when.concept !== undefined) {
    add('error', rule.id, '默认规则包不能用概念做条件；贴近业务的规则只能写在项目规则里');
  }
  for (const pattern of [rule.when.role, rule.when.parentRole].flat()) {
    if (pattern !== undefined && !isKnownRolePattern(pattern)) {
      add('error', rule.id, `角色 ${pattern} 不在通用角色表里；默认规则包只能用通用角色`);
    }
  }
  if ((rule.examples ?? []).length > 0) {
    add('error', rule.id, '默认规则包不能带样例：样例是具体项目里的节点');
  }
  const texts = [rule.id, rule.because, rule.value, ...strings(rule.when)];
  for (const text of texts) {
    if (GENRE_WORDS.test(text)) add('error', rule.id, `默认规则包里出现了品类词：${text}`);
    if (COORDINATES.some((pattern) => pattern.test(text))) {
      add('error', rule.id, `默认规则包里出现了坐标或像素尺寸：${text}`);
    }
  }
}

/** Every decision point of the default pack needs exactly one unconditional rule. */
function lintFallbacks(rules: readonly Rule[], add: AddProblem): void {
  for (const point of DECISION_POINTS) {
    const fallbacks = rules.filter(
      (rule) => rule.point === point.name && isFallback(entryOf(rule, 'default')),
    );
    if (fallbacks.length === 0) {
      add(
        'error',
        undefined,
        `决策点 ${point.name} 没有兜底规则（不带条件的规则），它就不再对每个节点都有决定`,
      );
    } else if (fallbacks.length > 1) {
      add(
        'error',
        fallbacks[1]?.id,
        `决策点 ${point.name} 有 ${fallbacks.length} 条兜底规则：${fallbacks.map((rule) => rule.id).join('、')}`,
      );
    }
  }
}

function lintExceptions(exceptions: readonly NodeException[], file: string): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const entry of exceptions) {
    const problem = getPoint(entry.point)
      ? valueProblem(entry.point, entry.value)
      : `引用了不存在的决策点 ${entry.point}`;
    if (problem !== undefined) {
      problems.push({
        severity: 'error',
        file,
        message: `节点 #${entry.node} 的节点例外：${problem}`,
      });
    }
  }
  return problems;
}

function lintDisabled(project: ProjectRules, file: string): LintProblem[] {
  const index = buildRuleIndex({ pack: defaultPack(), project, screens: new Map() });
  const problems: LintProblem[] = [];
  for (const { rule } of project.disabled) {
    const entry = index.byRef.get(rule);
    if (!entry || entry.layer === 'screen') {
      problems.push({ severity: 'error', file, message: `停用了不存在的规则 ${rule}` });
    } else if (isFallback(entry)) {
      problems.push({
        severity: 'error',
        file,
        rule,
        message: `${rule} 是决策点 ${entry.rule.point} 的兜底规则，不能停用`,
      });
    }
  }
  return problems;
}

function conceptProblems(
  rules: readonly Rule[],
  file: string,
  known: ReadonlySet<string> | undefined,
): LintProblem[] {
  if (known === undefined) return [];
  const problems: LintProblem[] = [];
  for (const rule of rules) {
    for (const concept of [rule.when.concept].flat()) {
      if (concept !== undefined && !known.has(concept)) {
        problems.push({
          severity: 'warning',
          file,
          rule: rule.id,
          message: `概念库里没有概念 ${concept}，这条规则不会命中任何节点`,
        });
      }
    }
  }
  return problems;
}

function exampleProblems(
  rules: readonly Rule[],
  file: string,
  docs: ReadonlyMap<string, ScreenDoc>,
): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const rule of rules) {
    for (const ref of rule.examples ?? []) {
      const { screen, id } = parseRef(ref);
      if (docs.has(screen) && !docs.get(screen)?.nodes[id]) {
        problems.push({
          severity: 'warning',
          file,
          rule: rule.id,
          message: `样例节点 ${ref} 已不存在`,
        });
      } else if (!docs.has(screen)) {
        problems.push({
          severity: 'warning',
          file,
          rule: rule.id,
          message: `样例 ${ref} 所在的界面不存在`,
        });
      }
    }
  }
  return problems;
}

function parseLeniently<T>(
  project: Project,
  path: string,
  parse: (text: string, label: string) => T,
  problems: LintProblem[],
): T | undefined {
  const bytes = readFileIfExistsSync(resolveInside(project.root, path));
  if (bytes === null) return undefined;
  try {
    return parse(bytes.toString('utf8'), path);
  } catch (error) {
    if (!isUiProError(error)) throw error;
    problems.push({ severity: 'error', file: path, message: error.message });
    return undefined;
  }
}

function loadDocs(project: Project): Map<string, ScreenDoc> {
  const docs = new Map<string, ScreenDoc>();
  for (const name of listScreens(project)) {
    try {
      docs.set(name, loadScreen(project, name));
    } catch (error) {
      if (!isUiProError(error)) throw error;
    }
  }
  return docs;
}

export interface LintReport {
  problems: LintProblem[];
  /** Files looked at, project-relative (the default pack by its package path). */
  files: string[];
}

/** Lints the default rule pack and every rules file of the project. */
export function lintProject(project: Project): LintReport {
  const problems: LintProblem[] = [];
  const files = [DEFAULT_PACK_FILE];
  problems.push(...lintRuleSet(defaultPack().rules, { layer: 'default', file: DEFAULT_PACK_FILE }));

  const docs = loadDocs(project);
  const glossary = parseLeniently(project, PROJECT_FILES.glossary, glossaryCodec.parse, problems);
  const concepts = glossary && new Set(glossary.concepts.map((concept) => concept.name));

  const projectPath = projectRulesKind.path(project, SINGLETON_KEY);
  const projectRules = parseLeniently(project, projectPath, projectRulesKind.parse, problems);
  files.push(projectPath);
  const screens = new Map<string, ScreenRules>();
  if (projectRules) {
    problems.push(
      ...lintRuleSet(projectRules.rules, { layer: 'project', file: projectPath }),
      ...lintRuleSet(projectRules.pending, { layer: 'project', file: projectPath, pending: true }),
      ...lintDisabled(projectRules, projectPath),
      ...conceptProblems([...projectRules.rules, ...projectRules.pending], projectPath, concepts),
      ...exampleProblems([...projectRules.rules, ...projectRules.pending], projectPath, docs),
    );
  }

  for (const name of listScreens(project)) {
    const path = screenRelPath(name, 'rules');
    const rules = parseLeniently(project, path, screenRulesKind.parse, problems);
    if (!rules) continue;
    files.push(path);
    screens.set(name, rules);
    problems.push(
      ...lintRuleSet(rules.rules, { layer: 'screen', file: path }),
      ...lintExceptions(rules.exceptions, path),
      ...conceptProblems(rules.rules, path, concepts),
      ...exampleProblems(rules.rules, path, docs),
    );
    for (const entry of rules.exceptions) {
      if (docs.has(name) && !docs.get(name)?.nodes[entry.node]) {
        problems.push({
          severity: 'error',
          file: path,
          message: `节点例外指向不存在的节点 #${entry.node}`,
        });
      }
    }
  }

  if (projectRules && screens.size === listScreens(project).length && docs.size === screens.size) {
    problems.push(...lintApplicability(projectRules, screens, docs));
  }
  return { problems, files };
}

/** Exceptions at a point that does not apply to their node never take effect. */
function lintApplicability(
  projectRules: ProjectRules,
  screens: ReadonlyMap<string, ScreenRules>,
  docs: ReadonlyMap<string, ScreenDoc>,
): LintProblem[] {
  const inputs: RuleInputs = {
    pack: defaultPack(),
    project: projectRules,
    screens: new Map(
      [...screens].flatMap(([name, rules]) => {
        const doc = docs.get(name);
        return doc ? [[name, { doc, rules }] as const] : [];
      }),
    ),
  };
  const evaluation = evaluate(inputs);
  const problems: LintProblem[] = [];
  for (const [name, rules] of screens) {
    for (const entry of rules.exceptions) {
      const node = evaluation.screens.get(name)?.get(entry.node);
      if (node && getPoint(entry.point) && !node.outcomes.has(entry.point)) {
        problems.push({
          severity: 'warning',
          file: screenRelPath(name, 'rules'),
          message: `节点 #${entry.node} 的节点例外在 ${entry.point} 上不会生效：这个决策点不适用于它（${getPoint(entry.point)?.scope}）`,
        });
      }
    }
  }
  return problems;
}
