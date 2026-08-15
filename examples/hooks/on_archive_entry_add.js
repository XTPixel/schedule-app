// on_archive_entry_add：归档条目写入后触发。
// 入参 payload 为 JSON 字符串（归档条目，只读）。返回字符串作为导出输出。
function on_archive_entry_add(payload) {
  var entry = JSON.parse(payload);
  if (!entry) return "";
  return "[archived] " + entry.doneAt + " " + entry.time + " " + entry.title + " (" + entry.source + ")";
}
