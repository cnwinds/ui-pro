# UI-Pro Schema 字段总览

本文是 [`DESIGN.md`](../DESIGN.md) 的配套说明，描述 UIR / Policy / Behavior 的核心字段约定。正式 JSON Schema 将在实现阶段落在 `packages/core/schemas/*.json`。

---

## 1. project.json

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 工程名 |
| `designSize` | `{w,h}` | 设计分辨率 |
| `sourceImage` | path | 主 UI 图 |
| `preview.port` | number | 默认预览端口 |
| `export.preferred` | string[] | 偏好引擎 |
| `textStrategy` | enum | 可覆盖默认文本策略包 |
| `policy.defaultPack` | semver | 锁定的默认包版本 |

---

## 2. UIR — scene.uir.json

### 2.1 根对象

| 字段 | 说明 |
|------|------|
| `version` | UIR schema 版本 |
| `screen` | 根 Screen 节点 |
| `patterns[]` | 已识别的 grid/list/tabs |
| `meta.analyzedAt` | 分析时间 |
| `meta.policyPackHash` | 物化时规范哈希 |

### 2.2 Node 共用字段

| 字段 | 说明 |
|------|------|
| `id` | 稳定 ID |
| `type` | 通用控件类型（见 DESIGN §5.2） |
| `name` | 显示名 |
| `rect` | 设计坐标矩形 |
| `zIndex` | 层级 |
| `parent` | 父 id |
| `children[]` | 子 id |
| `interactive` | 是否可交互 |
| `confidence` | 视觉置信度 0–1 |
| `semantics` | `{ role, tags[], ... }` 通用语义 |
| `visual` | 切图、状态图、九宫 |
| `visual.sliceMode` | `independent \| baked \| merged \| knockout` |
| `attach` | 附着锚点（角标） |
| `states` | 状态名列表 |
| `hitArea` | 点击区 |
| `decidedBy[]` | `ruleId@scope` 溯源 |
| `exceptions[]` | 节点级例外（含 rationale） |

### 2.3 semantics.role 推荐枚举（可扩展）

通用角色，**不是**品类名词：

`notification` · `enhancement` · `decoration` · `add_action` · `close` · `back` · `confirm` · `cancel` · `icon` · `value` · `title` · `background` · `frame` · `content`

业务项目可追加 tags，如 `tags: ["economy"]`，默认包不依赖它们。

### 2.4 Pattern

```json
{
  "id": "grid_slots_0",
  "kind": "grid",
  "itemType": "Slot",
  "nodeIds": ["slot_0", "slot_1"],
  "cellSize": { "w": 120, "h": 120 },
  "gap": { "x": 16, "y": 20 }
}
```

---

## 3. Policy

### 3.1 Rule

| 字段 | 说明 |
|------|------|
| `id` | 全局唯一 |
| `version` | 规则版本 |
| `salience` | 同级冲突权重 |
| `enabled` | 开关 |
| `category` | `slicing\|structure\|text\|naming\|interaction_default\|export` |
| `title` / `description` | 人读说明 |
| `when` | 匹配条件（all/any/not） |
| `then` | 决策动作 |
| `meta.universal` | 默认包必须为 true |

### 3.2 when 谓词（默认包允许集）

- `type` / `type.in`
- `semantics.role` / `semantics.tags.contains`
- `interactive`
- `pattern.kind`
- `visual.traits`
- `text.kind` / `text.length.lte`
- `geometry.*`（附着、嵌套）
- `confidence.gte`
- `id.exists` / `visual.sliceMode.exists`

### 3.3 then 动作（摘要）

- `slicing` / `nine_slice` / `keep_alpha`
- `attach` / `structure` / `states`
- `text.mode` / `hitArea`
- `naming.*` / `export.*`
- `require.decidedBy`

### 3.4 Policy Proposal（纠正升格）

| 字段 | 说明 |
|------|------|
| `status` | `proposed \| applied \| rejected` |
| `suggestedScope` | `project \| screen \| node` |
| `evidence.nodeIds` | 触发纠正的实例 |
| `impact.nodeIds` | reapply 将影响的节点 |
| `rule` | 完整或增量 rule body |

### 3.5 Node Exception

```json
{
  "ruleId": "badge.notification.independent_slice",
  "effect": "suppress",
  "rationale": "该处红点为剧情动画一体烘焙，经制作人确认",
  "author": "user",
  "at": "2026-11-25T10:00:00Z"
}
```

---

## 4. Behavior — *.beh.yaml

| 字段 | 说明 |
|------|------|
| `version` | DSL 版本 |
| `bindings[].id` | 行为 id |
| `bindings[].targets` | 节点 id 列表或 `{group|pattern|type|semantics}` 选择器 |
| `bindings[].trigger` | `onAppear \| onClick \| onToggle \| event` … |
| `bindings[].actions[]` | `playAnim \| playVFX \| playAudio \| setState \| emit` … |
| `bindings[].actions[].placeholder` | 资源未到位时允许预览占位 |

选择器必须能被 `ui-pro query` 同等解析，保证 Agent 与 CLI 一致。

---

## 5. CLI 响应信封

```json
{
  "ok": true,
  "command": "string",
  "summary": "string",
  "data": {},
  "hints": [],
  "warnings": [],
  "next": [],
  "error": { "code": "STRING", "message": "…", "options": [] }
}
```

结构性 `data` 若含规范变更，应带 `policyProposal` 与 `impact`。

---

## 6. 校验关系

```text
policy.check ──┐
uir.integrity ─┼─► validate ─► export / 正式交付
behavior.refs ─┘
```

任一失败则 `ok: false`，`export` 默认拒绝。
