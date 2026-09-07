import { renderHtmlReport } from "../src/exporter-html.mjs";
import { computeStats } from "../src/stats.mjs";
import { EVENT_TYPES } from "../src/types.mjs";
import { writeFileSync } from "node:fs";

const now = Date.now();
const events = [
  { kind: EVENT_TYPES.TURN_START, seq: 0, time: now, turn: 1, label: "第 1 轮" },
  { kind: EVENT_TYPES.USER_INPUT, seq: 1, time: now + 100, turn: 1, text: "帮我查一下今天的天气", sourceKind: "user", sourceLabel: "用户输入" },
  { kind: EVENT_TYPES.TOOL_CALL, seq: 2, time: now + 500, turn: 1, toolName: "weather_search", args: { city: "北京", date: "2026-09-07", api_key: "sk-xxxx-secret" }, durationMs: 1200 },
  { kind: EVENT_TYPES.TOOL_RESULT, seq: 3, time: now + 1700, turn: 1, toolName: "weather_search", text: '{"temp": 26, "condition": "晴", "wind": "北风3级", "humidity": 45}', durationMs: 1200, isError: false },
  { kind: EVENT_TYPES.ASSISTANT_MESSAGE, seq: 4, time: now + 2000, turn: 1, text: "北京今天晴，气温26度，北风3级，湿度45%。适合出行。", model: "deepseek-v4" },
  { kind: EVENT_TYPES.TURN_END, seq: 5, time: now + 2200, turn: 1, endKind: "completed", endLabel: "完成" },
  { kind: EVENT_TYPES.TURN_START, seq: 6, time: now + 3000, turn: 2, label: "第 2 轮" },
  { kind: EVENT_TYPES.USER_INPUT, seq: 7, time: now + 3100, turn: 2, text: "再查一下上海", sourceKind: "user", sourceLabel: "用户输入" },
  { kind: EVENT_TYPES.TOOL_CALL, seq: 8, time: now + 3400, turn: 2, toolName: "weather_search", args: { city: "上海" }, durationMs: 800 },
  { kind: EVENT_TYPES.TOOL_RESULT, seq: 9, time: now + 4200, turn: 2, toolName: "weather_search", text: '{"temp": 28, "condition": "多云", "wind": "东风2级"}', durationMs: 800, isError: false },
  { kind: EVENT_TYPES.ASSISTANT_MESSAGE, seq: 10, time: now + 4500, turn: 2, text: "上海今天多云，28度。", model: "deepseek-v4" },
  { kind: EVENT_TYPES.TURN_END, seq: 11, time: now + 4700, turn: 2, endKind: "completed", endLabel: "完成" },
  { kind: EVENT_TYPES.TURN_START, seq: 12, time: now + 5500, turn: 3, label: "第 3 轮" },
  { kind: EVENT_TYPES.USER_INPUT, seq: 13, time: now + 5600, turn: 3, text: "调用一个会报错的工具", sourceKind: "user", sourceLabel: "用户输入" },
  { kind: EVENT_TYPES.TOOL_CALL, seq: 14, time: now + 5900, turn: 3, toolName: "bad_tool", args: { x: 1 }, durationMs: 500 },
  { kind: EVENT_TYPES.TOOL_RESULT, seq: 15, time: now + 6400, turn: 3, toolName: "bad_tool", text: "Error: something went wrong", durationMs: 500, isError: true },
  { kind: EVENT_TYPES.TURN_END, seq: 16, time: now + 6600, turn: 3, endKind: "error", endLabel: "报错" },
];
const snap = {
  sessionId: "demo-session-001", title: "天气查询演示", events,
  stats: { turnCount: 3, toolCallCount: 3, errorCount: 1, interruptedCount: 0, totalDurationMs: 3600, toolNameCounts: { weather_search: 2, bad_tool: 1 }, tokenUsage: { promptTokens: 500, completionTokens: 120, totalTokens: 620 } },
  firstEventTime: now, lastEventTime: now + 6600, maxEvents: 500, stopped: false,
  errors: [{ time: now + 6400, turn: 3, message: "Error: something went wrong", source: "tool", code: null }],
};
const stats = computeStats(snap);
const html = renderHtmlReport(snap, stats, { theme: "light", generatedAt: now });
writeFileSync("docs/sample-report.html", html, "utf8");
console.log("示例报告已生成，长度:", html.length, "字节");
console.log("turnTimeline 条数:", stats.turnTimeline.length);
console.log("时间轴:", stats.turnTimeline.map(t => "T" + t.turn + "(" + (t.duration !== null ? t.duration + "ms," + t.endKind : "?") + ")").join(" "));
