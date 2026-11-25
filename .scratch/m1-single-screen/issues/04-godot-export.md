# 04 导出到 Godot

Status: ready-for-agent

先读 `../spec.md`，其中的并行规则和共享接口对本工单同样适用。

## 归属

只改这些文件：

- `packages/adapter-godot/**`，包括随包发布的 GDScript（例如 `packages/adapter-godot/godot/addons/ui_pro/`）
- `packages/cli/src/commands/export.ts`（替换占位）
- `packages/cli/test/export.test.ts`（新建）

## 背景

方案 §9 全章，重点是 §9.1 约定、§9.2 引擎内构建器、§9.3 可重复导出、§9.5 基元映射。`CONTEXT.md` 的“导出”一节：Godot 工程、导出产物、导出报告、适配器、运行时包。本机只有 Godot 4.6.1，代码按 4.6 的接口写（不用 4.7 才有的 `offset_transform_*`）。

首选引擎内构建器而不是在引擎外拼 `.tscn` 文本：由引擎校验属性、分配资源标识，并且能在已有场景上就地更新。`../ref/godot/` 里有跑通过的无界面构建、导入和截图脚本。

## 要做的事

### 1. 命令

`ui-pro export godot [--to <目录>] [--shot]`，界面用全局的 `--screen`。

- §9.2 写的是 `--project <路径>`，但 `--project` 已经是全局选项（UI-Pro 项目目录），所以这里用 `--to`。默认取 `ui-pro.yaml` 的 `export.godot.project`，相对路径以项目根目录为准。都没有时报错并提示两种写法。
- 目标目录不存在或为空时，新建一个最小的 Godot 工程：`project.godot` 用兼容渲染器，视口等于项目的设计分辨率。目录非空但没有 `project.godot` 时拒绝。已有的 Godot 工程，工具不改它的设置（§9.5“适配”）。
- 找 Godot：先看环境变量 `UI_PRO_GODOT`，再看 PATH 里的 `godot`、`godot4`。找不到时错误码 `E_GODOT_NOT_FOUND`，提示怎么设置。用 `--version` 检查不低于 4.6。

### 2. 导出规格

TypeScript 一侧把界面规格转成给构建器的 JSON：

- 节点树、每个节点的 Godot 类型（§9.5 的 Godot 列，这一批覆盖 `container`、`image`（有九宫时用 `NinePatchRect`）、`text`（`Label` 加 `LabelSettings`）、`button`、`progress`；其余基元先导出为 `Control` 占位，并写进导出报告）。
- 位置和尺寸：设计像素，相对父节点。
- 节点名由 `id` 转成大驼峰（`btn_upgrade` → `BtnUpgrade`），文件名用小写下划线（§9.1）。
- 每个节点设 `unique_name_in_owner`，元数据 `ui_pro_id` 写节点 `id`（§9.3）。
- 文字：内容、字号、颜色、描边、阴影、对齐，按 `TextSpec` 能给的给。

这部分要有不依赖 Godot 的单元测试。

### 3. 资产

资产构建在第 3 批。适配器接收一个资产来源（节点 → PNG 字节或没有），不关心资产从哪来。这一批 CLI 传一个兜底来源：从基准图（`referenceImagePath`）按节点的框裁出来，缩放到设计像素，只给图片类的叶子节点。导出报告把这些资产标为近似。资产写到 Godot 工程的 `ui/<界面>/assets/`。

### 4. 构建器

1. `godot --headless --path <工程> --import`，让引擎导入资产。
2. `godot --headless --path <工程> --script res://addons/ui_pro/<构建器>.gd -- <规格 JSON>`。构建器用引擎接口搭出节点树并保存为 `ui/<界面>/<界面>.tscn`。
3. **就地更新**（§9.3）：场景已经存在时加载它，按元数据 `ui_pro_id` 匹配节点，只改工具拥有的属性。没有 `ui_pro_id` 的节点（用户自己加的）和用户挂的脚本、加的属性保留。界面规格里已经删除的节点，从场景中移除并写进报告。冲突列入报告，不静默覆盖。
4. 构建器脚本随包发布，导出时复制到 Godot 工程的 `addons/ui_pro/`。

Godot 的标准输出和错误输出要收集起来；进程失败或输出里有 `ERROR:` 时，把相关行放进错误的 `details`。退出时的资源泄漏警告（见 `../ref/godot/build.err.txt`）不算错误。

### 5. 截图

`--shot`：以带窗口的方式运行一次，等几帧后截图（无界面模式不渲染，截不出图），存到 `.ui-pro/look/<界面>-godot.png`，放进 `views`。顺便算出与基准图的平均差值写进 `data`，门禁在第 3 批。

### 6. 导出报告

写到 UI-Pro 项目的 `export/<界面>.godot.json`（不进历史）：生成了哪些文件、各节点的 Godot 类型、占位的基元、近似的资产、移除的节点、冲突。`data` 里返回摘要。

## 验收

- 单元测试：基元映射、坐标换算（相对父节点、设计像素）、命名转换、规格 JSON 的结构。
- Godot 集成测试在找不到 Godot 时跳过（`describe.skipIf`），找得到时：
  - 用 `packages/cli/test/helpers.ts` 的 `treeProject` 导出到临时目录；场景能被 `godot --headless --path <工程> --quit` 无错误加载；`.tscn` 里每个节点都有 `ui_pro_id` 和唯一名。
  - 在导出的场景里加一个没有 `ui_pro_id` 的节点（用一段 GDScript 或直接编辑 `.tscn`），并给某个节点挂一个脚本；改动界面规格后再导出：用户的节点和脚本还在，改动生效，删除的节点被移除并出现在报告里。
  - `--shot` 生成截图。
- 在 Comments 里报告：一次导出的耗时（导入、构建分别多少），以及 `treeProject` 截图的路径，父 agent 会看图审核。

## Comments
