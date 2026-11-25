# 01 规则引擎与默认规则包

Status: ready-for-agent

先读 `../spec.md`，其中的并行规则和共享接口对本工单同样适用。

## 归属

只改这些文件：

- `packages/rules/**`
- `packages/cli/src/commands/rules.ts`（替换占位）
- `packages/cli/src/plugins.ts`：只在 `registerPlugins()` 里加一行注册调用
- `packages/cli/test/rules.test.ts`（新建）

## 背景

方案 §5 全章、§6.4、§10.3 的“规则”家族；`CONTEXT.md` 的“规则与决定”一节。核心是 §5.1 的三类决定里的**裁决**：每个节点的每个适用决策点，有且只有一条规则生效，同样的事实必然得到同样的决定。

`docs/packs/default.policy.yaml` 是 v1 的草稿，用的是 `salience` 权重和 `then:` 块，**格式不要沿用**（§5.3 明确不用隐式权重）。里面的规则内容可以参考。

## 要做的事

### 1. 文档格式

- `rules/project.yaml`（项目规则）和 `screens/<界面>/rules.yaml`（界面规则）的 zod schema。`packages/core/src/project/codecs.ts` 里的 `INITIAL_PROJECT_RULES`、`INITIAL_SCREEN_RULES` 必须能被解析。
- 规则的写法见 §5.3：`id`、`point`（决策点）、`when`（条件）、`value`、`because`（必填）、`examples`（节点引用 `<界面>/#<id>`）。
- **节点例外**写在界面规则里：节点、决策点、取值、`because`（必填，非空）。
- 项目规则里能停用某条规则（含默认规则包的规则），停用必须写理由。每个决策点的兜底规则不能停用，否则就不再是全函数。
- 用 `registerDocKind` 注册这两类文档，规则类操作通过 `ctx.doc()` / `ctx.setDoc()` 读写，这样 `--dry-run`、原子提交和撤销自动成立。

### 2. 决策点目录与条件语言

- §5.2 表格里的全部决策点，每个带取值集合和**适用范围**（例如 `text.mode` 只适用于文字节点，`fill.mode` 只适用于进度类，`press.feedback` 只适用于可交互节点）。
- `when` 是声明式的条件，键的集合固定并写成文档（放在 `packages/rules` 的 README 或代码注释里）。至少要能表达默认规则包需要的事实：基元类型、通用角色（支持 `badge.*` 这样的前缀匹配）、概念、可变性（空 / 非空 / 包含某项）、是否可交互、文字种类（`text.kind`）、重复性（同一相似簇的节点数）、父节点的类型与角色、几何关系（例如“附着在宿主上的小元素”需要有明确的几何定义）。
- **可变性**：节点的 `varies` 非空时用它；为空时按 §5.4 的表由通用角色推出默认值。
- **具体程度**＝条件里谓词的个数。同一规则层内，具体程度最高的胜出；并列且取值不同就是**歧义**。

### 3. 求值

- 规则层从低到高：默认规则包 → 项目规则 → 界面规则，高者胜；节点例外压过所有规则层（§5.3）。
- 同样的输入必须得到同样的结果，不依赖文件里规则的书写顺序。
- 有歧义的决策点不写决定，并给出警告；`rules check` 把它列为失败。不要悄悄选一个。

### 4. 默认规则包

- 放在 `packages/rules` 里，随产品发布，格式与项目规则相同。
- 覆盖 §5.2 的每个决策点：每个点一条无条件的兜底规则，加上 §5.4 那张“通用角色 → 默认处理”表推导出的规则。
- 通用性约束（§5.4）：条件只能用基元类型、通用角色、可变性、几何关系、文字种类、重复性、是否交互；不能出现概念、品类词、具体文案或坐标。

### 5. 钩子

- `beforeCommit`：重算每个界面每个节点的 `decisions`（`{ value, by }`，`by` 是规则 id 或 `exception`）。没有变化的界面不会被写入，事务会自己判断。这样任何一次提交（包括分析写入的草稿）之后，决定都是最新的，`--dry-run` 也能看到规则变更会改动哪些节点。
- `rename`：节点改名时，节点例外跟着改。
- 节点被删除后，指向它的节点例外在 `beforeCommit` 里移除，并用 `ctx.warn` 说明。

### 6. 操作（family `rules`）

按 §5.5 的流程设计，名字沿用 §10.3：

- `rule.propose`：Agent 根据用户的纠正提出一条规则。写入项目规则的待定区，不生效；通过 `ctx.warn` 给出影响清单（各界面哪些节点的哪个决策点会从什么变成什么）；通过 `ctx.ask` 问适用范围，`id: 'scope'`，选项 `project` / `screen` / `node`，默认 `project`。
- `rule.adopt`：按选定的范围让规则生效：`project` 写入项目规则，`screen` 写入指定界面的界面规则。可以引用待定区里的 id，也可以直接给出规则。生效后从待定区移除。
- `rule.disable`：停用一条规则，必须写理由。
- `exception.add`：用选择器指定节点，写入节点例外，必须写理由。

每个操作都要有清楚的中文 `summary`，`ui-pro schema` 能列出参数。需要 `rule.remove`、`exception.remove` 的话一并加上。

### 7. CLI：`ui-pro rules`

- `rules list`：列出生效的规则。可以按决策点、规则层筛选，也能看待定区和已停用的规则。
- `rules why <选择器>`：逐个决策点列出取值、生效的规则、被压过的规则（§5.6 末尾）。
- `rules check`：§5.6 的六项检查。“无漂移”依赖第 3 批的资产构建，现在报告为跳过并说明原因；“规则不回归”现在就能做：重算每条规则的 `examples`，结果变了就是回归。任何一项失败时 `ok: false`，错误码自定（例如 `E_RULES_CHECK`），`details` 里列出每条问题。
- `rules lint`：检查规则文件的格式、引用的决策点和取值是否存在，以及默认规则包和项目规则的通用性约束（项目规则可以用概念，默认规则包不行）。

### 8. 注册

`@ui-pro/rules` 导出一个 `registerRules(registry)`，在 `registerPlugins()` 里对 `defaultRegistry` 调用。必须幂等。

## 验收

- 在 `packages/cli/test/helpers.ts` 的 `treeProject` 上：任何一次 `apply` 之后，每个节点的每个适用决策点都有决定，`by` 指向真实存在的规则。
- §5.5 的“红点”流程能完整走通，并写成测试：`#badge_dot` 默认得到 `attach.split = independent`；`rule.propose` 一条把概念“红点”烘焙的项目规则，返回影响清单和 `scope` 提问，不改任何决定；`rule.adopt --dry-run` 的 `changes` 能看出哪些节点的 `decisions` 会变；正式执行后决定改变，`history undo` 后恢复。
- 歧义：同一规则层里两条同样具体、取值不同的规则，`rules check` 失败并指出这两条规则和受影响的节点。
- 节点例外没有理由时操作被拒绝；节点改名后例外跟着走；节点删除后例外被移除并有警告。
- 同一个相似簇里的节点在事实相同时得到相同的决定（同判同治）。
- `rules lint` 能抓出默认规则包里出现的概念、坐标或品类词。
- 默认规则包对每个决策点都是全函数：写一个测试，对每种基元类型、每个通用角色构造节点，断言所有适用决策点都有决定。

## Comments
