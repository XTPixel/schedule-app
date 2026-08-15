// V3.1 U4：标签颜色 token → 浅/深两套 Tailwind 类。
// 值保存在 config.tagColors（tag 名 → token）；未设置或未知 token 回退默认灰。
// 类名全部为字面量，保证 Tailwind 扫描时能生成对应样式。

export const TAG_COLOR_TOKENS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
  "gray",
] as const;

export type TagColorToken = (typeof TAG_COLOR_TOKENS)[number];

interface TagPalette {
  /** 芯片/底色（含浅色与深色主题）。 */
  bg: string;
  /** 边框。 */
  border: string;
  /** 文字。 */
  text: string;
  /** 日历左侧色条（纯色）。 */
  bar: string;
}

const PALETTE: Record<TagColorToken, TagPalette> = {
  red: {
    bg: "bg-red-50 dark:bg-red-900/30",
    border: "border-red-200 dark:border-red-800",
    text: "text-red-700 dark:text-red-300",
    bar: "bg-red-500",
  },
  orange: {
    bg: "bg-orange-50 dark:bg-orange-900/30",
    border: "border-orange-200 dark:border-orange-800",
    text: "text-orange-700 dark:text-orange-300",
    bar: "bg-orange-500",
  },
  amber: {
    bg: "bg-amber-50 dark:bg-amber-900/30",
    border: "border-amber-200 dark:border-amber-800",
    text: "text-amber-700 dark:text-amber-300",
    bar: "bg-amber-500",
  },
  green: {
    bg: "bg-green-50 dark:bg-green-900/30",
    border: "border-green-200 dark:border-green-800",
    text: "text-green-700 dark:text-green-300",
    bar: "bg-green-500",
  },
  teal: {
    bg: "bg-teal-50 dark:bg-teal-900/30",
    border: "border-teal-200 dark:border-teal-800",
    text: "text-teal-700 dark:text-teal-300",
    bar: "bg-teal-500",
  },
  blue: {
    bg: "bg-blue-50 dark:bg-blue-900/30",
    border: "border-blue-200 dark:border-blue-800",
    text: "text-blue-700 dark:text-blue-300",
    bar: "bg-blue-500",
  },
  indigo: {
    bg: "bg-indigo-50 dark:bg-indigo-900/30",
    border: "border-indigo-200 dark:border-indigo-800",
    text: "text-indigo-700 dark:text-indigo-300",
    bar: "bg-indigo-500",
  },
  violet: {
    bg: "bg-violet-50 dark:bg-violet-900/30",
    border: "border-violet-200 dark:border-violet-800",
    text: "text-violet-700 dark:text-violet-300",
    bar: "bg-violet-500",
  },
  pink: {
    bg: "bg-pink-50 dark:bg-pink-900/30",
    border: "border-pink-200 dark:border-pink-800",
    text: "text-pink-700 dark:text-pink-300",
    bar: "bg-pink-500",
  },
  gray: {
    bg: "bg-gray-100 dark:bg-slate-700",
    border: "border-gray-200 dark:border-slate-600",
    text: "text-gray-600 dark:text-slate-300",
    bar: "bg-gray-400",
  },
};

export function isTagColorToken(v: string | null | undefined): v is TagColorToken {
  return !!v && (TAG_COLOR_TOKENS as readonly string[]).includes(v);
}

/** 未知/未设置颜色回退默认灰。 */
export function resolveToken(v: string | null | undefined): TagColorToken {
  return isTagColorToken(v) ? v : "gray";
}

/** 标签芯片完整类（bg + border + text，浅深主题都可读）。 */
export function tagChipClasses(token: string | null | undefined): string {
  const p = PALETTE[resolveToken(token)];
  return `${p.bg} ${p.border} ${p.text}`;
}

/** 日历事项色条类。 */
export function tagBarClasses(token: string | null | undefined): string {
  return PALETTE[resolveToken(token)].bar;
}

/** 返回第一个已配置颜色的标签 token；无有色标签返回 null（维持默认样式）。 */
export function firstColoredTag(
  tags: string[],
  tagColors: Record<string, string>,
): string | null {
  for (const t of tags) {
    const c = tagColors[t];
    if (isTagColorToken(c)) return c;
  }
  return null;
}
