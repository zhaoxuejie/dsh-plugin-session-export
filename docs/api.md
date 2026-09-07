# dsh-plugin-session-export API 文档

插件暴露：3 个面向模型的工具、3 条 Web 路由、1 个 Web Client 面板。
本文档描述每个接口的输入/输出契约；底层事件契约见 `README.md`「事件契约」一节。

## 1. 工具（ctx.tools）

### 1.1 `export_session`

导出会话复盘报告（Markdown / HTML / both）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session` | string | 否 | 目标会话 ID；缺省为最近活跃会话 |
| `format` | string | 否 | `markdown` / `html` / `both`；缺省跟随配置 `exportFormat` |

返回（`output.schema`）：

```json
{
  "format": "markdown|html|both|none",
  "content": "报告文本（format=none 时为提示语）",
  "sessionId": "目标会话 ID",
  "title": "会话标题（可为空）",
  "eventCount": 0,
  "turnCount": 0,
  "toolCallCount": 0,
  "errorCount": 0
}
```

行为要点：
- 插件停用（`enable=false`）→ `format: "none"` + 提示。
- 目标会话无记录 → `format: "none"` + 提示（含可用会话查询指引）。
- `format=both` 时返回对象附带 `html` 字段（供文件下载等场景取用）。
- 聊天流展示：Markdown 包在 ` ```markdown ` 代码块，HTML 包在 ` ```html ` 代码块。

### 1.2 `session_stats`

会话统计查询。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session` | string | 否 | 目标会话 ID；缺省返回全部会话概览 + 最近活跃 |

返回：`{ text: string }`，包含轮次、工具调用、报错、中断、总耗时、平均轮次耗时、
Token 用量；单会话模式额外给出最慢工具 Top3。

### 1.3 `session_clear`

清空会话复盘记录（不可恢复）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session` | string | 否 | 目标会话 ID；缺省清空全部 |

返回：`{ text: string }` 清空确认。

## 2. Web 路由（ctx.webServer，供 client.js / 外部消费）

| 路由 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/session-export/stats` | GET | - | `{ ok, enabled, latestSessionId, sessions: [{ sessionId, title, turnCount, toolCallCount, errorCount, interruptedCount, totalDurationMs, toolNameCounts, eventCount, stopped }] }` |
| `/session-export/export` | GET | `format=markdown\|html`、`session=<id>` | 报告文件（`content-type` 与 `content-disposition` 附件头）；无记录返回 404 JSON |
| `/session-export/clear` | POST | `session=<id>`（可选） | `{ ok, cleared }` |

## 3. Web Client（src/client.js）

- 加载方式：`package.json` 声明 `dsh.client.platform: "web"` + `exports["./client"]`，
  由 Harness clientModules 扫描注入，浏览器半经 `window.__ModuleLoader__.load({ id, factory })` 注册。
- 面板：右下角 📦 胶囊 → 展开「会话黑匣子」：状态行、统计卡片（轮次/工具/报错/中断）、
  工具调用分布条形（Top5）、导出 Markdown / HTML（Blob 下载）、清空记录（confirm 确认）。
- 数据轮询：每 3s 拉取 `/session-export/stats`（面板打开时）。

## 4. 会话事件契约（采集输入）

插件订阅（均为 cordis effect，卸载自动释放）：

```
ctx.on('session/event', (session, event) => ...)     // 核心：event = { type, seq, time, data }
ctx.on('agent/session-start', (payload) => ...)       // 会话启动/恢复
ctx.on('agent/request-error', (payload) => ...)       // 请求层错误
ctx.on('session/event', ...)                          // 标题服务补写
```

事件类型（`session/event` 的 `type`，已按 deepseek-harness 源码校准）：

| 类型 | data 结构 | 归一化产物 |
|---|---|---|
| `turn/start` | `{ turn }` | `turn_start` |
| `user/message` | 消息对象 `{ id, role, content, source }` | `user_input`（content 提取文本，标注来源） |
| `assistant/message` | `{ turn, step, message, usage?, interrupted?, stream? }` | `assistant_message`（text + reasoning 分离、usage 累计） |
| `assistant/attempt` | `{ turn, step, stream }` | `assistant_message`（中断标记） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | `tool_call`（入参解析 + 敏感字段脱敏） |
| `tool/result` | `{ turn, step, message, error?, meta? }` | `tool_result`（配对 callId 计算耗时、isError） |
| `turn/end` | `{ turn, reason }` | `turn_end`（reason.kind + error 明细） |
| `session/title` | `{ title }` | 会话标题 |
| `step/start` / `step/end` / `request/header` / `request/context` / `session/end-seed` | - | 不入复盘时间线 |

## 5. 隐私与安全

- 工具入参中以下字段名（大小写不敏感）自动掩码：`api_key / apikey / password / passwd / pwd /
  token / access_token / refresh_token / secret / client_secret / authorization / cookie /
  set-cookie / x-api-key / private_key / ssh_key / credential(s)`。
- `includeToolArgs=false` 时入参整体不保留。
- HTML 报告对所有用户可控文本做 HTML 转义（防注入）。
- 全部采集数据仅存于插件进程内存（`Map`），插件卸载即清空；`session_clear` 可手动清空。
