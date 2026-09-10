# Changelog

## [1.0.1] - 2026-09-10

### 变更

- 补全 npm 包元数据：新增 `repository` / `homepage` / `bugs` 字段，使 npm 包页面可回链 GitHub 仓库与 Issue 区。

## [1.0.0] - 2026-09-06

首个正式版本，按 `PRD.md` 完整实现。

### 新增

- **旁路采集**：订阅 `session/event`，归一化 `turn/start`、`user/message`、`assistant/message`、
  `tool/call`、`tool/result`、`turn/end`、`session/title`；按会话隔离维护事件时间线。
- **快照补录**：首次收到会话事件时经 `session.snapshotEvents()` 补录插件加载前已发生的事件。
- **复盘报告**：
  - Markdown：元信息 / 会话概览 / 逐轮复盘 / 工具统计 / 报错汇总 / 原始事件流。
  - HTML：自包含单文件、light/dark/auto 主题、工具调用 `<details>` 折叠、全量 HTML 转义。
- **工具**：`export_session`（markdown/html/both）、`session_stats`（含最慢工具 Top3）、`session_clear`。
- **配置**：8 项配置（enable / autoRecord / maxContentLength / includeToolArgs / includeReasoning /
  exportFormat / htmlTheme / maxEventsPerSession），settings 服务热更新。
- **Web 面板**：`src/client.js` 浮动胶囊 + 统计卡片 + 工具分布条形 + 导出/清空；3 条 Web 路由。
- **安全**：工具入参敏感字段自动脱敏；单条文本智能截断；二进制内容仅保留元信息；单会话事件上限。
- **测试**：`test/run-all.mjs` 17 项自检（含真实 Harness 事件契约用例、XSS 转义、截断、脱敏）。

### 说明

- 事件命名按 Harness 真实契约映射（PRD 设想命名 `turn:before` 等 → 真实 `turn/start` 等）。
- 实现语言为 ESM `.mjs`（项目内既有插件范式），未引入构建链。
