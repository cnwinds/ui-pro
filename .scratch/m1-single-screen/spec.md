# M1 单界面闭环：第 2 批

Status: resolved

## 目标

第 1 批交付了内核：界面规格（UIR）、选择器、类型化操作、事务与历史、CLI 框架。第 2 批在它上面并行做四件事，做完后一张拍平图或一份合规 PSD 能走通“分析 → 看图 → 规则裁决 → 导出到 Godot”：

| 工单 | 内容 | 主要包 |
|---|---|---|
| [01](issues/01-rules-engine.md) | 规则引擎、默认规则包、`rules` 命令、规则类操作 | `packages/rules` |
| [02](issues/02-flat-analyze-and-look.md) | 拍平图分析（预检、候选、文字识别、相似簇、草稿）与 `look` 看图 | `packages/perception` |
| [03](issues/03-psd-analyze-lint-render.md) | PSD 分析：解析、Photopea 逐图层渲染、核对与输入等级、草稿、`psd lint` | `packages/psd` |
| [04](issues/04-godot-export.md) | 导出到 Godot 4.6：引擎内构建器、基元映射、可重复导出、截图 | `packages/adapter-godot` |

资产构建（抠图、补全、九宫）、质量门禁、端到端联调和 Agent 技能说明在第 3 批。

## 必读

- `CONTEXT.md`：术语表。用户可见的文字（错误信息、摘要、提示）一律用其中的中文术语，避开每个词条的 _Avoid_ 列表。例如说“源文件”不说“原图”，说“项目”不说“工程”（“Godot 工程”除外），说“导出报告”不说“交付报告”。
- `docs/DESIGN-v2.md`：方案。各工单注明了相关章节。
- `docs/adr/0001-kernel-has-no-llm.md`：内核不调用大模型。感知模型（OCR、检测）可以调用，输出随项目保存。
- 第 1 批的代码风格：`packages/core/src`、`packages/cli/src/commands/apply.ts`、`packages/cli/test/helpers.ts`。新代码照着写：命名、注释密度、错误处理方式保持一致。

## 第 2 批开工前已经准备好的共享接口

这些由父 agent 写好，四个工单直接使用，**不要修改**：

- `applyOps(project, ops, { evidence: { [screen]: { candidates, files } } })`：证据与基于它的草稿操作在同一个历史版本里提交，用户一次 `history undo` 就能撤销整次分析。操作执行时已经能读到新证据。`files` 是证据目录下的随附文件（mask、图层渲染、合成图），路径相对 `screens/<界面>/evidence/`。旧的证据文件不在新集合里会被删除。见 `packages/core/test/evidence.test.ts`。
- `node.add` 带 `from` 时，节点自动继承这些候选共有的相似簇（`cluster`）。
- `referenceImagePath(screen)`：界面基准图的项目相对路径。拍平图是源文件本身；PSD 是分析时写出的 `evidence/composite.png`（常量 `COMPOSITE_EVIDENCE`）。看图、核对、导出都只认这个函数。
- `AnalysisReport`、`AnalyzeOptions`（`@ui-pro/core`）：两种分析的统一返回值。
- `analyzeFlatScreen`（`@ui-pro/perception`）与 `analyzePsdScreen`（`@ui-pro/psd`）：目前是抛 `E_NOT_IMPLEMENTED` 的占位，签名已定。
- `packages/cli/src/plugins.ts` 的 `registerPlugins()`：其他包向内核注册操作、钩子的唯一入口，在构建 CLI 程序时调用。
- `packages/perception/src/opencv.ts` 的 `loadOpenCv()`：opencv.js 运行时与 OCR 库共用一个实例。

## 并行规则

四个 agent 在同一个工作区里同时工作，靠文件归属避免冲突。

- **只改自己工单列出的文件**。每个工单有一节“归属”。需要动别人的文件或 `packages/core` 时，不要改：在自己工单末尾的 `## Comments` 写清楚需要什么、为什么，然后用不改它的办法继续。
- **不加依赖，不跑 `pnpm install`**。需要的依赖已经装好。确实缺什么，写进 Comments。
- **不跑全仓库的写操作**：不要 `biome check --write .`，不要 `pnpm install`，不要 `git commit`、`git stash`、`git checkout`。格式化只对自己的文件：`pnpm exec biome check --write <你的路径>`。
- **测试只跑自己的**：`pnpm vitest run packages/<包>`，以及 `pnpm vitest run packages/cli/test/<你的文件>`。类型检查用 `pnpm -s typecheck`，别的包里的类型错误不归你管，但你的文件不能有。
- **错误码**：在自己的包里定义字符串常量，例如 `E_PSD_GRADE`，不要改 `packages/core/src/errors.ts`。
- **CLI 命令**：一个命令一个文件，实现 `CommandModule`，替换掉原来的 `stubCommand`。不需要改 `commands/index.ts`。CLI 测试写在自己的新文件里（例如 `packages/cli/test/rules.test.ts`），复用 `packages/cli/test/helpers.ts`，不要改它。

## 环境事实（已在本机验证）

- **OCR**：`@gutenye/ocr-node`（PaddleOCR 模型，onnxruntime）。加载约 0.5 秒，识别 438×652 的示例图约 0.4 秒。返回 `{ texts: [{ text, mean, box }], resizedImageWidth, resizedImageHeight }`。`box` 是四点多边形，坐标在 `resizedImage` 空间，要按 `源尺寸 / resized 尺寸` 换算回源文件像素。README 里写的 `score`/`frame` 字段不存在。实测记录在 `ref/ocr/`。
- **opencv.js**：只能用 `loadOpenCv()` 取。运行时对象是 Emscripten thenable，直接 `await` 它或从 async 函数返回它会永远挂起。用完的 `Mat` 必须 `delete()`。
- **sharp**：全仓库统一 0.35.5（`pnpm-workspace.yaml` 里有 override）。Windows 上两个版本的 sharp 不能在同一进程共存。
- **Photopea**：用 `playwright-core` 驱动本机 Edge（`channel: 'msedge'`）。宿主页必须用本地 HTTP 服务提供，里面嵌 Photopea 的 iframe；启动参数和消息协议见 `ref/photopea/probe.mjs`，各夹具的核对结果见 `ref/photopea/results.txt`。Photopea 脚本只能写 ES3（`for` 循环，没有 `Array.prototype.map`）。
- **Godot**：4.6.1 控制台版在 `D:\tools\godot_461\Godot_v4.6.1-stable_win64_console.exe`。无界面构建、导入、带窗口截图都已跑通，脚本见 `ref/godot/`。
- **示例**：拍平图 `benchmark/samples/candy-knight/ui.png`（438×652）；PSD 夹具 `benchmark/psd-fixtures/ag-psd/<名字>/{src.psd,canvas.png}`，其中 `canvas.png` 是 Photoshop 渲染的合成图。这些夹具不符合交付规范（没有命名前缀、画布尺寸任意），合规的测试 PSD 需要用 `ag-psd` 的 `writePsdBuffer` 在测试里生成。

## 完成的标准

- 工单里的验收条目全部满足，并在工单末尾 `## Comments` 写一段交付说明：做了什么、没做什么及原因、实测数据、需要父 agent 决定的事。
- 自己的测试全部通过；`pnpm -s typecheck` 在自己的文件里没有错误；`pnpm exec biome check <你的路径>` 通过。
- 把工单的 `Status:` 改为 `ready-for-human`，表示等待审核。
