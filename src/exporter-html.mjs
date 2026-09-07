// dsh-plugin-session-export — HTML 复盘报告生成器
// 自包含单文件：内联 CSS、支持 light/dark/auto 主题、工具调用可折叠、全部文本经 HTML 转义。
import { EVENT_TYPES, escapeHtml, formatDuration, formatTime, safeStringify, shortSessionId } from "./types.mjs";

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#57606a;--card:#f6f8fa;--border:#d0d7de;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--warn:#9a6700;--code:#f6f8fa;--reason:#8250df}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--warn:#d29922;--code:#161b22;--reason:#bc8cff}}
.theme-dark{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--warn:#d29922;--code:#161b22;--reason:#bc8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:32px 16px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:15px;margin:20px 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.card .k{color:var(--muted);font-size:12px}
.card .v{font-size:18px;font-weight:600;margin-top:2px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--card)}
code{background:var(--code);border-radius:4px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:10px 12px;overflow:auto;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
blockquote{border-left:3px solid var(--border);margin:8px 0;padding:4px 12px;color:var(--muted);white-space:pre-wrap}
.dur{color:var(--muted);font-size:12px}
.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:500}
.badge.ok{background:rgba(26,127,55,.12);color:var(--ok)}
.badge.err{background:rgba(207,34,46,.12);color:var(--err)}
.badge.warn{background:rgba(154,103,0,.14);color:var(--warn)}
.badge.run{background:rgba(9,105,218,.12);color:var(--accent)}
details.tool{margin:8px 0;border:1px solid var(--border);border-radius:6px;background:var(--card)}
details.tool summary{cursor:pointer;padding:8px 12px;font-weight:600;user-select:none}
details.tool .body{padding:4px 12px 12px}
.reason{color:var(--reason)}
.muted{color:var(--muted)}
.sep{height:1px;background:var(--border);margin:24px 0}
footer{color:var(--muted);font-size:12px;margin-top:40px;text-align:center}
`;

/**
 * 生成 HTML 复盘报告。
 * @param {object} snap 采集器快照
 * @param {object} stats computeStats 输出
 * @param {object} opts { theme?: 'light'|'dark'|'auto', includeRawEvents?: boolean, generatedAt?: number }
 * @returns {string} 完整 HTML 文档
 */
export function renderHtmlReport(snap, stats, opts = {}) {
  const events = snap.events ?? [];
  const s = snap.stats ?? {};
  const st = stats ?? {};
  const generatedAt = opts.generatedAt ?? Date.now();
  const theme = opts.theme ?? "light";
  const themeClass = theme === "dark" ? "theme-dark" : "";
  const title = snap.title ? `会话复盘报告 · ${snap.title}` : "会话复盘报告";

  const parts = [];
  parts.push("<!DOCTYPE html>");
  parts.push(`<html lang="zh-CN" class="${themeClass}">`);
  parts.push("<head>");
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(`<title>${escapeHtml(title)}</title>`);
  parts.push(`<style>${CSS}</style>`);
  parts.push("</head>");
  parts.push('<body><div class="wrap">');

  // ---- 元信息 ----
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  parts.push(`<div class="meta">导出时间：${formatTime(generatedAt, true)} · 格式：HTML${theme === "auto" ? "" : ` · 主题：${theme}`}</div>`);
  if (snap.stopped) {
    parts.push(`<div class="badge warn">⚠️ 已触发事件上限（${snap.maxEvents} 条），记录不完整</div>`);
  }

  // ---- 概览卡片 ----
  parts.push('<div class="grid">');
  const cards = [
    ["会话 ID", `<code>${escapeHtml(shortSessionId(snap.sessionId))}</code>`],
    ["开始时间", snap.firstEventTime !== null ? formatTime(snap.firstEventTime, true) : "-"],
    ["最后活动", snap.lastEventTime !== null ? formatTime(snap.lastEventTime, true) : "-"],
    ["总耗时", formatDuration(s.totalDurationMs ?? 0)],
    ["轮次数", String(s.turnCount ?? 0)],
    ["工具调用", `${s.toolCallCount ?? 0} 次`],
    ["报错", String(s.errorCount ?? 0)],
    ["中断", String(s.interruptedCount ?? 0)],
    ["平均轮次耗时", formatDuration(st.avgTurnMs ?? 0)],
  ];
  for (const [k, v] of cards) parts.push(`<div class="card"><div class="k">${escapeHtml(k)}</div><div class="v">${v}</div></div>`);
  const tu = s.tokenUsage ?? {};
  parts.push(`<div class="card"><div class="k">Token 用量</div><div class="v" style="font-size:13px">输入 ${tu.promptTokens ?? 0} · 输出 ${tu.completionTokens ?? 0} · 合计 ${tu.totalTokens ?? 0}</div></div>`);
  parts.push("</div>");

  // ---- 逐轮复盘 ----
  parts.push("<h2>逐轮复盘</h2>");
  const groups = groupByTurn(events);
  if (groups.before.length) {
    parts.push("<h3>轮次外事件</h3>");
    for (const evt of groups.before) parts.push(renderEventHtml(evt));
  }
  const turnNos = Object.keys(groups.turns).map(Number).sort((a, b) => a - b);
  if (!turnNos.length && !groups.before.length) {
    parts.push('<p class="muted">暂无事件记录。</p>');
  }
  for (const turn of turnNos) {
    parts.push(renderTurnHtml(turn, groups.turns[turn]));
  }

  // ---- 工具统计 ----
  parts.push("<h2>工具调用统计</h2>");
  const toolStats = st.toolStats ?? [];
  if (!toolStats.length) {
    parts.push('<p class="muted">本次会话无工具调用。</p>');
  } else {
    parts.push("<table><thead><tr><th>工具</th><th>调用次数</th><th>平均耗时</th><th>最长耗时</th></tr></thead><tbody>");
    for (const t of toolStats) {
      parts.push(`<tr><td><code>${escapeHtml(t.name)}</code></td><td>${t.calls}</td><td>${formatDuration(t.avgMs)}</td><td>${formatDuration(t.maxMs)}</td></tr>`);
    }
    parts.push("</tbody></table>");
  }

  // ---- 报错汇总 ----
  parts.push("<h2>报错汇总</h2>");
  const errors = snap.errors ?? [];
  if (!errors.length) {
    parts.push('<p class="muted">本次会话无报错。</p>');
  } else {
    parts.push("<table><thead><tr><th>时间</th><th>轮次</th><th>类型</th><th>错误消息</th></tr></thead><tbody>");
    for (const e of errors) {
      const type = e.source === "turn" ? "模型请求" : "工具执行";
      parts.push(`<tr><td>${formatTime(e.time, true)}</td><td>${e.turn ?? "-"}</td><td>${type}</td><td>${escapeHtml(e.message)}</td></tr>`);
    }
    parts.push("</tbody></table>");
  }

  // ---- 原始事件流 ----
  if (opts.includeRawEvents !== false) {
    parts.push("<h2>原始事件流</h2>");
    parts.push('<p class="muted">按采集时序排列的完整事件时间线（文本已按配置截断）。</p>');
    parts.push("<pre>");
    parts.push(events.map(rawLineHtml).join("\n"));
    parts.push("</pre>");
  }

  parts.push('<div class="sep"></div>');
  parts.push("<footer>由 dsh-plugin-session-export 生成 · DeepSeek Harness 会话黑匣子</footer>");
  parts.push("</div></body></html>");
  return parts.join("\n");
}

/** 按轮次分组（与 Markdown 导出共用逻辑，避免循环依赖故内联实现）。 */
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
function renderTurnHtml(turn, evts) {
  const start = evts.find((e) => e.kind === EVENT_TYPES.TURN_START);
  const end = evts.find((e) => e.kind === EVENT_TYPES.TURN_END);
  const duration = start && end && end.time >= start.time ? end.time - start.time : null;
  const endBadge = end ? turnEndBadge(end) : '<span class="badge run">进行中</span>';
  const parts = [`<h3>第 ${turn} 轮 · ${endBadge}${duration !== null ? ` <span class="dur">${formatDuration(duration)}</span>` : ""}</h3>`];
  for (const evt of evts) {
    if (evt.kind === EVENT_TYPES.TURN_START || evt.kind === EVENT_TYPES.TURN_END) continue;
    parts.push(renderEventHtml(evt));
  }
  return parts.join("");
}

function turnEndBadge(end) {
  if (end.endKind === "error") return '<span class="badge err">报错</span>';
  if (end.endKind === "completed") return '<span class="badge ok">完成</span>';
  return `<span class="badge warn">${escapeHtml(end.endLabel ?? end.endKind)}</span>`;
}

/** 渲染单个事件 HTML。 */
function renderEventHtml(evt) {
  switch (evt.kind) {
    case EVENT_TYPES.USER_INPUT: {
      const label = evt.sourceLabel ?? "用户输入";
      return `<p><strong>${escapeHtml(label)}</strong> <span class="dur">${formatTime(evt.time)}</span></p><blockquote>${escapeHtml(evt.text ?? "（空内容）")}</blockquote>`;
    }
    case EVENT_TYPES.ASSISTANT_MESSAGE: {
      if (!evt.text) return "";
      const badge = evt.interrupted ? '<span class="badge warn">中断</span>' : "";
      return `<p><strong>模型回复${evt.model ? ` · ${escapeHtml(evt.model)}` : ""}</strong> <span class="dur">${formatTime(evt.time)}</span> ${badge}</p><pre>${escapeHtml(evt.text)}</pre>`;
    }
    case EVENT_TYPES.TOOL_CALL: {
      const argsHtml = evt.args === null
        ? '<p class="muted">（入参未记录）</p>'
        : `<pre>${escapeHtml(safeStringify(evt.args))}</pre>`;
      return `<details class="tool"><summary>🛠 ${escapeHtml(evt.toolName ?? "unknown")} <span class="dur">${formatTime(evt.time)}</span></summary><div class="body">${argsHtml}</div></details>`;
    }
    case EVENT_TYPES.TOOL_RESULT: {
      const dur = evt.durationMs !== null && evt.durationMs !== undefined ? ` · 耗时 ${formatDuration(evt.durationMs)}` : "";
      const badge = evt.isError ? '<span class="badge err">执行失败</span>' : "";
      return `<div class="tool-result"><span class="dur">→ 返回${dur}</span> ${badge}<pre>${escapeHtml(evt.text)}</pre></div>`;
    }
    default:
      return "";
  }
}

/** 原始事件流单行（HTML 安全：所有用户可控文本一律转义）。 */
function rawLineHtml(evt) {
  const t = formatTime(evt.time);
  const turn = evt.turn !== undefined && evt.turn !== null ? `#${evt.turn}` : "--";
  const esc = (s) => escapeHtml(s);
  switch (evt.kind) {
    case EVENT_TYPES.TURN_START: return `[${t}] 轮次 ${turn} 开始`;
    case EVENT_TYPES.TURN_END: return `[${t}] 轮次 ${turn} 结束（${esc(evt.endLabel ?? evt.endKind)}）`;
    case EVENT_TYPES.USER_INPUT: return `[${t}] 轮次 ${turn} 用户输入：${esc(oneLine(evt.text, 80))}`;
    case EVENT_TYPES.ASSISTANT_MESSAGE: return `[${t}] 轮次 ${turn} 模型回复${evt.interrupted ? "（中断）" : ""}：${esc(oneLine(evt.text, 80))}`;
    case EVENT_TYPES.TOOL_CALL: return `[${t}] 轮次 ${turn} 工具调用 ${esc(evt.toolName)}：${esc(oneLine(safeStringify(evt.args), 60))}`;
    case EVENT_TYPES.TOOL_RESULT: return `[${t}] 轮次 ${turn} 工具返回${evt.isError ? "（错误）" : ""}${evt.durationMs !== null ? `（${formatDuration(evt.durationMs)}）` : ""}：${esc(oneLine(evt.text, 80))}`;
    default: return `[${t}] ${esc(evt.kind)}`;
  }
}

function oneLine(s, max) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  if (str.length <= max) return str || "(空)";
  return str.slice(0, max) + "…";
}
