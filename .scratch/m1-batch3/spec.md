# M1 单界面闭环：第 3 批

Status: ready-for-agent

## 目标

第 2 批之后，一张拍平图或一份合规 PSD 能走到“分析 → 看图 → 规则裁决 → 导出”，但导出用的是从基准图按框裁出的近似图，也没有门禁。第 3 批补上资产构建和质量门禁，做完后达到 M1 的三条退出标准（`docs/DESIGN-v2.md` §16）：

1. 示例界面（糖果骑士角色页）从给图到通过全部非引擎门禁；
2. “红点”纠正流程完整跑通（§14.4）；
3. 同一界面的合规 PSD 不经过抠图和补全，通过同样的门禁。

| 工单 | 内容 | 主要包 | 波次 |
|---|---|---|---|
| [05](issues/05-perception-gaps.md) | 感知补漏：假簇收紧、红点进草稿、截图杂质检出并默认排除、`snap`、看图标签不依赖系统字体 | `packages/perception` | 第二波 |
| [06](issues/06-asset-build.md) | 资产构建：资产规划、拍平图与 PSD 两条路径、九宫、去重与着色、状态补齐、命名、资产清单与锁文件、`asset.assign`、无漂移检查、`build` 命令 | `packages/build` | 第一波 |
| [07](issues/07-pixel-ops.md) | 像素能力：抠取、补全、文字剥离、提升分辨率；本地模型下载与 ONNX 推理；DashScope 图像模型与云端八条约束 | `packages/perception/src/pixel` | 第一波 |
| [08](issues/08-renderer-and-gates.md) | 参考渲染器与质量门禁：布局、绘制清单、Canvas 执行、九道非引擎门禁、门禁记录、`verify` 命令 | `packages/renderer`、`packages/verify` | 第一波 |
| [09](issues/09-delivery.md) | 交付：导出用构建出的资产、导出前检查门禁、引擎一致门禁、`doctor`、技能说明与 `skill` 命令 | `packages/adapter-godot`、`skill/` | 第一波 |

端到端联调（糖果骑士从给图到通过门禁、红点纠正流程、合规 PSD）由父 agent 在各工单审核之后做。

## 必读

- `CONTEXT.md`：术语表。用户可见的文字一律用其中的中文术语，避开 _Avoid_ 列表。第 3 批新增的词条：拆簇、初稿 / 终稿、锁文件、资产清单、外发记录、近似项、参考渲染器、绘制清单。说“资产”不说“资源”“切图”；说“近似项”不说“降级项”（降级项只指 PSD 输入低于 A 级的处理）。
- `docs/DESIGN-v2.md`：§4.3 节点、§5.2 决策点、§5.6 一致性校验、§6.5 资产构建、§6.6 云端图像模型的八条约束、§6.7 先粗后精、§6.8 PSD、§9 导出、§13 质量体系、§14 示例走查。
- `docs/adr/0001-kernel-has-no-llm.md`、`0002-reference-renderer-canvas2d.md`、`0003-image-models-dashscope-and-onnx.md`。
- 第 2 批 `../m1-single-screen/spec.md` 的“环境事实”，以及各工单末尾的审核意见。
- 代码风格照着 `packages/core/src`、`packages/rules/src`、`packages/adapter-godot/src` 写：命名、注释密度、错误处理方式保持一致。

## 第 3 批开工前已经准备好的共享接口

这些由父 agent 写好，各工单直接使用。`types.ts` 文件和已有函数的签名**不要修改**（可以加可选参数）；占位函数的函数体就是各工单要实现的东西。确实需要改接口，写进自己工单的 Comments。

**core**（`packages/core`）

- 资产清单与锁文件的结构：`src/schema/assets.ts`（`AssetManifest`、`AssetRecord`、`AssetHole`、`AssetStep`、`LockDoc`、`GeneratedEntry`、`ASSET_NAME_PATTERN`、`BUILD_STEPS`、`ASSET_ORIGINS`）。字段含义见注释。
- `applyOps(project, ops, { assets: { [界面]: { manifest, files, generated } }, lock })`：构建的资产文件、资产清单、锁文件和绑定它们的操作在同一个历史版本里提交，一次 `history undo` 撤销整次构建。操作执行时通过 `ctx.assets(screen)` 读到新清单。`files` 是 `assets/` 下除 `gen/` 外的全部文件，提交时整体替换；`generated` 是新的模型输出，只能放在 `gen/` 下，只增不删；锁文件里每条记录指向的文件必须存在。见 `packages/core/test/assets.test.ts`。
- 读取：`readAssetManifest`、`readAssetFile`、`readLock`、`assetRelPath`；路径常量 `GENERATED_DIR`、`PROJECT_FILES.lock`（`ui-pro.lock`）、`PROJECT_FILES.egress`（`history/egress.jsonl`）。
- 节点新字段：`tint`（乘色）、`clusterSplit`（拆簇理由）；`asset`、`nineSlice` 注明由构建写入。界面规格新字段 `exclusions`（排除区）。项目配置新字段 `image_model { provider, endpoint }`、`fonts`（字体名 → 项目内的字体文件）。
- 新操作：`cluster.split`（拆簇，理由必填）、`exclusion.add` / `exclusion.remove`（排除区，理由必填）。操作家族多了 `build`。
- **像素归属**：`pixelOwnership(doc)`、`expectedHoles(doc)`、`intersectRect`（`src/screen/ownership.ts`）。构建、无漂移检查和参考渲染器都用它判断每个节点画什么，不要各写一份。见下一节。

**perception**（`packages/perception`）

- `src/pixel/types.ts`：`PixelOps`（抠取、补全、文字剥离、提升分辨率）、`GenerationStore`（锁定的模型输出）、`CloudImageModel`（云端图像模型）、`EgressLog`（外发记录）、`ModelStore`（本地模型）、`PixelContext`。
- `src/models/catalog.ts`：三个本地模型的下载地址、哈希、大小、许可证、输入输出说明。
- 占位：`createPixelOps`、`createModelStore`、`createCloudImageModel`；错误码 `E_MODEL_UNAVAILABLE`、`E_IMAGE_BUDGET`、`E_CLOUD_IMAGE`、`E_NOT_LOCKED`。

**renderer**（`packages/renderer`，新包）：`src/types.ts`（`DrawList`、`DrawOp`、`RenderOptions`、`RenderSession`、`Viewport`）；占位 `layoutScreen`、`buildDrawList`、`openRenderSession`。

**verify**（`packages/verify`）：`src/types.ts`（`GATE_IDS`、`GATE_NAMES`、`GateResult`、`VerifyReport`、`VerifyOptions`、`VerifyStamp`）；占位 `verifyScreen`、`verifyInputsSha256`、`readVerifyStamp`、`assertVerified`；`src/gates/engine.ts` 的 `runEngineGate` 由 09 实现、08 调用。

**build**（`packages/build`）：`src/types.ts`（`BuildOptions`、`BuildReport`）；占位 `buildScreen`、`buildInputsSha256`、`registerBuild`（`packages/cli/src/plugins.ts` 已经调用）。

**cli**：`build`、`verify`、`doctor`、`snap`、`skill` 是占位命令。`packages/cli/test/stubs.test.ts` 已改为测试占位机制本身，替换占位命令不需要改它。

**依赖已装好**：renderer（`@napi-rs/canvas` 1.2.1、sharp、core），perception（`onnxruntime-node` 1.31.1），build（加了 renderer），verify（adapter-godot、build、renderer、rules），cli（加了 renderer）。

## 资产怎么画

构建、参考渲染器、导出三方共用这套约定。三方各自实现，但结果必须一致；有疑问时以这里为准，这里没写到的写进 Comments。

1. **像素归属**（`pixelOwnership`）：
   - `asset`：节点画自己的资产。没有资产时画占位（见第 7 条）。
   - `baked`：节点的像素留在宿主 `host` 的资产里，自己什么都不画。条件是 `attach.split: baked`，或 `decor.merge: merge`，或父节点 `content.split: baked` 且自己不是 `attach.split: independent`。
   - `text`：动态文字（`text.mode: dynamic`），由引擎画；它下面的每个资产都要剥离这些字。
   - `none`：`container`、`instance`、`particle`，没有自己的像素。
   - 位图文字（`text.mode: bitmap`、`bitmap-font`）按图片处理：独立时有自己的资产，否则并入宿主。`bitmap-font` 在 M1 等同 `bitmap`，记一条近似项。
2. **被遮住的地方**（`expectedHoles`）：资产下方的像素被后画、可见、不属于它的节点盖住时，拍平图的资产要处理这块：动态文字剥离（`stripped`）；独立节点看它自己的 `occlusion.fill`，`fill` 补全（`filled`），`none` 保留原像素（`kept`）。排除区一律补全。PSD 的资产来自分开的图层，下面本来就画完整了，没有这一步。
3. **顺序**：树的先序（父节点在前，子节点按 `children` 顺序从后到前）。`visible: false` 的节点连同子树都不画。状态覆盖（`states.<名>`）替换资产、显隐、着色和文字。
4. **放置**：资产画进节点布局后的矩形减去资产记录的 `inset`，即 `[x + l, y + t, w − l − r, h − t − b]`。没有九宫时整张拉伸进去。有九宫时，资产文件的密度必须是 1（一个文件像素等于一个设计像素），`record.nineSlice` 与节点的 `nineSlice` 数值相等；四角按原尺寸画，四边和中间拉伸。
5. **着色**：节点（或状态）的 `tint` 乘到资产的 RGB 上，透明度不变。
6. **动态文字**：
   - 内容：状态覆盖 > 渲染选项 `text` > 绑定（从 mock 数据取） > `text.content`。
   - 字体：`text.font` 在项目配置 `fonts` 里有对应文件就用它；否则用系统字体兜底，并记一条近似项。
   - 字号：`text.size`；没有时按框高的 0.8 估算，与 Godot 适配器一致。
   - 颜色：缺省 `#ffffff`。描边、阴影按 `TextSpec`。
   - 对齐：缺省水平、垂直都居中。M1 只画单行，不换行。
7. **占位**：归属为 `asset` 却还没有资产的节点，以及没有资产的 `surface`、`anim`，画一个带标注的框，并记一条警告。
8. **进度条**：`progress` 节点自己的资产是底槽；填充是它的一个独立子节点（第一个有资产的 `image` 子节点），按自己的矩形画。`content.split: baked` 时填充并在底槽里，整条当图片处理，导出时不接数值。
9. **密度**：资产文件的分辨率由 `scale.source` 决定：`native` 保留源文件的像素密度（每设计像素 `1 / screen.scale` 个文件像素）；`upscale`、`redraw` 做到密度 1。九宫资产一律做到密度 1。
10. **状态**：只给节点 `states` 里声明了、但还没有资产的状态出图，方法按 `state.source`：`derive` 由常态推导（按下压暗、禁用去色降透明度）；`placeholder` 用常态的图并记近似项；`generate` 在 M1 退回 `derive`，并记近似项“状态生成在 M2”。
11. **布局**：参考渲染器（`layoutScreen`）和 Godot 导出的锚点用同一套语义。
    - 节点的锚定取显式的 `anchor`；没有时取决定 `layout.anchor`：九个方向拆成水平 `left` / `center` / `right` 和垂直 `top` / `center` / `bottom`，`stretch` 两个方向都拉伸。
    - 设计尺寸下，每个节点的布局矩形就是它的 `rect`。
    - 视口变化时根节点铺满视口；其余节点相对父节点的布局矩形：`left` 保持到父节点左边的距离，`right` 保持到右边的距离，`center` 保持相对父节点中线的偏移，`stretch` 保持两边的距离、尺寸随父节点变；垂直方向同理。不拉伸的方向尺寸不变。
    - 这与 Godot 的锚点加偏移一一对应：锚点取 0、0.5、1，偏移是设计尺寸下到锚点的距离。
    - M1 不处理安全区：导出还没有安全区容器，所以参考渲染器也不避让；适配门禁把侵入安全区的可交互元素和文字记为警告。
12. **视口矩阵**（适配门禁）：Godot 工程按 `canvas_items` 拉伸、`expand` 保持比例。以界面的设计尺寸为基准，目标比例比基准更窄长时宽度不变、高度加长，更宽时高度不变、宽度加宽。竖屏界面取 9:16、9:19.5、9:20、3:4，横屏取倒数，与基准相同的不重复；9:19.5 和 9:20 带刘海与底部横条的安全区。具体数值写成常量。

## 产物的位置

- 界面的资产：`screens/<界面>/assets/manifest.json`（资产清单）、`screens/<界面>/assets/<资产名>.png`，锁定的模型输出 `screens/<界面>/assets/gen/<请求键>.png`。
- 锁文件 `ui-pro.lock`、外发记录 `history/egress.jsonl`（只追加，不进历史版本）。
- 一次构建是一个历史版本；什么都没变时不写版本。
- 临时文件放在 `.ui-pro/` 下（不进历史）：构建的资产总览图 `.ui-pro/build/<界面>/`，门禁记录 `.ui-pro/verify/<界面>.json`，门禁的热力图等 `.ui-pro/verify/<界面>/`，引擎一致门禁用的 Godot 工程 `.ui-pro/engine/<界面>/`。

## 并行规则

第一波四个工单（06、07、08、09）在同一个工作区里同时开工，05 等第一波空出名额再开。

- **只改自己工单“归属”里列出的文件**。需要动别人的文件或共享接口时不要改：在自己工单末尾的 `## Comments` 写清楚要什么、为什么，然后用不改它的办法继续。
- **跨工单只走共享接口**。别人的实现还没好时，测试用替身：假的 `PixelOps`、手写的资产清单和 PNG、`vi.mock`。不要在自己的包里重写别人的实现。
- **不加依赖，不跑 `pnpm install`**。缺什么写进 Comments。
- **不跑全仓库的写操作**：不要 `biome check --write .`，不要 `git commit`、`git stash`、`git checkout`。格式化只对自己的文件：`pnpm exec biome check --write <你的路径>`。
- **测试只跑自己的**：`pnpm vitest run packages/<包>`，以及 `pnpm vitest run packages/cli/test/<你的文件>`。类型检查 `pnpm -s typecheck`：别的包里的错误不归你，你的文件不能有。
- **重型测试**：调用本地模型、Godot、浏览器或断言耗时的测试写在 `*.integration.test.ts` 里，它们会在其余测试之后一次跑一个文件。本地模型测试 `describe.skipIf(!process.env.UI_PRO_MODELS)`；真实云端测试要 `UI_PRO_CLOUD=1` 且有 `DASHSCOPE_API_KEY`，平时用假的 `fetch`；Godot 测试看 `UI_PRO_GODOT`。
- **错误码**在自己的包里定义字符串常量，不改 `packages/core/src/errors.ts`。
- **CLI 命令**：一个命令一个文件，实现 `CommandModule`，替换原来的 `stubCommand`，不改 `commands/index.ts`。CLI 测试写在自己的新文件里，复用 `packages/cli/test/helpers.ts`，不要改它；要新的测试工具，写在自己的测试文件里。

## 环境事实（已在本机验证）

- **@napi-rs/canvas**：探针 `ref/canvas/probe.mts`，输出 `ref/canvas/probe.png`。本机能加载；带描边和阴影的中文、九宫拉伸、乘色着色都正确；单帧编码约 7 毫秒；`GlobalFonts.families` 能列出系统字体，项目字体用 `GlobalFonts.registerFromPath(file, family)` 注册。
- **本地模型**：HuggingFace 和 hf-mirror 都能连通。目录见 `packages/perception/src/models/catalog.ts`，三个模型共约 386 MB，缓存在 `%LOCALAPPDATA%\ui-pro\models`。
- **DashScope**：本机还没有设 `DASHSCOPE_API_KEY`，测试用假的 `fetch`。接口事实见工单 07。
- **Godot、OCR、opencv.js、sharp、Photopea**：同第 2 批。
- **示例**：`benchmark/samples/candy-knight/ui.png`，438×652，设计宽 1080，`screen.scale` 约 2.4657（默认规则包据此把 `scale.source` 定为放大）。分析约 7.6 秒，候选 215 个、相似簇 26 个，草稿 101 个节点。草稿是按包含关系嵌套的候选框，大多是 `container`，要经 Agent 审校才是能构建的切分规划。父 agent 会在第一波期间写一份审校后的切分规划 `benchmark/samples/candy-knight/plan.ops.json`，测试不要依赖它。

## 完成的标准

- 工单里的验收条目全部满足，并在工单末尾 `## Comments` 写一段交付说明：做了什么、没做什么及原因、实测数据、需要父 agent 决定的事。
- 自己的测试全部通过；`pnpm -s typecheck` 在自己的文件里没有错误；`pnpm exec biome check <你的路径>` 通过。
- 把工单的 `Status:` 改为 `ready-for-human`，表示等待审核。
