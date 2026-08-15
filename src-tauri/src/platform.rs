//! 平台能力（v1.0.1）：
//! - Windows 单实例：第二次启动时唤起已有主窗口并退出；
//! - Windows 开机自启动：写入/删除当前用户 Run 注册表项。
//! 非 Windows 平台不提供原生自启动，单实例退化为普通启动（不影响编译）。

/// 主窗口标题（与 `tauri.conf.json` 的 `app.windows[0].title` 保持一致），
/// 用于第二次启动时定位已有窗口。
#[cfg(windows)]
const MAIN_WINDOW_TITLE: &str = "此刻";

/// 单实例互斥体名称：按应用 identifier 命名，避免与其他程序冲突。
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX: &str = "Local\\com.personal.schedule.single-instance";

/// HKCU 开机启动注册表位置。
#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/// Run 键下的值名。
#[cfg(windows)]
const RUN_VALUE: &str = "此刻 MOMENT";

/// 确保只运行一个实例。返回 `false` 表示本进程是第二次启动，
/// 已唤起已有实例，调用方应立即退出。
#[cfg(windows)]
pub fn ensure_single_instance() -> bool {
    use std::thread;
    use std::time::Duration;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    let mutex_name = wide(SINGLE_INSTANCE_MUTEX);
    // 初始持有者置 true 并无必要，关键是句柄在整个主实例生命周期内保持打开。
    let handle = match unsafe { CreateMutexW(None, true, PCWSTR::from_raw(mutex_name.as_ptr())) } {
        Ok(h) => h,
        // 互斥体创建失败时保守放行：宁可有重复实例风险，也不能让应用无法启动。
        Err(_) => return true,
    };

    let is_second = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if !is_second {
        // windows crate 的 HANDLE 是 Copy 且无 Drop：句柄保持打开直到进程退出，
        // 保证主实例存活期间互斥体一直存在；进程退出时由系统回收。
        let _ = handle;
        return true;
    }

    // 第二次启动：关闭本进程对同一互斥体的引用，然后唤起已有主窗口。
    unsafe {
        let _ = CloseHandle(handle);
    }

    let title = wide(MAIN_WINDOW_TITLE);
    // 首次点击 exe 的瞬间，已有实例的窗口可能尚未创建完成，短暂重试。
    for _ in 0..20 {
        let hwnd = unsafe { FindWindowW(PCWSTR::null(), PCWSTR::from_raw(title.as_ptr())) };
        if let Ok(hwnd) = hwnd {
            if !hwnd.is_invalid() {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_SHOW);
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    let _ = SetForegroundWindow(hwnd);
                }
                return false;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

/// 非 Windows：不限制多实例。
#[cfg(not(windows))]
pub fn ensure_single_instance() -> bool {
    true
}

/// 开启/关闭开机自启动。配置变更后由后端统一调用，与 config.json 保持一致。
#[cfg(windows)]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        enable_autostart()
    } else {
        disable_autostart()
    }
}

/// 非 Windows：返回明确错误，由调用方降级处理（仅影响自启动，不影响其他功能）。
#[cfg(not(windows))]
pub fn set_autostart(_enabled: bool) -> Result<(), String> {
    Err("当前平台暂不支持开机自启动".to_string())
}

#[cfg(windows)]
fn enable_autostart() -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegSetValueExW, REG_SZ};

    let key = match open_run_key(true)? {
        Some(k) => k,
        None => return Err("无法打开开机启动注册表项".to_string()),
    };

    let exe = std::env::current_exe().map_err(|e| format!("无法获取程序路径：{e}"))?;
    let command = format!("\"{}\"", exe.display());
    let value_name = wide(RUN_VALUE);
    let data = wide_bytes(&command);

    let status = unsafe {
        RegSetValueExW(
            key,
            PCWSTR::from_raw(value_name.as_ptr()),
            None,
            REG_SZ,
            Some(data.as_slice()),
        )
    };
    close_key(key);

    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("写入开机自启动注册表失败（错误码 {}）", status.0))
    }
}

#[cfg(windows)]
fn disable_autostart() -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::RegDeleteValueW;

    // 注册表项不存在时视为已关闭。
    let Some(key) = open_run_key(false)? else {
        return Ok(());
    };

    let value_name = wide(RUN_VALUE);
    let status = unsafe { RegDeleteValueW(key, PCWSTR::from_raw(value_name.as_ptr())) };
    close_key(key);

    if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("删除开机自启动注册表项失败（错误码 {}）", status.0))
    }
}

/// 打开 Run 键。`create=false` 且键不存在时返回 `Ok(None)`。
#[cfg(windows)]
fn open_run_key(create: bool) -> Result<Option<windows::Win32::System::Registry::HKEY>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCreateKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE,
    };

    let sub_key = wide(RUN_KEY);
    let mut key = HKEY::default();
    let status = if create {
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR::from_raw(sub_key.as_ptr()),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut key,
                None,
            )
        }
    } else {
        unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR::from_raw(sub_key.as_ptr()),
                None,
                KEY_SET_VALUE,
                &mut key,
            )
        }
    };

    if status == ERROR_SUCCESS {
        return Ok(Some(key));
    }
    if !create && status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    Err(format!("打开开机启动注册表项失败（错误码 {}）", status.0))
}

#[cfg(windows)]
fn close_key(key: windows::Win32::System::Registry::HKEY) {
    use windows::Win32::System::Registry::RegCloseKey;
    unsafe {
        let _ = RegCloseKey(key);
    }
}

/// UTF-8 字符串 → 带 NUL 结尾的 UTF-16（Windows 宽字符串）。
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// UTF-8 字符串 → 带 NUL 结尾的 UTF-16 字节串（REG_SZ 需要）。
#[cfg(windows)]
fn wide_bytes(s: &str) -> Vec<u8> {
    wide(s).iter().flat_map(|u| u.to_le_bytes()).collect()
}
