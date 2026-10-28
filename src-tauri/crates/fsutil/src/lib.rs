//! 原子文件写入工具。
//!
//! 全项目统一用 [`write_atomic`] 替换各处手写的"写临时文件再 rename"：它在目标同目录写一个
//! 临时文件，`fsync` 落盘后再 rename 覆盖目标。相比直接 `std::fs::write`，即便写到一半断电，
//! 目标路径也只会是改名前的旧内容或改名后的完整新内容，不会留下被截断的损坏文件。

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// 原子写入：在目标同目录写临时文件、`fsync` 落盘后 rename 覆盖目标。
///
/// 父目录不存在时先创建。写入或改名失败时尽量删除临时文件，不留残留。
///
/// # Arguments
///
/// * `path` - 目标文件路径。
/// * `bytes` - 要写入的全部字节。
///
/// # Errors
///
/// 创建父目录、创建 / 写入 / 刷盘临时文件，或 rename 失败时返回对应 [`std::io::Error`]。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let tmp = tmp_path(path);
    let result = write_and_sync(&tmp, bytes).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 目标文件的同目录临时文件路径：在完整文件名后追加 `.tmp`。
///
/// # Arguments
///
/// * `path` - 目标文件路径。
///
/// # Returns
///
/// 同目录、同名加 `.tmp` 后缀的临时路径（与目标同卷，保证 rename 原子）。
fn tmp_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(".tmp");
    PathBuf::from(name)
}

/// 写入临时文件并 `fsync` 到磁盘。
///
/// # Arguments
///
/// * `tmp` - 临时文件路径。
/// * `bytes` - 要写入的全部字节。
///
/// # Errors
///
/// 创建、写入或 `sync_all` 失败时返回对应 [`std::io::Error`]。
fn write_and_sync(tmp: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(tmp)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::{tmp_path, write_atomic};
    use std::path::Path;

    #[test]
    fn 写入后可读回且不留临时文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("a.json");
        write_atomic(&path, b"hello").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert!(!tmp_path(&path).exists(), "临时文件应已被 rename 掉");
    }

    #[test]
    fn 覆盖已有文件() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new-and-longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new-and-longer");
    }

    #[test]
    fn 临时路径在同目录追加_tmp() {
        let p = Path::new("/data/net-devices.json");
        assert_eq!(tmp_path(p), Path::new("/data/net-devices.json.tmp"));
    }
}
