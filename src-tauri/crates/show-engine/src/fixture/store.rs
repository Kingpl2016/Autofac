//! 灯具模型库：内置模型 + 用户模型（自定义 / Excel 导入），用户模型持久化为 JSON。
//!
//! 内置模型只读，不写入文件；用户模型以 `{ "version": 1, "models": [...] }` 保存，
//! 通过“临时文件 + 重命名”原子写入，不会留下半个文件。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::builtin::builtin_models;
use super::model::{FixtureError, FixtureModel};

/// 用户模型文件的当前版本号。
const FILE_VERSION: u32 = 1;

/// 磁盘上的用户模型文件。
#[derive(Debug, Serialize, Deserialize)]
struct LibraryFile {
    /// 文件格式版本。
    version: u32,
    /// 用户模型。
    models: Vec<FixtureModel>,
}

/// 灯具库操作错误。
#[derive(Debug, Error)]
pub enum LibraryError {
    /// 试图修改或删除内置模型。
    #[error("内置模型不可修改")]
    BuiltinReadOnly,
    /// 要删除的模型不存在。
    #[error("模型不存在")]
    NotFound,
    /// 模型未通过校验。
    #[error("模型不合法：{0}")]
    Invalid(#[from] FixtureError),
    /// 读写文件失败。
    #[error("读写灯具库文件失败：{0}")]
    Io(#[from] io::Error),
}

impl LibraryError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// `builtin_readonly`、`not_found`、`invalid_model:<校验错误码>` 或 `io`。
    #[must_use]
    pub fn code(&self) -> String {
        match self {
            Self::BuiltinReadOnly => "builtin_readonly".to_owned(),
            Self::NotFound => "not_found".to_owned(),
            Self::Invalid(e) => format!("invalid_model:{}", e.code()),
            Self::Io(_) => "io".to_owned(),
        }
    }
}

/// 合并导入结果后的统计。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// 新增的模型编号。
    pub added: Vec<String>,
    /// 覆盖了已有用户模型的编号。
    pub updated: Vec<String>,
    /// 因与内置模型编号冲突而被忽略的编号。
    pub skipped: Vec<String>,
}

/// 灯具模型库。
#[derive(Debug)]
pub struct FixtureLibrary {
    /// 用户模型文件路径。
    path: PathBuf,
    /// 用户模型，按编号排序。
    user: Vec<FixtureModel>,
}

impl FixtureLibrary {
    /// 打开（或新建）灯具库。
    ///
    /// 文件不存在时得到空的用户库；文件损坏时把它改名为 `*.bad` 留作排查，并从空库开始，
    /// 不会因为一份坏文件让整个编辑器无法使用。
    ///
    /// # Arguments
    ///
    /// * `path` - 用户模型文件路径（父目录需已存在或可创建）。
    ///
    /// # Returns
    ///
    /// 灯具库；读取过程中的任何问题都会降级为空库并记录警告。
    #[must_use]
    pub fn open(path: PathBuf) -> Self {
        let user = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<LibraryFile>(&bytes) {
                Ok(file) => file
                    .models
                    .into_iter()
                    .filter(|m| m.validate().is_ok() && !m.builtin)
                    .collect(),
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "灯具库文件损坏，已隔离并从空库开始");
                    let mut bad = path.clone().into_os_string();
                    bad.push(".bad");
                    let _ = fs::rename(&path, PathBuf::from(bad));
                    Vec::new()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                tracing::warn!(error = %e, path = %path.display(), "读取灯具库文件失败，使用空库");
                Vec::new()
            }
        };
        let mut lib = Self { path, user };
        lib.user.sort_by(|a, b| a.id.cmp(&b.id));
        lib
    }

    /// 列出全部模型：内置模型在前，用户模型按编号排序在后。
    ///
    /// # Returns
    ///
    /// 全部模型的副本。
    #[must_use]
    pub fn list(&self) -> Vec<FixtureModel> {
        let mut all = builtin_models();
        all.extend(self.user.iter().cloned());
        all
    }

    /// 新增或更新一个用户模型并落盘。
    ///
    /// # Arguments
    ///
    /// * `model` - 要保存的模型；`builtin` 字段会被强制置为 `false`，编号首尾空白会被去除。
    ///
    /// # Returns
    ///
    /// 实际保存的模型。
    ///
    /// # Errors
    ///
    /// - 编号与内置模型相同时返回 [`LibraryError::BuiltinReadOnly`]。
    /// - 模型未通过校验时返回 [`LibraryError::Invalid`]。
    /// - 写文件失败时返回 [`LibraryError::Io`]（此时内存中的库保持原样）。
    pub fn upsert(&mut self, mut model: FixtureModel) -> Result<FixtureModel, LibraryError> {
        model.id = model.id.trim().to_owned();
        model.builtin = false;
        model.validate()?;
        if builtin_models().iter().any(|b| b.id == model.id) {
            return Err(LibraryError::BuiltinReadOnly);
        }
        let mut next = self.user.clone();
        if let Some(slot) = next.iter_mut().find(|m| m.id == model.id) {
            *slot = model.clone();
        } else {
            next.push(model.clone());
        }
        next.sort_by(|a, b| a.id.cmp(&b.id));
        write_file(&self.path, &next)?;
        self.user = next;
        Ok(model)
    }

    /// 删除一个用户模型并落盘。
    ///
    /// # Arguments
    ///
    /// * `id` - 要删除的模型编号。
    ///
    /// # Errors
    ///
    /// - 编号属于内置模型时返回 [`LibraryError::BuiltinReadOnly`]。
    /// - 找不到该用户模型时返回 [`LibraryError::NotFound`]。
    /// - 写文件失败时返回 [`LibraryError::Io`]。
    pub fn remove(&mut self, id: &str) -> Result<(), LibraryError> {
        if builtin_models().iter().any(|b| b.id == id) {
            return Err(LibraryError::BuiltinReadOnly);
        }
        let next: Vec<FixtureModel> = self.user.iter().filter(|m| m.id != id).cloned().collect();
        if next.len() == self.user.len() {
            return Err(LibraryError::NotFound);
        }
        write_file(&self.path, &next)?;
        self.user = next;
        Ok(())
    }

    /// 把 Excel 导入得到的模型合并进用户库并落盘（一次写入）。
    ///
    /// 与内置模型编号冲突的会被忽略；与已有用户模型同号的覆盖旧的。
    ///
    /// # Arguments
    ///
    /// * `models` - 导入得到的模型。
    ///
    /// # Returns
    ///
    /// 新增 / 覆盖 / 忽略的编号统计。
    ///
    /// # Errors
    ///
    /// 写文件失败时返回 [`LibraryError::Io`]（此时内存中的库保持原样）。
    pub fn merge_import(&mut self, models: Vec<FixtureModel>) -> Result<MergeOutcome, LibraryError> {
        let builtin_ids: Vec<String> = builtin_models().into_iter().map(|m| m.id).collect();
        let mut outcome = MergeOutcome::default();
        let mut next = self.user.clone();
        for mut model in models {
            model.builtin = false;
            if builtin_ids.contains(&model.id) {
                outcome.skipped.push(model.id);
                continue;
            }
            if let Some(slot) = next.iter_mut().find(|m| m.id == model.id) {
                outcome.updated.push(model.id.clone());
                *slot = model;
            } else {
                outcome.added.push(model.id.clone());
                next.push(model);
            }
        }
        next.sort_by(|a, b| a.id.cmp(&b.id));
        if !outcome.added.is_empty() || !outcome.updated.is_empty() {
            write_file(&self.path, &next)?;
        }
        self.user = next;
        Ok(outcome)
    }
}

/// 原子写入用户模型文件（先写临时文件再重命名）。
///
/// # Arguments
///
/// * `path` - 目标文件路径。
/// * `models` - 要写入的用户模型。
///
/// # Errors
///
/// 创建目录、写临时文件或重命名失败时返回 [`io::Error`]。
fn write_file(path: &Path, models: &[FixtureModel]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = LibraryFile {
        version: FILE_VERSION,
        models: models.to_vec(),
    };
    let json = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
    fsutil::write_atomic(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::model::{ChannelFunction, FixtureProperty};

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("show-engine-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir.join("fixtures.json")
    }

    fn user_model(id: &str) -> FixtureModel {
        FixtureModel {
            id: id.to_owned(),
            name: format!("灯{id}"),
            system: "照明".into(),
            product_type: "调光".into(),
            builtin: false,
            properties: vec![FixtureProperty {
                name: "亮度".into(),
                code: "Bright".into(),
                function: ChannelFunction::Dimmer,
                channel: 1,
                width: 1,
                big_endian: false,
                default_value: 0,
                value_desc: String::new(),
                description: String::new(),
                ..FixtureProperty::default()
            }],
            ..FixtureModel::default()
        }
    }

    #[test]
    fn 新库只有内置模型() {
        let lib = FixtureLibrary::open(temp_path("empty"));
        let all = lib.list();
        assert_eq!(all.len(), 6);
        assert!(all.iter().all(|m| m.builtin));
    }

    #[test]
    fn 保存后重新打开仍在_用户模型排在内置之后() {
        let path = temp_path("persist");
        let mut lib = FixtureLibrary::open(path.clone());
        lib.upsert(user_model("2.9.1.2")).expect("保存");
        lib.upsert(user_model("2.1.1.2")).expect("保存");
        let reopened = FixtureLibrary::open(path);
        let ids: Vec<String> = reopened.list().into_iter().skip(6).map(|m| m.id).collect();
        assert_eq!(ids, vec!["2.1.1.2", "2.9.1.2"]);
    }

    #[test]
    fn 同号保存是更新而不是重复() {
        let mut lib = FixtureLibrary::open(temp_path("update"));
        lib.upsert(user_model("2.1.1.2")).expect("保存");
        let mut changed = user_model("2.1.1.2");
        changed.name = "改名".into();
        lib.upsert(changed).expect("更新");
        let users: Vec<FixtureModel> = lib.list().into_iter().filter(|m| !m.builtin).collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].name, "改名");
    }

    #[test]
    fn 内置模型不可覆盖或删除() {
        let mut lib = FixtureLibrary::open(temp_path("builtin"));
        assert!(matches!(lib.upsert(user_model("1.4.1.4")), Err(LibraryError::BuiltinReadOnly)));
        assert!(matches!(lib.remove("1.4.1.4"), Err(LibraryError::BuiltinReadOnly)));
    }

    #[test]
    fn 不合法的模型被拒绝且不落盘() {
        let path = temp_path("invalid");
        let mut lib = FixtureLibrary::open(path.clone());
        let mut bad = user_model("2.1.1.2");
        bad.properties.clear();
        let err = lib.upsert(bad).expect_err("应当拒绝");
        assert_eq!(err.code(), "invalid_model:no_properties");
        assert!(!path.exists());
    }

    #[test]
    fn 删除用户模型_不存在时报错() {
        let mut lib = FixtureLibrary::open(temp_path("remove"));
        lib.upsert(user_model("2.1.1.2")).expect("保存");
        lib.remove("2.1.1.2").expect("删除");
        assert!(matches!(lib.remove("2.1.1.2"), Err(LibraryError::NotFound)));
        assert_eq!(lib.list().len(), 6);
    }

    #[test]
    fn 损坏的文件被隔离_库从空开始() {
        let path = temp_path("corrupt");
        fs::write(&path, b"{not json").expect("写入坏文件");
        let lib = FixtureLibrary::open(path.clone());
        assert_eq!(lib.list().len(), 6);
        assert!(!path.exists());
        let mut bad = path.clone().into_os_string();
        bad.push(".bad");
        assert!(PathBuf::from(bad).exists());
    }

    #[test]
    fn 合并导入_新增_覆盖_忽略内置冲突() {
        let mut lib = FixtureLibrary::open(temp_path("merge"));
        lib.upsert(user_model("2.2.1.4")).expect("保存");
        let outcome = lib
            .merge_import(vec![user_model("1.4.1.4"), user_model("2.2.1.4"), user_model("2.1.2.1")])
            .expect("合并");
        assert_eq!(outcome.skipped, vec!["1.4.1.4"]);
        assert_eq!(outcome.updated, vec!["2.2.1.4"]);
        assert_eq!(outcome.added, vec!["2.1.2.1"]);
        let user_ids: Vec<String> = lib.list().into_iter().skip(6).map(|m| m.id).collect();
        assert_eq!(user_ids, vec!["2.1.2.1", "2.2.1.4"]);
    }

    #[test]
    fn 编号首尾空白被去除() {
        let mut lib = FixtureLibrary::open(temp_path("trim"));
        let saved = lib.upsert(user_model("  2.1.1.2 ")).expect("保存");
        assert_eq!(saved.id, "2.1.1.2");
    }
}
