# 03 PSD 分析、逐图层渲染与合规检查

Status: resolved

先读 `../spec.md`，其中的并行规则和共享接口对本工单同样适用。

## 归属

只改这些文件：

- `packages/psd/**`
- `packages/cli/src/commands/psd.ts`（替换占位）
- `packages/cli/test/psd.test.ts`（新建）

`ui-pro analyze` 的分派由工单 02 负责，它会调用你实现的 `analyzePsdScreen`，签名已经定好，不要改。

## 背景

方案 §6.8 全节、附录 C（PSD 交付规范草案）、§6.2 与 §6.3 里关于 PSD 的段落、§14.5。`CONTEXT.md` 的“输入”一节：源文件、合成图、基准图、输入等级、交付规范、交付包。

要点：图层自身的像素不含图层样式，所以要用渲染器逐图层渲染；渲染结果不盲信，按顺序拼回后与 PSD 内嵌的合成图（由 Photoshop 渲染）核对，逐图层判定。合规且全部通过是 A 级，默认只接受 A。

## 要做的事

### 1. 解析

用 `ag-psd` 读出（`packages/psd/test/smoke.test.ts` 有 Node 下的用法）：图层树、图层标识（`layer.id`）、名称、种类（像素、文字、智能对象、形状、组）、是否隐藏、是否有图层样式、混合模式、剪贴、蒙版、文字属性（内容、字体、字号、颜色）、智能对象的源标识、内嵌合成图。PSD 没有合成图（保存时没开“最大兼容”）是合规错误。

交付包（目录加 `manifest.json`）的格式还没定，这一批遇到它返回 `E_NOT_IMPLEMENTED`，提示改交 PSD。

### 2. 渲染器 Provider

- 定义接口：输入 PSD 字节和要渲染的图层，输出每个图层画布大小的 RGBA 像素，包括隐藏的状态图层（`@pressed` 等）。
- Photopea 实现：参照 `../ref/photopea/probe.mjs`。用 `playwright-core` 启动本机 Edge，本地 HTTP 提供宿主页，用 ES3 脚本把除目标图层及其祖先组以外的图层都隐藏，导出 PNG，再恢复可见性。浏览器只启动一次，所有图层复用。
- 失败要说得清楚：本机没有 Edge、Photopea 连不上、超时，各有错误码和提示。
- 外发档位：项目配置 `egress: local` 时，不使用在线版 Photopea，报错并说明原因（在线版需要联网，是否上传数据尚未抓包确认）。
- 测试用的假渲染器：直接用 `ag-psd` 读到的图层像素。对没有图层样式的合成 PSD，它与合成图完全一致。
- 渲染结果按 PSD 哈希和图层标识缓存在 `.ui-pro/` 下，重复分析不重新渲染。

### 3. 核对与输入等级

- 按图层顺序把渲染结果拼回，与合成图逐像素比较。差异像素归到覆盖该像素的最上层图层，逐图层给出通过或不通过，以及度量值（差异像素占该图层面积的比例、最大差值）。阈值写成常量，说明取值理由。
- 参考 `../ref/photopea/results.txt`：`group-drop-shadows`、`smart-object`、`text-simple` 应该通过；`effects`、`fill-opacity` 应该有图层不通过。
- 等级：交付规范的“必须”项有任何不满足为 C；合规但有图层核对不过为 B；否则为 A。

### 4. `analyzePsdScreen`

- 先定等级。B 或 C 且没有 `allowDegraded` 时拒绝，错误码 `E_PSD_GRADE`，`details` 里附修改清单。
- 证据：`composite.png`（常量 `COMPOSITE_EVIDENCE`，基准图就是它）；每个图层的渲染结果裁到自身范围后存为 `layers/<图层标识>.png`；候选 `layer#<图层标识>`，带 `layer` 信息、`parent`（所在组）、`mask`（指向图层图片）。
- 相似簇：同一个智能对象的多个实例（`kind: 'smart-object'`）；同名加序号的组，例如 `slot_equip_1` 到 `slot_equip_6`（`kind: 'name'`）。
- 草稿（§6.3、附录 C.3）：
  - 带前缀的图层组成为节点，组的嵌套就是层级。节点 id 取组名，不合法时由内核编号。前缀到基元类型和通用角色的映射按 C.3 的表；项目配置 `psd.prefixes` 可以覆盖。
  - 组里不命名的普通图层是这个元素的组成部分，不单独成为节点，作为节点的 `from` 证据。
  - `txt_` 组里的文字图层成为文字节点，文本内容、字体、字号、颜色直接来自图层，不经过文字识别。
  - 隐藏的 `@状态名` 图层用 `state.set` 记为该状态的 `source: 'drawn'`。
  - 以 `#` 开头的组忽略。
- 用 `allowDegraded` 放行时，不合规或核对不过的部分按图层生成图片节点，逐条写进 `warnings`，以后的报告会列出它们。
- 提交：`applyOps(project, ops, { screen, evidence: { [screen]: { candidates, files } }, message })`，证据和草稿在同一个版本里。
- 返回 `AnalysisReport`：`grade`；预检的 `upscale` 取 `screen.scale`，画布尺寸不等于设计分辨率时也是合规错误（C.1）。

### 5. `ui-pro psd lint`

- 输入：一个 PSD 文件路径，或 `--screen` 指定的界面的源文件。
- 检查 §6.8 表里的“文件”“结构与命名”“还原”三类；“粒度”需要感知模型和项目规则，留到第 3 批，在报告里注明未检查。
- 每条问题：严重程度（必须 / 建议）、类别、图层路径、面向美术的中文说明和改法。
- 给美术的修改清单另存为 Markdown 到 `.ui-pro/psd-lint/`，路径放进 `views`。
- 响应 `ok: true`，`summary` 说明等级和问题数；文件读不了才失败。

## 验收

- 在测试里用 `ag-psd` 的 `writePsdBuffer` 生成一份合规的 PSD：画布等于设计分辨率；`bg_main`；`btn_upgrade` 组里有底图、`badge_dot` 组和隐藏的 `@pressed`；`txt_gold` 文字图层；`slot_equip_1` 到 `slot_equip_3` 是同一个智能对象的实例。用假渲染器分析：等级 A；候选和两种相似簇都对；草稿的节点树、类型、角色与组结构一致；文字节点的内容来自图层；`referenceImagePath` 指向写出的 `composite.png`；只产生一个历史版本，撤销后干净。
- 生成一份不合规的 PSD（组没有前缀、画布尺寸不对、没有合成图）：`psd lint` 逐条列出问题和改法；`analyze` 以 `E_PSD_GRADE` 拒绝；加 `--allow-degraded` 后通过，并有警告。
- Photopea 集成测试只在环境变量 `UI_PRO_PHOTOPEA=1` 时运行。在 `effects`、`group-drop-shadows`、`text-simple`、`smart-object`、`layer-mask` 上渲染并定级，自己跑一遍，把每个夹具的等级、不通过的图层和耗时写进 Comments。
- 报告 Photopea 的启动耗时和每个图层的平均渲染耗时。

## Comments

### 交付说明

**已完成**：解析、渲染器 Provider（Photopea、嵌入像素渲染器）、渲染缓存、核对与输入等级、`analyzePsdScreen`、`ui-pro psd lint`。全部在归属范围内完成，没有改动核心或其他包的文件。

#### 文件

- `packages/psd/src/`：`errors`、`image`、`model`、`parse`（ag-psd 解析）、`structure`、`compliance`（合规检查）、`prefixes`（前缀表，可被 `psd.prefixes` 覆盖）、`renderer`（接口与渲染单元规划）、`embedded-renderer`、`photopea`、`renderers`（工厂与外发档位）、`render-store`（渲染与缓存）、`verify`（核对）、`report`（等级与修改清单）、`evidence`、`draft`、`inspect`（分析与 lint 共用的检查流程）、`analyze`、`lint`、`index`（原有，已扩充导出）。
- `packages/cli/src/commands/psd.ts`：`psd lint [file]` 与 `--screen`、`--no-render`。
- 测试：`packages/psd/test/`（`fixtures`、`harness`、`analyze`、`compliance`、`verify`、`lint`、`photopea`、`photopea.integration`；`smoke` 是原有的）与 `packages/cli/test/psd.test.ts`。

#### 行为要点

- 等级：任何“必须”项不满足为 C；否则任何图层还原不过为 B；否则 A。没做过还原核对时等级为空；允许降级且渲染器不可用时改用嵌入像素渲染，结果没有核对，按 B 处理并写警告。
- `analyzePsdScreen` 的签名没变。B、C 且没有 `allowDegraded` 时抛 `E_PSD_GRADE`，`details` 含 `grade`、`fixList`、`issues`，提示里提到 `--allow-degraded`。`allowDegraded` 时，不合规或还原不过的图层按图层生成图片节点并逐条写入 `warnings`；某个图层既被当作节点自己的图又重复生成子图片节点的情况已避免。
- 一次分析只产生一个历史版本（证据和草稿同版本），撤销后干净（测试覆盖，CLI 测试也走了 `history undo`）。
- 外发档位：`egress: local` 时使用 Photopea 报 `E_PSD_EGRESS`，说明在线版需要联网；`allowDegraded` 时改用嵌入渲染器。
- 错误码：`E_PSD_GRADE`、`E_PSD_UNREADABLE`、`E_PSD_SOURCE`、`E_PSD_CONFIG`、`E_PSD_EGRESS`、`E_PSD_NO_BROWSER`、`E_PSD_PHOTOPEA_UNREACHABLE`、`E_PSD_RENDER_TIMEOUT`、`E_PSD_RENDER_FAILED`；交付包返回核心的 `E_NOT_IMPLEMENTED`，提示改交 PSD。
- 渲染缓存：`<项目>/.ui-pro/psd-render/<PSD 哈希>/<渲染器>/<图层标识>.{json,png}`；`psd lint` 的修改清单：`<项目或当前目录>/.ui-pro/psd-lint/<名称>.md`，路径放进 `views`（绝对路径、正斜杠）。核心的 `createProject` 已把 `.ui-pro/` 写进项目的 `.gitignore`，缓存和浏览器配置不会进版本库。
- `psd lint` 的“粒度”类检查未做（需要感知模型和项目规则，留到第 3 批），报告里以“未检查”注明；字体、画布尺寸在没有项目时也同样标为未检查。

#### 核对阈值（`verify.ts`，用真实 Photopea 校准）

- `PIXEL_TOLERANCE = 8`：预乘后每通道差值（0–255）。Photopea 与 Photoshop 的抗锯齿、色彩转换有 1–5 的正常浮动（`group-drop-shadows` 最大差 5），8 留出余量，同时 `effects` 里真实不一致的图层最大差值 ≥23。
- `MAX_DIFF_RATIO = 0.005`：差异像素占图层面积的比例，容许边缘零星像素。
- `MAX_UNEXPLAINED_RATIO = 0.001`：没有图层认领的差异（合成图上没有任何图层覆盖却有差别）占画布的比例。

#### Photopea 实测（`UI_PRO_PHOTOPEA=1`，本机 Edge，在线 Photopea）

只看还原核对，夹具本身不是按交付规范命名的，所以整体输入等级会因命名为 C，下表是还原核对这一项的结果。

| 夹具 | 图层数 | 还原核对 | 不通过的图层（差异比例 / 最大差值） | 渲染耗时 |
|---|---|---|---|---|
| `text-simple` | 1 | 通过（A） | 无 | 18–39 ms |
| `smart-object` | 2 | 通过（A） | 无 | 192 ms |
| `group-drop-shadows` | 3 | 通过（A） | 无（最大差值 5） | 243 ms |
| `layer-mask` | 1 | 通过（A） | 无 | 57 ms |
| `effects` | 7 | B | `other2`（0.464 / 141）、`other`（0.831 / 218）、`drop shadow`（0.294 / 74）、`inner outer glow`（0.251 / 41）、`bevel`（0.246 / 23）；`inner shadow`、`solid fill` 通过 | 152 ms |
| `fill-opacity` | 3 | B | `[#f00] Fill opacity 20% (non-TS Linear light mode)`（1.0 / 20） | 36 ms |

与 `ref/photopea/results.txt` 一致：`group-drop-shadows`、`smart-object`、`text-simple` 通过；`effects`、`fill-opacity` 有图层不通过。

耗时（同一台机器的最终一轮）：

- 启动（启动 Edge 加打开 Photopea 到就绪）：首次加载 4.1–5.8 s（本机网络状态下）；同一渲染器的后续文档约 160–310 ms（浏览器复用，只重开页面）。
- 文档载入 Photopea（`openMs`）：118–225 ms，`text-simple` 因含文字约 1 s。
- 每个图层的平均渲染耗时：6 个夹具共 17 个渲染单元、合计 719 ms，约 **42 ms/层**（范围 12–96 ms）。
- 早先网络较慢时，冷启动曾测到 17–52 s，见下一节。

#### 持久化浏览器配置：采用

做了一次对比实验：同一个 PSD 连续两次渲染，第二次复用同一份浏览器配置目录。

- 早先网络较慢时：16.4 s → 1.9 s、17.5 s → 1.05 s。
- 最终一轮（`photopea.integration.test.ts` 的缓存用例）：冷 4074 ms → 热 924 ms。
- 结论：第二次明显更快（约 4–15 倍），所以采用。

做法与理由：

- 位置选**每个项目各自一份**：`<项目>/.ui-pro/photopea-profile`（没有项目时用当前目录的 `.ui-pro/`）。理由：与渲染缓存、修改清单放在一起，删项目目录就清干净；不往用户目录写东西，不同项目之间也不会互相争用同一把锁；项目已经 `.gitignore` 了 `.ui-pro/`。代价是每个项目首次各付一次冷启动。
- 并发：浏览器配置同一时刻只能被一个浏览器进程用。用 `<配置目录>.lock`（`wx` 独占创建，写入进程号）；检测到残留的锁（进程号不存在）时接管；锁文件还没来得及写进程号时宽限 10 s。拿不到锁时**不等待**，改用一次性的干净浏览器（`profile: 'temporary'`，只是慢一些，结果相同；测试覆盖，耗时 13.5 s 中含两个渲染器）。`close()` 在成功和失败路径都会关浏览器、关服务并释放锁。
- `RenderStats.profile` 记录这次用的是 `persistent` 还是 `temporary`。

#### `fill-opacity` 失败的结论

不是归因逻辑的问题，是样例本身的问题，叠加归因规则的一个已知局限：

- 样例的画布只有 1×1 像素，三个图层都只覆盖这一个像素。差异像素归到“覆盖该像素的最上层图层”，所以只有最上面的 `[#f00] Fill opacity 20%` 被判不通过，另外两层的面积为 0，核对时空通过（`area=0`，没有像素可比）。
- 这一个像素的差值是真实的：Photopea 与 Photoshop 对“填充不透明度 + Linear light 混合”的结果最大差 20 级，超过阈值 8，所以判不通过是对的。它与 `ref/photopea/results.txt` 的结论一致。
- 归因的局限（保留，没有改）：被混合或半透明的最上层图层承担全部差异，下面真正出问题的图层可能被放过；面积为 0 的图层空通过。对美术的影响是：修改清单可能指向最上层，而不是根因所在的下层。这在真实设计稿里（图层有可观面积、重叠不多）影响很小；如需更严格，可改为对每层单独与合成图做“单层可见”的比较，但每层多一次渲染，留给后续决定。

#### 与工单的偏离和取舍

1. 渲染缓存、浏览器配置、修改清单都放在 `scratchRoot` 的 `.ui-pro/` 下；没有项目的 `psd lint <file>` 用当前目录。工单只说放在 `.ui-pro/` 下。
2. 前缀表只接受单词前缀（`^[a-z][a-z0-9]*_$`），`psd.prefixes` 配置里不符合的前缀按 `E_PSD_CONFIG` 报错。
3. 嵌入渲染器只用图层自带像素，不含图层样式、蒙版、混合模式，仅用于测试和 `allowDegraded` 兜底，所以兜底分析的结果一律不当作已核对。
4. 名称簇（同名加序号的组）靠组名识别；智能对象簇靠 `placedLayer.id`。
5. 集成测试拿的是 `benchmark/psd-fixtures/ag-psd/<夹具>/src.psd`；`packages/cli/test/psd.test.ts` 通过相对路径引用 `packages/psd/test/fixtures.ts` 的构造函数（两处都归本工单）。

#### 测试与检查

- `pnpm vitest run packages/psd`：不带环境变量 61 通过、10 跳过（7 个文件，6 通过、1 跳过）；`UI_PRO_PHOTOPEA=1` 时 71 通过。
- `pnpm vitest run packages/cli/test/psd.test.ts`：13 通过。
- `pnpm -s typecheck`：退出码 0（含 `packages/psd/test/fixtures.ts` 的 `version` → `fileVersion` 修正）。
- `pnpm exec biome check`（`packages/psd`、`packages/cli/src/commands/psd.ts`、`packages/cli/test/psd.test.ts`）：无问题。
- 清理：删除了 `probe-cache.mjs`、仓库根目录的日志文件和 `%TEMP%` 下我的临时目录；没有残留 msedge / Godot / node 子进程。

#### 需要他人修改的文件

无。

### 审核（父 agent）

通过。设 `UI_PRO_PHOTOPEA=1` 自己跑了一遍：8 个文件 84 个测试全过，测完没有残留的 Edge 进程。核对了几处容易出错的地方：文字字号乘了文字变换矩阵的缩放；本地服务只监听 `127.0.0.1`、端口随机；浏览器配置锁拿不到时改用一次性浏览器而不是等待，进程号误判的后果只是变慢；默认外发档位是 `cloud`，Photopea 默认可用。在 `effects` 夹具上跑了 `psd lint`，修改清单清楚、面向美术。

两处取舍都接受：差异归到最上层图层（单层可见比较要每层多渲染一次，等真实设计稿暴露问题再做）；浏览器配置每个项目一份。

审核时的改动：

- `report.ts` 的两条改法不再首推“改用交付助手导出交付包”：交付包现在会被拒绝（`E_NOT_IMPLEMENTED`），给美术推荐一条走不通的路会误导。改为先建议栅格化，并注明交付包暂未支持。