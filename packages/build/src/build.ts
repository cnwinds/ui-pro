import {
  type AskQuestion,
  type AssetManifest,
  applyOps,
  ErrorCodes,
  loadScreen,
  type Project,
  projectSelectorEnv,
  type Registry,
  readAssetManifest,
  readCandidates,
  readFileIfExistsSync,
  readLock,
  referenceImagePath,
  resolveInside,
  resolveSelector,
  scratchPath,
  toPosix,
  UiProError,
  writeFileAtomic,
} from '@ui-pro/core';
import {
  type ArtStyle,
  type CloudImageModel,
  createCloudImageModel,
  createModelStore,
  createPixelOps,
  PerceptionErrorCodes,
  type PixelContext,
  type PixelOps,
} from '@ui-pro/perception';
import { checkRules, readRuleInputs } from '@ui-pro/rules';
import { assembleAssets } from './assemble';
import { bindingOps } from './bindings';
import { TOOL_VERSION } from './constants';
import { dedupeAssets } from './dedupe';
import { BuildErrorCodes } from './errors';
import { buildFlatAsset, type Element, extractElement, type FlatContext } from './flat';
import { buildInputsSha256, inputsHash } from './hash';
import type { BuiltAsset, TextMeasurement } from './model';
import { type PlannedAsset, planAssets } from './plan';
import { buildLayerAsset, type DrawnState } from './psd';
import { decodePng } from './raster';
import { PixelRunner } from './runner';
import { renderSheet } from './sheet';
import { FileEgressLog, LockedStore } from './store';
import type { BuildApproximation, BuildOptions, BuildReport } from './types';

/** What a build can be given in place of the real services; tests pass fakes. */
export interface BuildDeps {
  createPixelOps?: (context: PixelContext) => PixelOps;
  createModelStore?: typeof createModelStore;
  createCloudImageModel?: typeof createCloudImageModel;
  /** Where `DASHSCOPE_API_KEY` is read from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** ISO 8601 stamp for new locked outputs. */
  now?: () => string;
  registry?: Registry;
}

/** The precheck stores no style profile yet, so every build uses smooth scaling. */
const STYLE: ArtStyle = 'smooth';

const MAX_LISTED_PROBLEMS = 5;
const CHECKS_FOR_BUILD = new Set(['complete', 'unambiguous']);

function assertReady(project: Project, screen: string) {
  const doc = loadScreen(project, screen);
  const evidence = readCandidates(project, screen);
  if (evidence === null) {
    throw new UiProError(
      BuildErrorCodes.notAnalyzed,
      `界面 ${screen} 还没有分析证据，不能构建资产`,
      {
        hint: '先运行 ui-pro analyze，再运行 ui-pro build',
      },
    );
  }

  const report = checkRules(readRuleInputs(project));
  const problems = report.items
    .filter((item) => CHECKS_FOR_BUILD.has(item.id))
    .flatMap((item) => item.problems.map((problem) => ({ check: item.name, ...problem })))
    .filter((problem) => problem.screen === screen);
  if (problems.length > 0) {
    const shown = problems
      .slice(0, MAX_LISTED_PROBLEMS)
      .map((problem) => problem.message)
      .join('；');
    const more =
      problems.length > MAX_LISTED_PROBLEMS
        ? `；还有 ${problems.length - MAX_LISTED_PROBLEMS} 处`
        : '';
    throw new UiProError(
      BuildErrorCodes.decisions,
      `界面 ${screen} 的决定还不能用来构建（${problems.length} 处问题）：${shown}${more}`,
      {
        hint: '用 ui-pro rules why <节点> 看是哪个决策点出了问题；改过规则之后提交 { "op": "rule.recompute" } 刷新决定，再重新构建',
        details: {
          screen,
          problems: problems.map(({ check, kind, message, node, nodes, point }) => ({
            check,
            kind,
            message,
            node,
            nodes,
            point,
          })),
        },
      },
    );
  }
  return { doc, evidence };
}

function regenerateNodes(project: Project, screen: string, selector: string): Set<string> {
  const refs = resolveSelector(selector, projectSelectorEnv(project, screen)).filter(
    (ref) => ref.screen === screen,
  );
  if (refs.length === 0) {
    throw new UiProError(
      ErrorCodes.selectorEmpty,
      `--regenerate ${selector} 没有选中界面 ${screen} 的节点`,
      {
        hint: '选择器要选中本界面的节点，例如 #n12 或 role=button',
      },
    );
  }
  return new Set(refs.map((ref) => ref.id));
}

interface CloudChoice {
  /** Null when the build may not or cannot use a cloud image model. */
  usable: CloudImageModel | null;
  why: string;
}

function chooseCloud(project: Project, deps: BuildDeps, env: NodeJS.ProcessEnv): CloudChoice {
  const { egress, image_model: config } = project.config;
  if (egress === 'local') return { usable: null, why: '项目的外发级别是 local，不使用云端服务' };
  const model = (deps.createCloudImageModel ?? createCloudImageModel)(config, env);
  return model === null
    ? {
        usable: null,
        why: '没有可用的云端图像模型（provider 是 none，或没有设置 DASHSCOPE_API_KEY）',
      }
    : { usable: model, why: '' };
}

function approximationsOf(
  built: readonly BuiltAsset[],
  notes: ReadonlyArray<BuildApproximation>,
): BuildApproximation[] {
  const seen = new Set<string>();
  const out: BuildApproximation[] = [];
  const add = (node: string, message: string) => {
    const key = `${node}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, message });
  };
  for (const asset of built) for (const message of asset.approximations) add(asset.node, message);
  for (const note of notes) add(note.node, note.message);
  return out;
}

/**
 * DESIGN §6.5: builds the screen's assets from its decisions and commits them, with the node
 * bindings and the lock, as one undoable version (a build that changes nothing writes none).
 *
 * Nothing is written until the whole build has succeeded, so a failed build leaves the project as
 * it was; cloud calls it already made stay in the egress log, which only grows.
 */
export async function buildScreen(
  project: Project,
  screen: string,
  options: BuildOptions = {},
  deps: BuildDeps = {},
): Promise<BuildReport> {
  const progress = options.onProgress;
  const env = deps.env ?? process.env;
  const warnings: string[] = [];

  if (options.locked && options.regenerate !== undefined) {
    throw new UiProError(ErrorCodes.usage, '--locked 与 --regenerate 不能一起用', {
      hint: '--locked 不产生新的模型输出，--regenerate 要重新产生；分两次运行',
    });
  }
  const { doc, evidence } = assertReady(project, screen);

  const cloudChoice = chooseCloud(project, deps, env);
  const quality = options.quality ?? (cloudChoice.usable === null ? 'draft' : 'final');
  if (quality === 'final' && cloudChoice.usable === null) {
    throw new UiProError(
      BuildErrorCodes.noCloud,
      `--final 要用云端图像模型，但${cloudChoice.why}`,
      {
        hint: '设置 DASHSCOPE_API_KEY 并把外发级别设为 cloud 后再试；或用 --draft 只做本地初稿',
      },
    );
  }
  if (quality === 'draft' && cloudChoice.usable === null) {
    warnings.push('没有云端图像模型，设置 DASHSCOPE_API_KEY 后运行 ui-pro build --final 换成终稿');
  }
  // A dry run reports what would happen without sending anything anywhere.
  const cloud = options.dryRun || quality === 'draft' ? null : cloudChoice.usable;
  if (options.dryRun && quality === 'final') {
    warnings.push('预演不调用云端图像模型，补全和放大只用本地方法；实际终稿的像素会不同');
  }

  const referenceFile = referenceImagePath(doc);
  const referenceBytes = readFileIfExistsSync(resolveInside(project.root, referenceFile));
  if (referenceBytes === null) {
    throw new UiProError(
      PerceptionErrorCodes.referenceMissing,
      `界面 ${screen} 的基准图 ${referenceFile} 不存在`,
      {
        hint: '重新运行 ui-pro analyze 生成基准图',
      },
    );
  }

  const baseLock = readLock(project, TOOL_VERSION);
  const previous = readAssetManifest(project, screen);
  const regenerate =
    options.regenerate === undefined
      ? undefined
      : regenerateNodes(project, screen, options.regenerate);

  let runner: PixelRunner | undefined;
  const store = new LockedStore(project, screen, baseLock, {
    allowNew: !options.locked,
    bypass: () => runner?.bypassing() ?? false,
    now: deps.now,
  });
  const log = new FileEgressLog(project);
  const models = (deps.createModelStore ?? createModelStore)({ onProgress: progress, env });
  const budget = project.config.budget.image_calls_per_screen;
  const makeOps = (useCloud: boolean): PixelOps =>
    (deps.createPixelOps ?? createPixelOps)({
      store,
      cloud: useCloud ? cloud : null,
      egress: project.config.egress,
      log,
      budget,
      models,
      onProgress: progress,
    });
  const active = new PixelRunner({
    screen,
    makeOps,
    cloud: cloud !== null,
    style: STYLE,
    regenerate,
    onProgress: progress,
  });
  runner = active;

  const plan = planAssets(doc, { previous });
  const planByNode = new Map<string, PlannedAsset>(plan.assets.map((asset) => [asset.node, asset]));
  progress?.(`规划了 ${plan.assets.length} 个资产`);

  const built = new Map<string, BuiltAsset>();
  const drawn: DrawnState[] = [];
  const measurements: TextMeasurement[] = [];
  const flatPlans: PlannedAsset[] = [];
  if (doc.source.kind === 'psd') {
    for (const asset of plan.assets) {
      const layers = await buildLayerAsset(
        { project, screen, doc, evidence, runner: active, style: STYLE, warnings },
        asset,
      );
      if (layers === undefined) {
        flatPlans.push(asset);
      } else {
        built.set(asset.node, layers.asset);
        drawn.push(...layers.states);
      }
    }
  } else {
    flatPlans.push(...plan.assets);
  }

  if (flatPlans.length > 0) {
    const context: FlatContext = {
      project,
      screen,
      doc,
      reference: await decodePng(referenceBytes),
      runner: active,
      style: STYLE,
      evidence,
      measurements,
    };
    const elements = new Map<string, Element>();
    for (const asset of flatPlans) elements.set(asset.node, await extractElement(context, asset));
    for (const asset of flatPlans) {
      const element = elements.get(asset.node);
      if (element !== undefined)
        built.set(asset.node, await buildFlatAsset(context, element, elements));
    }
  }

  const ordered = plan.assets.flatMap((asset) => {
    const entry = built.get(asset.node);
    return entry === undefined ? [] : [entry];
  });
  const deduped = await dedupeAssets(ordered, screen);
  const assembled = await assembleAssets({ finals: deduped.assets, drawn, planByNode });
  warnings.push(...assembled.warnings);

  const manifest: AssetManifest = {
    format: 'ui-pro/assets',
    version: 1,
    screen,
    sourceSha256: doc.source.sha256,
    inputsSha256: inputsHash(project, doc, evidence),
    assets: assembled.records,
  };
  const binding = bindingOps({
    doc,
    bindings: assembled.bindings,
    stale: plan.stale,
    previous,
    measurements,
  });
  warnings.push(...binding.warnings);

  const result = await applyOps(project, binding.ops, {
    screen,
    dryRun: options.dryRun,
    message: `构建资产：${screen}`,
    registry: deps.registry,
    assets: {
      [screen]: { manifest, files: assembled.files, generated: store.generatedFiles() },
    },
    lock: store.lock(baseLock, TOOL_VERSION),
  });

  const views: string[] = [];
  if (!options.dryRun) {
    const sheet = scratchPath(project.root, 'build', screen, 'sheet.png');
    await writeFileAtomic(sheet, await renderSheet(assembled.sheet));
    views.push(toPosix(sheet));
    if (buildInputsSha256(project, screen) !== manifest.inputsSha256) {
      warnings.push(
        '构建写入后，输入哈希与清单记录的不一致，资产会被判为过期；请再运行一次 ui-pro build',
      );
    }
  }

  const ask: AskQuestion[] = [...result.ask];
  if (active.budgetExhausted) {
    const message = `界面 ${screen} 的云端图像调用已用完 ${budget} 次的上限，剩下的步骤改用了本地方法`;
    warnings.push(message);
    ask.push({
      id: 'build.image-budget',
      question: `${message}，质量可能差一些。要提高 budget.image_calls_per_screen 后重新构建吗？`,
      options: ['提高上限', '保持现状'],
      default: '保持现状',
    });
  }

  return {
    screen,
    ...(result.version === undefined ? {} : { version: result.version }),
    assets: assembled.records.length,
    reused: store.stats.reused,
    generated: { local: store.stats.local, cloud: store.stats.cloud },
    approximations: approximationsOf(ordered, [...deduped.notes, ...assembled.notes]),
    warnings: [...new Set([...active.warnings, ...warnings, ...result.warnings])],
    ask,
    views,
  };
}
