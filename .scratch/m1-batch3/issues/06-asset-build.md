# 06 资产构建

Status: ready-for-agent

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
