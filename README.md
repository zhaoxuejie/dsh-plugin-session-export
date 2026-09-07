# dsh-plugin-session-export

DeepSeek Harness 会话黑匣子插件：全量旁路采集会话事件（轮次 / 用户输入 / 模型回复 / 工具调用 / 报错），
一键导出**美化 Markdown / HTML 复盘报告**，并内置会话统计工具与侧边 UI 面板。

> 需求来源：`PRD.md`（见 `docs/PRD.md`）。实现严格对齐 DeepSeek Harness 真实事件契约
> （以 `deepseek-harness` 源码为准，见下文「事件契约」）。

## 功能特性

| 能力 | 说明 |
|---|---|
| 旁路采集 | 订阅 `session/event`，按会话隔离维护事件时间线与统计，不侵入 agent 循环 |
| 快照补录 | 插件加载后首次收到某会话事件时，用 `session.snapshotEvents()` 补录插件加载前的事件 |
| 复盘报告 | 一键导出 Markdown / HTML（自包含、内联样式、深浅主题、工具调用可折叠） |
| 会话统计 | 轮次、工具调用次数/分布、总耗时、平均轮次耗时、最慢工具 Top3、报错、中断、Token 用量 |
| 智能截断 | 单条文本超 `maxContentLength` 自动截断并标注，二进制内容只保留元信息 |
| 敏感脱敏 | 工具入参中 `api_key / token / password / secret / authorization / cookie` 等字段自动掩码 |
| 配置热更新 | settings 服务 `applies: "live"`，改动即时生效 |
| 侧边面板 | Web Client 浮动面板：统计卡片、工具分布条形、导出、清空（`src/client.js`） |
| 隐私清理 | `session_clear` 工具 / 面板按钮一键清空全部会话记录 |

## 快速开始

### 安装

将 `dsh-plugin-session-export` 目录放入 Harness 项目级插件目录（与 `dsh-plugin-obsidian` 同级），
在 Harness 组合的 `cordis.patch.yml` 中追加挂载：

```yaml
- insert:
    - id: dsh-plugin-session-export
      name: dsh-plugin-session-export
```

安装依赖：

```bash
npm install   # 安装 schemastery（settings 面板 schema 渲染）
```

### 使用

- 插件加载后即自动开始旁路采集（`autoRecord: true`）。
- 对话过程中随时可用工具：`export_session`、`session_stats`、`session_clear`。
- Web 界面右下角出现 📦 胶囊按钮，点击展开「会话黑匣子」面板。

## 配置项

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | `true` | 插件总开关（关闭后停止采集与工具执行，已采集数据保留） |
| `autoRecord` | boolean | `true` | 自动旁路采集；关闭则需手动调用工具触发 |
| `maxContentLength` | number | `2000` | 单条文本导出最大字符数（200–100000） |
| `includeToolArgs` | boolean | `true` | 是否保留工具入参（关闭后仅保留工具名与耗时） |
| `includeReasoning` | boolean | `true` | 是否包含模型思考过程（reasoning 块） |
| `exportFormat` | `markdown\|html\|both` | `markdown` | 工具缺省导出格式 |
| `htmlTheme` | `light\|dark\|auto` | `light` | HTML 报告配色主题 |
| `maxEventsPerSession` | number | `500` | 单会话事件上限（50–100000），超出停止记录并标记 |

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `export_session` | `session?`（会话 ID，缺省最近活跃）、`format?`（markdown/html/both） | 复盘报告内容 + 会话元信息（轮次/工具/报错统计） |
| `session_stats` | `session?`（缺省返回全部会话概览） | 统计文本：轮次、工具、耗时、最慢工具 Top3、Token |
| `session_clear` | `session?`（缺省清空全部） | 清空确认 |

## 报告结构（PRD 2.1）

1. **报告元信息**：导出时间、格式、会话标题
2. **会话概览**：会话 ID、起止时间、总耗时、轮次、工具调用、报错、中断、平均轮次耗时、Token 用量
3. **逐轮复盘**：每轮 = 用户输入 → 思考/工具调用链 → 模型回复 → 轮次结束状态（完成/报错/中断…）与耗时
4. **工具调用统计**：工具名 / 调用次数 / 平均耗时 / 最长耗时
5. **报错汇总**：时间 / 轮次 / 类型（模型请求/工具执行）/ 错误消息
6. **原始事件流**：完整采集时间线（文本按配置截断）

示例报告见 `docs/sample-report.md`（Markdown）与 `docs/sample-report.html`（HTML，深色主题）。

## 事件契约（对齐 DeepSeek Harness 真源码）

PRD 中的设想事件名（`turn:before` 等）与 Harness 实际事件不同，实现按真实契约映射：

| PRD 设想 | Harness 真实事件（`session/event`） | 说明 |
|---|---|---|
| `turn:before` | `turn/start` `{ turn }` | 轮次开始 |
| `turn:after` | `turn/end` `{ turn, reason }` | reason.kind: `completed/aborted/blocked/error/max-tokens/interrupted` |
| `user:message` | `user/message`（data 即消息对象） | content 为 ContentBlock[]，source.kind 区分用户/插件注入 |
| 模型回复 | `assistant/message` `{ turn, step, message, usage?, interrupted? }` | 含 text/reasoning/tool-call 块 |
| `tool:before` | `tool/call` `{ turn, step, callId, name, arguments }` | arguments 为 JSON 字符串 |
| `tool:after` | `tool/result` `{ turn, step, message, error?, meta? }` | message.content[0] 为 tool-result 块，配对 callId 计算耗时 |
| `plugin:unload` | `ctx.effect` 清理 | 订阅即 effect，卸载自动释放 |

补充订阅：`agent/session-start`（会话启动/恢复）、`agent/request-error`（请求层错误）、`session/title`（标题）。

## 目录结构

```
dsh-plugin-session-export/
├── cordis.patch.yml        # bundle patch：向 web 组合挂载插件
├── package.json            # 包定义 + dsh.client 声明（web 平台）
├── src/
│   ├── index.mjs           # 插件入口：事件订阅 / 工具注册 / Web 路由 / settings / 清理
│   ├── config.mjs          # 配置 schema（schemastery）+ resolveConfig
│   ├── recorder.mjs        # 会话采集器：事件归一化 / 配对 / 统计 / 截断 / 快照补录
│   ├── stats.mjs           # 统计计算（纯函数）
│   ├── exporter-markdown.mjs
│   ├── exporter-html.mjs
│   ├── types.mjs           # 共享常量与工具函数（脱敏 / 文本提取 / 安全序列化 / 转义）
│   └── client.js           # Web 侧边面板（零依赖浏览器 bundle）
├── docs/
│   ├── PRD.md              # 需求文档副本
│   ├── api.md              # 接口文档
│   ├── sample-report.md    # 示例报告（Markdown）
│   └── sample-report.html  # 示例报告（HTML，深色主题）
├── test/run-all.mjs        # 18 项自检测试（node --test）
├── CHANGELOG.md
└── LICENSE                 # MIT
```

## 测试

```bash
npm test   # 或 node --test test/run-all.mjs
```

覆盖：配置解析、脱敏、截断、文本提取、真实 Harness 事件契约采集（正常/错误/中断/上限）、
工具配对耗时、快照补录、统计、Markdown/HTML 导出、XSS 转义、插件入口冒烟（注册/执行/清理）。

## 与 PRD 的说明性差异

1. **语言**：PRD 交付物清单写 `src/index.ts`，项目内既有插件统一使用 `src/*.mjs`（零构建 ESM），
   本插件遵循项目范式，避免引入构建链。
2. **挂载文件**：PRD 写 `cordis.yml`，Harness 实际使用 bundle patch 机制（`cordis.patch.yml`，
   与 `dsh-plugin-obsidian` 等一致）。
3. **事件命名**：按上方「事件契约」映射到 Harness 真实事件。
4. **enable 语义**：工具仍注册但执行时返回停用提示（工具注册表要求 schema 静态），采集与执行行为按开关生效。
