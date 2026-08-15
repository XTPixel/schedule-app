// 生产构建隐藏控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // v1.0.1：单实例保护。第二次点击 exe 时唤起已有主窗口并退出本进程。
    if !schedule_app_lib::platform::ensure_single_instance() {
        std::process::exit(0);
    }
    schedule_app_lib::run();
}
