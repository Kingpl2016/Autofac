//! 应用数据目录：设置、转发表、灯具库、自动存档、节目库、缓存、日志都放在软件目录下的 `data`。
//!
//! # 位置
//!
//! 优先使用可执行文件所在目录下的 `data`（便携：整个软件目录拷走，数据跟着走）。
//! 启动时会实际创建目录并写入、删除一个探测文件来确认**有写权限**；
//! 软件装在需要管理员权限的位置（例如 `Program Files`）时探测失败，
//! 自动退回系统的应用数据目录（与旧版本相同），并在 [`DataRoot::fallback_used`] 里标明，不会因为没权限而丢数据。
//!
//! # 旧数据迁移
//!
//! 首次使用新位置时，把旧位置（系统应用数据 / 配置目录）里的设置类文件**复制**过来
//! （不删除旧文件，作为备份），并写入 `.migrated` 标记，之后不再重复迁移，避免用户删除的文件“复活”。
//! 节目库默认目录：新位置还没有 `recordings` 而旧的 `文档\ArtNet Studio Recordings` 已存在时，
//! 继续使用旧目录，用户已有的录制不会“消失”。
//!
//! # 目录结构
//!
//! ```text
//! data/
//!   settings.json  devices.json  forwarding.json  net-devices.json
//!   fixtures.json  ui-prefs.json  signal-checker.json  show-autosave.artshow
//!   ofl-catalog.json  ai-profiles.json  mcp-servers.json
//!   recordings/    节目库（.artrec / .artrec.show / .artrec.json …）
//!   fixture-assets/  灯具资源库：index.json、icons/、models/、thumbs/（文件按内容 SHA-256 命名）
//!   skills/  trash/  ai-history/  AI 助手的技能、回收站（30 天）与对话记录
//!   cache/         可随时删除的缓存（波形峰值等）
//!   logs/          日志
//! ```

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 应用标识符，须与 `tauri.conf.json` 的 `identifier` 一致（有测试守护）。
pub const IDENTIFIER: &str = "com.artnetstudio.app";

/// 软件目录下的数据目录名。
pub const DATA_DIR_NAME: &str = "data";

/// 旧版本默认的节目库目录名（位于“文档”下）。
pub const LEGACY_RECORDINGS_DIR: &str = "ArtNet Studio Recordings";

/// 迁移完成标记文件名。
const MIGRATED_MARKER: &str = ".migrated";

/// 写权限探测用的临时文件名。
const PROBE_FILE: &str = ".write-test";

/// 需要从旧位置迁移的文件。
const MIGRATED_FILES: &[&str] = &[
    "settings.json",
    "devices.json",
    "forwarding.json",
    "net-devices.json",
    "fixtures.json",
    "ui-prefs.json",
    "signal-checker.json",
    "show-autosave.artshow",
    "show-autosave.artshow.bak",
];

/// 应用数据根目录（作为 Tauri 托管状态使用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRoot {
    path: PathBuf,
    fallback_used: bool,
}

/// `data_dir_info` 命令的返回值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    /// 数据根目录。
    pub path: String,
    /// 是否因为软件目录不可写而退回了系统应用数据目录。
    pub fallback_used: bool,
}

impl DataRoot {
    /// 以指定目录创建（测试用）。
    ///
    /// # Arguments
    ///
    /// * `path` - 数据根目录。
    /// * `fallback_used` - 是否为退回的系统目录。
    ///
    /// # Returns
    ///
    /// 数据根目录。
    #[must_use]
    pub fn new(path: PathBuf, fallback_used: bool) -> Self {
        Self { path, fallback_used }
    }

    /// 数据根目录。
    ///
    /// # Returns
    ///
    /// 目录路径（已创建且可写）。
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 是否退回了系统应用数据目录。
    ///
    /// # Returns
    ///
    /// 软件目录不可写时为 `true`。
    #[must_use]
    pub fn fallback_used(&self) -> bool {
        self.fallback_used
    }

    /// 缓存目录（可随时删除，不含用户数据）。
    ///
    /// # Returns
    ///
    /// `data/cache`。
    #[must_use]
    pub fn cache_dir(&self) -> PathBuf {
        self.path.join("cache")
    }

    /// 日志目录。
    ///
    /// # Returns
    ///
    /// `data/logs`。
    #[must_use]
    pub fn logs_dir(&self) -> PathBuf {
        self.path.join("logs")
    }

    /// 默认的节目库目录。
    ///
    /// # Arguments
    ///
    /// * `legacy` - 旧版本的默认目录（“文档”下的 `ArtNet Studio Recordings`），不存在时为 `None`。
    ///
    /// # Returns
    ///
    /// `data/recordings`；但新目录还不存在而旧目录已存在时沿用旧目录，避免已有录制“消失”。
    #[must_use]
    pub fn recordings_dir(&self, legacy: Option<&Path>) -> PathBuf {
        let new = self.path.join("recordings");
        match legacy {
            Some(old) if !new.exists() && old.is_dir() => old.to_path_buf(),
            _ => new,
        }
    }

    /// 前端用的描述。
    ///
    /// # Returns
    ///
    /// 路径与是否退回。
    #[must_use]
    pub fn info(&self) -> DataDirInfo {
        DataDirInfo {
            path: self.path.to_string_lossy().into_owned(),
            fallback_used: self.fallback_used,
        }
    }
}

/// 确认目录存在且当前用户有写权限：创建目录，写入再删除一个探测文件。
///
/// # Arguments
///
/// * `dir` - 要检查的目录（不存在时创建）。
///
/// # Errors
///
/// 无法创建目录、路径是文件，或没有写权限时返回对应的 IO 错误。
pub fn ensure_writable(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(PROBE_FILE);
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)
}

/// 系统的应用数据目录（与旧版本使用的位置相同），不依赖 Tauri 的 `AppHandle`。
///
/// # Arguments
///
/// * `identifier` - 应用标识符。
///
/// # Returns
///
/// Windows 为 `%APPDATA%\<id>`，macOS 为 `~/Library/Application Support/<id>`，
/// 其它为 `$XDG_DATA_HOME/<id>`（缺省 `~/.local/share/<id>`）；环境变量缺失时为 `None`。
#[must_use]
pub fn system_data_dir(identifier: &str) -> Option<PathBuf> {
    let env = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        env("APPDATA").map(|d| d.join(identifier))
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|d| d.join("Library/Application Support").join(identifier))
    } else {
        env("XDG_DATA_HOME")
            .or_else(|| env("HOME").map(|h| h.join(".local/share")))
            .map(|d| d.join(identifier))
    }
}

/// 旧版本存放设置类文件的目录（数据目录与配置目录；Windows 与 macOS 上两者相同）。
///
/// # Arguments
///
/// * `identifier` - 应用标识符。
///
/// # Returns
///
/// 去重后的候选目录，优先级从高到低。
#[must_use]
pub fn legacy_dirs(identifier: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = system_data_dir(identifier).into_iter().collect();
    if cfg!(all(unix, not(target_os = "macos"))) {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
        if let Some(c) = config {
            dirs.push(c.join(identifier));
        }
    }
    dirs
}

/// 旧版本默认节目库目录（系统“文档”文件夹下），不依赖 `AppHandle`。
///
/// 经 [`dirs::document_dir`] 定位“文档”，能正确处理 Windows 上“文档”被重定向到
/// OneDrive / 其它盘，以及 Linux 的 XDG 用户目录设置。
///
/// # Returns
///
/// 目录路径（不保证存在）；系统未提供“文档”目录时为 `None`。
#[must_use]
pub fn legacy_recordings_dir() -> Option<PathBuf> {
    dirs::document_dir().map(|d| d.join(LEGACY_RECORDINGS_DIR))
}

/// 把旧位置里的设置类文件复制到新位置（只做一次）。
///
/// 已存在于新位置的文件不会被覆盖；旧文件保持原样作为备份。完成后写入 `.migrated`。
///
/// # Arguments
///
/// * `sources` - 旧目录，按优先级从高到低；同名文件取第一个存在的。
/// * `target` - 新的数据根目录。
///
/// # Returns
///
/// 实际复制的文件名；已经迁移过时为空。
#[must_use]
pub fn migrate_legacy(sources: &[PathBuf], target: &Path) -> Vec<String> {
    let marker = target.join(MIGRATED_MARKER);
    if marker.exists() {
        return Vec::new();
    }
    let mut copied = Vec::new();
    for name in MIGRATED_FILES {
        let to = target.join(name);
        if to.exists() {
            continue;
        }
        let Some(from) = sources.iter().map(|d| d.join(name)).find(|p| p.is_file()) else {
            continue;
        };
        match std::fs::copy(&from, &to) {
            Ok(_) => copied.push((*name).to_owned()),
            Err(e) => tracing::warn!(file = *name, error = %e, "迁移旧数据失败，保留旧文件"),
        }
    }
    if let Err(e) = std::fs::write(&marker, b"1") {
        tracing::warn!(error = %e, "写入迁移标记失败");
    }
    copied
}

/// 决定数据根目录并做好准备：确认写权限，必要时退回，并迁移旧数据。
///
/// # Arguments
///
/// * `exe_dir` - 可执行文件所在目录；`None` 时直接用系统目录。
/// * `system_dir` - 退回时使用的系统应用数据目录。
/// * `legacy` - 旧数据目录（迁移来源）。
///
/// # Returns
///
/// 可用的数据根目录；软件目录和系统目录都不可写时，最后退回到系统临时目录下的同名目录，保证程序能启动。
#[must_use]
pub fn prepare(exe_dir: Option<&Path>, system_dir: Option<PathBuf>, legacy: &[PathBuf]) -> DataRoot {
    if let Some(dir) = exe_dir.map(|d| d.join(DATA_DIR_NAME)) {
        match ensure_writable(&dir) {
            Ok(()) => {
                let copied = migrate_legacy(legacy, &dir);
                if !copied.is_empty() {
                    tracing::info!(files = ?copied, "已把旧位置的设置复制到软件目录下的 data");
                }
                return DataRoot::new(dir, false);
            }
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "软件目录没有写权限，改用系统应用数据目录");
            }
        }
    }
    let system = system_dir.unwrap_or_else(|| std::env::temp_dir().join(IDENTIFIER));
    if let Err(e) = ensure_writable(&system) {
        tracing::error!(dir = %system.display(), error = %e, "系统应用数据目录也不可写，改用临时目录");
        let temp = std::env::temp_dir().join(IDENTIFIER);
        let _ = std::fs::create_dir_all(&temp);
        return DataRoot::new(temp, true);
    }
    DataRoot::new(system, true)
}

/// 按当前进程环境解析数据根目录（应用启动时调用一次）。
///
/// # Returns
///
/// 数据根目录。
#[must_use]
pub fn resolve() -> DataRoot {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    prepare(exe_dir.as_deref(), system_data_dir(IDENTIFIER), &legacy_dirs(IDENTIFIER))
}

/// 查询数据根目录（前端的持久化存储据此把文件放进同一个目录）。
///
/// # Arguments
///
/// * `root` - 托管的数据根目录。
///
/// # Returns
///
/// 路径与是否退回。
#[tauri::command]
pub fn data_dir_info(root: tauri::State<'_, DataRoot>) -> DataDirInfo {
    root.info()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ans-datadir-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 标识符与_tauri_conf_一致() {
        let conf = include_str!("../tauri.conf.json");
        let v: serde_json::Value = serde_json::from_str(conf).unwrap();
        assert_eq!(v["identifier"], IDENTIFIER);
    }

    #[test]
    fn 软件目录可写时使用_data_且探测文件被清理() {
        let tmp = Tmp::new("ok");
        let exe = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();
        let root = prepare(Some(&exe), Some(tmp.join("sys")), &[]);
        assert_eq!(root.path(), exe.join("data"));
        assert!(!root.fallback_used());
        assert!(root.path().is_dir());
        assert!(!root.path().join(PROBE_FILE).exists());
    }

    #[test]
    fn 软件目录不可写时退回系统目录并标明() {
        let tmp = Tmp::new("fallback");
        // 软件目录是一个文件：无法在其下创建 data
        let exe = tmp.join("app-is-a-file");
        std::fs::write(&exe, b"x").unwrap();
        let root = prepare(Some(&exe), Some(tmp.join("sys")), &[]);
        assert_eq!(root.path(), tmp.join("sys"));
        assert!(root.fallback_used());
        assert!(root.path().is_dir());
    }

    #[test]
    fn 都不可写时最终退回临时目录_程序仍能启动() {
        let tmp = Tmp::new("last-resort");
        let blocker = tmp.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let root = prepare(Some(&blocker), Some(blocker.join("sys")), &[]);
        assert!(root.fallback_used());
        assert!(root.path().starts_with(std::env::temp_dir()));
    }

    #[test]
    fn 没有软件目录信息时直接用系统目录() {
        let tmp = Tmp::new("no-exe");
        let root = prepare(None, Some(tmp.join("sys")), &[]);
        assert_eq!(root.path(), tmp.join("sys"));
        assert!(root.fallback_used());
    }

    #[test]
    fn 迁移只复制一次_不覆盖新文件_保留旧文件() {
        let tmp = Tmp::new("migrate");
        let old = tmp.join("old");
        let other = tmp.join("old-config");
        let new = tmp.join("new");
        for d in [&old, &other, &new] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(old.join("settings.json"), "old-settings").unwrap();
        std::fs::write(old.join("fixtures.json"), "old-fixtures").unwrap();
        std::fs::write(other.join("forwarding.json"), "config-forwarding").unwrap();
        std::fs::write(old.join("random.txt"), "not migrated").unwrap();
        std::fs::write(new.join("fixtures.json"), "new-fixtures").unwrap();

        let mut copied = migrate_legacy(&[old.clone(), other.clone()], &new);
        copied.sort();
        assert_eq!(copied, vec!["forwarding.json", "settings.json"]);
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "old-settings");
        assert_eq!(std::fs::read_to_string(new.join("fixtures.json")).unwrap(), "new-fixtures");
        assert_eq!(std::fs::read_to_string(new.join("forwarding.json")).unwrap(), "config-forwarding");
        assert!(!new.join("random.txt").exists());
        assert!(old.join("settings.json").exists(), "旧文件作为备份保留");

        // 用户之后删掉的文件不会因为再次启动而“复活”
        std::fs::remove_file(new.join("settings.json")).unwrap();
        assert!(migrate_legacy(&[old, other], &new).is_empty());
        assert!(!new.join("settings.json").exists());
    }

    #[test]
    fn 同名文件取优先级更高的旧目录() {
        let tmp = Tmp::new("priority");
        let (a, b, new) = (tmp.join("a"), tmp.join("b"), tmp.join("new"));
        for d in [&a, &b, &new] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(a.join("settings.json"), "from-a").unwrap();
        std::fs::write(b.join("settings.json"), "from-b").unwrap();
        let _ = migrate_legacy(&[a, b], &new);
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "from-a");
    }

    #[test]
    fn 端到端_prepare_会迁移旧设置() {
        let tmp = Tmp::new("e2e");
        let exe = tmp.join("app");
        let old = tmp.join("old");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "keep-me").unwrap();
        let root = prepare(Some(&exe), None, &[old]);
        assert_eq!(std::fs::read_to_string(root.path().join("settings.json")).unwrap(), "keep-me");
    }

    #[test]
    fn 节目库目录_新目录优先_仅在新目录未建立且旧目录存在时沿用旧目录() {
        let tmp = Tmp::new("recordings");
        let root = DataRoot::new(tmp.join("data"), false);
        std::fs::create_dir_all(root.path()).unwrap();
        let legacy = tmp.join("Documents").join(LEGACY_RECORDINGS_DIR);
        // 没有旧目录：用新目录
        assert_eq!(root.recordings_dir(Some(&legacy)), root.path().join("recordings"));
        assert_eq!(root.recordings_dir(None), root.path().join("recordings"));
        // 旧目录存在、新目录还没建：沿用旧目录
        std::fs::create_dir_all(&legacy).unwrap();
        assert_eq!(root.recordings_dir(Some(&legacy)), legacy);
        // 新目录一旦建立，就以新目录为准
        std::fs::create_dir_all(root.path().join("recordings")).unwrap();
        assert_eq!(root.recordings_dir(Some(&legacy)), root.path().join("recordings"));
    }

    #[test]
    fn 子目录与描述() {
        let root = DataRoot::new(PathBuf::from("X"), true);
        assert_eq!(root.cache_dir(), PathBuf::from("X").join("cache"));
        assert_eq!(root.logs_dir(), PathBuf::from("X").join("logs"));
        let info = root.info();
        assert!(info.fallback_used);
        assert_eq!(info.path, "X");
    }

    #[test]
    fn 可写探测会拒绝文件路径() {
        let tmp = Tmp::new("probe");
        let file = tmp.join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_writable(&file).is_err());
        assert!(ensure_writable(&tmp.join("new").join("deep")).is_ok());
    }
}
