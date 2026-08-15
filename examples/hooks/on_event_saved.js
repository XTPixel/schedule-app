// on_event_saved：事件保存后触发。
// 入参 payload 为 JSON 字符串（事件对象，只读）。返回字符串作为导出输出。
function on_event_saved(payload) {
  var ev = JSON.parse(payload);
  if (!ev || !ev.title) return "";
  // 导出类场景：仅返回文本，不写内部数据文件。
  return "[event-saved] " + ev.id + " " + ev.title + " @ " + ev.start;
}
