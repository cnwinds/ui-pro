# 09 交付

Status: ready-for-agent

先读 `../spec.md`，其中的共享接口、“资产怎么画”（导出必须画得与参考渲染器一样，第 11 条是锚点）、并行规则对本工单同样适用。

## 归属

只改这些文件：

- `packages/adapter-godot/**`
- `packages/verify/src/gates/engine.ts`、`packages/verify/test/engine.integration.test.ts`（新建）
- `packages/cli/src/commands/export.ts`、`doctor.ts`、`skill.ts`（后两个替换占位）；`packages/cli/test/export.test.ts`、`doctor.test.ts`、`skill.test.ts`（后两个新建）
- `packages/cli/package.json` 的 `files` 字段（只在技能说明要随包发布时改）
- `skill/**`（新建，仓库根目录）

## 背景

方案 §9 全章、§13.1 的引擎一致、§14.6 定稿、§10.1 自描述、§11.5 协作协议（技能说明的依据）。第 2 批工单 `../m1-single-screen/issues/04-godot-export.md` 及其审核意见。

第 2 批的导出从基准图按框裁图兜底（`referenceCropSource`），有子节点的按钮、面板的像素会画两遍；所有节点只按父节点左上角定位，没有锚点；也不检查门禁。本工单把它变成真正的交付。

06（资产）和 08（渲染器、门禁）同时在做。测试用手写的资产清单和 PNG，通过 `applyOps` 的 `assets` 选项写进项目（写法见 `packages/core/test/assets.test.ts`）；`assertVerified`、`openRenderSession` 还是占位时用 `vi.mock('@ui-pro/verify', …)`、`vi.mock('@ui-pro/renderer', …)`。

## 要做的事

### 1. 导出用构建出的资产

- 资产来自资产清单，不再从基准图裁。一个资产可能被多个节点使用（组件实例、乘色变体），在 Godot 工程里只写一份，按资产名命名。
- 只给归属为 `asset` 的节点贴图（`pixelOwnership`）。`baked` 的节点照常导出为节点（它可能可交互、要绑定数据），但不贴图。
- 放置按“资产怎么画”第 4 条：`inset`、拉伸、九宫。九宫用 `NinePatchRect`（按钮用带样式盒的 `Button`），补丁边距取资产记录的 `nineSlice`；九宫资产的密度是 1，文件像素等于设计像素。
- `inset` 在 Godot 里怎么实现（调整节点矩形，还是加一个工具拥有的子节点）由你决定，但要满足：画面与参考渲染器一致；锚点和点击区域仍以节点的 `rect` 为准；不破坏三方合并。在 Comments 里说明选择。
- 乘色用 `self_modulate`，子节点不受影响。
- 状态：按钮的 `pressed`、`disabled`、`hover` 等状态资产写进 `TextureButton` 对应的贴图属性。没有资产的状态按 `press.feedback` 由运行时处理，M1 记一条近似项即可。
- 进度条按“资产怎么画”第 8 条：映射到 `TextureProgressBar` 的 `texture_under` 和 `texture_progress`，还是保留填充子节点，由你决定；值满时画面要与参考渲染器一致。在 Comments 里说明。
- 字体：项目配置 `fonts` 里的字体文件复制进 Godot 工程，`LabelSettings.font` 指向它；没有对应文件的字体记近似项，写法照现有的字号近似项。
- 导入设置：像素风（预检的风格档案）用最近邻过滤，其余线性；无损压缩。
- CLI 不再使用 `referenceCropSource`。函数如果只剩测试在用，就删掉，测试改用手写资产。

### 2. 锚点

按 spec 第 11 条，把每个节点的锚点和偏移写进场景（`anchor_*`、`offset_*`；`stretch` 两侧都锚定）。设计尺寸下画面与现在完全一样；改变窗口尺寸时与 `layoutScreen` 的结果一致。

新建的 Godot 工程（`prepareGodotProject`）设 `display/window/stretch/mode="canvas_items"`、`display/window/stretch/aspect="expand"`。已有的工程不改，由 `doctor` 检查。

### 3. 导出前检查门禁

`ui-pro export godot` 先调用 `assertVerified`：没跑过、没通过或通过之后又改过，都拒绝导出，错误信息照它给的。不提供绕过门禁的开关（方案 §13.1）。

### 4. 导出报告

方案 §9.4 和 §14.6 列的全部内容：

- 生成了什么；门禁结果（来自门禁记录）；
- 占位：基元类型还没有对应控件的，以及没有资产的；
- 近似项：资产清单里的和导出计划里的合在一起，注明节点；
- 节点例外：规则文档里的例外及理由；
- 云端图像模型用量：外发记录里这个界面的调用次数。

CLI 的 `warnings` 只放需要人看的要点，完整内容在报告文件里。

### 5. 引擎一致门禁 `runEngineGate`

- 导出到 `.ui-pro/engine/<界面>/`：工具自建的临时 Godot 工程，只含运行时包，用兼容渲染器（方案 §9.1）。像 `--shot` 那样带窗口运行并截图，尺寸是界面的设计尺寸。
- 用传进来的 `RenderSession` 在 `scale: 1` 下渲染同尺寸的帧，比较：
  - 动态文字的框以外：结构相似度和平均色差，阈值写成常量；
  - 动态文字：墨迹外接框的交并比和主体颜色。Skia 与 Godot 的字体光栅化差异不算失败。
- 三联对比图（参考渲染 | 引擎截图 | 热力图）写到 `.ui-pro/verify/<界面>/engine.png`。
- Godot 没装时 `skipped`，理由里写怎么安装、怎么设 `UI_PRO_GODOT`；Godot 运行出错时 `fail`，问题里带 Godot 的错误行。
- 第 2 批审核留下的“截图差值的门禁阈值”就在这里定：在 Comments 里报告阈值和实测值。

### 6. `doctor`

`ui-pro doctor` 在项目外也能跑，在项目里多查项目相关的项。每一项是 `ok`、`warn` 或 `fail`，带怎么修：

- Node 版本；sharp、`@napi-rs/canvas`、`onnxruntime-node` 能否加载；opencv.js 能否初始化；OCR 模型是否就绪；
- Godot：`UI_PRO_GODOT` 或 PATH 里能否找到，版本不低于 4.6；
- Photopea 要用的 Edge 或 Chrome；
- 本地感知模型是否已下载：`createModelStore().has(name)`，07 还没实现时这一项报 `warn`“无法检查”；
- 云端图像模型：外发档位，`DASHSCOPE_API_KEY` 有没有设置。只说有没有，绝不输出它的值；
- 项目：`fonts` 指向的文件存在；配置了 `export.godot.project` 时，检查那个 Godot 工程的设计分辨率和拉伸模式是否与项目一致，不一致给建议（工具不改工程设置，方案 §9.5）。

有 `fail` 时命令仍然 `ok: true`，`summary` 说有几项要处理。不做慢的检查（下载模型、打开浏览器）。

### 7. 技能说明与 `skill` 命令

仓库根目录 `skill/ui-pro/SKILL.md`，需要时加 `reference/*.md`。读者是外部 Agent（Cursor、Claude Code、Codex）：

- 什么时候用：把游戏界面的拍平图或 PSD 变成 Godot 界面；
- 工作流：`init` → `analyze` → `look` → 审校切分规划（一次 `apply` 提交一批操作，先 `--dry-run`）→ `rules check` → `build` → `verify` → `export godot`。每一步看什么，怎么读响应（`summary`、`warnings`、`ask`、`views`、`next`）；
- 协作协议（方案 §11.5）：`ask` 里的问题必须转述给用户，不替用户决定；看图用 `look` 的编号，不自己估坐标，框不准时用 `snap`；纠正按 §5.5 的六步走，适用范围要问用户；
- 红点纠正的完整例子（方案 §14.4）；
- 常见错误码和处理办法。

只写已经存在的命令和参数，照 `ui-pro schema` 和各命令的 `--help` 写。第 3 批其他工单还在做的命令（`build`、`verify`、`snap`）按它们工单里的接口写，父 agent 合并后会核对。

命令：

- `ui-pro skill show`：打印 SKILL.md。
- `ui-pro skill install [--target cursor|claude|codex] [--global]`：复制到项目里的 `.cursor/skills/ui-pro/`、`.claude/skills/ui-pro/` 或 `.agents/skills/ui-pro/`；`--global` 时装到用户目录下的对应位置。目标已存在且内容不同时覆盖，并在 `warnings` 里说明。响应列出写了哪些文件。
- 技能文件要随 npm 包发布：确认从源码运行和从构建产物运行时都能找到它。

## 验收

- adapter-godot 单元测试：
  - 导出计划用资产清单：共享资产只写一份、`baked` 不贴图、`inset`、九宫、乘色、状态、进度条、字体；
  - 锚点：九个方向和 `stretch` 的 `anchor_*`、`offset_*` 取值。
- Godot 集成测试（`UI_PRO_GODOT`）：
  - 手写资产的界面导出后截图，与基准图一致；
  - 改变窗口尺寸（宽度不变、高度加长）截图，贴底的节点仍然贴底，位置与 `layoutScreen` 一致；
  - 再次导出仍保留用户的改动（第 2 批的三方合并测试继续通过）。
- 引擎一致门禁的集成测试：手写资产的界面通过；故意弄错一个节点的锚点或贴图后失败。
- CLI：
  - 没通过门禁时拒绝导出（`E_NOT_VERIFIED`）；导出报告的内容；
  - `doctor` 的响应结构，用假的环境变量构造缺 Godot、缺密钥的情况；
  - `skill show`；`skill install` 写到临时目录。
- 在 Comments 里报告：引擎一致门禁的阈值与实测值；导出一个中等界面的耗时；`inset` 和进度条的实现选择；技能说明里哪些地方要等其他工单完成后核对。
