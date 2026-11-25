# UI-Pro

游戏 UI 智能拆分与交互编排工具箱：**CLI 内核 + 大模型 Agent**，以 **UIR + Policy + Behavior** 为真相源，支持规范驱动切分、自然语言修订、实时预览与多引擎导出。

## 文档

- **[设计方案 v2](docs/DESIGN-v2.md)** — 当前版本：架构、规范体系、还原管线、PSD 交付规范、行为、预览、Godot 导出、大模型接入、里程碑
- [设计方案 v1](docs/DESIGN.md) — 早期版本，保留作参考
- [通用默认规范包](docs/packs/default.policy.yaml) — v1 的规则格式，采纳 v2 后需要重写
- [Schema 总览](docs/schemas/overview.md) — v1 的字段约定，采纳 v2 后需要重写

## 核心主张

所有结构性工作都有明确指导原则；用户纠正会升格为项目规范并全量重算；默认包只使用通用 UI 语义，不绑定特定游戏品类。
