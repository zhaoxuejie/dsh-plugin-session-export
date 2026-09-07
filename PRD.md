# PRD：dsh-plugin-session-export 会话复盘导出插件

> 在 DeepSeek-Harness 会话中提供完整会话复盘与导出能力，插件监听会话全生命周期事件，收集每一轮思考、工具调用、报错信息，导出为美化的 Markdown / HTML 报告，方便调试 Agent、复盘任务、分享对话过程。

元信息
- 作者：自定义
- 版本：V1.0
- 状态：开发中
- 更新日期：2026-09-06

---

## 1. 背景与痛点

### 1.1 用户痛点
- Agent 跑了十几轮，一堆工具调用、思考过程，想复盘调试却找不到完整记录，原生导出只有简单 JSON，可读性极差。
- 排查 Agent 为什么出错时，需要逐轮翻看：当时模型输出了什么、调用了哪个工具、工具入参是什么、返回了什么、哪一步开始跑偏——手动翻聊天记录效率极低。
- 想把一次成功的 Agent 任务过程分享给同事/社区，缺少一份结构化、可读性强的报告。
- 长会话中工具返回的大段文本（文件内容、API 响应）直接导出会让报告爆炸，需要智能截断与过滤。
- 多轮对话中模型的中间思考（reasoning）与最终回答混在一起，复盘时难以区分。

### 1.2 目标用户
Agent 开发者、需要调试 Harness 插件的开发者、技术博主（分享 Agent 工作流）、需要留存任务执行记录的用户。

### 1.3 插件定位
一句话定位：Harness 会话黑匣子插件，**插件负责全量事件采集与结构化报告生成**；不干预 Agent 正常运行，仅做旁路记录与导出；支持一键导出当前会话为 Markdown / HTML 复盘报告。

---

## 2. 范围界定

### 2.1 ✅ V1.0 必须实现（P0）
- [ ] 监听 `turn:before` / `turn:after` 事件，采集每一轮的用户输入、模型输出、工具调用
- [ ] 监听 `tool:before` / `tool:after` 事件，采集工具名称、入参、返回结果、执行耗时、是否报错
- [ ] 监听 `plugin:unload` 事件，做资源清理
- [ ] 内存中维护当前会话的完整事件时间线（按时间戳排序）
- [ ] 提供 `export_session` 工具：导出当前会话为美化 Markdown 报告
- [ ] 提供 `export_session_html` 工具：导出为带样式的 HTML 报告
- [ ] 侧边 UI 面板：展示当前会话统计（轮次数、工具调用数、耗时、报错数）+ 一键导出按钮
- [ ] 智能截断：工具返回内容超过设定字符数自动截断，标注"已截断"
- [ ] 过滤二进制内容：图片、文件等非文本内容不导出原始数据，仅记录元信息
- [ ] 报告结构：会话概览 → 逐轮复盘（用户输入 → 模型思考 → 工具调用 → 工具返回 → 最终回答）→ 统计汇总
- [ ] 插件卸载时清空所有会话记录，无残留

### 2.2 ⭕ V1.1 后续迭代（P1，本期不做）
- [ ] 导出为 PDF（需要额外依赖，体积大）
- [ ] 会话回放功能：按时间轴逐步回放整个 Agent 执行过程
- [ ] 多会话批量导出与对比
- [ ] 导出报告自动上传到飞书文档 / Notion
- [ ] 事件搜索与过滤（按工具名、关键词、报错类型筛选）
- [ ] Token 消耗统计与成本估算

### 2.3 ❌ 不在本版本做（明确边界）
- ❌ 不修改模型输出内容，仅做旁路记录
- ❌ 不做会话持久化到磁盘（仅内存，Harness 重启后丢失）
- ❌ 不做实时远程同步（如 WebSocket 推送，属于实时日志转发插件的范畴）

---

## 3. 功能详细需求

### 3.1 用户触发方式
- 自然语言触发：`导出当前会话`、`生成复盘报告`、`会话复盘`
- 工具调用触发：`export_session()`、`export_session_html()`
- 侧边 UI 按钮：【导出 Markdown】【导出 HTML】
- 事件自动触发：插件加载后自动开始旁路记录，无需用户操作

### 3.2 全部功能列表

#### 功能1：全量事件采集（旁路，不干预）
插件加载后自动订阅以下事件，将每条事件存入内存时间线：
- `turn:before`：记录轮次开始时间、当前轮次序号
- `user:message`：记录用户原始输入文本
- `turn:after`：记录模型最终输出、轮次结束时间、本轮耗时
- `tool:before`：记录工具名称、工具入参（JSON）、调用时间
- `tool:after`：记录工具返回结果、执行耗时、是否成功、错误信息
- 所有事件带时间戳、轮次序号，保证可还原完整执行顺序

#### 功能2：会话统计
实时计算当前会话统计数据：
- 总轮次数
- 总工具调用次数
- 各工具调用次数分布
- 总耗时 / 平均每轮耗时
- 报错次数与报错列表
- 最长工具调用（耗时 Top 3）

#### 功能3：Markdown 报告导出
生成结构化 Markdown 报告，结构如下：
```
# 会话复盘报告
## 一、会话概览
- 会话ID、开始时间、结束时间、总耗时
- 总轮次数、总工具调用数、报错数
## 二、逐轮复盘
### 第1轮
- 用户输入：xxx
- 模型思考：xxx（如有 reasoning）
- 工具调用：
  - 工具A（耗时 1.2s）：入参 {...} → 返回 {...}
- 最终回答：xxx
### 第2轮 ...
## 三、工具调用统计
| 工具名 | 调用次数 | 总耗时 | 平均耗时 | 报错次数 |
## 四、报错汇总
- 时间 | 工具 | 错误信息
```

#### 功能4：HTML 报告导出
在 Markdown 结构基础上，生成带 CSS 样式的独立 HTML 文件：
- 深色/浅色主题
- 代码块语法高亮
- 工具调用折叠面板（默认折叠，点击展开查看入参/返回）
- 轮次时间轴可视化
- 可直接在浏览器打开，无需额外依赖

#### 功能5：智能截断与过滤
- 工具返回内容超过 `maxContentLength`（默认 2000 字符）自动截断，末尾标注 `[...已截断，共 X 字符]`
- 二进制内容（图片、文件）仅记录：文件名、大小、类型，不导出原始数据
- 模型 reasoning 内容超过设定长度做摘要处理
- 可配置是否导出工具入参（敏感信息保护）

#### 功能6：侧边 UI 面板
- 实时展示会话统计卡片：轮次数、工具调用数、总耗时、报错数
- 按钮：【导出 Markdown】【导出 HTML】【清空记录】
- 工具调用次数分布迷你条形图
- 不污染主聊天流

### 3.3 配置项（对应 cordis.yml schema）

| 配置key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| enable | boolean | true | 插件总开关 |
| autoRecord | boolean | true | 是否自动开始记录（插件加载即开始） |
| maxContentLength | number | 2000 | 单条工具返回内容最大导出字符数，超出截断 |
| includeToolArgs | boolean | true | 导出报告中是否包含工具入参（关闭可保护敏感信息） |
| includeReasoning | boolean | true | 是否导出模型思考过程 |
| exportFormat | string | "markdown" | 默认导出格式：markdown / html / both |
| htmlTheme | string | "light" | HTML 报告主题：light / dark |
| maxEventsPerSession | number | 500 | 单会话最大事件数，超出后停止记录（防内存溢出） |

### 3.4 UI 表现
- 侧边面板：统计卡片 + 导出按钮 + 工具分布迷你图
- 导出结果输出到聊天流：Markdown 为代码块，HTML 为文件下载链接
- 不修改模型主回答内容
- 记录过程中无任何主聊天流插入，完全静默旁路

---

## 4. 状态与数据设计

### 4.1 内存状态结构

```typescript
interface BaseEvent {
  id: string;
  timestamp: number;       // 毫秒时间戳
  turnIndex: number;       // 所属轮次序号
  type: string;            // 事件类型
}

interface UserInputEvent extends BaseEvent {
  type: "user_input";
  content: string;
}

interface ModelOutputEvent extends BaseEvent {
  type: "model_output";
  content: string;
  reasoning?: string;
}

interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
}

interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  toolName: string;
  result: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

interface TurnStartEvent extends BaseEvent {
  type: "turn_start";
}

interface TurnEndEvent extends BaseEvent {
  type: "turn_end";
  durationMs: number;
}

type SessionEvent = UserInputEvent | ModelOutputEvent | ToolCallEvent | ToolResultEvent | TurnStartEvent | TurnEndEvent;

interface SessionState {
  events: SessionEvent[];          // 事件时间线
  currentTurnIndex: number;         // 当前轮次序号
  sessionStartTime: number;         // 会话开始时间
  toolCallStats: Map<string, {      // 工具调用统计
    count: number;
    totalDurationMs: number;
    errorCount: number;
  }>;
  errorList: Array<{                // 报错列表
    timestamp: number;
    toolName: string;
    error: string;
  }>;
}
```

- 会话隔离：✅ 每个 session 独立事件时间线与统计
- 持久化：仅内存保存，不落地磁盘

### 4.2 生命周期行为

1. **插件加载 apply(ctx)**
   - 订阅全部会话事件
   - 注册导出工具
   - 注册侧边 UI 面板
   - 初始化配置

2. **插件卸载 plugin:unload**
   - 取消所有事件订阅
   - 清空所有会话的事件时间线与统计数据
   - 移除 UI 面板
   - 卸载后无任何残留状态，新会话不再被记录

### 4.3 自动休眠逻辑
- 本插件为旁路记录型，不干预 Agent 正常运行，无需自动休眠
- 当事件数达到 `maxEventsPerSession` 上限时，自动停止记录该会话，防止内存溢出
- 停止记录后侧边面板提示"事件数已达上限，已停止记录"

---

## 5. 工具与事件清单

### 5.1 注册给大模型调用的 Tool 列表

| tool名称 | 入参 | 返回 | 用途 |
|---|---|---|---|
| export_session | format?:"markdown"\|"html"\|"both" | {content:string, format:string} | 导出当前会话复盘报告 |
| session_stats | 无入参 | {turnCount:number, toolCallCount:number, totalDurationMs:number, errorCount:number} | 获取当前会话统计数据 |
| session_clear | 无入参 | {success:boolean} | 清空当前会话记录 |

### 5.2 监听 Harness 事件列表

| 事件名 | 用途 |
|---|---|
| `turn:before` | 记录轮次开始，递增轮次序号 |
| `turn:after` | 记录模型最终输出、轮次结束、计算本轮耗时 |
| `user:message` | 记录用户原始输入 |
| `tool:before` | 记录工具调用名称、入参、开始时间 |
| `tool:after` | 记录工具返回结果、耗时、是否报错 |
| `plugin:unload` | 资源清理，清空全部会话记录 |

---

## 6. 安全约束 & 异常处理

### 6.1 安全规则
- 本插件不访问本地文件、不调用 shell、不发起网络请求，无高危操作
- 仅做内存中的旁路记录，不修改任何模型输出或工具行为
- 工具入参可能包含敏感信息（API Key、密码），提供 `includeToolArgs` 配置项允许用户关闭入参导出
- 事件数有上限保护，防止内存溢出
- 导出报告仅输出到聊天流，不自动写入磁盘

### 6.2 异常场景处理

1. **事件采集失败**：单个事件采集出错不影响整体记录，打印警告后继续
2. **导出时会话为空**：返回提示"当前会话暂无记录"
3. **事件数超限**：自动停止记录，不崩溃
4. **工具返回内容为循环引用对象**：JSON 序列化时做安全处理，捕获异常后记录"[无法序列化的对象]"
5. **HTML 生成失败**：回退到 Markdown 格式导出，确保至少有一种格式可用

---

## 7. 手工测试用例

- [ ] 用例1：正常多轮对话（含工具调用），验证事件时间线完整记录
- [ ] 用例2：导出 Markdown 报告，验证结构完整、包含概览/逐轮/统计/报错四部分
- [ ] 用例3：导出 HTML 报告，验证可在浏览器打开、样式正常、工具调用可折叠
- [ ] 用例4：工具返回超长内容（>2000字符），验证导出时自动截断并标注
- [ ] 用例5：工具调用报错，验证报错信息被记录并出现在报告报错汇总中
- [ ] 用例6：关闭 includeToolArgs，验证导出报告中不包含工具入参
- [ ] 用例7：侧边面板实时展示统计数据，验证轮次数/工具调用数/耗时随对话更新
- [ ] 用例8：清空会话记录，验证事件时间线被清空、统计归零
- [ ] 用例9：插件卸载，验证所有会话记录清空、不再采集新事件
- [ ] 用例10：模拟超长会话（>500事件），验证达到上限后自动停止记录，不崩溃

---

## 8. 风险与待解决问题

| 风险 | 缓解方案 |
|---|---|
| 长会话事件数过多导致内存占用高 | 设置 maxEventsPerSession 上限 + 工具返回内容截断 |
| 工具入参包含敏感信息（API Key） | 提供 includeToolArgs 开关 + 常见敏感字段自动脱敏（如 api_key、password、token） |
| Harness 事件名或 payload 结构随版本变化 | 事件采集做容错处理，字段缺失时用占位符，不硬依赖具体字段名 |
| HTML 报告中代码高亮需要额外依赖 | 使用轻量内联 CSS，不引入第三方高亮库，保证零依赖 |

---

## 9. 交付物清单

- cordis.yml
- src/index.ts（插件入口，事件订阅与工具注册）
- src/recorder.ts（事件采集器，维护时间线）
- src/exporter-markdown.ts（Markdown 报告生成器）
- src/exporter-html.ts（HTML 报告生成器）
- src/stats.ts（会话统计计算）
- src/types.ts（类型定义）
- package.json / tsconfig.json
- docs/PRD.md（本文档）
- docs/api.md（接口文档）
- README.md 用户文档
- CHANGELOG.md
- LICENSE
