// Deliberately ES5: old WebViews must display useful instructions even when
// they cannot parse the application's modern JavaScript module.
(function () {
  var unsupported = typeof window.structuredClone !== "function" || typeof Object.fromEntries !== "function";
  window.__momentUnsupportedWebView = unsupported;
  if (!unsupported) {
    window.setTimeout(function () {
      var pending = document.getElementById("boot-message");
      if (!pending) return;
      pending.textContent = "启动尚未完成";
      document.getElementById("boot-help").textContent = "请重新打开此刻；若仍无法启动，请保留应用和日程数据以便排查。";
      var again = document.getElementById("boot-retry");
      again.hidden = false;
      again.addEventListener("click", function () { window.location.reload(); });
    }, 15000);
    return;
  }
  document.getElementById("boot-message").textContent = "请更新系统浏览组件";
  document.getElementById("boot-help").textContent = /Android/i.test(navigator.userAgent)
    ? "当前系统浏览组件缺少此刻所需的功能。请在系统应用商店更新 Android System WebView 或 Chrome，再重新打开此刻。日程数据会保留。"
    : "当前浏览组件缺少此刻所需的功能。请更新 Microsoft Edge WebView2 运行时，再重新打开此刻。日程数据会保留。";
  var retry = document.getElementById("boot-retry");
  retry.hidden = false;
  retry.addEventListener("click", function () { window.location.reload(); });
})();
