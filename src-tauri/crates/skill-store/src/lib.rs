//! AI 助手的用户技能库与回收站。
//!
//! - [`store`]：`data/skills/<name>/SKILL.md`（Agent Skills 格式）的安全导入、导出、删除与恢复；
//! - [`trash`]：删除的用户数据先进回收站，30 天内可恢复（技能目录、MCP 服务器配置、记忆共用）；
//! - [`frontmatter`]：`SKILL.md` 前言的解析与校验。

pub mod error;
pub mod frontmatter;
pub mod store;
pub mod trash;

pub use error::SkillError;
pub use store::{SkillInfo, SkillStore};
pub use trash::{Trash, TrashEntry, KEEP_MS};
