import {
  type AssetManifest,
  type AssetRecord,
  expectedHoles,
  type Ownership,
  parseRef,
  pixelOwnership,
  type ScreenDoc,
  type UINode,
} from '@ui-pro/core';
import { collectAmbiguities, type Evaluation, evaluate } from './evaluate';
import type { RuleInputs } from './inputs';
import { getPoint, valueProblem } from './points';
import type { Rule } from './schema';

export type CheckId =
  | 'complete'
  | 'unambiguous'
  | 'no-drift'
  | 'cluster-consistency'
  | 'exceptions-justified'
  | 'no-regression';

export interface CheckProblem {
  kind: string;
  message: string;
  screen?: string;
  node?: string;
  nodes?: string[];
  point?: string;
  rules?: string[];
}

export interface CheckItem {
  id: CheckId;
  /** The check's name as DESIGN §5.6 lists it. */
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  /** Why the check was skipped. */
  reason?: string;
  problems: CheckProblem[];
  /** Things worth knowing that do not fail the check. */
  warnings: string[];
}

export interface CheckReport {
  ok: boolean;
  items: CheckItem[];
}

const MAX_LISTED = 8;
const list = (items: readonly string[]) =>
  items.length > MAX_LISTED
    ? `${items.slice(0, MAX_LISTED).join('、')} 等 ${items.length} 个`
    : items.join('、');

/** 完备: every applicable point of every node has the decision the current rules give. */
function checkComplete(inputs: RuleInputs, evaluation: Evaluation): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const [screen, nodes] of evaluation.screens) {
    const doc = inputs.screens.get(screen)?.doc;
    for (const node of nodes.values()) {
      const stored = doc?.nodes[node.id]?.decisions ?? {};
      const ref = `${screen}/#${node.id}`;
      const missing: string[] = [];
      const stale: string[] = [];
      const undecided: string[] = [];
      for (const [point, outcome] of node.outcomes) {
        const current = stored[point];
        if (outcome.status === 'undecided') undecided.push(point);
        else if (outcome.status === 'ambiguous') {
          if (current) stale.push(`${point}（有歧义，不应有决定）`);
        } else if (!current) missing.push(point);
        else if (current.value !== outcome.decision?.value || current.by !== outcome.decision?.by) {
          stale.push(`${point}（现为 ${current.value}，应为 ${outcome.decision?.value}）`);
        }
      }
      const extra = Object.keys(stored).filter((point) => !node.outcomes.has(point));
      const dangling = Object.entries(stored)
        .filter(
          ([, decision]) => decision.by !== 'exception' && !evaluation.index.byRef.has(decision.by),
        )
        .map(([point, decision]) => `${point}（${decision.by}）`);
      const report = (kind: string, points: string[], message: string) => {
        if (points.length > 0) {
          problems.push({
            kind,
            message: `节点 ${ref} ${message}：${list(points)}`,
            screen,
            node: node.id,
          });
        }
      };
      report('missing', missing, `缺少 ${missing.length} 个决策点的决定`);
      report('stale', stale, '的决定与现行规则重算的结果不同（用 rule.recompute 刷新）');
      report('undecided', undecided, '在这些决策点上没有任何规则给出决定');
      report('extra', extra, '有不适用的决定');
      report('dangling', dangling, '的决定指向不存在的规则');
    }
  }
  return problems;
}

/** 无歧义: no two equally specific rules of one layer with different values apply to a node. */
function checkUnambiguous(evaluation: Evaluation): CheckProblem[] {
  return collectAmbiguities(evaluation).map((ambiguity) => ({
    kind: 'ambiguous',
    message: `界面 ${ambiguity.screen} 的决策点 ${ambiguity.point}：规则 ${ambiguity.rules.join('、')} 同样具体（各 ${ambiguity.specificity} 个条件）但取值不同；受影响：${list(ambiguity.nodes.map((id) => `#${id}`))}`,
    screen: ambiguity.screen,
    point: ambiguity.point,
    rules: ambiguity.rules,
    nodes: ambiguity.nodes,
  }));
}

/** 同形同判: nodes of one similarity cluster share type and role. */
function checkClusters(inputs: RuleInputs): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const [screen, { doc }] of inputs.screens) {
    const clusters = new Map<string, string[]>();
    for (const node of Object.values(doc.nodes)) {
      if (node.cluster === undefined) continue;
      clusters.set(node.cluster, [...(clusters.get(node.cluster) ?? []), node.id]);
    }
    for (const [cluster, ids] of clusters) {
      const kinds = new Set(ids.map((id) => `${doc.nodes[id]?.type}|${doc.nodes[id]?.role ?? ''}`));
      if (kinds.size <= 1) continue;
      const described = ids.map(
        (id) => `#${id}（${doc.nodes[id]?.type}，${doc.nodes[id]?.role ?? '无角色'}）`,
      );
      problems.push({
        kind: 'cluster',
        message: `界面 ${screen} 的相似簇 ${cluster} 里节点的基元类型或通用角色不一致：${described.join('、')}`,
        screen,
        nodes: ids,
      });
    }
  }
  return problems;
}

/** 例外有据: every exception and every disabled rule carries a reason and is still meaningful. */
function checkExceptions(inputs: RuleInputs): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const [screen, { doc, rules }] of inputs.screens) {
    for (const entry of rules.exceptions) {
      const base = { screen, node: entry.node, point: entry.point };
      const where = `界面 ${screen} 的节点 #${entry.node} 在 ${entry.point} 上的节点例外`;
      if (entry.because.trim() === '') {
        problems.push({ ...base, kind: 'no-reason', message: `${where}没有写理由` });
      }
      if (!(entry.node in doc.nodes)) {
        problems.push({ ...base, kind: 'dangling', message: `${where}指向不存在的节点` });
      }
      const problem = getPoint(entry.point)
        ? valueProblem(entry.point, entry.value)
        : `未知的决策点：${entry.point}`;
      if (problem !== undefined) {
        problems.push({ ...base, kind: 'invalid', message: `${where}不合法：${problem}` });
      }
    }
  }
  for (const entry of inputs.project.disabled) {
    if (entry.because.trim() === '') {
      problems.push({ kind: 'no-reason', message: `停用规则 ${entry.rule} 没有写理由` });
    }
  }
  return problems;
}

const NOT_BUILT = '还没有构建资产：运行 ui-pro build 完成资产构建后才能比对资产与决定是否相符';

const decidedValue = (node: UINode, point: string): string | undefined =>
  node.decisions[point]?.value;

/** The decision point whose value made `node` draw inside another asset or not at all. */
function bakedPoint(node: UINode): string {
  if (decidedValue(node, 'attach.split') === 'baked') return 'attach.split';
  if (decidedValue(node, 'decor.merge') === 'merge') return 'decor.merge';
  return 'content.split';
}

/** An approximation starts with the decision point it is about: `occlusion.fill：…`. */
function aboutPoint(approximation: string, point: string): boolean {
  return approximation.startsWith(point) && /^\s*[：:]/.test(approximation.slice(point.length));
}

const instanceKey = (node: UINode): string | undefined =>
  node.cluster !== undefined
    ? `cluster:${node.cluster}`
    : node.instanceOf !== undefined
      ? `component:${node.instanceOf}`
      : undefined;

const holeKeys = (holes: ReadonlyArray<{ node: string; handling: string }>): Set<string> =>
  new Set(holes.map((hole) => `${hole.node} ${hole.handling}`));

function describeHoles(keys: Iterable<string>): string {
  return [...keys].map((key) => key.replace(' ', '：')).join('、');
}

/**
 * 无漂移 for one screen: the built assets are what the decisions call for. A difference the build
 * recorded as an approximation of that decision point is a warning, anything else a problem.
 */
function driftOfScreen(
  screen: string,
  doc: ScreenDoc,
  manifest: AssetManifest,
  problems: CheckProblem[],
  warnings: string[],
): void {
  const ownership: ReadonlyMap<string, Ownership> = pixelOwnership(doc);
  const expected = expectedHoles(doc, ownership);
  const byName = new Map(manifest.assets.map((asset) => [asset.name, asset]));

  const report = (
    kind: string,
    message: string,
    where: { node?: string; nodes?: string[] },
    point: string | undefined,
    records: readonly AssetRecord[] = [],
  ) => {
    const recorded =
      point === undefined
        ? undefined
        : records
            .flatMap((record) => record.approximations)
            .find((entry) => aboutPoint(entry, point));
    if (recorded !== undefined) {
      warnings.push(`${message}（构建已记为近似项：${recorded}）`);
      return;
    }
    problems.push({
      kind,
      message,
      screen,
      ...where,
      ...(point === undefined ? {} : { point }),
    });
  };

  const instances = new Map<string, string[]>();
  for (const [id, owned] of ownership) {
    const node = doc.nodes[id];
    if (node === undefined || owned.kind !== 'asset') continue;
    const key = instanceKey(node);
    if (key !== undefined) instances.set(key, [...(instances.get(key) ?? []), id]);
  }

  for (const [id, owned] of ownership) {
    const node = doc.nodes[id];
    if (node === undefined) continue;
    const ref = `${screen}/#${id}`;

    if (owned.kind !== 'asset') {
      const used =
        node.asset !== undefined ||
        Object.values(node.states ?? {}).some((state) => state.asset !== undefined) ||
        manifest.assets.some((asset) => asset.uses.some((use) => use.node === id));
      if (!used) continue;
      const why =
        owned.kind === 'baked'
          ? `像素并入 #${owned.host} 的资产（${bakedPoint(node)}）`
          : owned.kind === 'text'
            ? '是动态文字，由引擎绘制'
            : '本身没有像素';
      report(
        'unexpected-asset',
        `节点 ${ref} ${why}，不该有自己的资产`,
        { node: id },
        owned.kind === 'baked' ? bakedPoint(node) : owned.kind === 'text' ? 'text.mode' : undefined,
        manifest.assets.filter((asset) => asset.uses.some((use) => use.node === id)),
      );
      continue;
    }

    if (node.asset === undefined) {
      report(
        'missing-asset',
        `节点 ${ref} 要画自己的资产，但没有绑定资产`,
        { node: id },
        undefined,
      );
      continue;
    }
    const record = byName.get(node.asset);
    if (record === undefined) {
      report(
        'missing-asset',
        `节点 ${ref} 绑定的资产 ${node.asset} 不在资产清单里`,
        { node: id },
        undefined,
      );
      continue;
    }

    const stretch = decidedValue(node, 'stretch.mode');
    if ((stretch === 'nine-slice' || stretch === 'three-slice') && record.nineSlice === undefined) {
      report(
        'nine-slice',
        `节点 ${ref} 的 stretch.mode 是 ${stretch}，但资产 ${record.name} 没有九宫格边距`,
        { node: id },
        'stretch.mode',
        [record],
      );
    }

    const defaultUses = record.uses.filter((use) => use.state === undefined);
    const mine = defaultUses.find((use) => use.node === id);
    const tinted = mine?.tint !== undefined || node.tint !== undefined;
    const key = instanceKey(node);
    const isInstance = key !== undefined && (instances.get(key)?.length ?? 0) > 1;
    const mode = decidedValue(node, 'variant.mode');
    if (isInstance && mode === 'tint') {
      const shared = defaultUses.some((use) => use.node !== id);
      if (!shared || !tinted) {
        report(
          'tint',
          `节点 ${ref} 的 variant.mode 是 tint，应与同簇的实例共用一张资产并带乘色，但${
            shared ? `共用的资产 ${record.name} 没有给它乘色` : `资产 ${record.name} 只有它自己在用`
          }`,
          { node: id },
          'variant.mode',
          [record],
        );
      }
    }
    if (isInstance && mode === 'variant-assets' && tinted) {
      report(
        'tint',
        `节点 ${ref} 的 variant.mode 是 variant-assets，各实例应有自己的资产，但它带着乘色`,
        { node: id },
        'variant.mode',
        [record],
      );
    }
  }

  for (const record of manifest.assets) {
    const owners = record.uses.filter((use) => use.state === undefined).map((use) => use.node);
    if (owners.length === 0) continue;
    if (record.origin === 'layer') {
      if (record.holes.length > 0) {
        report(
          'holes',
          `资产 ${record.name} 由图层渲染而成，不该有补全的洞，但记了 ${record.holes.length} 个：${describeHoles(holeKeys(record.holes))}`,
          { node: owners[0], nodes: owners },
          undefined,
        );
      }
      continue;
    }
    if (record.origin !== 'crop' && record.origin !== 'generated') continue;
    const wanted = holeKeys(owners.flatMap((owner) => expected.get(owner) ?? []));
    const actual = holeKeys(record.holes);
    const missing = [...wanted].filter((key) => !actual.has(key));
    const extra = [...actual].filter((key) => !wanted.has(key));
    if (missing.length === 0 && extra.length === 0) continue;
    const parts = [
      ...(missing.length > 0 ? [`缺少 ${describeHoles(missing)}`] : []),
      ...(extra.length > 0 ? [`多出 ${describeHoles(extra)}`] : []),
    ];
    report(
      'holes',
      `界面 ${screen} 的资产 ${record.name} 补全的洞与决定不符（节点：处理方式）：${parts.join('；')}`,
      { node: owners[0], nodes: owners },
      'occlusion.fill',
      [record],
    );
  }
}

/**
 * 无漂移: the built assets agree with the decisions. Skipped for screens that have not been built.
 */
function checkDrift(inputs: RuleInputs): CheckItem {
  const problems: CheckProblem[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const [screen, { doc, assets }] of inputs.screens) {
    if (assets === null || assets === undefined) continue;
    checked++;
    driftOfScreen(screen, doc, assets, problems, warnings);
  }
  if (checked === 0) {
    return {
      id: 'no-drift',
      name: '无漂移',
      status: 'skipped',
      reason: NOT_BUILT,
      problems: [],
      warnings: [],
    };
  }
  const unbuilt = [...inputs.screens]
    .filter(([, input]) => input.assets === null || input.assets === undefined)
    .map(([screen]) => screen);
  if (unbuilt.length > 0) {
    warnings.push(`界面 ${list(unbuilt)} 还没有构建资产，没有比对`);
  }
  return item('no-drift', '无漂移', problems, warnings);
}

/** 规则不回归: the examples of every rule still get the rule's value. */
function checkRegressions(evaluation: Evaluation): {
  problems: CheckProblem[];
  warnings: string[];
} {
  const problems: CheckProblem[] = [];
  const warnings: string[] = [];
  const replay = (rule: Rule, where: string) => {
    for (const example of rule.examples ?? []) {
      const { screen, id } = parseRef(example);
      const node = evaluation.screens.get(screen)?.get(id);
      const base = { screen, node: id, point: rule.point, rules: [where] };
      if (!node) {
        warnings.push(`规则 ${where} 的样例 ${example} 已不存在，无法重算`);
        continue;
      }
      const outcome = node.outcomes.get(rule.point);
      if (!outcome) {
        problems.push({
          ...base,
          kind: 'inapplicable',
          message: `规则 ${where} 的样例 ${example} 不适用于决策点 ${rule.point}`,
        });
      } else if (outcome.decision?.value !== rule.value) {
        const now = outcome.decision
          ? `${outcome.decision.value}（${outcome.decision.by}）`
          : '没有决定（有歧义）';
        problems.push({
          ...base,
          kind: 'regression',
          message: `规则 ${where} 的样例 ${example} 在 ${rule.point} 上现在是${now}，不再是当初的 ${rule.value}`,
        });
      }
    }
  };
  for (const entry of evaluation.index.byRef.values()) {
    if (!evaluation.index.disabled.has(entry.ref)) replay(entry.rule, entry.ref);
  }
  return { problems, warnings };
}

function item(
  id: CheckId,
  name: string,
  problems: CheckProblem[],
  warnings: string[] = [],
): CheckItem {
  return { id, name, status: problems.length === 0 ? 'pass' : 'fail', problems, warnings };
}

/** DESIGN §5.6: the six consistency checks over the rule documents and the screens. */
export function checkRules(inputs: RuleInputs): CheckReport {
  const evaluation = evaluate(inputs);
  const regressions = checkRegressions(evaluation);
  const items: CheckItem[] = [
    item('complete', '完备', checkComplete(inputs, evaluation)),
    item('unambiguous', '无歧义', checkUnambiguous(evaluation)),
    checkDrift(inputs),
    item('cluster-consistency', '同形同判', checkClusters(inputs)),
    item('exceptions-justified', '例外有据', checkExceptions(inputs)),
    item('no-regression', '规则不回归', regressions.problems, regressions.warnings),
  ];
  return { ok: items.every((entry) => entry.status !== 'fail'), items };
}
