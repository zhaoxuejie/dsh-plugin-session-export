// dsh-plugin-session-export — Web Client 侧边面板（浏览器 bundle，零依赖）
// 契约（与 dsh-plugin-vault-memory 同款，已真源码校准）：
//   window.__ModuleLoader__.load({ id, factory })；factory 只接收 require，
//   自行构造 module/exports，末尾 module.exports = { name, apply } 并 return module.exports；
//   apply(ctx) 挂载 DOM 并返回 dispose。
// 面板能力：会话统计卡片、工具分布迷你条形、导出 Markdown/HTML、清空记录、自动刷新。
// UI 入口：右上角导航栏按钮（"Session 日志"左侧），样式与导航栏按钮一致。

window.__ModuleLoader__.load({
  id: "dsh-plugin-session-export",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var NAME = "dsh-plugin-session-export";
    var POLL_MS = 3000;

    function el(tag, attrs, text) {
      var node = document.createElement(tag);
      if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
      if (text !== undefined) node.textContent = text;
      return node;
    }

    var css = [
      "#dsh-session-export-panel{position:fixed;top:56px;right:16px;z-index:2147483001;width:340px;max-height:70vh;",
      "background:#171a21;color:#e8eaed;border-radius:12px;border:1px solid #30363d;box-shadow:0 8px 32px rgba(0,0,0,.5);",
      "display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;",
      "font-size:13px;line-height:1.5}",
      "#dsh-session-export-panel.open{display:flex}",
      ".dse-nav-btn{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}",
      ".dse-head{padding:12px 14px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between}",
      ".dse-head b{font-size:14px}",
      ".dse-close{background:none;border:none;color:#8b949e;font-size:16px;cursor:pointer;padding:0 4px}",
      ".dse-body{padding:10px 14px;overflow-y:auto}",
      ".dse-status{color:#8b949e;font-size:12px;margin-bottom:10px;word-break:break-all}",
      ".dse-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}",
      ".dse-card{background:#21262d;border-radius:8px;padding:8px 10px}",
      ".dse-card .k{color:#8b949e;font-size:11px}",
      ".dse-card .v{font-size:17px;font-weight:600;margin-top:2px}",
      ".dse-bars{margin-bottom:12px}",
      ".dse-bars .bar-row{display:flex;align-items:center;gap:8px;margin:3px 0}",
      ".dse-bars .bar-name{width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9}",
      ".dse-bars .bar-track{flex:1;height:10px;background:#21262d;border-radius:5px;overflow:hidden}",
      ".dse-bars .bar-fill{height:100%;background:linear-gradient(90deg,#4D6BFE,#7C3AED);border-radius:5px}",
      ".dse-bars .bar-num{width:34px;text-align:right;color:#8b949e;font-size:11px}",
      ".dse-empty{color:#8b949e;text-align:center;padding:16px 0}",
      ".dse-actions{display:flex;gap:8px;margin-bottom:4px}",
      ".dse-btn{flex:1;border:none;border-radius:7px;padding:8px 6px;cursor:pointer;font-size:12.5px;font-weight:600;color:#fff}",
      ".dse-btn.md{background:#238636}.dse-btn.md:hover{background:#2ea043}",
      ".dse-btn.html{background:#8957e5}.dse-btn.html:hover{background:#a371f7}",
      ".dse-btn.clear{background:#da3633}.dse-btn.clear:hover{background:#f85149}",
      ".dse-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dse-foot{color:#8b949e;font-size:11px;text-align:center;padding:8px;border-top:1px solid #21262d}",
    ].join("");

    var styleNode = el("style", {}, css);
    document.head.appendChild(styleNode);

    // ---- 面板 DOM ----
    var panel = el("div", { id: "dsh-session-export-panel" });

    var head = el("div", { class: "dse-head" });
    head.appendChild(el("b", {}, "会话黑匣子"));
    var closeBtn = el("button", { class: "dse-close", title: "收起" }, "\u2715");
    head.appendChild(closeBtn);

    var body = el("div", { class: "dse-body" });
    var status = el("div", { class: "dse-status" }, "加载中…");
    var cards = el("div", { class: "dse-cards" });
    var bars = el("div", { class: "dse-bars" });
    var empty = el("div", { class: "dse-empty" }, "暂无会话记录");
    var actions = el("div", { class: "dse-actions" });
    var btnMd = el("button", { class: "dse-btn md" }, "导出 Markdown");
    var btnHtml = el("button", { class: "dse-btn html" }, "导出 HTML");
    var btnClear = el("button", { class: "dse-btn clear" }, "清空");
    btnMd.disabled = true; btnHtml.disabled = true; btnClear.disabled = true;
    actions.appendChild(btnMd); actions.appendChild(btnHtml); actions.appendChild(btnClear);

    body.appendChild(status); body.appendChild(cards); body.appendChild(bars); body.appendChild(empty); body.appendChild(actions);
    var foot = el("div", { class: "dse-foot" }, "dsh-plugin-session-export");
    panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot);
    document.body.appendChild(panel);

    // ---- 导航栏按钮：注入到"Session 日志"左侧，样式保持一致 ----
    var navBtn = el("button", { class: "dse-nav-btn", title: "会话黑匣子" });
    navBtn.innerHTML = "\ud83d\udce6 <span>会话黑匣子</span>";
    var navInjected = false;

    function findSessionLogBtn() {
      // 优先找包含"Session"或"日志"文本的 button
      var btns = document.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var txt = btns[i].textContent || "";
        if (txt.indexOf("Session") >= 0 || txt.indexOf("\u65e5\u5fd7") >= 0) {
          return btns[i];
        }
      }
      return null;
    }

    function injectNavButton() {
      if (navInjected) return true;
      var refBtn = findSessionLogBtn();
      if (!refBtn || !refBtn.parentNode) return false;
      // 复制参考按钮的样式，保持视觉一致
      try {
        var cs = window.getComputedStyle(refBtn);
        navBtn.style.background = cs.background;
        navBtn.style.color = cs.color;
        navBtn.style.border = cs.border;
        navBtn.style.borderRadius = cs.borderRadius;
        navBtn.style.padding = cs.padding;
        navBtn.style.fontSize = cs.fontSize;
        navBtn.style.fontFamily = cs.fontFamily;
        navBtn.style.fontWeight = cs.fontWeight;
        navBtn.style.cursor = "pointer";
        navBtn.style.display = "inline-flex";
        navBtn.style.alignItems = "center";
        navBtn.style.gap = "6px";
        navBtn.className = refBtn.className + " dse-nav-btn";
      } catch (e) { /* 样式复制失败不影响功能 */ }
      refBtn.parentNode.insertBefore(navBtn, refBtn);
      navInjected = true;
      return true;
    }

    if (typeof MutationObserver !== "undefined") {
      var navObserver = new MutationObserver(function () {
        injectNavButton();
        if (navInjected) navObserver.disconnect();
      });
      navObserver.observe(document.body, { childList: true, subtree: true });
    }
    // 立即尝试一次（页面可能已渲染完成）
    injectNavButton();

    // ---- 状态 ----
    var open = false;
    var currentSessionId = null;
    function toggle() {
      open = !open;
      if (open) { panel.classList.add("open"); refresh(); }
      else panel.classList.remove("open");
    }
    navBtn.addEventListener("click", toggle);
    closeBtn.addEventListener("click", function () { open = false; panel.classList.remove("open"); });

    // ---- 数据 ----
    function shortId(id) {
      var s = String(id || "-");
      return s.length > 20 ? s.slice(0, 8) + "\u2026" + s.slice(-4) : s;
    }

    function renderCards(data) {
      cards.textContent = "";
      if (!data || !data.enabled) {
        status.textContent = "插件已停用（enable=false）";
        btnMd.disabled = btnHtml.disabled = btnClear.disabled = true;
        empty.style.display = "block";
        bars.textContent = "";
        return;
      }
      var s = null;
      if (data.latestSessionId && data.sessions) {
        for (var i = 0; i < data.sessions.length; i++) {
          if (data.sessions[i].sessionId === data.latestSessionId) { s = data.sessions[i]; break; }
        }
      }
      if (!s && data.sessions && data.sessions.length) s = data.sessions[0];
      currentSessionId = s ? s.sessionId : null;
      if (!s) {
        status.textContent = "等待会话活动…";
        btnMd.disabled = btnHtml.disabled = btnClear.disabled = true;
        empty.style.display = "block";
        bars.textContent = "";
        return;
      }
      empty.style.display = "none";
      btnMd.disabled = btnHtml.disabled = btnClear.disabled = false;
      status.textContent = "最近活跃：" + shortId(s.sessionId) + (s.title ? "\uff08" + s.title + "\uff09" : "") + (s.stopped ? " \u26a0\ufe0f 已达上限" : "");
      var items = [
        ["轮次", s.turnCount || 0],
        ["工具调用", s.toolCallCount || 0],
        ["报错", s.errorCount || 0],
        ["中断", s.interruptedCount || 0],
      ];
      for (var j = 0; j < items.length; j++) {
        var c = el("div", { class: "dse-card" });
        c.appendChild(el("div", { class: "k" }, items[j][0]));
        c.appendChild(el("div", { class: "v" }, String(items[j][1])));
        cards.appendChild(c);
      }
      // 工具分布
      bars.textContent = "";
      var counts = s.toolNameCounts || {};
      var total = 0;
      for (var k in counts) total += counts[k];
      var entries = Object.keys(counts).map(function (n) { return [n, counts[n]]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
      if (total > 0 && entries.length) {
        bars.appendChild(el("div", { class: "k", style: "color:#8b949e;font-size:11px;margin-bottom:4px" }, "工具调用分布"));
        for (var m = 0; m < entries.length; m++) {
          var row = el("div", { class: "bar-row" });
          row.appendChild(el("div", { class: "bar-name", title: entries[m][0] }, entries[m][0]));
          var track = el("div", { class: "bar-track" });
          var fill = el("div", { class: "bar-fill" });
          fill.style.width = Math.max(4, Math.round((entries[m][1] / total) * 100)) + "%";
          track.appendChild(fill);
          row.appendChild(track);
          row.appendChild(el("div", { class: "bar-num" }, String(entries[m][1])));
          bars.appendChild(row);
        }
      }
    }

    function refresh() {
      fetch("/session-export/stats", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(renderCards)
        .catch(function () { status.textContent = "面板服务不可用"; });
    }

    // ---- 导出 / 清空 ----
    function download(format) {
      var url = "/session-export/export?format=" + format;
      if (currentSessionId) url += "&session=" + encodeURIComponent(currentSessionId);
      fetch(url, { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (text) {
          var blob = new Blob([text], { type: format === "html" ? "text/html" : "text/markdown" });
          var objUrl = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = objUrl;
          a.download = "session-report." + (format === "html" ? "html" : "md");
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(objUrl); }, 2000);
        })
        .catch(function () { status.textContent = "导出失败"; });
    }
    btnMd.addEventListener("click", function () { download("markdown"); });
    btnHtml.addEventListener("click", function () { download("html"); });
    btnClear.addEventListener("click", function () {
      if (!window.confirm("确认清空当前会话的复盘记录？此操作不可恢复。")) return;
      var url = "/session-export/clear";
      if (currentSessionId) url += "?session=" + encodeURIComponent(currentSessionId);
      fetch(url, { method: "POST", cache: "no-store" })
        .then(function () { refresh(); })
        .catch(function () { status.textContent = "清空失败"; });
    });

    // ---- 轮询 ----
    var timer = setInterval(function () { if (open) refresh(); }, POLL_MS);

    function apply() {
      // 挂载已在上方完成；返回清理函数
      return function dispose() {
        clearInterval(timer);
        if (typeof navObserver !== "undefined" && navObserver) navObserver.disconnect();
        styleNode.remove();
        if (navBtn.parentNode) navBtn.remove();
        panel.remove();
      };
    }

    module.exports = { name: NAME, apply: apply };
    return module.exports;
  },
});
