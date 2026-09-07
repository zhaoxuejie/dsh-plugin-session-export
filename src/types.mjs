// dsh-plugin-session-export — 共享类型常量与纯工具函数（零依赖）
// 内容块 / 消息结构契约对齐 @deepseek-ai/dsh-llm（已真源码校准）：
//   TextBlock {type:'text',text} / ReasoningBlock {type:'reasoning',text}
//   ImageBlock {type:'image',attachment:{attachmentId,mediaType,bytes,width,height,name?}}
//   ToolCallBlock {type:'tool-call',id,name,arguments} / ToolResultBlock {type:'tool-result',toolCallId,content,isError?}

/** 报告内部统一事件类型（把 Harness 原始事件归一化为复盘语义）。 */
export const EVENT_TYPES = Object.freeze({
  TURN_START: "turn_start",
  USER_INPUT: "user_input",
  ASSISTANT_MESSAGE: "assistant_message",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  TURN_END: "turn_end",
  SESSION_ERROR: "session_error",
});

/** 工具入参/返回中需要脱敏的敏感字段名（大小写不敏感、支持前缀匹配）。 */
export const SENSITIVE_KEYS = Object.freeze([
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "pwd",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "authorization",
  "cookie",
  "cookie2",
  "set-cookie",
  "x-api-key",
  "private_key",
  "privatekey",
  "ssh_key",
  "credential",
  "credentials",
]);

const SENSITIVE_RE = new RegExp(`^(?:${SENSITIVE_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i");

/** 判断键名是否为敏感字段。 */
export function isSensitiveKey(key) {
  return typeof key === "string" && SENSITIVE_RE.test(key.trim());
}

/**
 * 安全 JSON 序列化：处理循环引用 / BigInt / 无法序列化的值。
 * 失败时返回 "[无法序列化的对象]"，绝不抛出。
 */
export function safeStringify(value, space = 2) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      function replacer(_key, val) {
        if (typeof val === "bigint") return `${val}n`;
        if (typeof val === "function" || typeof val === "symbol" || val === undefined) return undefined;
        if (val !== null && typeof val === "object") {
          if (seen.has(val)) return "[循环引用]";
          seen.add(val);
        }
        return val;
      },
      space,
    );
  } catch {
    return "[无法序列化的对象]";
  }
}

/**
 * 递归提取 ContentBlock[] 的纯文本（text + reasoning 拼接）。
 * 二进制块（image）只保留元信息标记，不导出原始数据。
 */
export function extractBlockText(blocks, maxLen = Infinity) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push(typeof block.text === "string" ? block.text : "");
        break;
      case "reasoning":
        parts.push(typeof block.text === "string" ? block.text : "");
        break;
      case "image": {
        const a = block.attachment && typeof block.attachment === "object" ? block.attachment : null;
        const meta = a
          ? `[图片: ${a.name || "未命名"} · ${a.mediaType || "未知类型"} · ${a.bytes ?? 0} 字节 · ${a.width ?? "?"}×${a.height ?? "?"}]`
          : "[图片]";
        parts.push(meta);
        break;
      }
      case "tool-call":
        parts.push(`[工具调用: ${block.name}]`);
        break;
      case "tool-result":
        parts.push(extractBlockText(block.content, maxLen));
        break;
      default:
        // 未知块：尝试抽取可读字段，保持健壮
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.content !== "undefined") parts.push(extractBlockText(block.content, maxLen));
        else parts.push(`[${block.type || "未知内容块"}]`);
    }
    let total = 0;
    for (const p of parts) total += p.length;
    if (total > maxLen) break;
  }
  let out = parts.join("");
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

/**
 * 工具返回内容截断：超过 max 字符时保留前缀并追加截断标注。
 * 返回 { text, truncated, originalLength }。
 */
export function truncateContent(text, max) {
  const src = typeof text === "string" ? text : safeStringify(text, 2);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;
  if (src.length <= limit) return { text: src, truncated: false, originalLength: src.length };
  return {
    text: `${src.slice(0, limit)}\n\n[...已截断，共 ${src.length} 字符]`,
    truncated: true,
    originalLength: src.length,
  };
}

/**
 * 对工具入参做脱敏（深度拷贝，替换敏感字段的值）。
 * includeToolArgs=false 时调用方可直接丢弃入参；这里负责"开启动态脱敏"。
 */
export function maskSensitive(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) {
      out[k] = maskValueByType(v);
    } else if (v !== null && typeof v === "object") {
      out[k] = maskSensitive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskValueByType(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    if (v.length <= 4) return "****";
    return `${v.slice(0, 2)}****${v.slice(-2)}`;
  }
  if (typeof v === "number" || typeof v === "boolean") return "****";
  if (Array.isArray(v)) return v.map(() => "****");
  return "[已脱敏]";
}

/** 毫秒 → 人类可读时长（如 1.2s / 3m 5s）。 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1000) return `${n.toFixed(0)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** 毫秒时间戳 → 本地时间字符串。 */
export function formatTime(ts, withDate = false) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (!withDate) return hm;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** 会话 ID 短显示：保留前后缀。 */
export function shortSessionId(id) {
  if (typeof id !== "string" || id.length <= 16) return id || "-";
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

/** HTML 转义（所有用户内容进 HTML 前必须过这里，防注入）。 */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
