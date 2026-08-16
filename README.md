<p align="center">
  <img src="assets/branding/icons/app-icon-256.png" alt="此刻 MOMENT 图标" width="128" />
</p>

<h1 align="center">此刻 MOMENT</h1>

<p align="center">
  本地优先 · 数据自持 · 常驻托盘的 Windows 个人日程管理桌面应用<br/>
  回答「此刻该做什么」：事件 / 日常 / 浮动事项 + 五层候选推荐引擎 + 今日时间轴 + 系统级提醒
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/版本-1.0.1-2563EB" />
  <img alt="Platform" src="https://img.shields.io/badge/平台-Windows-0078D6" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.x-FFC131" />
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB" />
</p>

---

## 项目简介

**此刻 MOMENT** 是一款本地优先的个人日程管理桌面应用。所有数据保存在本机 JSON 文件中，不上传云端；应用常驻系统托盘，在事件开始、日常窗口开启与浮动事项截止前按优先级推送系统通知。

它不是一个简单的待办清单，而是把「事件、日常、浮动事项」三类数据与候选推荐引擎结合，直接告诉你现在最该做什么。

## 功能特性

### 日程与推荐

- **「现在」页**：大时钟 + 主候选/次选 + 今日时间轴 + 应用内提醒横幅；
- **五层候选推荐**：事件 / 日常窗口 / 浮动事项按优先级与时间规则推荐；
- **日历**：月 / 周 / 日视图，重复事件实例展开、日常窗口叠加、标签筛选与着色；
- **事件 / 日常 / 浮动事项**：列表管理、行内编辑、右侧抽屉显式保存。

### 录入与提醒

- **自然语言快速录入**：如「明天下午3点开会」，解析失败自动降级表单；
- **重复事件**：daily / weekly / monthly / yearly / custom + 多级提前提醒；
- **系统提醒**：事件开始、日常窗口开始/即将结束、浮动事项截止；支持优先级分级、免打扰时段与提示音开关。

### 效率工具

- **计时器**：单计时器开始 / 暂停 / 继续，实际耗时写入归档与统计；
- **跳过 / 稍后 / 撤回**：稍后跨零点不丢失，到点自动重新提醒；
- **标签系统**：标签过滤、标签颜色，芯片 / 过滤条 / 日历同步着色。

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
| 存储 | 本地 JSON，版本迁移 v0 → v4，原子写入 + `.bak` + mtime 冲突检测 |

## 快速开始

### 环境要求

- Windows 10 / 11（WebView2 一般随系统自带）
- Node.js 18+ 与 npm
- Rust stable（MSVC 工具链）
- Visual Studio Build Tools（含「使用 C++ 的桌面开发」组件）

### 开发模式

```powershell
npm install
npm run tauri dev
```

### 生产构建

```powershell
npm run tauri build
```

构建产物：

- 安装包：`src-tauri/target/release/bundle/`
- 主程序：`src-tauri/target/release/schedule-app.exe`

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

- 应用默认只读写本机数据，不包含账号系统，也不会上传云端。
- 脚本钩子默认关闭；启用后会执行数据目录 `hooks/*.js`（受限解释器，无文件系统 / 网络能力，单脚本限时 2 秒），请仅放入信任的脚本。
- 请勿让网盘 / Git 等工具在多端同时同步同一个数据目录，以免产生写入冲突。

## 版本

- 当前应用版本：**1.0.1**
- 数据版本：`CURRENT_VERSION = 4`

## 许可证

本仓库暂未声明开源许可证，默认保留所有权利。
