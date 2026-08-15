// on_candidate_refresh：候选刷新（get_now_candidates）后触发。
// 入参 payload 为 JSON 字符串（候选结果，只读）。返回字符串作为导出输出。
function on_candidate_refresh(payload) {
  var r = JSON.parse(payload);
  if (!r) return "";
  var main = r.main ? "主:" + r.main.title : "主:无";
  var n = (r.secondary || []).length;
  return "[candidates] " + r.localDate + " " + main + " 次选" + n + "条";
}
