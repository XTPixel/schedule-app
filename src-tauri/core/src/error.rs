use std::fmt;

/// 核心层统一错误类型。
#[derive(Debug, Clone)]
pub enum AppError {
    Io(String),
    Json(String),
    Parse(String),
    /// 数据文件版本高于当前程序支持版本（§5.7：拒绝加载 + 提示导出/升级）。
    NewerVersion {
        file: String,
        version: u64,
    },
    /// 数据文件损坏，已备份到 .bak。
    Corrupted {
        file: String,
        backup: String,
        detail: String,
    },
    NotFound(String),
    InvalidTimezone(String),
    InvalidInput(String),
    /// 数据文件在应用读取之后被外部修改（V3.1：写入前拦截，避免静默覆盖）。
    /// Display 输出 `EXTERNAL_CHANGE:<file>`，前端按该结构化前缀识别。
    ExternalChange {
        file: String,
    },
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(m) => write!(f, "IO错误: {m}"),
            AppError::Json(m) => write!(f, "JSON错误: {m}"),
            AppError::Parse(m) => write!(f, "解析错误: {m}"),
            AppError::NewerVersion { file, version } => write!(
                f,
                "数据文件 {file} 的版本({version})高于当前程序支持版本，请安装更新版本后读取此数据"
            ),
            AppError::Corrupted {
                file,
                backup,
                detail,
            } => {
                write!(
                    f,
                    "数据文件 {file} 损坏（{detail}），原始文件已备份到 {backup}"
                )
            }
            AppError::NotFound(m) => write!(f, "未找到: {m}"),
            AppError::InvalidTimezone(m) => write!(f, "无效时区: {m}"),
            AppError::InvalidInput(m) => write!(f, "无效输入: {m}"),
            AppError::ExternalChange { file } => write!(f, "EXTERNAL_CHANGE:{file}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Json(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
