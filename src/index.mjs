// dsh-plugin-session-export — DeepSeek Harness 会话黑匣子插件入口
//
// 能力（对应 PRD）：
//  1. 旁路采集：订阅 session/event（turn/start·user/message·assistant/message·tool/call·tool/result·turn/end·session/title）
//     + agent/session-start / agent/request-error，按会话隔离维护事件时间线与统计。
//  2. 快照补录：首次收到某会话实时事件时，用 session.snapshotEvents() 补录插件加载前已发生的事件。
//  3. 工具：export_session（Markdown/HTML 复盘报告）、session_stats（统计）、session_clear（清空）。
//  4. Web 面板：/session-export/* 路由 + client.js 侧边面板（统计卡片 / 导出 / 清空）。
//  5. 配置：settings 服务热更新（applies: "live"）。
//  6. 清理：所有订阅均为 cordis effect，插件卸载自动释放；事件 Map 在 dispose 时清空。

import { Config, resolveConfig } from "./config.mjs";
import { SessionRecorder } from "./recorder.mjs";
import { computeStats } from "./stats.mjs";
import { renderMarkdownReport } from "./exporter-markdown.mjs";
import { renderHtmlReport } from "./exporter-html.mjs";
import { formatDuration, safeStringify, shortSessionId } from "./types.mjs";

export const name = "dsh-plugin-session-export";
export const inject = ["tools", "sessions"];

export { Config };

export function apply(ctx, entryConfig) {
  // ---- 配置（settings 服务存在时支持运行时热更新）----
  // 分层：schema 默认 → entry config（base）→ 用户 settings（user），settings 服务负责合并。
  // settings 服务缺失时退回 entry config / 默认值，不崩。
  const config = resolveConfig(entryConfig);
  const settingsSvc = ctx.get("settings");
  if (settingsSvc && typeof settingsSvc.register === "function") {
    try {
      const scope = settingsSvc.register(name, Config, {
        applies: "live",
        base: entryConfig && typeof entryConfig === "object" ? entryConfig : undefined,
      });
      Object.assign(config, resolveConfig(scope.get()));
      if (typeof scope.watch === "function") {
        scope.watch((next) => {
          if (next && typeof next === "object") Object.assign(config, resolveConfig(next));
        });
      }
    } catch (err) {
      ctx.logger?.(name).warn?.(`settings 注册失败，使用入口配置: ${err?.message ?? err}`);
    }
  }

  // ---- 会话级状态 ----
  /** @type {Map<string, SessionRecorder>} 会话 id → 采集器 */
  const recorders = new Map();
  /** 最近活跃会话 id（工具缺省导出目标）。 */
  let latestSessionId = null;

  const recorderFor = (session, event) => {
    const id = String(session?.id ?? "unknown");
    let rec = recorders.get(id);
    if (!rec) {
      rec = new SessionRecorder({
        sessionId: id,
        maxEvents: config.maxEventsPerSession,
        maxContentLength: config.maxContentLength,
        includeToolArgs: config.includeToolArgs,
        includeReasoning: config.includeReasoning,
      });
      rec.replay(session); // 快照补录插件加载前的事件
      recorders.set(id, rec);
    }
    return rec;
  };

  const isRecording = () => config.enable && config.autoRecord;

  // ---- 会话标题（sessionTitle 服务 + session/title 事件双通道）----
  const titleService = ctx.get("sessionTitle");
  const applyTitle = (session, rec) => {
    if (rec.title) return;
    try {
      const snap = titleService?.get?.(session);
      if (snap?.title) rec.title = snap.title;
    } catch { /* 服务不可用时忽略 */ }
  };

  // ---- 1. 实时事件采集 + 标题补写（单一 session/event 监听器）----
  if (ctx.on) {
    ctx.on("session/event", (session, event) => {
      if (!isRecording() || !event?.type) return;
      try {
        const rec = recorderFor(session, event);
        rec.handle(session, event);
        if (session?.id) {
          latestSessionId = session.id;
          if (!rec.title) applyTitle(session, rec);
        }
      } catch (err) {
        ctx.logger?.(name).warn?.(`session/event 处理失败: ${err?.message ?? err}`);
      }
    });

    // 会话启动（startup / resume）：建立采集器，resume 时会话已有历史事件，等待首个实时事件触发补录
    ctx.on("agent/session-start", (payload) => {
      if (!isRecording()) return;
      const session = payload?.session ?? payload?.agent?.session;
      const id = String(session?.id ?? "unknown");
      if (!recorders.has(id) && session) {
        const rec = recorderFor(session, null);
        rec.replay(session);
        recorders.set(id, rec);
        latestSessionId = id;
      }
    });

    // 请求层错误（如 API 不可达），记为会话错误，不入轮次
    ctx.on("agent/request-error", (payload) => {
      if (!isRecording()) return;
      const session = payload?.session ?? payload?.agent?.session;
      const id = String(session?.id ?? latestSessionId ?? "unknown");
      const rec = recorders.get(id);
      if (!rec || rec.stopped) return;
      const time = payload?.time ?? Date.now();
      rec.errorList.push({
        time,
        turn: null,
        message: payload?.message ?? "Agent 请求失败",
        source: "request",
        code: payload?.code ?? null,
      });
      if (rec.firstEventTime === null) rec.firstEventTime = time;
      rec.lastEventTime = time;
    });
  }

  // ---- 2. 工具注册 ----
  const resolveTarget = (sessionParam) => {
    const want = typeof sessionParam === "string" && sessionParam ? sessionParam : latestSessionId;
    if (!want || !recorders.has(want)) {
      return { rec: null, targetId: want };
    }
    return { rec: recorders.get(want), targetId: want };
  };

  const buildReport = (rec, format) => {
    const snap = rec.snapshot();
    const stats = computeStats(snap);
    const now = Date.now();
    const outputs = {};
    if (format === "markdown" || format === "both") {
      outputs.markdown = renderMarkdownReport(snap, stats, { generatedAt: now });
    }
    if (format === "html" || format === "both") {
      outputs.html = renderHtmlReport(snap, stats, { theme: config.htmlTheme, generatedAt: now });
    }
    return { snap, stats, outputs, format };
  };

  ctx.tools.register({
    name: "export_session",
    description: "导出 DeepSeek Harness 会话复盘报告（Markdown 或 HTML）。用于回顾某次对话的完整过程：用户输入、模型回复、工具调用链、耗时、报错与 Token 用量。缺省导出最近活跃会话。",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "目标会话 ID（缺省为最近活跃会话；可用 session_stats 查询会话列表）",
        },
        format: {
          type: "string",
          description: "导出格式：markdown / html / both（缺省跟随插件配置）",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          format: { type: "string" },
          content: { type: "string" },
          sessionId: { type: "string" },
          title: { type: "string" },
          eventCount: { type: "number" },
          turnCount: { type: "number" },
          toolCallCount: { type: "number" },
          errorCount: { type: "number" },
        },
        required: ["format", "content", "sessionId"],
      },
      render: (_args, value) => {
        if (!value || typeof value !== "object" || !value.content) {
          return [{ type: "text", text: String(value ?? "") }];
        }
        const head = `会话复盘报告（${value.format}）· 会话 ${shortSessionId(value.sessionId)} · ${value.turnCount} 轮 / ${value.toolCallCount} 次工具 / ${value.errorCount} 次报错`;
        if (value.format === "html") {
          return [{ type: "text", text: `${head}\n\n\`\`\`html\n${value.content}\n\`\`\`` }];
        }
        return [{ type: "text", text: `${head}\n\n\`\`\`markdown\n${value.content}\n\`\`\`` }];
      },
    },
    timeoutMs: 15_000,
    async execute(args) {
      if (!config.enable) return { format: "none", content: "插件已停用（enable=false），请先在设置中开启后再导出。", sessionId: "" };
      const { rec, targetId } = resolveTarget(args?.session);
      if (!rec) {
        const hint = targetId ? `会话 ${shortSessionId(targetId)} 暂无记录` : "当前没有任何会话记录";
        return { format: "none", content: `${hint}。确认插件已启用、会话发生过对话，或用 session_stats 查看可用会话。`, sessionId: targetId ?? "" };
      }
      const want = args?.format ?? config.exportFormat;
      const format = want === "html" ? "html" : want === "both" ? "both" : "markdown";
      const { snap, stats, outputs } = buildReport(rec, format);
      const primary = format === "both" ? "markdown" : format;
      return {
        format,
        content: outputs[primary] ?? "",
        sessionId: snap.sessionId,
        title: snap.title ?? "",
        eventCount: snap.eventCount,
        turnCount: snap.stats.turnCount,
        toolCallCount: snap.stats.toolCallCount,
        errorCount: snap.stats.errorCount,
        // both 模式下附带 HTML 供工具调用方取用（面板/文件下载场景）
        ...(format === "both" ? { html: outputs.html } : {}),
      };
    },
  });

  ctx.tools.register({
    name: "session_stats",
    description: "查看 DeepSeek Harness 会话的采集统计：各会话的轮次数、工具调用、耗时、报错、中断与 Token 用量；也可获取单个会话的详细统计（含最慢工具 Top3）。",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "目标会话 ID（缺省返回全部已采集会话的概览）",
        },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? safeStringify(value, 2)) }],
    },
    timeoutMs: 10_000,
    async execute(args) {
      if (!config.enable) return { text: "插件已停用（enable=false）。" };
      const want = typeof args?.session === "string" && args.session ? args.session : null;
      const lines = [];
      if (want) {
        const rec = recorders.get(want);
        if (!rec) return { text: `会话 ${shortSessionId(want)} 暂无记录。` };
        const snap = rec.snapshot();
        const stats = computeStats(snap);
        lines.push(`会话 ${shortSessionId(want)}${snap.title ? `（${snap.title}）` : ""}`);
        lines.push(`- 轮次 ${snap.stats.turnCount} · 工具调用 ${snap.stats.toolCallCount} 次 · 报错 ${snap.stats.errorCount} · 中断 ${snap.stats.interruptedCount}`);
        lines.push(`- 总耗时 ${formatDuration(snap.stats.totalDurationMs)} · 平均轮次 ${formatDuration(stats.avgTurnMs)}`);
        lines.push(`- Token：输入 ${snap.stats.tokenUsage.promptTokens} / 输出 ${snap.stats.tokenUsage.completionTokens} / 合计 ${snap.stats.tokenUsage.totalTokens}`);
        if (stats.slowestTools.length) {
          lines.push("- 最慢工具 Top3：");
          for (const t of stats.slowestTools) lines.push(`  - ${t.toolName}：${formatDuration(t.durationMs)}（第 ${t.turn ?? "-"} 轮）`);
        }
      } else {
        if (!recorders.size) return { text: "暂无任何会话记录。" };
        lines.push(`已采集 ${recorders.size} 个会话：`);
        for (const [id, rec] of recorders) {
          const snap = rec.snapshot();
          const flag = rec.stopped ? "（已达上限）" : "";
          lines.push(`- ${shortSessionId(id)}${snap.title ? `（${snap.title}）` : ""}：${snap.stats.turnCount} 轮 · ${snap.stats.toolCallCount} 次工具 · ${snap.stats.errorCount} 次报错${flag}`);
        }
        lines.push(`\n最近活跃：${shortSessionId(latestSessionId ?? "")}`);
      }
      return { text: lines.join("\n") };
    },
  });

  ctx.tools.register({
    name: "session_clear",
    description: "清空会话复盘记录。清空后已采集的事件时间线与统计将被删除，无法恢复。用于隐私清理或释放内存。",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "目标会话 ID（缺省清空全部会话）",
        },
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    timeoutMs: 5_000,
    async execute(args) {
      const want = typeof args?.session === "string" && args.session ? args.session : null;
      let cleared = 0;
      if (want) {
        if (recorders.delete(want)) cleared = 1;
        if (latestSessionId === want) latestSessionId = null;
      } else {
        cleared = recorders.size;
        recorders.clear();
        latestSessionId = null;
      }
      return { text: cleared ? `已清空 ${cleared} 个会话的复盘记录。` : "没有可清空的记录。" };
    },
  });

  // ---- 3. Web 面板路由（延迟获取 webServer，避免 inject 依赖导致加载顺序问题）----
  const registerRoutes = (ws) => {
    const json = (res, code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    ws.register({
      kind: "exact",
      path: "/session-export/stats",
      handler: async (_req, res) => {
        if (!config.enable) return json(res, 200, { ok: true, enabled: false });
        const rows = [];
        for (const [id, rec] of recorders) {
          const snap = rec.snapshot();
          rows.push({
            sessionId: id,
            title: snap.title ?? "",
            turnCount: snap.stats.turnCount,
            toolCallCount: snap.stats.toolCallCount,
            errorCount: snap.stats.errorCount,
            interruptedCount: snap.stats.interruptedCount,
            totalDurationMs: snap.stats.totalDurationMs,
            toolNameCounts: snap.stats.toolNameCounts,
            eventCount: snap.eventCount,
            lastEventTime: rec.lastEventTime,
            stopped: rec.stopped,
          });
        }
        rows.sort((a, b) => (b.lastEventTime ?? 0) - (a.lastEventTime ?? 0));
        json(res, 200, { ok: true, enabled: true, latestSessionId, sessions: rows });
      },
    });

    ws.register({
      kind: "exact",
      path: "/session-export/export",
      handler: async (req, res) => {
        const query = parseQuery(req?.url);
        const format = query.format === "html" || query.format === "both" ? query.format : "markdown";
        const { rec, targetId } = resolveTarget(query.session);
        if (!rec) {
          return json(res, 404, { ok: false, error: `会话 ${shortSessionId(targetId ?? "")} 暂无记录` });
        }
        const snap = rec.snapshot();
        const stats = computeStats(snap);
        const primary = format === "both" ? "markdown" : format;
        const body = primary === "html"
          ? renderHtmlReport(snap, stats, { theme: config.htmlTheme })
          : renderMarkdownReport(snap, stats);
        try {
          res.writeHead(200, {
            "content-type": primary === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="session-${shortSessionId(rec.sessionId).replace(/[^\w.-]/g, "_")}.${primary === "html" ? "html" : "md"}"`,
          });
          res.end(body);
        } catch (e) {
          json(res, 200, { ok: true, format: primary, content: body });
        }
      },
    });

    ws.register({
      kind: "exact",
      path: "/session-export/clear",
      handler: async (req, res) => {
        const query = parseQuery(req?.url);
        const want = query.session || null;
        let cleared = 0;
        if (want) {
          if (recorders.delete(want)) cleared = 1;
          if (latestSessionId === want) latestSessionId = null;
        } else {
          cleared = recorders.size;
          recorders.clear();
          latestSessionId = null;
        }
        json(res, 200, { ok: true, cleared });
      },
    });
  };

  // 延迟获取 webServer：插件可能在 webServer 服务初始化前加载，轮询等待就绪
  ctx.effect(() => {
    let disposed = false;
    let registered = false;
    const tryRegister = () => {
      if (disposed || registered) return;
      const ws = ctx.get("webServer");
      if (ws && typeof ws.register === "function") {
        registerRoutes(ws);
        registered = true;
      } else {
        setTimeout(tryRegister, 500);
      }
    };
    tryRegister();
    return () => { disposed = true; };
  });

  // ---- 4. 清理（插件卸载）----
  ctx.effect(() => () => {
    recorders.clear();
    latestSessionId = null;
  });
}

/** 解析 URL 查询参数（兼容 query string 或完整 URL）。 */
function parseQuery(url = "") {
  const q = String(url).includes("?") ? String(url).split("?")[1] ?? "" : "";
  const out = {};
  for (const pair of q.split("&")) {
    if (!pair) continue;
    const [k, ...rest] = pair.split("=");
    if (!k) continue;
    out[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
  }
  return out;
}
