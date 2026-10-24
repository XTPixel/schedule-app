# 构建与验收工具

从项目根目录的 PowerShell 执行。先运行`. ./.tools/build-env.ps1`，使编译、缓存、临时文件与模拟器使用D盘；现有SDK/JDK仅作为工具读取。版本同时维护在package、Cargo、Tauri和锁文件中，Android及MSI版本由构建脚本换算。

## 本地构建

```powershell
. ./.tools/build-env.ps1
./.tools/verify.ps1
npm run tauri -- build --debug --no-bundle
./.tools/build-android.ps1 -Abi x86_64
./.tools/build-android.ps1 -Abi aarch64
./.tools/build-android.ps1 -Abi aarch64 -Release
```

Windows原生界面测试需要Tauri嵌入前端资源的Debug EXE，单独`cargo build`的开发服务器模式不能代替。优化Windows运行检查与实际MSI安装矩阵只允许在授权的可丢弃CI环境执行；Release忽略Debug数据目录覆盖，不能用真实用户机器当隔离实例。

`release-candidates.ps1`收集本地候选并签名。它会覆盖目录中的Windows本地产物，所以只能在接收CI文件**之前**执行。Android证书、系统保护的密码与可携带加密备份都在忽略的私有目录，后续版本沿用现有证书。

## 设备和隔离

`start-emulator.ps1 -Avd Moment_API35`使用端口5554，`-Avd Moment_API36`使用5558；启动前拒绝已有模拟器进程，镜像和AVD留在D盘。API36原应用测试设置：

```powershell
$env:MOMENT_EMULATOR='emulator-5558'
$env:MOMENT_ANDROID_QA_PORT='9227'
```

将当前x86_64 Debug候选安装并打开后，按顺序运行`android-smoke.cjs`、`android-layout-checks.cjs`、`android-lifecycle-checks.cjs`、`android-notification-checks.cjs`、`android-recovery-checks.cjs`及`android-target-environment.cjs`。通知检查会重启专用模拟器，先验证提醒送达才重新打开应用；其他脚本不得同时操作同一模拟器。`MOMENT_HANDOFF_ANDROID=1`选择API36的`handoff-ui-checks.cjs`，该检查最后会退出应用。

软件渲染模拟器偶尔出现操作系统System UI无响应。`emulator-system-ui-ready.cjs`保留该系统对话框证据并只选择观察到的Wait按钮，不跳过应用无响应。故障原始记录与重试后的结果分别保留。

`build-saf-provider.ps1`构建独立的`com.personal.schedule.safqa`，供`android-saf-failure-checks.cjs`通过真实系统文档选择器制造EACCES、ENOSPC和取消。该提供器只安装到专用模拟器，不部署到用户手机，也不编入产品APK。它验证失败处理，不代表实际填满了设备存储。

真机必须匹配私有授权设备记录。原`com.personal.schedule`不卸载、不清数据；业务测试前后逐文件核对原数据。项目证书升级使用独立`com.personal.schedule.qa`人工数据。真实云端测试还须有明确的账号和前缀授权，凭据不进入模拟器、源码或日志。`cloud-integration.cjs`与`cloud-contention.cjs`共享测试资源，由独占文件锁限制为串行运行。

Windows本地测试只操作带`.moment-qa-root`标记且通过原生路径断言的目录。端口分配为：Windows本地9225、持续负载9226、API36界面9227、双Windows竞争9228/9229、API35优化通知9231、真机独立QA9232。手机原应用与云端桥分别使用9223/9224。避免遗留ADB转发占用Windows端口。

## CI包接收与最终清单

Verify执行前端、Rust、脚本和源码范围检查，分支发布流程还执行MSI安装/升级/降级阻止/回滚/卸载/重装及优化EXE冷启动、写入退出与重开。GitHub产物保留期限为14天；成功接收的本地文件应另行保管。

`import-ci-package.ps1`要求选中的成功Verify运行与产品输入一致、下载ZIP匹配GitHub官方摘要、六项安装和三项优化运行结果全通过。它保留旧本地候选，接收**实际测试过的**MSI和EXE，并保存来源收据。`runtime-probe.yml`仅供手动诊断，须明确指定具有相同产品输入的现存Verify运行，不能把诊断运行当完整安装验收。

最终两小时负载使用`windows-soak.cjs`，依据真实经过时间运行，记录当前Debug EXE摘要、读写/搜索/统计/会话/导航及重载，结束后清理人工数据。修改产品输入会使之前的持续负载证据失效。原始版本记录保留在各自目录，`latest.json`只指向当前运行。

测试完成、源码提交并固定后执行：

```powershell
node .tools/source-audit.cjs
node .tools/acceptance-matrix.cjs
node .tools/candidate-manifest.cjs --final
node .tools/check-candidates.cjs --require-soak
```

若验证脚本或产品源码变更，先重新运行`verify.ps1`；产品变化还须重建并重跑受影响的设备、CI和持续负载验收。矩阵将16个场景映射到实际执行的Rust测试清单与原始证据摘要。最终检查递归核对源码、八种候选、证书、设备已装APK、云端受测EXE、实际CI文件、矩阵和两小时证据，任何不符都会拒绝定版。

`candidate-manifest.cjs`不带`--final`会生成待验收清单，适合检查进度；已定版后再次这样运行会将状态恢复为待验收。`--final`先生成待验收状态，全部门槛及完整性通过后才设置`formalRelease:true`；最后再次检查以保存正式状态的完整性记录。清单生成后若修改任何源码或文档，须重新生成并核验，不能只手工修改正式状态。
