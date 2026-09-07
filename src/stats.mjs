// dsh-plugin-session-export — 会话统计计算（从采集器快照派生，纯函数，可测试）
import { EVENT_TYPES } from "./types.mjs";

/**
 * 由采集器快照计算复盘统计。
 * @param {ReturnType<import("./recorder.mjs").SessionRecorder["snapshot"]>} snap
 * @returns 统计对象（含逐轮耗时、慢工具 TopN 等）
 */
export function computeStats(snap) {
  const events = Array.isArray(snap?.events) ? snap.events : [];
  const base = snap?.stats ?? {};

  // ---- 轮次起止配对（按 turn 号）----
  const turnRanges = new Map(); // turn → { start, end, firstText, lastText, endKind }
  for (const evt of events) {
    if (evt.turn === undefined || evt.turn === null) continue;
    let r = turnRanges.get(evt.turn);
    if (!r) { r = { start: null, end: null, firstText: null, lastText: null, endKind: null }; turnRanges.set(evt.turn, r); }
    if (evt.kind === EVENT_TYPES.TURN_START) { r.start = evt.time; r.firstText = evt.label; }
    else if (evt.kind === EVENT_TYPES.TURN_END) { r.end = evt.time; r.lastText = evt.endLabel; r.endKind = evt.endKind ?? null; }
  }
  const turnDurations = [];
  let totalTurnMs = 0;
  for (const r of turnRanges.values()) {
    if (r.start !== null && r.end !== null) {
      const d = Math.max(0, r.end - r.start);
      turnDurations.push(d);
      totalTurnMs += d;
    }
  }
  turnDurations.sort((a, b) => a - b);

  // ---- 轮次时间轴（供 HTML 可视化）----
  const turnTimeline = [];
  for (const [turn, r] of turnRanges) {
    const duration = r.start !== null && r.end !== null ? Math.max(0, r.end - r.start) : null;
    turnTimeline.push({ turn, start: r.start, end: r.end, duration, endKind: r.endKind, endLabel: r.lastText });
  }
  turnTimeline.sort((a, b) => a.turn - b.turn);

  // ---- 工具耗时明细（已配对）----
  const toolStats = new Map(); // toolName → { calls, errors, totalMs, maxMs }
  const slowCalls = []; // { toolName, durationMs, turn }
  for (const evt of events) {
    if (evt.kind !== EVENT_TYPES.TOOL_CALL) continue;
    let t = toolStats.get(evt.toolName);
    if (!t) { t = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }; toolStats.set(evt.toolName, t); }
    t.calls += 1;
    if (evt.durationMs !== null && evt.durationMs !== undefined) {
      t.totalMs += evt.durationMs;
      t.maxMs = Math.max(t.maxMs, evt.durationMs);
      slowCalls.push({ toolName: evt.toolName, durationMs: evt.durationMs, turn: evt.turn ?? null });
    }
  }
  for (const evt of events) {
    if (evt.kind === EVENT_TYPES.TOOL_RESULT && evt.isError && evt.toolName !== undefined) {
      // isError 时 result 事件本身不带 toolName，用配对方式：这里统计错误数走 errorList 口径即可
    }
  }
  slowCalls.sort((a, b) => b.durationMs - a.durationMs);

  const avgTurnMs = turnDurations.length ? totalTurnMs / turnDurations.length : 0;
  const p50TurnMs = percentile(turnDurations, 0.5);

  return {
    ...base,
    turnCount: base.turnCount ?? turnRanges.size,
    avgTurnMs,
    p50TurnMs,
    turnDurations,
    totalTurnMs,
    toolStats: [...toolStats.entries()].map(([name, v]) => ({
      name, calls: v.calls, errors: v.errors,
      totalMs: v.totalMs, maxMs: v.maxMs, avgMs: v.calls ? v.totalMs / v.calls : 0,
    })).sort((a, b) => b.calls - a.calls),
    slowestTools: slowCalls.slice(0, 3).map((c) => ({ ...c })),
    turnTimeline,
  };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(sortedArr.length * p)));
  return sortedArr[idx];
}
