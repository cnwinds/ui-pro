# @ui-pro/rules

规则引擎与默认规则包：给每个节点在每个适用的决策点上算出唯一的决定，并记下是哪条规则给出的。引擎是纯函数：同样的节点事实和同样的规则，永远得到同样的决定，与规则在文件里的先后无关。

```ts
import { registerRules } from '@ui-pro/rules';
registerRules(registry); // 幂等：文档类型、rules 族操作、两个钩子
```

CLI 入口：`ui-pro rules list | why | check | lint`，规则的增删改走 `ui-pro apply`（见“操作”）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `packages/rules/pack/default.rules.yaml` | 默认规则包（`@default`），随产品发布，只读 |
| `rules/project.yaml` | 项目规则（`@project`）、待定区 `pending`、停用清单 `disabled` |
| `screens/<界面>/rules.yaml` | 界面规则（`@screen:<界面>`）和节点例外 `exceptions` |

三个文件的规则条目相同：

```yaml
- id: attach.badge-baked          # 小写字母开头，可含 . _ -；同一层内唯一
  point: attach.split             # 决策点，必须在目录里
  when: { role: badge.*, attached: true }   # 条件，省略或 {} 表示无条件
  value: baked                    # 取值，必须是该决策点允许的值
  because: 红点画在底板描边上      # 必填的理由
  examples: [main/#badge_dot]     # 可选：促成这条规则的节点，`rules check` 会重放
```

节点例外和停用都必须写 `because`：

```yaml
exceptions:
  - { node: badge_dot, point: attach.split, value: baked, because: 这个红点画在描边上 }
disabled:
  - { rule: hit.small-padded@default, because: 本项目的热区够大 }
```

决定写在节点的 `decisions` 里：`{ value, by }`，`by` 是规则引用（`<id>@default`、`<id>@project`、`<id>@screen:<界面>`）或 `exception`。

## 求值

对一个节点的一个决策点：

1. 有节点例外就用它，`by` 为 `exception`。
2. 否则从高到低找规则层：界面规则、项目规则、默认规则包。第一个有规则命中的层决定结果，低层的命中规则只记为“被高层压过”。
3. 同一层内，条件数最多的规则胜出（具体度 = `when` 里键的个数，一个列表只算一个条件）。
4. 同一层内具体度最高的规则有多条且取值不同，就是**歧义**：这个点不写决定，`rules check` 报错并点名两条规则和受影响的节点。取值相同则取引用较小的一条。
5. 被停用的规则（`disabled`）不参与；每个决策点在默认规则包里的兜底规则（无条件、id 以 `fallback` 结尾）不能停用，所以每个适用的点总有决定。

`ui-pro rules why <选择器>` 逐点列出每条命中规则的结局：`winner`、`tied`、`less-specific`、`lower-layer`、`exception`、`ambiguous`、`disabled`。

## 条件语言 `when`

所有键都必须成立（与）。能写“一个或多个”的键，写列表表示“其中之一”。

| 键 | 取值 | 成立当 |
| --- | --- | --- |
| `type` | 基元类型或列表 | 节点类型在其中 |
| `role` | 通用角色或列表，`badge.*` 匹配前缀 | 节点有角色且匹配 |
| `concept` | 概念名或列表 | 节点有概念且在其中（默认规则包不许用） |
| `varies` | `empty`、`non-empty`，或可变性（`visibility content state motion size`）或列表 | 节点的可变性（自己没写就取角色默认值）为空 / 非空 / 含其中之一 |
| `interactive` | 布尔 | 节点可交互：button、toggle、toggle-group、slider、input、scroll、list，或角色是 button / toggle / tab |
| `textKind` | `value label title` 或列表 | 文字节点的种类 |
| `repeat` | `{ min?, max? }` | 同一相似簇（或同一组件的实例）在本界面的节点数落在范围内；不属于簇时为 1 |
| `parentType` / `parentRole` | 同 `type` / `role` | 父节点的类型 / 角色 |
| `attached` | 布尔 | 附着：父节点不是根也不是 container，二者的矩形相交，且节点面积不超过父节点的 25% |
| `overVariable` | 布尔 | 压在会变化的元素上：画在它之后、与它相交、且不是它的子孙（container 不算） |
| `position` | `top-left top top-right left center right bottom-left bottom bottom-right fill` | 节点在父节点里的位置：中心落在哪一个三分格；同时盖住父节点宽高的 95% 以上为 `fill` |
| `shape` | `square wide tall` | 长边与短边之比不超过 1.2 为 `square`，否则按宽高 |
| `childrenEven` | 布尔 | 有 3 个以上同尺寸子节点，各占一格，行列等距（容差 2 像素） |
| `touchSmall` | 布尔 | 矩形短边小于 44 设计像素 |
| `lowRes` | 布尔 | 界面的源文件分辨率低于设计分辨率（`scale` 大于 1） |
| `crossScreen` | 布尔 | 节点的资产、组件或概念在其他界面里也出现 |

这些几何阈值是 `src/facts.ts` 里的常量，不由规则文件配置。条件里不能写坐标、像素尺寸和品类词，`rules lint` 在默认规则包里强制检查。

## 决策点目录

取值只能是下表列出的；`naming.*` 的取值是命名模板（小写字母、数字、`_`、`-` 和 `{prefix}` `{semantic}` `{index}`）。

| 决策点 | 取值 | 适用于 |
| --- | --- | --- |
| `attach.split` | `independent baked` | 附着在宿主上的节点 |
| `content.split` | `separate baked` | 有子节点的节点，container 除外 |
| `decor.merge` | `merge separate` | image 节点，根节点除外 |
| `occlusion.fill` | `fill none` | 根节点和 container 以外的节点 |
| `text.mode` | `dynamic bitmap-font bitmap` | text 节点 |
| `repeat.mode` | `component independent` | 属于相似簇或组件实例的节点 |
| `variant.mode` | `tint variant-assets` | 同上且自带像素 |
| `stretch.mode` | `nine-slice three-slice fixed` | image、button、toggle、input |
| `fill.mode` | `resize clip radial` | progress、slider |
| `state.source` | `derive generate placeholder` | 可交互，或可变性含 `state` |
| `press.feedback` | `scale tint none` | 可交互 |
| `hit.area` | `visible padded` | 可交互 |
| `layout.anchor` | 九个位置、`stretch` | 非根节点 |
| `layout.flow` | `flow absolute` | 有两个以上子节点 |
| `scale.source` | `native upscale redraw` | 自带像素的节点 |
| `atlas.group` | `screen shared` | 自带像素的节点 |
| `naming.node` | 命名模板 | 全部节点 |
| `naming.asset` | 命名模板 | 自带像素的节点 |

“自带像素”指除 container、text、instance、particle 以外的基元类型。

## 通用角色表

默认规则包只能引用这张表里的角色，表同时给出各角色的默认可变性（节点自己的 `varies` 为空时生效）。游戏专有的名字写在概念里。

| 角色 | 默认可变性 |
| --- | --- |
| `background` `decoration` `title` `icon` | 无（`icon` 在 `slot` 里时为 `content`） |
| `panel` `frame` `progress` | `size` |
| `label` `value` `slot` `badge.mark` `list-item` | `content` |
| `button` `toggle` `tab` | `state` |
| `badge.notification` | `visibility` |
| `badge.count` | `visibility content` |
| `figure` `surface` | `motion` |

## 操作（`ui-pro schema` 可查参数）

| 操作 | 作用 |
| --- | --- |
| `rule.propose` | 写入待定区（暂不生效），列出它按整个项目生效时每处决定的变化，并询问范围 `scope`：`project`（默认）、`screen`、`node` |
| `rule.adopt` | 让规则生效：`id` 取自待定区，或直接给 `rule`；`scope` 为 `project` 或 `screen` |
| `rule.disable` / `rule.enable` | 停用 / 恢复默认规则包或项目规则（停用必须写理由，兜底规则不能停用） |
| `rule.remove` | 删除项目规则（含待定区）或界面规则；默认规则包只能停用 |
| `exception.add` / `exception.remove` | 给选择器命中的节点写入 / 移除节点例外 |
| `rule.recompute` | 按现行规则重算全部决定；手工改过规则文件后用它刷新 |

## 钩子

- `beforeCommit`：每次提交前按现行规则重写全部节点的 `decisions`，所以任何操作之后决定都是最新的，`--dry-run` 的 `changes` 也能看出规则变更会动哪些节点。节点已不存在的节点例外在这里一并移除并给出警告；有歧义的点给出警告。
- `rename`：节点例外和规则的 `examples` 跟着节点的新 id 走。

## 检查

`ui-pro rules check`（失败时错误码 `E_RULES_CHECK`，`details.checks` 里逐项列出问题）：

| 项 | 检查什么 |
| --- | --- |
| 完备 | 每个适用的点都有与现行规则相符的决定，没有多余或指向不存在规则的决定 |
| 无歧义 | 没有同层同样具体而取值不同的规则同时命中 |
| 无漂移 | 尚未实现，要等资产构建能产出实际资产（状态为 `skipped`） |
| 同形同判 | 同一相似簇里的节点基元类型和通用角色一致 |
| 例外有据 | 节点例外和停用都有理由，指向的节点、决策点和取值都存在 |
| 规则不回归 | 各规则的样例在现行规则下仍得到该规则的取值；样例节点已不存在只给警告 |

`ui-pro rules lint`（失败时 `E_RULES_LINT`）检查规则文件本身：格式、决策点与取值、同层条件完全相同的规则、停用清单；对默认规则包还强制通用性（不含概念、品类词、坐标或像素尺寸，角色只用通用角色表，不带样例，每个点恰有一条兜底规则）。

## 错误码

`E_RULE_INVALID`（决策点或取值不合法）、`E_RULE_NOT_FOUND`、`E_RULE_EXISTS`、`E_RULE_PROTECTED`（兜底规则不能停用）、`E_RULES_CHECK`、`E_RULES_LINT`。

## 测试

```
pnpm vitest run packages/rules
pnpm vitest run packages/cli/test/rules.test.ts
```
