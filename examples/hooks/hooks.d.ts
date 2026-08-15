// 脚本钩子类型声明（仅用于编辑器提示，不影响运行时执行）。
// 运行环境：受限 JS 解释器（boa_engine，无文件系统/网络/进程能力）。
//
// 约定：
// - 每个 *.js 脚本可声明一个或多个下述钩子函数。
// - 入参 payload 为 JSON 字符串（只读快照，export 类场景）。
// - 返回值（string）为「导出输出」，会被后端收集（可通过「扩展 → 脚本钩子 → 测试钩子」查看）。
// - 脚本无法修改内部数据文件（解释器无 I/O 能力）。

type HookPayload = string;

declare function on_event_saved(payload: HookPayload): string | void;
declare function on_archive_entry_add(payload: HookPayload): string | void;
declare function on_candidate_refresh(payload: HookPayload): string | void;
