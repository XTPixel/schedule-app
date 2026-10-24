<p align="center">
  <img src="assets/branding/icons/app-icon-256.png" alt="此刻 MOMENT 图标" width="128" />
</p>

<h1 align="center">此刻 MOMENT</h1>

<p align="center">
  本地优先 · 数据自持 · Windows / Android 个人日程管理应用<br/>
  回答「此刻该做什么」：事件 / 日常 / 浮动事项 / 长期任务 + 五层候选推荐引擎 + 今日时间轴 + 系统级提醒
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/版本-2.0.0--rc.1-2563EB" />
  <img alt="Platform" src="https://img.shields.io/badge/平台-Windows%20%2F%20Android-0078D6" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.x-FFC131" />
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB" />
</p>

---

## 项目简介

**此刻 MOMENT** 是一款本地优先的个人日程管理应用。业务数据保存在本机 JSON 文件中；未配置同步时无需云端。用户可选用自己的七牛空间，上传经过压缩和加密的快照，在 Windows 和 Android 之间接续编辑。Windows 支持常驻托盘；Android 使用系统通知调度。

当前工作版本为 **2.0.0-rc.1**，前端及101项Rust测试、Windows真实界面、Android最低版本引导、HONOR70项目证书升级和后台提醒均已有验收证据。手机原应用覆盖后保留RC1 Debug，原有业务数据指纹一致。正式签名ARM64 Release、Windows EXE/MSI及测试包位于D盘候选目录，SHA-256和签名以产物清单为准。完整范围见[开发计划](docs/V2.0_Lite_完整开发与验收计划.md)，本轮结果及未完成的发布门槛见[RC1验收与发布说明](docs/V2.0_Lite_rc1_验收与发布说明.md)；历史过程保留在[beta.2记录](docs/V2.0_Lite_beta2_验收与交付记录.md)。三天试用及安装等门槛完成前保持发布候选状态；用户已取消本轮Windows11实测要求，保留未验证说明。

### 本轮新增能力

- 同步写入守卫、租约与基础版本校验；失去编辑授权后只读并暂停计时。
- 协议 v2 使用不可覆盖的协调记录提交版本与租约，快照经 Argon2id + AES-256-GCM 加密。
- 下载前完整校验、事务恢复、最近五个本地恢复点；恢复前保留当前副本。
- 网络传输期间释放业务存储锁，generation 校验保护传输中的新修改；支持取消、超时和重试退避。
- 凭据更新先暂存完整新配置；损坏事务进入恢复页面；可导出不含事项、凭据和原始错误的诊断。
- 导入、模板应用和批量标签变更使用持久化事务；本地备份可选口令加密。
- Android 原生文档导入导出、通知授权、小屏导航和键盘安全区域处理。
- Android 提醒计划持久化、重启恢复、通知与精确定时设置入口；静音切换同步更新已排提醒。
- 修复空返回值被误认为取消操作，事项/会话/模板删除后正常刷新并恢复适用的撤回入口。
- 会话操作后保留未提交的长期任务草稿并维持放弃修改确认；搜索日期范围倒置时给出明确提示。
- 活跃计时每十秒及生命周期边界保存，重启恢复暂停；被动刷新保留外部文件冲突基线，损坏文件备份避免重名覆盖。
- 损坏的配置或业务文件也能进入本地恢复和文档导入；旧浏览组件和缺少浏览组件时提供启动引导。
- Android 提醒预排未来 48 小时、最多 128 条，打开应用刷新，重启解锁后恢复已排提醒。设置页可检查通知与精确定时权限；系统省电和厂商后台策略仍可能延迟送达，强行停止后需要重新打开。后台同步在恢复前台时补做。

### 同步和备份

先导出本地备份，再在设置中填写独立七牛测试空间、HTTPS 下载域名和专用前缀（默认 `moment-sync/v2`）。使用权限受限的用户自备 AK/SK，凭据保存于系统凭据库；同步口令必须自行保管。首次两端都有数据时明确选择上传或下载。旧协议前缀会被拒绝，所有设备升级后应使用新前缀。

设置中的文档备份可填写至少 8 个字符的独立口令，文件使用 Argon2id + AES-256-GCM 加密；留空导出明文 JSON。两种格式均不包含云端凭据；目录导出同样是明文。备份口令不保存，遗失后无法解密。本地恢复入口位于设置的数据管理区域，恢复前自动备份当前数据；启动发现损坏事务会先展示恢复页面。

设备配置和正在运行的计时器保留在本机。退出前应停止计时并确认同步成功，再到另一台设备接续。不要把同一前缀用于多个互不相关的数据集。旧版客户端不支持协议 v2，升级全部设备后再配置新前缀；回退应用前先断开同步、导出备份，保留原目录并在独立目录恢复，禁止旧版直接写入新协议空间。

### 本机 D 盘构建

在项目根目录的 PowerShell 中执行：

```powershell
. ./.tools/build-env.ps1
./.tools/start-emulator.ps1          # 使用 D 盘已有专用镜像启动，默认 3GB 内存
npm run build
./.tools/verify.ps1                  # 前端、Rust 和测试脚本校验
./.tools/build-android.ps1 -Abi x86_64  # 模拟器
./.tools/build-android.ps1 -Abi aarch64 # 后续真机测试包
./.tools/build-android.ps1 -Abi aarch64 -Release # 未签名 Release 候选包
```

本机缓存、临时文件、Gradle、Rust 工具链和目标文件使用 D 盘。NDK 对中文路径的限制通过 `D:\moment-native-build` 处理；SDK/JDK 原有安装只作为工具读取。模拟器及镜像位于 `D:\moment-build\android-sdk`，AVD 位于同盘。Android 构建脚本可在原生库编译成功、系统禁止创建符号链接时复制原生库后继续打包，无需打开 Windows 开发者模式。

它把事件、日常、浮动事项和长期任务与候选推荐引擎结合，帮助选择现在最适合处理的事项。

## 功能特性

### 日程与推荐

- **「现在」页**：大时钟 + 主候选/次选 + 今日时间轴（按计划 / 实际双时间轴）+ 应用内提醒横幅；
- **五层候选推荐**：事件 / 日常窗口 / 浮动事项按优先级与时间规则推荐；
- **日历**：月 / 周 / 日视图，重复事件实例展开、日常窗口叠加、标签筛选与着色；
- **事件 / 日常 / 浮动事项**：列表管理、行内编辑、右侧抽屉显式保存。

### 录入与提醒

- **自然语言快速录入**：如「明天下午3点开会」，解析失败自动降级表单；
- **日常**：按星期循环，或「每隔 N 天」模式（锚点日期 + 间隔）；
- **重复事件**：daily / weekly / monthly / yearly / custom + 多级提前提醒；
- **系统提醒**：事件开始、日常窗口开始/即将结束、浮动事项截止；已完成事项不再提醒；支持优先级分级、免打扰时段与提示音开关。

### 效率工具

- **计时器**：单计时器开始 / 暂停 / 继续，实际耗时写入归档与统计；
- **跳过 / 稍后 / 撤回**：稍后跨零点不丢失，到点自动重新提醒；
- **标签系统**：表单中标签候选直接显示、点击即选；标签过滤、标签颜色，芯片 / 过滤条 / 日历同步着色。

### 长期任务

- **独立数据类**：与事件 / 日常 / 浮动并列，独立页面、独立存储（`long_tasks.json`）；
- **计划窗口**：开始 / 截止日期，窗口内任意一天都可以开始投入；
- **会话式执行**：开始 → 暂停 / 继续 → 终止；每次终止记一条投入记录（用时 + 可选收获），任务保持进行中、可反复投入；
- **「现在」页独立区域**：显示当前窗口内的长期任务，不进入五层候选推荐；
- **归档与统计整合**：每天同一长期任务合并为一条归档条目，进入实际时间轴、归档页与全局统计；标签耗时同步计入；
- **详情抽屉**：汇总卡 + 投入时间线，收获可补填 / 编辑，记录可删除 / 撤回。

### 数据与系统

- **数据目录 / 导入导出**：自定义数据目录、JSON 导出导入；
- **事项模板**：工作日 / 周末 / 自定义模板批量生成；
- **脚本钩子**：受限 JS（boa）导出钩子，单脚本限时 2 秒；
- **托盘 / 全局快捷键 / 主题**：最小化到托盘、快捷键唤起、浅色 / 深色 / 跟随系统；
- **开机自启动**：设置页一键开关；
- **单实例保护**：重复启动时唤起已有窗口，不会开启第二个应用；
- **数据安全**：本地 JSON 原子写入 + `.bak` 备份 + 软删除 + 时区归一化 + 外部修改冲突提示。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2.x（Rust 后端） |
| 前端 | React 18 + TypeScript 5 + Vite 5 + Tailwind CSS 3 + Zustand 4 |
| 核心引擎 | `schedule-core` 纯 Rust crate（模型 / 存储 / 候选推荐 / 重复展开 / NLP / 搜索 / 统计 / 钩子） |
| 存储 | 本地 JSON，版本迁移 v0 → v6，原子写入 + `.bak` + mtime 冲突检测 |

## 快速开始

### 环境要求

- Windows10及可用的现代WebView2运行时；Windows11兼容性未验证，本轮按用户决定不进行该平台实测
- 已验证的构建工具链：Node.js 24.14.1、npm、Rust 1.97.1（MSVC）
- Visual Studio Build Tools（含「使用 C++ 的桌面开发」组件）
- Android最低API26，需可用且更新到现代版本的系统WebView；本轮使用JDK17、NDK29和target API36构建

### 开发模式

```powershell
. ./.tools/build-env.ps1
npm install
npm run tauri dev
```

### 生产构建

```powershell
. ./.tools/build-env.ps1
./.tools/build-windows.ps1
```

构建产物：

- 安装包：`$env:CARGO_TARGET_DIR/release/bundle/`
- 主程序：`$env:CARGO_TARGET_DIR/release/schedule-app.exe`

本机为 `D:\moment-native-build\target`。Android Release 默认不附正式签名；Debug 或测试证书不能作为正式发布签名。所有升级包必须沿用相同签名证书，否则系统会拒绝覆盖安装；不要通过卸载来解决签名不匹配，以免丢失应用数据。

Windows 构建脚本将应用语义版本映射为 MSI 可升级的三段数字版本（本轮应用 `2.0.0-rc.1`、MSI `2.0.50`；正式2.0.0使用MSI2.0.99）。不要直接把带预发布标记的版本传给 MSI 打包器。已完成原生构建时可用 `-BundleOnly` 仅重新打包。

Gradle的 Android 签名从环境变量读取 `MOMENT_ANDROID_KEYSTORE`、`MOMENT_ANDROID_STORE_PASSWORD`、`MOMENT_ANDROID_KEY_ALIAS`、`MOMENT_ANDROID_KEY_PASSWORD`；四项必须完整配置。将口令放在本机安全环境或 CI secrets，不写进 Gradle、聊天或版本库；未配置时只生成未签名候选包。本机已用`.tools/android-signing.ps1`在D盘`.private/android-signing`建立项目证书，以当前用户DPAPI保护随机密码；交付脚本会用它签署独立的`arm64-release.apk`。私有目录不参与Git提交和缓存清理。本轮已按[交付记录](docs/V2.0_Lite_beta2_验收与交付记录.md)导出并验证由用户自选密码保护的可携带证书备份，离线副本由用户自行保管；现有Debug手机仍沿用测试签名。

### 构建验证

```powershell
npx tsc --noEmit
npm run build
cargo test -p schedule-core
cargo check -p schedule-app
```

> 项目路径含中文时请使用 MSVC 工具链；MSI 打包已配置 WiX `zh-CN` 代码页。

## 数据与存储

- **默认数据目录**：Tauri `app_data_dir`（Windows 下为 `%APPDATA%\com.personal.schedule`）。
- **自定义目录**：设置页「数据目录」选择后，在默认目录写入 `data_dir.txt` 指针文件。
- **文件结构**：

```
config.json
events.json
routines.json
tasks.json
templates.json
archive/YYYY-MM.json
hooks/
```

- 每份数据文件均含 `version` 字段，损坏时自动备份 `.corrupt-*.bak`，覆盖前复制 `.bak`。
- 应用检测到文件被外部修改时，会弹出「重新加载 / 覆盖」选择，不会静默覆盖。

> ⚠️ 请勿让网盘同步、Git 仓库或多端同时读写同一数据目录。

## 项目结构

```
├── src/                     # 前端源码（React + TypeScript）
│   ├── pages/               # 现在 / 日历 / 事件 / 日常 / 浮动 / 搜索 / 归档 / 统计 / 扩展 / 设置
│   ├── components/          # 抽屉 / Toast / 确认框 / 时间输入 / 标签 / 候选卡 / 侧栏
│   ├── store/               # Zustand 全局状态与 IPC 调用封装
│   ├── api/                 # Tauri invoke 封装
│   ├── lib/                 # 时间 / 主题 / 标签颜色 / 格式化工具
│   └── types/               # TypeScript 类型（与 Rust serde camelCase 对齐）
├── src-tauri/
│   ├── core/                # schedule-core：模型 / 存储 / 候选引擎 / 重复展开 / 统计 / 钩子
│   └── src/                 # Tauri 应用层：命令 / 托盘 / 通知 / 配置应用线程
├── assets/branding/         # 品牌资产：图标 SVG 母版 / 各尺寸 PNG / 推广渲染图
└── V3.1_修复迭代计划.md      # V3.1（1.0.0-rc.1）迭代计划（历史存档）
```

## 安全提示

- 未配置同步时仅使用本机数据；启用后会向用户配置的七牛空间发送加密业务快照。设备名称、时间和协调租约属于明文元数据。
- 使用独立测试空间或专用前缀及受限凭据。凭据至少需要读取对应空间对象及创建对象的权限；同步依赖不可覆盖创建，不授予无关空间、账户管理或删除权限。具体授权范围在七牛侧核验后再用于真实数据。
- 脚本钩子默认关闭；启用后会执行数据目录 `hooks/*.js`（受限解释器，无文件系统 / 网络能力，单脚本限时 2 秒），请仅放入信任的脚本。
- 请勿让网盘 / Git 等工具在多端同时同步同一个数据目录，以免产生写入冲突。

## 版本

- 后续开发与验收：[V2.0 Lite 完整开发计划](docs/V2.0_Lite_完整开发与验收计划.md)（Windows / Android 单设备互斥同步）。
- 当前应用版本：**2.0.0-beta.2**（正式发布验收未完成）
- 数据版本：`CURRENT_VERSION = 6`

## 许可证

本仓库暂未声明开源许可证，默认保留所有权利。
