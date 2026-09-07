// dsh-plugin-session-export — 自检测试（node:test，无外部依赖）
// 覆盖：配置解析、脱敏/截断/文本提取、真实 Harness 事件契约采集、
//       工具调用配对耗时、错误记录、事件上限、统计、Markdown/HTML 导出。
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.mjs";
import { SessionRecorder } from "../src/recorder.mjs";
import { computeStats } from "../src/stats.mjs";
import { renderMarkdownReport } from "../src/exporter-markdown.mjs";
import { renderHtmlReport } from "../src/exporter-html.mjs";
import {
  EVENT_TYPES, extractBlockText, truncateContent, maskSensitive, safeStringify, escapeHtml,
} from "../src/types.mjs";

// ---- 工具函数 ----

test("config: 默认值与合并", () => {
  const def = resolveConfig();
  assert.equal(def.enable, true);
  assert.equal(def.maxContentLength, 2000);
  const merged = resolveConfig({ enable: false, includeToolArgs: false, maxContentLength: 9999 });
  assert.equal(merged.enable, false);
  assert.equal(merged.includeToolArgs, false);
  assert.equal(merged.maxContentLength, 9999);
  assert.equal(merged.htmlTheme, "light"); // 未提供保持默认
  const clamped = resolveConfig({ maxContentLength: 10, maxEventsPerSession: 1 });
  assert.equal(clamped.maxContentLength, 200); // 钳制到下限
  assert.equal(clamped.maxEventsPerSession, 50); // 钳制到下限
});

test("脱敏：敏感字段被掩码，递归生效", () => {
  const out = maskSensitive({ api_key: "sk-abcdef", nested: { password: "123456", ok: "hi" }, arr: [{ token: "t" }] });
  assert.equal(out.api_key, "sk****ef");
  assert.equal(out.nested.password, "12****56");
  assert.equal(out.nested.ok, "hi");
  assert.equal(out.arr[0].token, "t".length <= 4 ? "****" : "t****");
});

test("截断：超长内容保留前缀与标注", () => {
  const long = "x".repeat(3000);
  const r = truncateContent(long, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, 3000);
  assert.ok(r.text.startsWith("x".repeat(1000)));
  assert.ok(r.text.includes("已截断"));
});

test("文本提取：text/reasoning/图片元信息/嵌套工具结果", () => {
  const blocks = [
    { type: "text", text: "你好" },
    { type: "reasoning", text: "思考" },
    { type: "image", attachment: { name: "a.png", mediaType: "image/png", bytes: 100, width: 10, height: 20 } },
    { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "返回" }] },
  ];
  const text = extractBlockText(blocks);
  assert.ok(text.includes("你好"));
  assert.ok(text.includes("思考"));
  assert.ok(text.includes("a.png") && text.includes("10×20"));
  assert.ok(text.includes("返回"));
});

test("安全序列化与 HTML 转义", () => {
  const circular = {}; circular.self = circular;
  assert.equal(safeStringify(circular).includes("循环引用"), true);
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

// ---- 采集器：按 deepseek-harness agent.ts 真实事件序列 ----

function makeSessionStub(seedEvents = []) {
  return {
    id: "sess-test-001",
    header: { createdAt: 1700000000000, cwd: "D:/proj", agentPreset: "standard" },
    snapshotEvents: () => seedEvents,
  };
}

function rawEvent(type, seq, time, data) {
  return { type, seq, time, data };
}

/** 构造一轮完整的正常会话事件序列（用户输入 → 工具调用 → 模型回复 → 完成）。 */
function buildNormalFlow() {
  const evts = [];
  let t = 1000;
  const at = (type, seq, data) => rawEvent(type, seq, (t += 100), data);
  evts.push(at("turn/start", 0, { turn: 1 }));
  evts.push(at("step/start", 1, { turn: 1, step: 1 }));
  evts.push(at("user/message", 2, { id: "m1", role: "user", content: [{ type: "text", text: "帮我查一下 API 文档" }], source: { kind: "user" } }));
  evts.push(at("assistant/message", 3, {
    turn: 1, step: 1,
    message: { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "web_fetch", arguments: '{"url":"https://example.com/api"}' }], source: { provider: "deepseek", model: "deepseek-chat" } },
  }));
  evts.push(at("tool/call", 4, { turn: 1, step: 1, callId: "call_1", name: "web_fetch", arguments: '{"url":"https://example.com/api"}' }));
  evts.push(at("tool/result", 5, {
    turn: 1, step: 1,
    message: { id: "t1", role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "HTTP 200 OK" }], isError: false }] },
  }));
  evts.push(at("assistant/message", 6, {
    turn: 1, step: 1,
    message: { id: "a2", role: "assistant", content: [{ type: "text", text: "文档地址是 https://example.com/api" }], source: { provider: "deepseek", model: "deepseek-chat" } },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  }));
  evts.push(at("step/end", 7, { turn: 1, step: 1 }));
  evts.push(at("turn/end", 8, { turn: 1, reason: { kind: "completed" } }));
  return evts;
}

test("采集：完整正常轮次（用户输入/工具配对/模型回复/轮次结束）", () => {
  const rec = new SessionRecorder({ sessionId: "sess-test-001", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const session = makeSessionStub();
  for (const e of buildNormalFlow()) rec.handle(session, e);

  const snap = rec.snapshot();
  assert.equal(snap.eventCount, 7); // step/start、step/end 不入时间线
  assert.equal(snap.stats.turnCount, 1);
  assert.equal(snap.stats.toolCallCount, 1);
  assert.equal(snap.stats.errorCount, 0);
  assert.equal(snap.stats.tokenUsage.totalTokens, 120);
  assert.equal(snap.title, null);

  const kinds = snap.events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    EVENT_TYPES.TURN_START, EVENT_TYPES.USER_INPUT, EVENT_TYPES.ASSISTANT_MESSAGE,
    EVENT_TYPES.TOOL_CALL, EVENT_TYPES.TOOL_RESULT, EVENT_TYPES.ASSISTANT_MESSAGE,
    EVENT_TYPES.TURN_END,
  ]);

  // 工具配对耗时
  const toolResult = snap.events.find((e) => e.kind === EVENT_TYPES.TOOL_RESULT);
  assert.equal(toolResult.durationMs, 100);
  assert.equal(toolResult.isError, false);
  assert.ok(toolResult.text.includes("HTTP 200 OK"));

  // 用户输入归属轮次
  const userInput = snap.events.find((e) => e.kind === EVENT_TYPES.USER_INPUT);
  assert.equal(userInput.turn, 1);
  assert.equal(userInput.sourceKind, "user");

  // 模型回复
  const reply = snap.events.find((e) => e.kind === EVENT_TYPES.ASSISTANT_MESSAGE && e.text.includes("文档地址"));
  assert.ok(reply.model.includes("deepseek-chat"));

  // 轮次结束
  const end = snap.events.find((e) => e.kind === EVENT_TYPES.TURN_END);
  assert.equal(end.endKind, "completed");
});

test("采集：工具入参脱敏 + includeToolArgs=false 不保留入参", () => {
  const evts = buildNormalFlow();
  // 入参里带敏感字段
  evts[4].data.arguments = '{"url":"https://example.com","api_key":"sk-abc123"}';

  const rec1 = new SessionRecorder({ sessionId: "s1", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  for (const e of evts) rec1.handle(makeSessionStub(), e);
  const call1 = rec1.snapshot().events.find((e) => e.kind === EVENT_TYPES.TOOL_CALL);
  assert.equal(call1.args.url, "https://example.com");
  assert.notEqual(call1.args.api_key, "sk-abc123"); // 已脱敏

  const rec2 = new SessionRecorder({ sessionId: "s2", maxEvents: 500, maxContentLength: 2000, includeToolArgs: false, includeReasoning: true });
  for (const e of evts) rec2.handle(makeSessionStub(), e);
  const call2 = rec2.snapshot().events.find((e) => e.kind === EVENT_TYPES.TOOL_CALL);
  assert.equal(call2.args, null);
});

test("采集：错误场景（turn error / tool error / interrupted / blocked / max-tokens）", () => {
  const rec = new SessionRecorder({ sessionId: "s3", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const s = makeSessionStub();
  let t = 0;
  const at = (type, data) => rawEvent(type, t++, (t * 100), data);

  rec.handle(s, at("turn/start", { turn: 1 }));
  rec.handle(s, at("user/message", { content: [{ type: "text", text: "hi" }], source: { kind: "user" } }));
  rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "c_e", name: "bash", arguments: "{}" }));
  rec.handle(s, at("tool/result", {
    turn: 1, step: 1,
    message: { content: [{ type: "tool-result", toolCallId: "c_e", content: [{ type: "text", text: "boom" }], isError: true }] },
    error: { name: "BashError", code: "NON_ZERO_EXIT", message: "exit code 1" },
  }));
  rec.handle(s, at("turn/end", { turn: 1, reason: { kind: "completed" } }));

  rec.handle(s, at("turn/start", { turn: 2 }));
  rec.handle(s, at("turn/end", { turn: 2, reason: { kind: "error", error: { message: "Rate limit exceeded", code: "RATE_LIMIT" } } }));
  rec.handle(s, at("turn/start", { turn: 3 }));
  rec.handle(s, at("turn/end", { turn: 3, reason: { kind: "max-tokens" } }));
  rec.handle(s, at("turn/start", { turn: 4 }));
  rec.handle(s, at("turn/end", { turn: 4, reason: { kind: "blocked" } }));

  const snap = rec.snapshot();
  assert.equal(snap.stats.turnCount, 4);
  assert.equal(snap.stats.errorCount, 2); // 1 工具错误 + 1 turn error
  assert.equal(snap.errors.length, 2);
  assert.equal(snap.errors[0].source, "tool");
  assert.equal(snap.errors[1].source, "turn");
  assert.equal(snap.errors[1].message, "Rate limit exceeded");
  const ends = snap.events.filter((e) => e.kind === EVENT_TYPES.TURN_END);
  assert.deepEqual(ends.map((e) => e.endKind), ["completed", "error", "max-tokens", "blocked"]);
});

test("采集：事件上限停止记录", () => {
  const rec = new SessionRecorder({ sessionId: "s4", maxEvents: 3, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const s = makeSessionStub();
  for (let i = 0; i < 5; i++) rec.handle(s, rawEvent("turn/start", i, i * 10, { turn: i + 1 }));
  assert.equal(rec.snapshot().eventCount, 3);
  assert.equal(rec.stopped, true);
  // 停止后不再记录
  rec.handle(s, rawEvent("turn/end", 99, 999, { turn: 9, reason: { kind: "completed" } }));
  assert.equal(rec.snapshot().eventCount, 3);
});

test("采集：会话标题事件与 request-error", () => {
  const rec = new SessionRecorder({ sessionId: "s5", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const s = makeSessionStub();
  rec.handle(s, rawEvent("session/title", 0, 1, { title: "帮我写一个插件" }));
  assert.equal(rec.snapshot().title, "帮我写一个插件");
  rec.errorList.push({ time: 2, turn: null, message: "API 不可达", source: "request", code: "NETWORK" });
  assert.equal(rec.snapshot().stats.errorCount, 1);
});

test("采集：快照补录（插件加载前的事件）", () => {
  const seed = buildNormalFlow().slice(0, 5); // 插件加载前已发生前 5 条
  const rec = new SessionRecorder({ sessionId: "s6", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const s = makeSessionStub(seed);
  rec.replay(s);
  // 补录后接一条新事件
  rec.handle(s, rawEvent("turn/end", 8, 9999, { turn: 1, reason: { kind: "completed" } }));
  const snap = rec.snapshot();
  assert.equal(snap.eventCount, 5); // 补录 4 条（step/start 不入时间线）+ 新 turn/end 1 条
  assert.equal(snap.stats.toolCallCount, 1);
  assert.equal(snap.stats.turnCount, 1);
});

test("采集：unknown 会话 id 兜底", () => {
  const rec = new SessionRecorder({ sessionId: "x", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  rec.handle({}, rawEvent("turn/start", 0, 1, { turn: 1 }));
  assert.equal(rec.snapshot().eventCount, 1);
});

// ---- 统计 ----

test("统计：轮次耗时/工具分布/慢工具 Top3/平均耗时", () => {
  const rec = new SessionRecorder({ sessionId: "s7", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const s = makeSessionStub();
  let t = 0;
  // seq 严格递增；time 可覆盖（模拟真实 Harness 的 seq 单调性）
  const at = (type, data, timeOverride) => ({ type, seq: t++, time: timeOverride ?? (t * 100), data });
  rec.handle(s, at("turn/start", { turn: 1 }));
  rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "c1", name: "web_fetch", arguments: "{}" }));
  rec.handle(s, at("tool/result", { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "r1" }] }] } }));
  rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "c2", name: "web_fetch", arguments: "{}" }));
  rec.handle(s, at("tool/result", { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "r2" }] }] } }));
  rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "c3", name: "bash", arguments: "{}" }));
  // bash 调用耗时最长：call 在 600ms，result 在 1400ms
  rec.handle(s, at("tool/result", { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "c3", content: [{ type: "text", text: "r3" }] }] } }, 1400));
  rec.handle(s, at("turn/end", { turn: 1, reason: { kind: "completed" } }));

  const stats = computeStats(rec.snapshot());
  assert.equal(stats.toolCallCount, 3);
  const byName = Object.fromEntries(stats.toolStats.map((x) => [x.name, x]));
  assert.equal(byName.web_fetch.calls, 2);
  assert.equal(byName.bash.calls, 1);
  assert.equal(stats.slowestTools.length, 3);
  assert.equal(stats.slowestTools[0].toolName, "bash"); // 600ms→1400ms，最慢
  assert.equal(stats.slowestTools[0].durationMs, 800);
  assert.equal(stats.avgTurnMs, 700); // turn 1: 100ms→800ms
});

// ---- 导出 ----

test("Markdown 导出：结构完整、含概览与逐轮复盘", () => {
  const rec = new SessionRecorder({ sessionId: "sess-test-001", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const session = makeSessionStub();
  for (const e of buildNormalFlow()) rec.handle(session, e);
  const snap = rec.snapshot();
  const stats = computeStats(snap);
  const md = renderMarkdownReport(snap, stats, { generatedAt: 1700000000000 });

  assert.ok(md.includes("# 会话复盘报告"));
  assert.ok(md.includes("## 会话概览"));
  assert.ok(md.includes("## 逐轮复盘"));
  assert.ok(md.includes("## 工具调用统计"));
  assert.ok(md.includes("## 报错汇总"));
  assert.ok(md.includes("## 原始事件流"));
  assert.ok(md.includes("第 1 轮"));
  assert.ok(md.includes("帮我查一下 API 文档"));
  assert.ok(md.includes("文档地址是 https://example.com/api"));
  assert.ok(md.includes("web_fetch"));
  assert.ok(md.includes("HTTP 200 OK"));
  assert.ok(md.includes("完成"));
  assert.ok(md.includes("100ms")); // 工具耗时
});

test("Markdown 导出：includeToolArgs=false 时入参不出现", () => {
  const rec = new SessionRecorder({ sessionId: "s8", maxEvents: 500, maxContentLength: 2000, includeToolArgs: false, includeReasoning: true });
  const session = makeSessionStub();
  for (const e of buildNormalFlow()) rec.handle(session, e);
  const md = renderMarkdownReport(rec.snapshot(), computeStats(rec.snapshot()));
  assert.ok(md.includes("入参未记录"));
  assert.ok(!md.includes('"url"')); // 工具入参 JSON 不出现（模型回复中的 URL 不属于入参）
});

test("HTML 导出：主题、转义、可折叠工具、无未转义内容", () => {
  const rec = new SessionRecorder({ sessionId: "sess-test-001", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const session = makeSessionStub();
  for (const e of buildNormalFlow()) rec.handle(session, e);
  const snap = rec.snapshot();
  const stats = computeStats(snap);
  const html = renderHtmlReport(snap, stats, { theme: "dark", generatedAt: 1700000000000 });

  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('class="theme-dark"'));
  assert.ok(html.includes("会话概览") || html.includes("逐轮复盘"));
  assert.ok(html.includes("<details class=\"tool\">"));
  assert.ok(html.includes("web_fetch"));
  assert.ok(html.includes("帮我查一下 API 文档"));
  // 转义验证：构造注入内容
  const rec2 = new SessionRecorder({ sessionId: "s9", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  rec2.handle(session, rawEvent("turn/start", 0, 1, { turn: 1 }));
  rec2.handle(session, rawEvent("user/message", 1, 2, { content: [{ type: "text", text: '<img src=x onerror=alert(1)>' }], source: { kind: "user" } }));
  rec2.handle(session, rawEvent("turn/end", 2, 3, { turn: 1, reason: { kind: "completed" } }));
  const html2 = renderHtmlReport(rec2.snapshot(), computeStats(rec2.snapshot()));
  assert.ok(!html2.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html2.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("会话统计工具文本与清空逻辑（复用 recorder 语义）", () => {
  const rec = new SessionRecorder({ sessionId: "s10", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
  const session = makeSessionStub();
  for (const e of buildNormalFlow()) rec.handle(session, e);
  const snap = rec.snapshot();
  assert.equal(snap.stats.turnCount, 1);
  assert.equal(snap.stats.toolCallCount, 1);
});

// ---- 插件入口冒烟：mock ctx 加载 apply，验证注册与工具执行链路 ----

test("插件入口冒烟：apply 注册事件/工具/路由，工具可执行", async () => {
  const { apply, Config } = await import("../src/index.mjs");
  assert.equal(typeof apply, "function");
  assert.ok(Config); // schemastery Schema（可调用对象）

  const disposers = [];
  const onHandlers = {};
  const toolDefs = [];
  const routes = [];
  const sessionStub = {
    id: "sess-smoke-001",
    header: { createdAt: 1700000000000, cwd: "D:/x", agentPreset: "standard" },
    snapshotEvents: () => [],
  };

  const ctx = {
    get: (svc) => {
      if (svc === "settings") return null; // 无 settings，走 entry config
      if (svc === "webServer") return {
        register: (route) => { routes.push(route); return () => {}; },
      };
      if (svc === "sessionTitle") return { get: () => ({ title: "冒烟标题" }) };
      return undefined;
    },
    on: (evt, handler) => { onHandlers[evt] = handler; return () => {}; },
    effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
    logger: () => ({ warn: () => {}, info: () => {} }),
    tools: { register: (def) => { toolDefs.push(def); return () => {}; } },
  };

  apply(ctx, { enable: true, autoRecord: true, includeToolArgs: true });

  // 事件订阅齐全
  for (const evt of ["session/event", "agent/session-start", "agent/request-error"]) {
    assert.equal(typeof onHandlers[evt], "function", `应订阅 ${evt}`);
  }
  // 3 个工具注册
  assert.equal(toolDefs.length, 3);
  const names = toolDefs.map((t) => t.name);
  assert.deepEqual(names.sort(), ["export_session", "session_clear", "session_stats"]);
  // 3 条路由
  assert.equal(routes.length, 3);

  // 通过 session/event 驱动采集
  const handler = onHandlers["session/event"];
  let t = 0;
  handler(sessionStub, { type: "turn/start", seq: t++, time: 1000, data: { turn: 1 } });
  handler(sessionStub, { type: "user/message", seq: t++, time: 1100, data: { id: "m", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } } });
  handler(sessionStub, { type: "assistant/message", seq: t++, time: 1200, data: { turn: 1, step: 1, message: { id: "a", role: "assistant", content: [{ type: "text", text: "收到" }], source: { provider: "p", model: "m1" } } } });
  handler(sessionStub, { type: "turn/end", seq: t++, time: 1300, data: { turn: 1, reason: { kind: "completed" } } });

  // export_session 工具执行（缺省最近活跃会话）
  const exp = toolDefs.find((d) => d.name === "export_session");
  const result = await exp.execute({});
  assert.equal(result.format, "markdown");
  assert.ok(result.content.includes("会话复盘报告"));
  assert.ok(result.content.includes("你好"));
  assert.equal(result.turnCount, 1);

  // session_stats 执行
  const statsTool = toolDefs.find((d) => d.name === "session_stats");
  const statsResult = await statsTool.execute({});
  assert.ok(statsResult.text.includes("sess-smoke-001"));
  assert.ok(statsResult.text.includes("1 轮"));

  // session_clear 执行
  const clearTool = toolDefs.find((d) => d.name === "session_clear");
  const clearResult = await clearTool.execute({});
  assert.ok(clearResult.text.includes("已清空 1 个会话"));

  // 卸载清理
  for (const d of disposers) d();
  const afterClear = await exp.execute({});
  assert.ok(afterClear.content.includes("当前没有任何会话记录"));
});

// ===== 工具参数 schema 契约（回归：raw register 的 parameters 必须是完整 JSON Schema 根 type:object+properties）=====
test("index.mjs 工具参数为完整 JSON Schema（raw register 不会自动编译，defineTool 才会）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  // 不允许 required:false（dsh-tools 契约：required 只允许 true/省略）
  assert.equal((src.match(/required:\s*false/g) || []).length, 0, "发现非法 required:false");
  // 每个 ctx.tools.register 块的 parameters 根必须是 { type:"object", properties:{...} }
  const blocks = src.match(/ctx\.tools\.register\(\{[\s\S]*?\n  \}\)/g) || [];
  assert.ok(blocks.length >= 3, `应至少注册 3 个工具，实际 ${blocks.length}`);
  for (const block of blocks) {
    // parameters 根必须是完整 JSON Schema：紧跟 { type:"object", properties:{...} }
    const pm = block.match(/parameters:\s*\{\s*type:\s*"object",\s*properties:\s*\{/);
    assert.ok(pm, "parameters 必须是 { type:'object', properties:{...} } 完整 JSON Schema");
    // properties 内每个参数属性必须有合法 type
    const propRe = /^\s{8}(\w+):\s*\{([\s\S]*?)\n\s{8}\},?\s*$/gm;
    let prop;
    while ((prop = propRe.exec(block)) !== null) {
      assert.ok(/type:\s*"(string|number|integer|boolean|null|array|object|json)"/.test(prop[2]), `参数 ${prop[1]} 缺合法 type`);
    }
  }
});

// ===== client.js ModuleLoader 契约（回归：Cannot set properties of undefined (setting 'name')）=====
test("client.js 遵循 ModuleLoader 契约（factory 仅收 require，自行构造 module.exports）", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const code = readFileSync(new URL("../src/client.js", import.meta.url), "utf8");

  const makeEl = (tag) => ({
    tagName: tag,
    attrs: {},
    children: [],
    textContent: null,
    style: {},
    classList: { add() {}, remove() {} },
    disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    remove() {},
    click() {},
  });
  const documentMock = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load(entry) { loaded = { id: entry.id, factory: entry.factory }; } },
      confirm: () => true,
    },
    document: documentMock,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ enabled: true, sessions: [] }), text: () => Promise.resolve("") }),
    Blob: function () {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 0,
    console,
  };
  let loaded = null;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  assert.ok(loaded, "client.js 应调用 __ModuleLoader__.load");
  assert.equal(loaded.id, "dsh-plugin-session-export");

  // factory 只传 require —— 修复前此处抛 Cannot set properties of undefined
  let exported;
  assert.doesNotThrow(() => { exported = loaded.factory(() => ({})); });
  assert.equal(exported.name, "dsh-plugin-session-export");
  assert.equal(typeof exported.apply, "function");
  assert.equal(typeof exported.apply(), "function", "apply 应返回 dispose");
  exported.apply()(); // dispose 不抛错
});
