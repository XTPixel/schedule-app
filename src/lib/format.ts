// 展示用常量与标签映射。
import type { ArchiveSource, CandidateSource, Priority } from "../types";

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "高",
  normal: "中",
  low: "低",
};

export const PRIORITY_BADGE: Record<Priority, string> = {
  high: "bg-red-50 text-red-600 border-red-200",
  normal: "bg-gray-50 text-gray-600 border-gray-200",
  low: "bg-sky-50 text-sky-600 border-sky-200",
};

export const SOURCE_LABEL: Record<ArchiveSource, string> = {
  event: "事件",
  routine: "日常",
  task: "浮动",
  longtask: "长期",
  manual: "手动",
};

export const CANDIDATE_SOURCE_LABEL: Record<CandidateSource, string> = {
  event: "事件",
  routine: "日常",
  task: "浮动",
};

export const WEEKDAY_LABEL = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function weekdayLabel(days: number[]): string {
  if (!days.length) return "每天";
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_LABEL[d] ?? `周${d}`)
    .join("·");
}

export function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return "进行中";
  }
}
