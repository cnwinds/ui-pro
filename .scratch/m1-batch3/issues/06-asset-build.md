# 06 资产构建

Status: resolved

先读 `../spec.md`，其中的共享接口、“资产怎么画”、并行规则对本工单同样适用。

## 归属

只改这些文件：

- `packages/build/**`（`src/types.ts` 不改）
- `packages/rules/src/check.ts` 里“无漂移”这一项，以及为了读资产清单要改的 `packages/rules/src/inputs.ts`；测试写在新文件 `packages/rules/test/drift.test.ts`
- `packages/cli/src/commands/build.ts`（替换占位）、`packages/cli/test/build.test.ts`（新建）

## 背景

方案 §6.5 全节；§6.6 的约束 5–8 里属于构建的部分（锁定、预算、外发记录、落选候选）；§6.7 先粗后精；§6.8 PSD 的像素从哪来；§5.2 决策点；§5.6 的“无漂移”；§14.2 切分规划。`CONTEXT.md` 的资产、锁定、锁文件、资产清单、外发记录、近似项、初稿 / 终稿。

第 2 批审核留下的三件事归本工单：

- 决定之间会相互影响（例如 `attach.split: baked` 时 `occlusion.fill` 无关紧要），构建必须合起来解释。这套解释已经写成共享的 `pixelOwnership` / `expectedHoles`，直接用。
- `build` 开工前检查决定是否完备、无歧义（§5.6 的前两项），不完备就拒绝并指出哪些节点、哪些决策点。
- 第 2 批的 Godot 导出对有子节点的按钮、面板用基准图裁图兜底，子节点的像素画了两遍。本工单给宿主出不含独立子节点像素的底图，导出（09）换用它。

像素层面的四步（抠取、补全、文字剥离、提升分辨率）由工单 07 在 `PixelOps` 里实现。本工单只通过 `createPixelOps(context)` 调用它们，并实现 `PixelContext` 里归构建的部分：锁定的模型输出、外发记录、预算。07 还没做完时，测试用假的 `PixelOps`。

## 要做的事

### 1. 命令

`ui-pro build [--final | --draft] [--locked] [--regenerate <选择器>] [--dry-run]`，界面用全局的 `--screen`。

- 开工前检查：
  - 界面分析过（有证据），否则报错并提示 `ui-pro analyze`；
  - 决定完备、无歧义（用 `checkRules` 的这两项，或者直接求值）。不满足时报错 `E_BUILD_DECISIONS`，列出节点和决策点，提示 `ui-pro rules why <节点>` 与 `rule.recompute`。
- 档位：有云端图像模型可用（`createCloudImageModel` 不为空，且外发档位不是 `local`）时默认 `--final`，否则默认 `--draft`。只出初稿时加一条警告：没有云端图像模型，设置 `DASHSCOPE_API_KEY` 后运行 `ui-pro build --final` 换成终稿。
- `--locked`：不调用任何感知模型，`GenerationStore.allowNew` 为 false；缺锁定输出时报 `E_NOT_LOCKED`，指出哪个节点的哪一步。
- `--regenerate <选择器>`：匹配到的节点不用锁定输出，重新调用模型，新结果替换锁文件里的记录。旧的模型输出文件留在 `gen/`，不删。
- `--dry-run`：算完整个构建并报告，不写任何文件。
- 响应：`summary` 形如“已构建界面 character：资产 42 个（复用锁定输出 30 次，本地模型 12 次，云端 0 次）”；`data` 是 `BuildReport`；`warnings` 列近似项；`views` 是资产总览图；`ask` 来自预算等；`next` 给 `ui-pro verify`。

### 2. 资产规划

先由界面规格、决定、`pixelOwnership` 和 `expectedHoles` 算出一份资产规划，再取像素。规划是纯函数，不读写文件，能单独测试：

- 每个归属为 `asset` 的节点要一个资产：取哪块像素、哪些地方要补全或剥离、做到什么密度（spec“资产怎么画”第 9 条）、要不要做九宫（`stretch.mode`）。
- 重复元素（`repeat.mode: component`，或同一相似簇、同一组件的实例）：完全一致的共用一张母版；`variant.mode: tint` 用一张母版加各实例的乘色；`variant-assets` 各存一张，相同的再去重。
- 状态：spec“资产怎么画”第 10 条。
- 排除区：覆盖它的资产都要补全那块。
- 进度条：spec“资产怎么画”第 8 条。底槽在填充下面的部分要补全，引擎才能把填充缩短。

### 3. 拍平图路径

每个资产按顺序：抠取 → 补全与剥离 → 提升分辨率 → 九宫 → 去重 → 状态 → 整理。

- **工作图**：像素从基准图（`referenceImagePath`）取，抠取和补全都在源文件的像素密度下做，最后再按目标密度放大。铺满全屏、不透明的背景不需要抠取。
- **抠取**：`subject` 按节点选：通用角色 `figure` 用 `figure`，位图文字用 `text`，其余用 `ui`。`style` 来自预检的风格档案（像素风用 `pixel`）。候选有 mask 时作为 `hint` 传入。
- **补全与剥离**：`expectedHoles` 给的是矩形，实际只补全上面那个节点真正盖住的像素：用它抠出来的透明通道（外扩 1–2 像素）作为补全区域，比如圆形红点只补按钮角上那一圈，而不是整个方框。动态文字的位置调用 `stripText`，量出的字号、颜色、描边、阴影换算成设计像素后，**只填**节点 `text` 里还没有的字段，Agent 或用户已经写的值不动。`kept` 的地方不处理。
- **提升分辨率**：密度目标是 1 时调用 `upscale`。

### 4. PSD 路径

- 资产的像素来自图层渲染（`evidence/layers/<图层 id>.png`，节点的 `evidence` 里是 `layer#<id>`）。宿主的资产由它自己的图层，加上并入它的子节点、装饰的图层合成。不抠取，不补全。
- 隐藏的 `@状态` 图层成为对应状态的资产。
- 文字图层：动态文字的内容和样式已在草稿里；位图文字用图层渲染。
- 资产记录的 `origin` 为 `layer`，`holes` 为空。只有 PSD 分辨率低于设计分辨率时才放大。

### 5. 九宫、去重、着色、整理

- **九宫**：`stretch.mode` 为 `nine-slice` 或 `three-slice` 时，检测边角与中段的均匀性，裁成最小纹理；再拉伸回原尺寸与原图比对，通过才采用。不通过就保留整张图，并记一条近似项。
- **去重**：同组实例用感知哈希比较，近似但不完全相同的选一张最好的做母版（被遮挡最少、最清晰），其余实例与母版的差异记为近似项。
- **着色**：`variant.mode: tint` 时，按最小二乘求每个实例相对母版的乘色，色差超过阈值就改为各存一张，并记近似项。
- **整理**：裁掉透明边并相应记录 `inset`；边缘外扩防渗色；按 `naming.asset` 模板命名（`{prefix}` 取基元类型的前缀，`{semantic}` 取节点 id 去掉类型前缀后的部分，`{index}` 是同名时的序号），名字唯一并符合 `ASSET_NAME_PATTERN`；`atlas.group` 记进 `atlas` 字段（`screen` 记为界面名，`shared` 记为 `shared`）。M1 不打图集。
- **近似项**的写法：以决策点开头，例如“stretch.mode：九宫拉伸回原尺寸后结构相似度 0.91，低于 0.95，按固定尺寸处理”。无漂移检查靠这个前缀认出构建已经说明过的偏差。

### 6. 写入与可复现

- **`asset.assign` 操作**（家族 `build`，由 `registerBuild` 注册）：写节点的 `asset`、`tint`、`nineSlice`、`states.<名>.asset`，以及第 3 步量出的文字字段（只填空缺）。它校验资产名在 `ctx.assets(screen)` 里存在。`summary` 注明它由构建使用，Agent 不需要直接调用。
- 整次构建是一个 `applyOps` 调用：操作是一串 `asset.assign`，附带 `assets` 和 `lock`。结果与现有的资产和锁文件完全相同时不写版本。
- **`buildInputsSha256`**：源文件哈希，加上界面规格去掉 `asset.assign` 写入的字段，加上决定、排除区、设计分辨率等影响资产的配置。构建刚写完时它必须等于清单里的 `inputsSha256`；改了决定、改了节点矩形，它就变。在注释里写清楚包含什么、不包含什么。
- **`GenerationStore`**（建在锁文件和 `gen/` 上）：请求键是操作、模型、输入像素、遮罩、参数的哈希；`put` 写 `gen/<键>.png`，落选候选写 `gen/<键>-alt<n>.png`，都记进锁文件。
- **`EgressLog`**（建在 `history/egress.jsonl` 上）：每次云端调用追加一行 `EgressRecord`；`count(screen)` 数这个界面已经调用了几次。
- **预算**：云端调用次数达到 `budget.image_calls_per_screen` 时，07 会抛 `E_IMAGE_BUDGET`。构建对这个界面停用云端，其余步骤改用本地方法出初稿，并在 `ask` 里问用户是否提高上限。

### 7. 无漂移检查

把 `checkRules` 里“无漂移”这一项从 `skipped` 改成真的检查。`RuleInputs` 的每个界面带上它的资产清单（`inputs.ts` 用 `readAssetManifest` 读）；没有清单时仍为 `skipped`，理由改为“还没有构建资产”。逐个节点对照：

- 归属为 `asset` 的节点没有资产，或者资产不在清单里；归属为 `baked`、`text`、`none` 的节点却有资产。
- 拍平图资产的 `holes` 与 `expectedHoles` 不符（比较“哪个节点、怎么处理”的集合）。`origin: layer` 的资产应当没有 `holes`。
- `variant.mode: tint` 的实例没有共用资产或没有乘色；`variant-assets` 的实例却带乘色。
- `stretch.mode` 是 `nine-slice` 或 `three-slice`，资产记录却没有 `nineSlice`。
- 资产的 `approximations` 里有以该决策点开头的说明时，这一条记为 warning，不算 problem。

其余五项检查不动。

### 8. 视图

资产总览图：所有资产排在棋盘格底上，下面标资产名，写到 `.ui-pro/build/<界面>/sheet.png`。合成后与基准图的对比由门禁（08）做，构建不出。

## 验收

- 单元测试：
  - 资产规划：在手写的界面上覆盖独立、并入、动态文字、位图文字、排除区、进度条、`tint` 与 `variant-assets` 等情况；
  - 九宫检测和验证：用合成图（中段均匀的圆角框）测试；
  - 乘色的求解与阈值；命名模板与重名；
  - `buildInputsSha256`：构建前后不变（排除了构建写入的字段），改决定或节点矩形后变化；
  - `GenerationStore`、`EgressLog`、`asset.assign`。
- 用假的 `PixelOps`（确定性的，例如补全取周围平均色）在合成的拍平图项目上：
  - `buildScreen` 把清单、资产文件、锁文件写进同一个版本，`history undo` 全部撤掉；
  - 什么都没改时再构建，不写新版本，`reused` 计数正确；
  - 没有锁定输出时 `--locked` 报 `E_NOT_LOCKED`；`--regenerate` 只重做匹配到的节点。
- PSD 路径：用 `ag-psd` 的 `writePsdBuffer` 在测试里生成一份合规 PSD，用内嵌合成图渲染器分析（不需要 Photopea），构建结果没有抠取和补全步骤、`holes` 为空。
- 无漂移：每一种问题各有测试；没有清单时为 `skipped`。
- CLI：`ui-pro build` 的响应结构，`--dry-run` 不写文件。CLI 测试可以用 `vi.mock('@ui-pro/perception', …)` 换上假的 `createPixelOps`。
- 在 Comments 里报告：合成项目上一次构建的耗时；哪些情况只做到近似；07 完成后需要父 agent 在糖果骑士上重点看什么。

## Comments

### 做完了什么

工单要求的功能和测试全部做完，没有砍项。

- `packages/build`：`buildScreen`、资产规划（纯函数 `planAssets`）、拍平图路径（抠取 → 补全/文字剥离 → 放大 → 九宫 → 去重 → 状态 → 整理）、PSD 图层路径、`asset.assign` 操作（家族 `build`）、`buildInputsSha256`、`GenerationStore`（锁文件 + `gen/`）、`EgressLog`（`history/egress.jsonl`）、资产总览图 `.ui-pro/build/<界面>/sheet.png`、预算 `ask`。一次 `applyOps` 写清单、资产文件、锁和节点绑定，输入没变时不产生新版本。
- `packages/rules`：`check.ts` 的“无漂移”（无清单时 `skipped`，原因含“资产构建”），`inputs.ts` 给 `ScreenInput` 加了可选的 `assets`（`readRuleInputs` 和 `readTxInputs` 都会填）。测试 `packages/rules/test/drift.test.ts`。
- `packages/cli/src/commands/build.ts`：真实命令，替换了桩；测试 `packages/cli/test/build.test.ts`。
- 为 CLI 测试把 `packages/build/test/support.ts` 里的种子逻辑拆成了导出的 `seedSynthetic`。

### 验证结果（我这次收尾时重跑的）

- `pnpm vitest run packages/build packages/rules packages/cli/test/build.test.ts packages/cli/test/rules.test.ts`：25 个文件、327 个测试全部通过。
- `pnpm -s typecheck`：退出码 0（整个仓库，当前没有错误）。
- `biome check --write` 只对我的路径跑过，无剩余告警。
- 没有跑糖果骑士（需要本地模型和 OCR，见下“需要父 agent 看的”）。
- `packages/cli/test/schema.test.ts`（不是我的文件）现在会失败：它断言 25 个操作，`asset.assign` 加进来后是 26 个，diff 里只多了 `asset.assign`。

### 实测耗时（合成项目，假 PixelOps，本机）

合成项目是 360×640 的拍平图，11 个资产（背景、九宫面板、星星、3 个按钮及其 pressed/disabled 状态、进度条底槽和填充），连测 3 次：

- 首次构建 205–296 ms
- 再构建（全部复用、不写新版本）127–160 ms
- `--dry-run` 97–166 ms

这是假的补全/放大，不含模型推理，只说明编排本身开销很小，真实耗时由 07 的模型决定。

### 与工单不一致或工单没写的地方

1. **`--final` 在没有可用云端图像模型时报 `E_BUILD_NO_CLOUD`**，而不是悄悄降成草稿。工单只规定了“默认值”的选择；显式要终稿却做不到，我认为应该报错。需要确认。
2. **`--locked` 与 `--regenerate`、`--final` 与 `--draft` 同用**：CLI 用 `UsageError`（退出码 2，`E_USAGE`）。`buildScreen` 自己对 `--locked` + `--regenerate` 也报 `E_USAGE`。
3. **`--dry-run` 永远不调云端**：补全和放大只用本地方法，并给警告“预演不调用云端图像模型……实际终稿的像素会不同”。所以预演的 `generated.cloud` 恒为 0，和真正的终稿不可比。
4. **`--regenerate <选择器>` 的匹配范围**：除了选中的节点，还包括“以它为洞”的资产（例如选星星，也会重做面板和背景里星星那个洞的补全）。选择器匹配不到节点时报 `E_SELECTOR_EMPTY`。旧的 `gen/` 文件保留，锁里的记录换成 `-r<n>` 的新文件。
5. **画风固定为 `smooth`**：预检没有写下画风档案，所以 `ArtStyle` 目前恒为 `smooth`。
6. **`atlas.group` 不进 `buildInputsSha256`**：图集分组是跨界面反馈，不决定任何资产的像素；放进去会让一个界面的构建改动另一个界面的哈希。
7. **失败的构建不落任何东西**：只有 `history/egress.jsonl`（只增不减的外发记录）会留下已经发出的云端调用。
8. **CLI 没有进度输出**：`CommandContext` 没有暴露 stderr，所以没把 `onProgress` 接出来。长构建期间命令行是静默的。
9. **`dedupe` 里加了一条说明**：`variant.mode: tint` 的簇里，如果没有任何实例能与母版共用（或某实例形状对不上），每个落单的实例都会留下以 `variant.mode：` 开头的近似项。这是为了让“无漂移”能把这类情况降为警告，而不是让第一个母版无故报错。
10. **`asset.assign` 的 schema 是用 core 导出的 schema 实例拼出来的**：`packages/build/package.json` 里没有 `zod`，从 build 包里解析不到。见下“需要父 agent 决定的”。

### 无漂移的具体口径

- 没有任何界面有清单：`skipped`，原因“还没有构建资产：运行 ui-pro build 完成资产构建后才能比对资产与决定是否相符”。部分界面有清单：只比对有的，没有的在 `warnings` 里点名。
- 问题种类：`missing-asset`（要画资产的节点没绑定，或绑定的资产不在清单里）、`unexpected-asset`（并入/动态文字/无像素节点却有资产）、`holes`（拍平图资产的洞与 `expectedHoles` 按“节点+处理方式”集合比较；PSD 图层资产记了洞）、`tint`（tint 实例没共用资产或没乘色；variant-assets 实例带乘色）、`nine-slice`（决定是九宫/三宫但记录没有 `nineSlice`）。
- 比对范围：`holes` 只比对 `origin` 是 `crop`/`generated` 且有默认外观使用者的记录；状态用的推导资产不比。tint 的判断只针对同一簇或组件里至少 2 个“画自己资产”的节点。
- 近似项降级：资产的 `approximations` 里有以该决策点名（后跟 `：` 或 `:`）开头的条目，对应问题降为 `warnings`（写“构建已记为近似项：……”）。缺资产和图层洞没有对应决策点，不降级。
- 合成项目构建后，“无漂移”通过，只有一条警告（进度条的 `occlusion.fill` 覆盖）。决定在构建后被改动而没重建，会报 `unexpected-asset` 和 `holes`；重建后恢复。

### 只做到近似的情况（都会进 `BuildReport.approximations` 和 CLI 的 `warnings`）

- `text.mode: bitmap-font`：M1 等同 `bitmap`，按图片处理。
- 并入宿主的决定但找不到宿主（`decor.merge` / `attach.split` / `content.split` 的 `noHost`）：保留自己的资产。
- 进度条：填充下面的底槽即使决定是 `occlusion.fill: none` 也一律补全，否则引擎没法缩短填充。
- 状态：`state.source: placeholder`、`generate`（M2 才有，按推导）、没有推导方法的状态名、标成画好的状态但 PSD 里找不到 `@状态` 图层。
- 九宫：找不到可拉伸中段、只找到一个方向（降为三宫）、验证（重拉伸后与原图的结构相似度）不过时。
- 去重：`repeat.mode: component` 的近乎相同实例共用母版（记结构相似度）；`variant.mode: tint` 拟合误差超限或形状不同时各存一张。
- 放大：放大后缩回与放大前的结构相似度低于阈值时，说明细节可能被改写。
- PSD 路径：图层合成出来的遮挡物没有“元素轮廓”，补全回退用矩形。

### 需要父 agent 决定的

1. 在 `packages/build/package.json` 里加 `zod` 依赖（我不能加依赖），之后 `asset.assign` 的 schema 可以直接用 `z.strictObject` 重写，不再绕 core 的导出。
2. 修改 `packages/cli/test/schema.test.ts`：操作数 25 → 26（新增 `asset.assign`）。
3. 上面第 1 条（`--final` 无云端报错）是否接受。
4. 是否要在 CLI 里接进度输出（需要给 `CommandContext` 加 stderr 能力，不是我的文件）。

### 对非本人文件的修改请求

- `packages/cli/test/schema.test.ts`：操作数 25 → 26。
- `packages/build/package.json`：加 `zod`。
- 另外观察到（不是我的范围）：PSD 分析的草稿里，`slot_equip_N` 容器下的智能对象 `icon` 没有成为节点，所以合规 PSD 构建出 4 个资产（背景、按钮、按钮 pressed、红点），三个图标没有资产。属于 PSD 草稿的问题，应由 PSD 工单确认是否预期。

### 07 之后父 agent 在糖果骑士上重点看什么

`benchmark/samples/candy-knight/ui.png` 先 `ui-pro analyze`，再 `ui-pro build --draft`，然后：

1. 打开 `.ui-pro/build/<界面>/sheet.png`，逐个看资产：背景被补全的地方（文字、被控件挡住的区域）、有没有残留字形或水印。
2. 面板、按钮是否检出九宫，边距是否合理；报了九宫近似项的，看拉伸后是否变形。
3. 文字剥离后底下的纹理是否自然（本地模型的质量）。
4. 近似项和警告的数量和内容是否合理，有没有成片的 `noHost` 或 `variant.mode` 说明（说明决定与画面不符）。
5. 构建后跑 `ui-pro rules check`，“无漂移”应通过；再构建一次应不写新版本，`reused` 等于模型输出数。
6. 真实模型下的耗时和 `--locked` 复用（第二次构建应全部复用）。
7. 配好 `DASHSCOPE_API_KEY` 后 `--final` 的预算 `ask` 和外发记录 `history/egress.jsonl` 是否符合预期。

### 审核（父 agent）

通过。相关测试 327 个全过；`buildScreen` 在构建前检查“完备”和“无歧义”，对应第 2 批留下的“build 前置检查”要求。无漂移检查口径清楚。

对“需要父 agent 决定”的答复：

1. 已在 `packages/build/package.json` 加上 `zod`，并用它重写了 `asset.assign` 的 schema（不再绕 core 的 `ExclusionSchema`）。
2. 已更新 `packages/cli/test/schema.test.ts`：操作数 25 → 26（含 `asset.assign`）。
3. `--final` 没有可用云端时用 `E_BUILD_NO_CLOUD` 报错：接受。显式要求终稿却做不到，不能悄悄降成草稿。
4. CLI 进度输出：第 3 批不做；端到端时如果构建很慢再给 `CommandContext` 加 stderr。
5. 画风恒为 `smooth`、`atlas.group` 不进哈希：接受。
6. PSD 草稿里智能对象 icon 不成节点：记到工单 05 / 端到端时再确认。

糖果骑士上的真实模型构建放到 09 交付后、端到端联调时做。