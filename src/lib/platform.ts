/**
 * 平台能力边界：Android 当前只提供本地日程能力，Windows 才启用桌面同步与系统集成。
 * 使用 WebView 的 user agent 判断不会触碰任何业务数据，也能在前端首帧完成降级。
 */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
