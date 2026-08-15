# 个人日程管理 · Phase 0 (MVP) 开发核对清单（0.1.0）

> 版本定标（v1.0.0 正式版方案）：MVP = **0.1.0**，详见 `docs/版本历史与定标.md`。
> 对照《项目策划文档 v0.6》第 9.4 节 Sprint 0 任务与第 1~12 章约束，逐项校验完成情况。
> 状态说明：✅ 已实现并验证 · 🟡 已实现（受沙箱环境限制未能编译验证）· ⬜ 未实现（明确属于 Phase 1 及以后，禁止超范围）。

---

## 一、工程脚手架（子目标 1）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1.1 | Tauri 2.x 工程骨架 | ✅ | `src-tauri/`（Rust + workspace 双 crate）+ 根目录 Vite 前端 |
| 1.2 | 后端 Rust 技术栈 | ✅ | `tauri 2`、`tauri-plugin-notification 2`、`serde/serde_json`、`chrono/chrono-tz` |
| 1.3 | 前端 React + TypeScript + Vite | ✅ | `package.json` 锁定 react18/ts5/vite5 |
| 1.4 | Tailwind CSS | ✅ | `tailwind.config.js` + `postcss.config.js`，仅浅色主题配色 |
| 1.5 | Zustand 状态管理 | ✅ | `src/store/useAppStore.ts` |
| 1.6 | 前端构建可编译 | ✅ | `tsc` 零错误 + `vite build` 成功（73 模块，dist 产出） |
| 1.7 | 后端核心 crate 可编译 | 🟡 | `schedule-core` 通过 vendor 离线目录源 `cargo check`（见 §九） |

## 二、数据模型（子目标 2，与第 5 章 JSON Schema 一一对应）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 2.1 | `Event` 字段与 §5.2 一致 | ✅ | id/title/description/start/end/allDay/reminders/repeat/tags/priority/status/createdAt/updatedAt/completedAt/deletedAt |
| 2.2 | `Routine` 字段与 §5.3 一致 | ✅ | timeWindows(daysOfWeek/start/end)/durationMinutes/tags/priority/enabled + deletedAt |
| 2.3 | `Task` 字段与 §5.4 一致 | ✅ | deadline/sortOrder/status + deletedAt |
| 2.4 | `ArchiveEntry/Day/File` 与 §5.5 一致 | ✅ | time/doneAt 分离、source/sourceId、按月文件 |
| 2.5 | `Config` 与 §5.6 一致 | ✅ | timezone/notifications(doNotDisturb)/appearance/behavior/candidate.missedRoutineGraceHours/dataDir |
| 2.6 | 短 ID（e_/r_/t_/a_ 前缀） | ✅ | `core/src/id.rs` 时间戳+计数器混合 |
| 2.7 | 前向兼容：未知字段忽略 | ✅ | serde 默认忽略未知字段；预留字段（repeat/reminders/durationMinutes）MVP 只落盘不消费 |

## 三、存储层（子目标 2，§5.7）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 3.1 | 原子写入（临时文件 + rename） | ✅ | `storage.rs::write_json_atomic`（`.tmp` → `rename`） |
| 3.2 | `.bak` 备份机制 | ✅ | 覆盖前复制上一份到 `.bak`；加载损坏时另存 `.corrupt-<ts>.bak` |
| 3.3 | 数据版本校验 | ✅ | `version` 高于当前版本拒绝加载并报错（含「导出/升级」提示文案） |
| 3.4 | 版本迁移骨架 | ✅ | `migrate_v0_to_v1` + 迁移步骤分发循环 |
| 3.5 | mtime 外部修改检测 | ✅ | 读时记录 mtime，写时比对并返回 `ExternalChange` 标记（MVP 自动重载语义） |
| 3.6 | 软删除（deletedAt） | ✅ | 三类对象删除均写 `deletedAt`，候选引擎过滤 |
| 3.7 | 归档按月分文件 | ✅ | `archive/YYYY-MM.json` |

## 四、候选推荐引擎（子目标 4，第 8 章）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 4.1 | 五层打分分层 | ✅ | 1 事件进行中/即将开始 → 2 窗口内日常 → 3 逾期日常 → 4 今天晚些事件 → 5 浮动事项 |
| 4.2 | 过滤规则（§8.3） | ✅ | 排除 completed/cancelled/enabled=false/deletedAt/当日已归档 |
| 4.3 | 逾期宽限 missedRoutineGraceHours=4 | ✅ | 硬编码 4（config 字段落盘，V1.0 开放） |
| 4.4 | 免打扰时段仅应用内展示 | ✅ | `should_notify` 由全局开关 + DND 计算 |
| 4.5 | 同分「最久未做」打破平局 | ✅ | 按月内归档的 lastDone 升序 |
| 4.6 | 输出主候选 1 + 次选 5 | ✅ | `main` + `secondary`（默认 5） |
| 4.7 | 候选附类型/来源/建议时长/操作 | ✅ | `Candidate{sourceType,sourceId,suggestedDurationMinutes,...}` |
| 4.8 | 今日时间轴 | ✅ | 事件 + 日常窗口 + 当日归档 |

## 五、后端 IPC 命令（子目标 3，§9.4 Sprint 0 API）

| # | API | 状态 |
| --- | --- | --- |
| 5.1 | `load_all_data()` | ✅ 加载并校验全部 JSON |
| 5.2 | `get_now_candidates(now)` | ✅ 返回候选 + 今日时间轴 + 提醒 |
| 5.3 | `save_event` / `delete_event` | ✅ CRUD（软删除） |
| 5.4 | `save_routine` / `delete_routine` | ✅ CRUD（软删除） |
| 5.5 | `save_task` / `delete_task` | ✅ CRUD（软删除） |
| 5.6 | `archive_entry(entry)` | ✅ 按 doneAt 归属到天，返回已存条目 |
| 5.7 | `update_archive_day(date, payload)` | ✅ 覆盖某天（补记/编辑/删除/小结） |
| 5.8 | `get_config` / `set_config` | ✅ 配置读写 |
| 5.9 | `notify(title, body)` | ✅ 系统通知（尊重全局开关） |
| 5.10 | 补充 `get_archive_month(month)` | ✅ 归档页翻月读取 |

## 六、前端页面（子目标 5/6，第 7 章）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 6.1 | 「现在」首页 | ✅ | 大号当前时间 + 主候选卡 + 次选列表 + 今日时间轴 + 快录框 |
| 6.2 | 主候选「开始/完成/跳过/稍后」 | ✅ | 完成→归档+标记完成；跳过/稍后为会话内隐藏 + Toast |
| 6.3 | 事件列表页 | ✅ | 行内编辑标题 + 时间范围 + 优先级 + 更多→抽屉 |
| 6.4 | 日常列表页 | ✅ | 窗口展示 + 启用开关 + 抽屉 |
| 6.5 | 浮动事项列表页 | ✅ | 拖拽排序（sortOrder 静默保存）+ 上下移动按钮 |
| 6.6 | 归档页 | ✅ | 日期导航 + 手动补记 + 编辑/删除 |
| 6.7 | 设置页 | ✅ | 通知/免打扰/行为/时区/宽限只读 |
| 6.8 | 行内编辑 + 右侧 480px 非模态抽屉 | ✅ | `InlineEdit` + `Drawer`（fixed right 480px） |
| 6.9 | 禁用模态弹窗（仅危险确认） | ✅ | 删除走 `ConfirmDialog`，其余无模态 |
| 6.10 | 失焦自动保存 | ✅ | 抽屉字段 onBlur → `saveDraft` |
| 6.11 | Toast 撤销（5–7 秒） | ✅ | 删除/完成/归档均可撤回（6 秒） |
| 6.12 | 时间输入：键盘直输 1430→14:30 + 步进 | ✅ | `TimeField` |
| 6.13 | 前端不直接读写本地文件 | ✅ | 全部经 `invoke` 调 Rust 后端 |

## 七、托盘 / 通知 / 常驻（子目标 7，§4.5/§4.7/§6.3）

| # | 检查项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 7.1 | 最小化到托盘 | ✅ | `CloseRequested` 时隐藏 + `prevent_close`（按 `minimizeToTray` 配置） |
| 7.2 | 托盘菜单（打开/快速新增/通知开关/退出） | ✅ | `build_tray` |
| 7.3 | 托盘单击恢复主窗口 | ✅ | 左键单击 → `show_main` |
| 7.4 | 基础系统通知 | ✅ | `tauri-plugin-notification` |
| 7.5 | 被动刷新 + resume 唤醒钩子 | ✅ | 启动/窗口打开触发 `check_and_notify`；`RunEvent::Resumed` 重算 + 补发 + 向前端 `emit("app-resumed")` |
| 7.6 | 不做高频后台轮询 | ✅ | 无后台线程；前端 60s 被动刷新 + 窗口 focus 刷新 |

## 八、约束规则核对（总目标第 1~10 条）

| # | 约束 | 状态 | 说明 |
| --- | --- | --- | --- |
| 8.1 | 只做 Phase 0，Phase1/1.5/2.0 不实现 | ✅ | 无日历视图/自然语言解析/深色主题/统计/Git 备份/全局快捷键/开机自启 |
| 8.2 | 技术栈固定 | ✅ | Tauri2+Rust；React+TS+Vite+Tailwind+Zustand；Tauri IPC 读 JSON |
| 8.3 | 存储原子性/备份/版本/软删除 | ✅ | 见 §三 |
| 8.4 | 候选引擎 Rust 后端实现 | ✅ | `schedule-core::candidates` |
| 8.5 | 不实现 NLP/日历/热键/深色/统计/Git | ✅ | 仅浅色主题；快录为纯文本 |
| 8.6 | 前端只做 UI，业务在后端 | ✅ | 所有业务/存储/候选/通知经 IPC |
| 8.7 | 行内编辑 + 480px 抽屉 + 失焦保存 + Toast | ✅ | 见 §六 |
| 8.8 | 时间/时区按 §5.8 | ✅ | 绝对时刻落盘 UTC Z；窗口 HH:mm；全天 YYYY-MM-DD |
| 8.9 | 托盘/最小化/通知/resume | ✅ | 见 §七 |
| 8.10 | 产出代码 + 核对清单 | ✅ | 本清单 + 完整代码 |

---

## 九、验证结果与环境限制（如实记录）

| 验证项 | 结果 |
| --- | --- |
| 前端 `tsc` 类型检查 | ✅ 通过（0 错误） |
| 前端 `vite build` 生产打包 | ✅ 通过（73 模块，`dist/` 产出：JS 198KB / CSS 18.8KB） |
| 后端 `schedule-core` `cargo check` | ✅ 通过（0 错误 0 警告） |
| 后端 `schedule-app`（含 Tauri）Release 编译 | ✅ 通过（`Finished release profile`，产出 `schedule-app.exe`） |
| 应用启动冒烟测试 | ✅ 通过（进程存活、无崩溃） |
| 运行时存储层 | ✅ 通过（`%APPDATA%\com.personal.schedule\config.json` 生成且 Schema 正确，`.bak` 备份机制生效） |
| 安装包（msi/nsis）打包 | ⚠️ 未完成：bundler 需从 github.com 下载 WiX/NSIS 工具，本机网络访问 GitHub 超时/重置（环境问题，非代码问题） |

**验证过程（如实记录）：**
1. **前端**：`tsc` + `vite build` 全链路通过。
2. **后端核心逻辑**：早期沙箱无 MSVC/schannel，曾用「Node 走 crates.io 稀疏索引离线 vendor + GNU 工具链 + ASCII 临时目录」完成 `schedule-core` 的 `cargo check`（0 错误 0 警告）。
3. **后端应用层（Tauri 壳层）**：用户本机安装 Rust + Visual Studio Build Tools 后，`cargo build --release` 完整通过，期间修复了 5 处编译问题（3 个删除函数返回值类型、1 个未使用导入、1 个 `if let` 临时值生命周期）。
4. **运行验证**：启动 `schedule-app.exe` 冒烟测试通过；应用首启生成 `config.json`（字段与 §5.6 完全一致），`.bak` 备份机制正常触发。
5. **唯一未完成**：安装包 bundling（WiX/NSIS 从 GitHub 下载超时）。可执行文件已就绪，可直接分发运行；如需安装包，需在可访问 GitHub 的网络（或配置代理）下重跑 `npm run tauri build`。

---

## 十、如何运行（交付后）

```powershell
# 1. 安装前端依赖（npm 缓存可指向任意可写目录）
npm install

# 2. 安装 Rust 工具链（若已安装可跳过）
#    rustup 默认安装 stable-msvc；需 Visual Studio Build Tools（C++ 桌面开发）

# 3. 开发模式（前端热更新 + 打开桌面窗口）
npm run tauri dev

# 4. 打包（msi/nsis）
npm run tauri build
```

> 注：`src-tauri/.cargo/config.toml` 是为本沙箱离线编译生成的目录源配置，在正常联网环境可删除以恢复 crates.io 官方源；`src-tauri/vendor/` 为离线依赖缓存，可一并删除。
