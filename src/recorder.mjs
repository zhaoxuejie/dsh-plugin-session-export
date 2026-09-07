// dsh-plugin-session-export — 会话事件采集器（黑匣子核心）
//
// 将 DeepSeek Harness 原始 session/event 归一化为复盘语义的内部事件流：
//   Harness 原始事件（已按 deepseek-harness 真源码校准）:
//     turn/start       { turn }
//     user/message     Message 对象本身（{id, role, content, source}）——data 即消息
//     assistant/message { turn, step, message, usage?, interrupted?, stream? }
//     assistant/attempt { turn, step, stream }（中断且无内容）
//     tool/call        { turn, step, callId, name, arguments: string }
//     tool/result      { turn, step, message, error?, meta? }
//     turn/end         { turn, reason: { kind, error?, reason? } }
//     session/title    { title, ... }
//   → 归一化为 EVENT_TYPES 中的语义类型，并附带提取后的文本、耗时、错误等复盘字段。

import { EVENT_TYPES, extractBlockText, truncateContent, maskSensitive } from "./types.mjs";

/** 轮次结束原因的可读中文标签。 */
export const TURN_END_LABELS = Object.freeze({
  completed: "完成",
  aborted: "中止",
  blocked: "等待批准",
  error: "报错",
  "max-tokens": "达到输出上限",
  interrupted: "中断",
});

/**
 * 单个会话的采集器。
 * 维护：归一化事件时间线（有界）、工具调用配对、增量统计、会话元信息。
 */
export class SessionRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId 会话 id
   * @param {number} opts.maxEvents 单会话事件上限
   * @param {number} opts.maxContentLength 单条文本最大导出长度
   * @param {boolean} opts.includeToolArgs 是否保留工具入参
   * @param {boolean} opts.includeReasoning 是否保留思考块
   */
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.maxEvents = opts.maxEvents;
    this.maxContentLength = opts.maxContentLength;
    this.includeToolArgs = opts.includeToolArgs;
    this.includeReasoning = opts.includeReasoning;

    /** 归一化事件时间线（含截断后文本与配对耗时）。 */
    this.events = [];
    /** callId → events 下标（工具配对）。 */
    this.toolCallIndex = new Map();
    /** 已采集到的最大 seq（去重用）。 */
    this.lastSeq = -1;
    /** 是否因达到事件上限而停止。 */
    this.stopped = false;

    // ---- 元信息 ----
    this.title = "";
    this.createdAt = null;
    this.cwd = "";
    this.agentPreset = "";
    this.firstEventTime = null;
    this.lastEventTime = null;

    // ---- 增量统计 ----
    this.turnCount = 0;
    this.toolCallCount = 0;
    this.toolNameCounts = new Map();
    this.errorList = [];
    this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.interruptedCount = 0;
    /** 已完成的工具调用耗时（毫秒）。 */
    this.toolDurations = [];
    /** 打开中的轮次（turn 号）。 */
    this.openTurn = null;
  }

  /** 会话是否处于记录中。 */
  get active() {
    return !this.stopped;
  }

  /**
   * 入口：注入一个原始 Harness 会话事件（session/event 回调）。
   * @param {object} session Harness Session 对象（用于快照补录）
   * @param {object} event 原始事件 { type, seq, time, data }
   */
  handle(session, event) {
    if (this.stopped) return;
    const seq = Number.isFinite(event?.seq) ? event.seq : -1;
    if (seq <= this.lastSeq) return; // 去重（重放/补录场景）
    this.lastSeq = seq;

    const time = Number.isFinite(event?.time) ? event.time : Date.now();
    if (this.firstEventTime === null) this.firstEventTime = time;
    this.lastEventTime = time;

    // ---- 元信息捕获 ----
    if (session && typeof session === "object") {
      const h = session.header;
      if (h) {
        if (this.createdAt === null && h.createdAt !== undefined) this.createdAt = h.createdAt;
        if (!this.cwd && typeof h.cwd === "string") this.cwd = h.cwd;
        if (!this.agentPreset && typeof h.agentPreset === "string") this.agentPreset = h.agentPreset;
      }
      if (session.id && this.sessionId === null) this.sessionId = session.id;
    }

    const data = event?.data;
    switch (event?.type) {
      case "turn/start": {
        const turn = data?.turn;
        this.openTurn = turn;
        this.turnCount = Math.max(this.turnCount, Number(turn) || 0);
        this.push({ kind: EVENT_TYPES.TURN_START, seq, time, turn, label: `第 ${turn} 轮` });
        break;
      }
      case "user/message": {
        // data 即 Message 对象：{ content: ContentBlock[], source }
        const text = extractBlockText(data?.content, this.maxContentLength);
        const sourceKind = data?.source?.kind ?? "user";
        this.push({
          kind: EVENT_TYPES.USER_INPUT,
          seq, time,
          turn: this.openTurn, // user/message 事件不携带 turn，继承当前打开轮次
          text,
          sourceKind,
          sourceLabel: sourceKind === "user" ? "用户输入" : sourceKind === "plugin" ? `系统注入（${data.source.plugin ?? "plugin"}）` : `来源：${sourceKind}`,
        });
        break;
      }
      case "assistant/message": {
        const msg = data?.message;
        const blocks = msg?.content;
        const textParts = [];
        if (this.includeReasoning) {
          const reasoning = extractBlockText(blocks?.filter((b) => b?.type === "reasoning"), this.maxContentLength);
          if (reasoning) textParts.push(`[思考] ${reasoning}`);
        }
        const visible = extractBlockText(blocks?.filter((b) => b?.type === "text"), this.maxContentLength);
        if (visible) textParts.push(visible);
        const model = msg?.source?.model ? String(msg.source.model) : "";
        const hasToolCalls = blocks?.some((b) => b?.type === "tool-call");
        if (hasToolCalls && !visible && !textParts.length) textParts.push("[本轮为工具调用轮，无正文输出]");
        // usage 统计
        if (data?.usage) this.accumulateUsage(data.usage);
        if (data?.interrupted) this.interruptedCount += 1;
        this.push({
          kind: EVENT_TYPES.ASSISTANT_MESSAGE,
          seq, time,
          turn: data?.turn, step: data?.step,
          text: textParts.join("\n\n") || null,
          model,
          interrupted: data?.interrupted === true,
          tokenUsage: data?.usage ?? null,
        });
        break;
      }
      case "assistant/attempt": {
        this.interruptedCount += 1;
        this.push({
          kind: EVENT_TYPES.ASSISTANT_MESSAGE,
          seq, time,
          turn: data?.turn ?? this.openTurn, step: data?.step,
          text: "[输出中断，无已落盘内容]",
          interrupted: true,
          model: "",
        });
        break;
      }
      case "tool/call": {
        const argsRaw = typeof data?.arguments === "string" ? data.arguments : safeJson(data?.arguments);
        let args = null;
        if (this.includeToolArgs) {
          try { args = maskSensitive(JSON.parse(argsRaw || "{}")); }
          catch { args = argsRaw ? { _raw: String(argsRaw).slice(0, this.maxContentLength) } : {}; }
        } else {
          args = null; // 不保留入参
        }
        const idx = this.push({
          kind: EVENT_TYPES.TOOL_CALL,
          seq, time,
          turn: data?.turn, step: data?.step,
          toolName: data?.name,
          callId: data?.callId,
          args,
          durationMs: null,
        });
        if (data?.callId) this.toolCallIndex.set(data.callId, idx);
        this.toolCallCount += 1;
        this.toolNameCounts.set(data?.name ?? "unknown", (this.toolNameCounts.get(data?.name ?? "unknown") ?? 0) + 1);
        break;
      }
      case "tool/result": {
        const msg = data?.message;
        const block = Array.isArray(msg?.content) ? msg.content.find((b) => b?.type === "tool-result") : null;
        const callId = block?.toolCallId ?? data?.error?.callId ?? null;
        const isError = data?.error != null || block?.isError === true;
        const resultText = extractBlockText(block?.content, this.maxContentLength) || (isError ? `[工具执行失败: ${data.error?.name ?? ""}]` : "[无返回内容]");
        let durationMs = null;
        if (callId && this.toolCallIndex.has(callId)) {
          const callIdx = this.toolCallIndex.get(callId);
          const callTime = this.events[callIdx]?.time;
          if (callTime !== undefined && Number.isFinite(callTime)) durationMs = Math.max(0, time - callTime);
          this.events[callIdx].durationMs = durationMs;
          this.toolCallIndex.delete(callId);
          if (durationMs !== null) this.toolDurations.push(durationMs);
        }
        if (isError) {
          this.errorList.push({
            time, turn: data?.turn,
            message: data?.error?.message ?? data?.error?.name ?? "工具执行失败",
            source: "tool", toolName: data?.error?.name ?? "",
          });
        }
        this.push({
          kind: EVENT_TYPES.TOOL_RESULT,
          seq, time,
          turn: data?.turn, step: data?.step,
          callId,
          text: resultText,
          isError,
          durationMs,
          errorCode: data?.error?.code ?? null,
        });
        break;
      }
      case "turn/end": {
        const reason = data?.reason;
        const kind = reason?.kind ?? "completed";
        const isError = kind === "error";
        this.openTurn = null;
        if (isError && reason?.error) {
          this.errorList.push({
            time, turn: data?.turn,
            message: reason.error.message ?? reason.error.code ?? "模型请求失败",
            source: "turn", code: reason.error.code ?? null,
          });
        }
        if (kind === "interrupted" || kind === "aborted") this.interruptedCount += 1;
        this.push({
          kind: EVENT_TYPES.TURN_END,
          seq, time,
          turn: data?.turn,
          endKind: kind,
          endLabel: TURN_END_LABELS[kind] ?? kind,
          error: isError ? { message: reason.error?.message ?? "模型请求失败", code: reason.error?.code ?? null } : null,
        });
        break;
      }
      case "session/title": {
        if (typeof data?.title === "string" && data.title) this.title = data.title;
        break;
      }
      default:
        // step/start、step/end、request/header、request/context、session/end-seed 等：不进入复盘时间线
        break;
    }

    // 事件上限保护
    if (this.events.length >= this.maxEvents) {
      this.stopped = true;
    }
  }

  /** 快照补录：插件加载前该会话已有的事件（seq 去重）。 */
  replay(session) {
    if (!session || typeof session.snapshotEvents !== "function") return;
    try {
      const snapshot = session.snapshotEvents(0, this.lastSeq === -1 ? undefined : this.lastSeq + 1);
      if (!Array.isArray(snapshot)) return;
      // 先按 seq 排序，保证时间线单调；handle 内部做去重
      const sorted = snapshot
        .filter((e) => Number.isFinite(e?.seq) && e.seq > this.lastSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const e of sorted) this.handle(session, e);
    } catch {
      // 补录失败不影响后续实时采集
    }
  }

  /** 追加归一化事件并返回下标。 */
  push(evt) {
    this.events.push(evt);
    return this.events.length - 1;
  }

  accumulateUsage(usage) {
    const u = usage ?? {};
    const add = (k) => Number.isFinite(u[k]) ? u[k] : 0;
    this.tokenUsage.promptTokens += add("promptTokens") + add("inputTokens");
    this.tokenUsage.completionTokens += add("completionTokens") + add("outputTokens");
    this.tokenUsage.totalTokens += add("totalTokens");
  }

  /** 导出用的只读快照。 */
  snapshot() {
    return {
      sessionId: this.sessionId,
      title: this.title || null,
      createdAt: this.createdAt,
      cwd: this.cwd || null,
      agentPreset: this.agentPreset || null,
      eventCount: this.events.length,
      maxEvents: this.maxEvents,
      stopped: this.stopped,
      firstEventTime: this.firstEventTime,
      lastEventTime: this.lastEventTime,
      stats: {
        turnCount: this.turnCount,
        toolCallCount: this.toolCallCount,
        toolNameCounts: Object.fromEntries(this.toolNameCounts),
        errorCount: this.errorList.length,
        interruptedCount: this.interruptedCount,
        tokenUsage: { ...this.tokenUsage },
        totalDurationMs: this.firstEventTime !== null && this.lastEventTime !== null
          ? Math.max(0, this.lastEventTime - this.firstEventTime)
          : 0,
      },
      errors: this.errorList,
      events: this.events,
    };
  }
}

/** 兼容非字符串 arguments 的安全 JSON 序列化。 */
function safeJson(v) {
  if (v === null || v === undefined) return "{}";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return "{}"; }
}
