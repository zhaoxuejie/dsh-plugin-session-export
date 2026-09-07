// 临时脚本：生成示例报告（docs/sample-report.md / .html）
import { writeFileSync } from "node:fs";
import { SessionRecorder } from "../src/recorder.mjs";
import { computeStats } from "../src/stats.mjs";
import { renderMarkdownReport } from "../src/exporter-markdown.mjs";
import { renderHtmlReport } from "../src/exporter-html.mjs";

const rec = new SessionRecorder({ sessionId: "demo-session-9f3a2c", maxEvents: 500, maxContentLength: 2000, includeToolArgs: true, includeReasoning: true });
const s = { id: "demo-session-9f3a2c", header: { createdAt: 1757100000000, cwd: "D:/projectDsh", agentPreset: "standard" } };
let t = 0;
// 所有事件使用同一 epoch 时钟（与真实 Harness 一致），offset 毫秒递增
const T0 = 1757100000000;
const at = (type, data, offset) => ({ type, seq: t++, time: T0 + (offset ?? t * 250), data });

rec.handle(s, at("turn/start", { turn: 1 }));
rec.handle(s, at("user/message", { id: "m1", role: "user", content: [{ type: "text", text: "帮我把这个项目的代码结构梳理一下，看看有哪些插件" }], source: { kind: "user" } }));
rec.handle(s, at("assistant/message", { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "用户想了解项目结构，我需要用 bash 列出目录，再逐个查看关键文件的 package.json。" }], source: { provider: "deepseek", model: "deepseek-chat" } } }));
rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "call_1", name: "bash", arguments: '{"command":"ls -la","cwd":"D:/projectDsh"}' }));
rec.handle(s, at("tool/result", { turn: 1, step: 1, message: { id: "t1", role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "dsh-plugin-obsidian\ndsh-plugin-session-export\ndeepseek-harness\nmoqian-dsh-plugin" }], isError: false }] } }, 3200));
rec.handle(s, at("tool/call", { turn: 1, step: 1, callId: "call_2", name: "read_file", arguments: '{"path":"dsh-plugin-obsidian/package.json"}' }));
rec.handle(s, at("tool/result", { turn: 1, step: 1, message: { id: "t2", role: "user", content: [{ type: "tool-result", toolCallId: "call_2", content: [{ type: "text", text: '{"name":"dsh-plugin-vault-memory","version":"0.2.0"}' }], isError: false }] } }, 4100));
rec.handle(s, at("assistant/message", { turn: 1, step: 1, message: { id: "a2", role: "assistant", content: [{ type: "text", text: "项目下共 4 个主要目录，其中 dsh-plugin-obsidian 是一个 Obsidian 记忆插件（v0.2.0）。" }], source: { provider: "deepseek", model: "deepseek-chat" } }, usage: { promptTokens: 320, completionTokens: 86, totalTokens: 406 } }));
rec.handle(s, at("turn/end", { turn: 1, reason: { kind: "completed" } }));

rec.handle(s, at("turn/start", { turn: 2 }));
rec.handle(s, at("user/message", { id: "m2", role: "user", content: [{ type: "text", text: "那 session-export 呢？" }], source: { kind: "user" } }));
rec.handle(s, at("tool/call", { turn: 2, step: 1, callId: "call_3", name: "web_fetch", arguments: '{"url":"https://example.com/api"}' }));
rec.handle(s, at("tool/result", { turn: 2, step: 1, message: { id: "t3", role: "user", content: [{ type: "tool-result", toolCallId: "call_3", content: [{ type: "text", text: "" }], isError: true }] }, error: { name: "FetchError", code: "HTTP_503", message: "上游服务暂不可用（503）" } }, 6800));
rec.handle(s, at("assistant/message", { turn: 2, step: 1, message: { id: "a3", role: "assistant", content: [{ type: "text", text: "抱歉，刚才请求失败了（503），我换个方式再试。" }], source: { provider: "deepseek", model: "deepseek-chat" } }, usage: { promptTokens: 60, completionTokens: 22, totalTokens: 82 } }));
rec.handle(s, at("turn/end", { turn: 2, reason: { kind: "error", error: { message: "Model request failed after tool error", code: "LLM_RETRY" } } }));

const snap = rec.snapshot();
const stats = computeStats(snap);
const md = renderMarkdownReport(snap, stats, { generatedAt: 1757100123456 });
const html = renderHtmlReport(snap, stats, { theme: "dark", generatedAt: 1757100123456 });
writeFileSync(new URL("./sample-report.md", import.meta.url), md, "utf8");
writeFileSync(new URL("./sample-report.html", import.meta.url), html, "utf8");
console.log("sample written, md bytes:", md.length, "html bytes:", html.length);

