// 主题切换（§4.8：浅色 / 深色 / 跟随系统）。
export type ThemePref = "light" | "dark" | "system";

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

/** 将主题类应用到 <html>，Tailwind darkMode: "class" 据此切换。 */
export function applyTheme(pref: ThemePref): "light" | "dark" {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  return resolved;
}
