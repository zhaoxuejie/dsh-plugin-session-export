// 临时验证：模拟 Harness ModuleLoader 环境加载 client.js，验证 factory 契约
// 复现修复前的报错场景：Cannot set properties of undefined (setting 'name')
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("../src/client.js", import.meta.url), "utf8");

// ---- 浏览器环境 mock ----
const listeners = {};
const elements = [];
function makeEl(tag) {
  return {
    tagName: tag,
    attrs: {},
    children: [],
    textContent: null,
    style: {},
    classList: { add() {}, remove() {} },
    disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(evt, fn) { this["on" + evt] = fn; },
    remove() {},
    click() {},
  };
}
const documentMock = {
  head: makeEl("head"),
  body: makeEl("body"),
  createElement: (tag) => makeEl(tag),
  addEventListener: () => {},
};
const globalObj = {
  window: { __ModuleLoader__: null, confirm: () => true },
  document: documentMock,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ enabled: true, sessions: [] }), text: () => Promise.resolve("") }),
  Blob: function () {},
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 0,
  console,
};

// ---- 模拟 ModuleLoader：factory 只传 require（复现 bug 的关键）----
let loaded = null;
globalObj.window.__ModuleLoader__ = {
  load(entry) {
    const sandbox = { ...globalObj };
    // 以脚本方式执行，捕获 entry
    const factory = entry.factory;
    loaded = { id: entry.id, factory };
  },
};

// 用 vm 执行 client.js（全局 this = sandbox）
import vm from "node:vm";
vm.createContext(globalObj);
vm.runInContext(code, globalObj);

if (!loaded) {
  console.error("FAIL: client.js 未调用 __ModuleLoader__.load");
  process.exit(1);
}
if (loaded.id !== "dsh-plugin-session-export") {
  console.error("FAIL: id 不匹配", loaded.id);
  process.exit(1);
}

// 执行 factory，只传 require —— 修复前这里会抛 "Cannot set properties of undefined"
let exported;
try {
  exported = loaded.factory(() => ({}));
} catch (err) {
  console.error("FAIL: factory 执行抛错:", err.message);
  process.exit(1);
}

// 验证导出契约
if (!exported || exported.name !== "dsh-plugin-session-export" || typeof exported.apply !== "function") {
  console.error("FAIL: module.exports 契约不符:", exported && Object.keys(exported));
  process.exit(1);
}

// 验证 apply 返回 dispose
let dispose;
try {
  dispose = exported.apply();
} catch (err) {
  console.error("FAIL: apply 执行抛错:", err.message);
  process.exit(1);
}
if (typeof dispose !== "function") {
  console.error("FAIL: apply 应返回 dispose 函数");
  process.exit(1);
}
dispose(); // 清理不抛错

console.log("OK: client.js 契约验证通过（id/name/apply/dispose 全部正常）");
