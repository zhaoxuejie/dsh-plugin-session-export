// dsh-plugin-session-export — 配置 schema 与解析
// 配置项设计对齐 PRD 第 3 节"配置设计"，通过 settings 服务支持运行时热更新（applies: "live"）。
import Schema from "schemastery";

/** 默认配置（PRD 3.3 默认值）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enable: true,
  autoRecord: true,
  maxContentLength: 2000,
  includeToolArgs: true,
  includeReasoning: true,
  exportFormat: "markdown",
  htmlTheme: "light",
  maxEventsPerSession: 500,
});

/** 配置 schema（schemastery，供 settings 面板渲染）。 */
export const Config = Schema.object({
  enable: Schema.boolean()
    .description("插件总开关。关闭后停止采集与工具注册，已采集数据保留。")
    .default(DEFAULT_CONFIG.enable),
  autoRecord: Schema.boolean()
    .description("自动记录：插件加载后自动旁路采集所有会话事件；关闭则需手动调用 session_export 工具采集。")
    .default(DEFAULT_CONFIG.autoRecord),
  maxContentLength: Schema.number()
    .min(200)
    .max(100000)
    .description("单条文本内容（用户输入/模型回复/工具入参与返回）导出最大字符数，超出部分智能截断。")
    .default(DEFAULT_CONFIG.maxContentLength),
  includeToolArgs: Schema.boolean()
    .description("导出是否包含工具调用入参。关闭时仅保留工具名与耗时，不保留入参。")
    .default(DEFAULT_CONFIG.includeToolArgs),
  includeReasoning: Schema.boolean()
    .description("导出是否包含模型思考过程（reasoning 块）。")
    .default(DEFAULT_CONFIG.includeReasoning),
  exportFormat: Schema.union([
    Schema.const("markdown"),
    Schema.const("html"),
    Schema.const("both"),
  ])
    .description("默认导出格式：markdown / html / both（聊天流展示用）。")
    .default(DEFAULT_CONFIG.exportFormat),
  htmlTheme: Schema.union([
    Schema.const("light"),
    Schema.const("dark"),
    Schema.const("auto"),
  ])
    .description("HTML 报告配色主题。")
    .default(DEFAULT_CONFIG.htmlTheme),
  maxEventsPerSession: Schema.number()
    .min(50)
    .max(100000)
    .description("单个会话最多采集的事件条数，超出后停止记录并标记（防止内存无限增长）。")
    .default(DEFAULT_CONFIG.maxEventsPerSession),
}).description("DeepSeek Harness 会话黑匣子：会话事件采集与复盘报告导出");

/** 深度合并 + 白名单过滤，得到运行时配置。 */
export function resolveConfig(entry = {}) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const out = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  // 数值防御：越界值钳制到合法区间（下限/上限）
  if (!Number.isFinite(out.maxContentLength)) out.maxContentLength = DEFAULT_CONFIG.maxContentLength;
  else out.maxContentLength = Math.min(100000, Math.max(200, Math.floor(out.maxContentLength)));
  if (!Number.isFinite(out.maxEventsPerSession)) out.maxEventsPerSession = DEFAULT_CONFIG.maxEventsPerSession;
  else out.maxEventsPerSession = Math.min(100000, Math.max(50, Math.floor(out.maxEventsPerSession)));
  return out;
}
