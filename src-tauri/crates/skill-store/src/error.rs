//! 技能库的错误。

/// 技能库的错误（`code` 给前端翻译）。
#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    /// `SKILL.md` 格式不对（缺少前言、名称不合规、描述为空或过长）。
    #[error("invalid skill: {0}")]
    Invalid(String),
    /// 包超过大小或文件数上限。
    #[error("skill package is too large")]
    TooLarge,
    /// 包里有符号链接。
    #[error("skill package contains a symlink")]
    Symlink,
    /// 包里有越界路径（`..`、绝对路径）。
    #[error("skill package contains an unsafe path")]
    UnsafePath,
    /// 同名技能已存在（未要求替换）。
    #[error("a skill with this name already exists")]
    Exists,
    /// 技能或回收站条目不存在。
    #[error("not found")]
    NotFound,
    /// 读写失败。
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// zip 读写失败。
    #[error("zip: {0}")]
    Zip(String),
}

impl SkillError {
    /// 错误码。
    ///
    /// # Returns
    ///
    /// `invalid` / `too_large` / `symlink` / `unsafe_path` / `exists` / `not_found` / `io` / `zip`。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::TooLarge => "too_large",
            Self::Symlink => "symlink",
            Self::UnsafePath => "unsafe_path",
            Self::Exists => "exists",
            Self::NotFound => "not_found",
            Self::Io(_) => "io",
            Self::Zip(_) => "zip",
        }
    }
}

impl From<zip::result::ZipError> for SkillError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Zip(e.to_string())
    }
}
