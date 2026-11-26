# 01 规则引擎与默认规则包

Status: resolved

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

### 交付说明（实现代理）

**做了什么**

- `packages/rules`：规则文档 schema 与两类 `DocKind`（`rules/project.yaml`、`screens/<界面>/rules.yaml`，`INITIAL_*` 能解析）；18 个决策点的目录（取值集合 + 适用范围）；17 个键的 `when` 条件语言（文档在 `packages/rules/README.md`）；通用角色表与默认可变性；节点事实的纯函数计算（附着、位置、形状、等距、重复、跨界面等，阈值是 `src/facts.ts` 的常量）；三层求值（界面 → 项目 → 默认规则包，节点例外压过全部，具体度 = 谓词个数，歧义不写决定，停用，兜底规则受保护）；默认规则包 44 条（每个决策点恰有一条无条件兜底 + §5.4 推导出的规则）；`beforeCommit`（重算全部 `decisions`，清理失效的节点例外并警告，歧义警告）与 `rename` 钩子；操作 `rule.propose`、`rule.adopt`、`rule.disable`、`rule.enable`、`rule.remove`、`exception.add`、`exception.remove`、`rule.recompute`；`rules check` 六项、`rules lint`、`rules list`、`rules why` 的库函数；幂等的 `registerRules(registry)`。
- `packages/cli/src/commands/rules.ts`：`ui-pro rules list | why | check | lint`（替换占位）。`packages/cli/src/plugins.ts`：加了一行 `registerRules(defaultRegistry)` 和对应两行 import。
- 测试：`packages/rules/test` 8 个文件 130 条（含原有的 smoke），`packages/cli/test/rules.test.ts` 20 条，共 150 条全部通过。

**验收对照**

- `treeProject` 上任何一次 `apply` 之后，每个适用决策点都有决定，`by` 全部是 `*@default`（CLI 测试和包内测试各一条）。
- §5.5 红点流程：`#badge_dot` 默认 `attach.split = independent`（`attach.varies-independent@default`）；`rule.propose` 一条概念“红点”烘焙的项目规则，返回影响清单（`main/#badge_dot 的 attach.split：independent → baked`）和 `scope` 提问（`project`/`screen`/`node`，默认 `project`），不改任何决定；`rule.adopt --dry-run` 的 `changes` 里 `badge_dot` 的 `decisions` 在变；正式执行后改变；`history undo` 后恢复。包内测试里还有一条用角色条件的版本。
- 歧义：`rules check` 失败（`E_RULES_CHECK`），`details.checks` 里 `无歧义` 的问题列出两条规则和受影响的节点。
- 节点例外无理由被拒绝（`E_OP_INVALID`）；改名后例外跟着走；删除节点后例外移除并警告。
- 同一相似簇里事实相同的节点得到相同的决定（引擎是纯函数，另有 2 万组随机事实的“默认规则包永不歧义”测试和按基元类型 × 通用角色的全函数测试）。
- `rules lint` 抓出默认规则包里的概念、品类词、坐标、像素尺寸、非通用角色、样例、缺失或重复的兜底规则。

**实测数据**

- 默认规则包 44 条，覆盖 18 个决策点，每点一条兜底。
- `treeProject`：7 个节点共 49 个决定。
- 一个 402 节点的界面：`evaluate` 8 ms，`checkRules` 14 ms，无变化的 `rule.recompute` 提交 149 ms。同一界面 401 次 `node.add` 的一次 `apply` 用 2.4 s，时间花在核心逐条操作后的整界面校验上，与规则钩子无关（钩子只在提交前跑一次）。

**与工单不一致或超出的地方**

- 多做了 `rule.enable`（恢复被停用的规则）和 `rule.recompute`（空操作，靠 `beforeCommit` 刷新；手工改过规则文件后用）。`rule.remove`、`exception.remove` 按工单允许加上。
- `rename` 钩子除了节点例外，还会改写规则（项目规则、待定区、界面规则）的 `examples`，否则改名后“规则不回归”会找不到样例。
- `rule.adopt` 的 `scope` 只收 `project`/`screen`；“仅这一个节点”走 `exception.add`（`rule.propose` 的提问里三个选项都有）。
- 工单没有规定 `when` 的全部键，我定了 17 个：`type role concept varies interactive textKind repeat parentType parentRole attached overVariable position shape childrenEven touchSmall lowRes crossScreen`，几何的定义和阈值写在 README 与 `src/facts.ts`。
- 默认规则包里依赖测量的取值不替项目做主：`variant.mode` 兜底 `variant-assets`（`tint` 要等着色还原达标，由项目规则改），`fill.mode` 兜底 `clip`，`state.source` 兜底 `derive`（`generate` 由项目规则改），`stretch.mode` 只在 `varies: size` 时 `nine-slice`，不推 `three-slice`。
- 错误码在本包定义：`E_RULE_INVALID`（决策点或取值不合法，也用于不能停用界面规则）、`E_RULE_NOT_FOUND`、`E_RULE_EXISTS`、`E_RULE_PROTECTED`、`E_RULES_CHECK`、`E_RULES_LINT`。参数本身不合法（缺 `because` 等）仍是核心的 `E_OP_INVALID`。
- `rules list`、`rules why` 加了 `--limit`/`--offset`（`list`）与 `--limit`（`why`），沿用 `query` 的分页习惯。
- “同形同判”检查做的是：同一相似簇的节点基元类型和通用角色必须一致；事实相同则决定相同由引擎保证并有测试。核心里目前没有“簇被拆分”的记录，所以没有检查“拆分后各部分的决定是否一致”。
- “规则不回归”：样例节点已不存在只给警告；`rule.propose`/`rule.adopt` 里写了不存在的样例节点则直接拒绝。
- “无漂移”按工单报告为 `skipped`，原因写明要等资产构建。

**没做的**

- 无漂移检查（依赖第 3 批资产构建）。
- `ui-pro rules` 没有写规则的子命令；增删规则一律走 `ui-pro apply`，与工单一致。

**需要父 agent 决定**

1. 上面几个依赖测量的兜底取值（`variant.mode`、`fill.mode`、`state.source`）要不要改成更激进的默认。
2. 是否把 `rules check` 的“完备”接进 `ui-pro verify` 或 `build` 的前置检查（现在只在 `rules check` 里）。
3. 核心是否要给“簇拆分”留数据结构，好让“同形同判”能覆盖到。

**对非本人文件的修改请求**

- 核心：不需要改动，全部绕过。
- `packages/cli/test/helpers.ts` 的 `treeProject` 应在播种前调用 `registerPlugins()`。现在播种用的是默认注册表，进程里第一次 `runCli` 之前还没有规则钩子，所以每个测试文件的第一个测试播种出的节点没有 `decisions`，随后的第一次 `apply` 会一次改动全部节点；`apply.test.ts` 的第一条测试因此对“修改 1”的断言会失败（之后的测试因为已注册而通过，依赖执行顺序）。
- `packages/cli/test/schema.test.ts` 的“lists every operation”断言只有 14 个操作，现在多了 8 个 `rules` 族操作（共 22 个），要更新断言和 `共 14 个操作`。
- 这两条是现在仅有的已知回归，我没有改这些文件。另外 `packages/psd/test/fixtures.ts(125,15)` 有一个类型错误，不是本工单的文件。

### 审核（父 agent）

通过。求值（节点例外压过规则层、只在有匹配的最高层里按条件数比较、并列不同值即歧义、与书写顺序无关）、默认规则包（每点一条兜底、条件只用通用事实）、钩子与操作都与工单一致。在临时项目上用示例图手动走了一遍 §5.5 红点流程：`rules why` → `rule.propose`（影响清单 + scope 提问）→ `rule.adopt --dry-run` → 采纳 → `rules check` → `history undo`，结果都对。

对“需要父 agent 决定”的答复：

1. 依赖测量的兜底值（`variant.mode`、`fill.mode`、`state.source`）维持保守。测量要到第 3 批才有，现在没有依据做更激进的默认。
2. “完备”“无歧义”接进第 3 批 `build` 的前置检查：资产构建依赖决定，有歧义或缺决定时拒绝构建。
3. 核心暂不加“簇拆分”的数据结构，等出现拆分操作时再加。

审核时的改动：

- 按你的请求修了两处回归：`packages/cli/test/helpers.ts` 的 `treeProject` 先调用 `registerPlugins()` 再播种；`schema.test.ts` 的操作清单更新到 22 个。
- 留给第 3 批：决定之间有联动（例如红点改为 `attach.split = baked` 后，`occlusion.fill` 仍是 `fill`），资产构建要把相关决定放在一起解释，不能逐条照做。