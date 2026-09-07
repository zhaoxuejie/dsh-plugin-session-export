// dsh-plugin-session-export — Markdown 复盘报告生成器
// 报告结构对齐 PRD 2.1：元信息 → 会话概览 → 逐轮复盘 → 工具统计 → 报错汇总 → 原始事件流
import { EVENT_TYPES, formatDuration, formatTime, safeStringify, shortSessionId } from "./types.mjs";

/**
 * 生成 Markdown 复盘报告。
 * @param {object} snap 采集器快照（SessionRecorder.snapshot()）
 * @param {object} stats 统计（computeStats 输出）
 * @param {object} opts { includeRawEvents?: boolean, generatedAt?: number }
 * @returns {string} Markdown 文本
 */
export function renderMarkdownReport(snap, stats, opts = {}) {
  const events = snap.events ?? [];
  const s = snap.stats ?? {};
  const st = stats ?? {};
  const generatedAt = opts.generatedAt ?? Date.now();
  const L = [];

  // ---- 1. 报告元信息 ----
  L.push("# 会话复盘报告", "");
  L.push(`> 导出时间：${formatTime(generatedAt, true)} · 导出格式：Markdown`);
  if (snap.title) L.push(`> 会话标题：${snap.title}`);
  if (snap.stopped) L.push(`> ⚠️ 本会话已触发事件上限（${snap.maxEvents} 条），记录不完整`);
  L.push("");

  // ---- 2. 会话概览 ----
  L.push("## 会话概览", "");
  L.push("| 项目 | 值 |");
  L.push("|---|---|");
  L.push(`| 会话 ID | \`${shortSessionId(snap.sessionId)}\` |`);
  L.push(`| 开始时间 | ${snap.firstEventTime !== null ? formatTime(snap.firstEventTime, true) : "-"} |`);
  L.push(`| 最后活动 | ${snap.lastEventTime !== null ? formatTime(snap.lastEventTime, true) : "-"} |`);
  L.push(`| 总耗时 | ${formatDuration(s.totalDurationMs ?? 0)} |`);
  L.push(`| 轮次数 | ${s.turnCount ?? 0} |`);
  L.push(`| 工具调用 | ${s.toolCallCount ?? 0} 次（${(st.toolStats ?? []).length} 种）|`);
  L.push(`| 报错 | ${s.errorCount ?? 0} 次 |`);
  L.push(`| 中断 | ${s.interruptedCount ?? 0} 次 |`);
  L.push(`| 平均轮次耗时 | ${formatDuration(st.avgTurnMs ?? 0)} |`);
  const tu = s.tokenUsage ?? {};
  L.push(`| Token 用量 | 输入 ${tu.promptTokens ?? 0} / 输出 ${tu.completionTokens ?? 0} / 合计 ${tu.totalTokens ?? 0} |`);
  L.push("");

  // ---- 3. 逐轮复盘 ----
  L.push("## 逐轮复盘", "");
  const groups = groupByTurn(events);
  if (groups.before.length) {
    L.push("### 轮次外事件", "");
    L.push("> 以下事件发生在任何轮次边界之前（插件加载早期）。", "");
    for (const evt of groups.before) renderEvent(L, evt);
    L.push("");
  }
  const turnNos = Object.keys(groups.turns).map(Number).sort((a, b) => a - b);
  if (!turnNos.length && !groups.before.length) {
    L.push("_暂无事件记录。_", "");
  }
  for (const turn of turnNos) {
    const evts = groups.turns[turn];
    renderTurn(L, turn, evts, st);
    L.push("");
  }

  // ---- 4. 工具调用统计 ----
  L.push("## 工具调用统计", "");
  const toolStats = st.toolStats ?? [];
  if (!toolStats.length) {
    L.push("_本次会话无工具调用。_", "");
  } else {
    L.push("| 工具 | 调用次数 | 平均耗时 | 最长耗时 |");
    L.push("|---|---|---|---|");
    for (const t of toolStats) {
      L.push(`| \`${t.name}\` | ${t.calls} | ${formatDuration(t.avgMs)} | ${formatDuration(t.maxMs)} |`);
    }
  }
  L.push("");

  // ---- 5. 报错汇总 ----
  L.push("## 报错汇总", "");
  const errors = snap.errors ?? [];
  if (!errors.length) {
    L.push("_本次会话无报错。_", "");
  } else {
    L.push("| 时间 | 轮次 | 类型 | 错误消息 |");
    L.push("|---|---|---|---|");
    for (const e of errors) {
      L.push(`| ${formatTime(e.time, true)} | ${e.turn ?? "-"} | ${e.source === "turn" ? "模型请求" : "工具执行"} | ${String(e.message ?? "").replace(/\|/g, "\\|")} |`);
    }
  }
  L.push("");

  // ---- 6. 原始事件流（可选）----
  if (opts.includeRawEvents !== false) {
    L.push("## 原始事件流", "");
    L.push("> 按采集时序排列的完整事件时间线（文本已按配置截断）。", "");
    L.push("```text");
    for (const evt of events) {
      L.push(formatRawLine(evt));
    }
    L.push("```");
    L.push("");
  }

  return L.join("\n");
}

/** 按轮次分组事件。 */
function groupByTurn(events) {
  const turns = {};
  const before = [];
  for (const evt of events) {
    if (evt.turn === undefined || evt.turn === null) { before.push(evt); continue; }
    if (!turns[evt.turn]) turns[evt.turn] = [];
    turns[evt.turn].push(evt);
  }
  return { turns, before };
}

/** 渲染单个轮次。 */
function renderTurn(L, turn, evts, st) {
  const start = evts.find((e) => e.kind === EVENT_TYPES.TURN_START);
  const end = evts.find((e) => e.kind === EVENT_TYPES.TURN_END);
  const duration = start && end && end.time >= start.time ? end.time - start.time : null;
  const label = end ? end.endLabel : "进行中";
  L.push(`### 第 ${turn} 轮${duration !== null ? `（${formatDuration(duration)}）` : ""}${label ? ` · ${label}` : ""}`, "");
  for (const evt of evts) {
    if (evt.kind === EVENT_TYPES.TURN_START || evt.kind === EVENT_TYPES.TURN_END) continue;
    renderEvent(L, evt);
  }
}

/** 渲染单个事件（用户输入/模型回复/工具调用链）。 */
function renderEvent(L, evt) {
  switch (evt.kind) {
    case EVENT_TYPES.USER_INPUT:
      L.push(`**${evt.sourceLabel ?? "用户输入"}**（${formatTime(evt.time)}）`, "");
      if (evt.text) L.push("> " + String(evt.text).split("\n").join("\n> "), "");
      else L.push("_（空内容）_", "");
      L.push("");
      break;
    case EVENT_TYPES.ASSISTANT_MESSAGE:
      if (evt.text) {
        L.push(`**模型回复${evt.model ? ` · ${evt.model}` : ""}**${evt.interrupted ? "（中断）" : ""}（${formatTime(evt.time)}）`, "");
        L.push(String(evt.text), "");
        L.push("");
      }
      break;
    case EVENT_TYPES.TOOL_CALL: {
      const args = evt.args;
      const argLine = args === null
        ? "（入参未记录）"
        : "入参：```json\n" + safeStringify(args) + "\n```";
      L.push(`**工具调用：\`${evt.toolName}\`**（${formatTime(evt.time)}）`, "");
      L.push(argLine, "");
      break;
    }
    case EVENT_TYPES.TOOL_RESULT: {
      const dur = evt.durationMs !== null && evt.durationMs !== undefined ? ` · 耗时 ${formatDuration(evt.durationMs)}` : "";
      const flag = evt.isError ? " ❌ 执行失败" : "";
      L.push(`→ 返回${flag}${dur}：`, "");
      L.push("```text");
      L.push(String(evt.text));
      L.push("```", "");
      break;
    }
    default:
      break;
  }
}

/** 原始事件流单行。 */
function formatRawLine(evt) {
  const t = formatTime(evt.time);
  const turn = evt.turn !== undefined && evt.turn !== null ? `#${evt.turn}` : "--";
  switch (evt.kind) {
    case EVENT_TYPES.TURN_START: return `[${t}] 轮次 ${turn} 开始`;
    case EVENT_TYPES.TURN_END: return `[${t}] 轮次 ${turn} 结束（${evt.endLabel ?? evt.endKind}）`;
    case EVENT_TYPES.USER_INPUT: return `[${t}] 轮次 ${turn} 用户输入：${oneLine(evt.text, 80)}`;
    case EVENT_TYPES.ASSISTANT_MESSAGE: return `[${t}] 轮次 ${turn} 模型回复${evt.interrupted ? "（中断）" : ""}：${oneLine(evt.text, 80)}`;
    case EVENT_TYPES.TOOL_CALL: return `[${t}] 轮次 ${turn} 工具调用 ${evt.toolName}：${oneLine(safeStringify(evt.args), 60)}`;
    case EVENT_TYPES.TOOL_RESULT: return `[${t}] 轮次 ${turn} 工具返回${evt.isError ? "（错误）" : ""}${evt.durationMs !== null ? `（${formatDuration(evt.durationMs)}）` : ""}：${oneLine(evt.text, 80)}`;
    default: return `[${t}] ${evt.kind}`;
  }
}

function oneLine(s, max) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  if (str.length <= max) return str || "(空)";
  return str.slice(0, max) + "…";
}
