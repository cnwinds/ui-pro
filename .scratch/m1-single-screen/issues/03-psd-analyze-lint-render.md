# 03 PSD 分析、逐图层渲染与合规检查

Status: ready-for-agent

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
