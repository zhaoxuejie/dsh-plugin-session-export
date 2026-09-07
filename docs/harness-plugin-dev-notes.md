---
title: DeepSeek Harness 插件开发踩坑笔记
date: 2026-09-07
tags: [deepseek-harness, plugin, cordis, 踩坑]
summary: 开发 dsh-plugin-session-export 过程中实际踩到的坑、根因和修复方式，按范式、事件契约、工具注册、Client Bundle、安装验证五类整理。
---

# DeepSeek Harness 插件开发踩坑笔记

> 来源：开发 `dsh-plugin-session-export` 全过程实录。每条都是实际报过错、花过时间排查的，不是纸上谈兵。

## 一、项目范式（别被 PRD 带偏）

### 1. 零构建 ESM，不是 TypeScript

PRD 里写 `src/index.ts` 是作者的设想。项目内既有插件（`dsh-plugin-obsidian`、`dsh-daily-digest`）统一是 **`.mjs` 零构建**。跟随范式，不要自己引入构建链。

### 2. 挂载文件是 `cordis.patch.yml`，不是 `cordis.yml`

```yaml
# cordis.patch.yml — bundle 层 patch，自动应用
- insert:
    - id: dsh-plugin-your-name
      name: dsh-plugin-your-name
```

profile 根目录的 `cordis.yml` 是空数组（注释明确说"edit cordis.patch.yml, not this file"）。

### 3. schemastery 必须默认导入

```js
import Schema from "schemastery";   // ✅ 正确（CJS 默认导出）
import { Schema } from "schemastery"; // ❌ 错误，会是 undefined
```

### 4. 服务通过 `ctx.get()` 获取，不是属性访问

```js
const settings = ctx.get("settings");
const webServer = ctx.get("webServer");
const sessionTitle = ctx.get("sessionTitle");
```

服务可能不存在（不同 profile），要做存在性判断再注册，不能崩。

### 5. 清理用 `ctx.effect()`

```js
ctx.effect(() => {
  const off = ctx.on("session/event", handler);
  return () => { off(); recorderMap.clear(); };
});
```

插件卸载时 cordis 自动调用返回的清理函数。所有订阅、定时器、DOM 都要在这里释放。

### 6. settings 注册的正确姿势

```js
const scope = settings.register(name, Config, {
  applies: "live",          // 运行时热更新
  base: entryConfig,        // 入口配置作为 base 层
});
const config = resolveConfig(scope.get());
scope.watch((next) => Object.assign(config, resolveConfig(next)));
```

配置数值越界要**钳制**（clamp），不要回退默认值——回退会让用户设置"消失"。

---

## 二、事件契约（必须对照源码，不能猜）

### 7. PRD 的事件名是设想，真实事件名不同

| PRD 设想 | 真实 Harness 事件 |
|---|---|
| `turn:before` | `turn/start` |
| `turn:after` | `turn/end`（含 `reason`） |
| `user:message` | `user/message` |
| `tool:before` | `tool/call`（含 `callId`、`arguments` 是 JSON 字符串） |
| — | `tool/result`（含 `message`，`message.content[0]` 是 tool-result 块） |
| — | `assistant/message`（含 `usage`、`interrupted`） |
| — | `session/title`、`agent/session-start`、`agent/request-error` |

**统一通过 `session/event` 事件推送**，结构是 `{ type, seq, time, data }`。不要去订阅 `turn/start` 等单独事件——它们不存在。

### 8. `seq` 必须严格递增，否则被去重

事件总线按 `seq` 去重。补发/模拟事件时 seq 要单调 +1，重复 seq 会被静默丢弃。

### 9. 本地 zstd 会话文件没有事件历史

`~/.dsh/sessions/*/session.jsonl.zstd` 解压后只有 header，**不含事件流**——事件只在运行时实时推送，不落盘。所以插件必须：
- 实时订阅 `session/event`
- 首次收到某会话时用 `session.snapshotEvents()` 补录插件加载前已发生的事件

不要尝试从 zstd 文件回放事件。

### 10. `turn/end` 的 reason 结构

```js
data.reason = { kind: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted", error?: ... }
```

`kind` 是枚举，不要自己发明。渲染时做映射表。

---

## 三、工具注册（这次最痛的坑）

### 11. ⚠️ raw `ctx.tools.register()` 的 parameters 必须是完整 JSON Schema

**这是本次耗时最长的 bug。**

```js
// ❌ 错误：参数名映射（defineTool 风格），raw register 不会自动编译
ctx.tools.register({
  name: "my_tool",
  parameters: {
    session: { type: "string", description: "..." },
    format:  { type: "string", description: "..." },
  },
  ...
});

// ✅ 正确：完整 JSON Schema，根必须有 type:"object" + properties
ctx.tools.register({
  name: "my_tool",
  parameters: {
    type: "object",
    properties: {
      session: { type: "string", description: "..." },
      format:  { type: "string", description: "..." },
    },
  },
  ...
});
```

**根因**：`defineTool()` 内部会调用 `parameterSchemaSpecToJsonSchema()` 把参数名映射编译成标准 JSON Schema。但 raw `ctx.tools.register()` 的 `schemas()` 方法**直接透传** `parameters`，不做编译。模型 API（DeepSeek）收到非标准 JSON Schema 的 parameters 就会报：

```
Invalid schema for function 'my_tool': {"type":"string","description":"..."} is not of type "string"
```

**判断依据**：harness 官方测试 `tools.spec.ts:1949` 里 raw register 写的就是 `parameters: { type: 'object', properties: {...} }`。而测试里的 `echoTool` 是 `defineTool()` 定义的，所以可以写参数名映射——别被它误导。

### 12. 参数属性里不能写 `required: false`

```js
// ❌ 错误
{ type: "string", required: false, description: "..." }

// ✅ 正确（可选参数直接省略 required）
{ type: "string", description: "..." }

// ✅ 必填参数
{ type: "string", required: true, description: "..." }
```

dsh-tools 的 `compilePropertyMap` 校验：`required` 存在时必须为 `true`。写 `required: false` 会抛 `unsupported JSON schema: parameters.xxx.required must be true when present`。

### 13. `output` 必须有 `schema` + `render`

```js
output: {
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  render: (_args, value) => [{ type: "text", text: value.text }],
}
```

register 时会校验 `output.render` 必须是函数，`output.schema` 必须通过 `assertSupportedJsonSchema`。

### 14. `timeoutMs` 必须是正有限数

`undefined` 可以（不设超时），但设了就必须 `> 0` 且有限。`0`、`Infinity`、`NaN` 都会抛 `timeoutMs must be a positive finite number`。

---

## 四、Client Bundle（浏览器端）

### 15. ⚠️ `__ModuleLoader__.load` 的 factory 只收 `require` 一个参数

```js
// ❌ 错误：第二个参数 exports 是 undefined
window.__ModuleLoader__.load({
  id: "my-plugin",
  factory: function (require, exports) {
    exports.name = "my-plugin";  // 💥 Cannot set properties of undefined (setting 'name')
  },
});

// ✅ 正确：自行构造 module/exports
window.__ModuleLoader__.load({
  id: "my-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ... 业务逻辑 ...
    module.exports = { name: "my-plugin", apply: apply };
    return module.exports;
  },
});
```

Harness 的 ModuleLoader 调用 factory 时只传 `require`。这是与 obsidian 插件对齐的契约，照抄即可。

### 16. `apply()` 要返回 dispose 函数

```js
function apply() {
  // 挂载 DOM、启动轮询
  var timer = setInterval(refresh, 3000);
  return function dispose() {
    clearInterval(timer);
    host.remove();
    style.remove();
  };
}
```

### 17. Client bundle 生产模式无 HMR

改 `client.js` 后必须**重启 dsh web**，bundle 在启动时组合，运行中不 watch。开发模式（`--dev`）才有 HMR。

### 18. package.json 的 `dsh.client` 声明

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": false
    }
  },
  "exports": {
    "./client": "./src/client.js"
  }
}
```

`exports["./client"]` 指向浏览器端入口。client-modules 服务扫描 bundle 里声明了 `dsh.client` 的包，组合成浏览器可加载的脚本。

---

## 五、Web 路由（webServer）

### 28. ⚠️ webServer 的 handler 用 Node 原生 `res`，不是 Express

```js
// ❌ 错误：Express 风格，原生 res 没有 send/statusCode 方法，响应发不出去
const json = (res, code, body) => {
  res.statusCode(code);
  res.setHeader("content-type", "application/json");
  res.send(JSON.stringify(body));  // 💥 原生 res 没有 send，静默失败，前端 fetch 挂起
};

// ✅ 正确：Node 原生 http.ServerResponse
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

webServer.register({
  kind: "exact",
  path: "/my-plugin/stats",
  handler: async (_req, res) => {
    json(res, 200, { ok: true });
  },
});
```

**症状**：前端面板显示"服务不可用"，fetch 超时或网络错误。因为 handler 执行了但 `res.end()` 从未被调用，连接挂起。

**判断依据**：obsidian、daily-digest 等插件的路由全部用 `res.writeHead()` + `res.end()`。照抄即可。

### 29. 路由注册用 `kind: "exact"` + `path` + `handler(req, res)`

```js
webServer.register({
  kind: "exact",
  path: "/my-plugin/xxx",
  handler: async (req, res) => { ... },
});
```

`kind` 字段不能省。`req.url` 包含查询字符串，用自己的 parseQuery 解析。

### 30. ⚠️ inject 里声明不存在的服务会导致整个应用崩溃

```js
// ❌ 危险：如果 webServer 服务在当前 profile 未注册或名称不同，cordis 依赖注入校验失败，整个 dsh 崩溃
export const inject = ["tools", "webServer", "sessions"];

// ✅ 安全：只声明确定存在的服务，可选服务用 ctx.get() 按需获取
export const inject = ["tools", "sessions"];
// webServer 用延迟获取（见下一条）
```

**症状**：dsh web 启动后进程直接退出，端口无监听，页面无法访问。不是插件加载失败，是整个应用崩。

### 31. ⚠️ webServer 不要加到 inject，用延迟获取（轮询等待就绪）

插件可能在 webServer 服务初始化之前加载，此时 `ctx.get("webServer")` 返回 undefined。直接判断跳过会导致路由永远注册不上。

```js
// ✅ 正确：effect 里轮询等待 webServer 就绪
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
```

### 32. 面板要跟随当前会话（latestSessionId），不要固定 sessions[0]

```js
// ❌ 错误：永远显示排序后的第一个（可能是时长最长的旧会话）
var s = data.sessions[0];

// ✅ 正确：优先显示 latestSessionId 对应的当前活跃会话
var s = data.sessions.find(x => x.sessionId === data.latestSessionId) || data.sessions[0];
```

后端排序按**最近活跃时间**（`lastEventTime` 降序），不要按总时长（`totalDurationMs`）——否则旧长会话永远排第一。

---

## 六、安装与验证

### 19. 本地安装到 web profile

```bash
# 1. profile 的 package.json 加两处：
#    dsh.profile.bundles 数组追加 "dsh-plugin-your-name"
#    dependencies 加 "dsh-plugin-your-name": "link:D:/path/to/your-plugin"

# 2. 安装（建立符号链接）
cd ~/.dsh/profiles/web
pnpm install --no-frozen-lockfile
```

`link:` 协议在 Windows 上创建 Junction（目录联接），不是文件符号链接。

### 20. 不需要重装——link 协议源码改了直接生效

改插件源码后**不需要 pnpm install**，只需重启 dsh web。只有改 `package.json`（依赖、bundles）才需要重新 install。

### 21. 验证挂载：`dsh --profile web --dump-config`

```bash
dsh --profile web --dump-config | Select-String "your-plugin"
```

输出里出现 `# == dsh-plugin-your-name` 和 `id: dsh-plugin-your-name` 说明挂载成功。这是不启动服务就能验证的最快方式。

### 22. 所有插件路由都 404 不一定是你的问题

web 服务有 token 认证（`?token=xxx`），且插件路由可能有前缀。如果 `/your-plugin/xxx` 返回 404，先对比其他已启用插件的路由（如 `/vault-memory/health`）——如果都 404，说明是认证或路径前缀问题，不是你插件的问题。

### 23. web 服务关键信息

- 端口：`3080`（`127.0.0.1:3080`）
- 启动：`dsh web`（会自动打开浏览器，带 token）
- 日志：启动时 stdout 显示 `dsh web: http://127.0.0.1:3080/?token=xxx`
- 后台启动重定向日志：`Start-Process node -ArgumentList "...bin.js","web" -RedirectStandardOutput out.log -RedirectStandardError err.log`

---

## 六、测试策略

### 24. 单元测试用 `node --test`，零依赖

```js
import { test } from "node:test";
import assert from "node:assert/strict";
```

不需要 vitest/jest。测试文件放 `test/run-all.mjs`，运行 `node --test test/run-all.mjs`。

### 25. 写 Client Bundle 的契约回归测试

用 `node:vm` 模拟浏览器环境，验证 factory 契约：

```js
import vm from "node:vm";
const sandbox = {
  window: { __ModuleLoader__: { load(e) { loaded = e; } } },
  document: mockDocument,
  fetch: () => Promise.resolve(...),
  setInterval: () => 1, clearInterval: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(clientCode, sandbox);
const exported = loaded.factory(() => ({})); // 只传 require
assert.equal(exported.name, "my-plugin");
assert.equal(typeof exported.apply, "function");
```

这能捕获 "factory 多收了 exports 参数" 这类回归。

### 26. 写工具参数 schema 的源码级断言

直接读 `src/index.mjs` 源码，正则断言每个 `ctx.tools.register` 块的 `parameters` 根是 `{ type:"object", properties:{...} }`，且不含 `required: false`。比运行时集成测试轻量且确定性强。

### 27. 冒烟测试：模拟 cordis 上下文

构造最小 `ctx` mock（`ctx.on`、`ctx.tools.register`、`ctx.get`、`ctx.effect`），调用 `apply(ctx, {})`，验证工具注册、事件订阅、清理函数都正常。这比真实启动 harness 快得多。

---

## 七、快速检查清单（开发新插件时过一遍）

- [ ] 入口是 `.mjs`，`export const name/inject/Config + export function apply`
- [ ] `cordis.patch.yml` 的 insert 里 id 和 name 与 package.json name 一致
- [ ] schemastery 用默认导入
- [ ] 服务用 `ctx.get()` 并做存在性判断
- [ ] 清理用 `ctx.effect(() => () => ...)`
- [ ] 事件名对照过 harness 源码（`session/event` + `{type, seq, time, data}`）
- [ ] 工具 `parameters` 是完整 JSON Schema（根 `type:"object"` + `properties`）
- [ ] 参数属性没有 `required: false`
- [ ] 工具 `output` 有 `schema` + `render`
- [ ] client.js 的 factory 只收 `require`，自行构造 module.exports
- [ ] package.json 有 `dsh.client.platform: "web"` 和 `exports["./client"]`
- [ ] `node --check` 所有源文件通过
- [ ] `node --test` 全绿
- [ ] `dsh --profile web --dump-config` 能看到插件挂载
- [ ] 重启 dsh web 后浏览器控制台无 "Failed to load plugins"
