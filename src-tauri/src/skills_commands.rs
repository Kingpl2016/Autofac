//! Tauri 命令：AI 助手的用户技能（`data/skills`）与回收站（`data/trash`）。
//!
//! 逻辑在 `skill-store` 库；本模块只做“提取 State → 调用库 → 返回 DTO”。错误以错误码字符串返回
//! （`invalid` / `too_large` / `symlink` / `unsafe_path` / `exists` / `not_found` / `io` / `zip`）。
//! 技能里的 `scripts/` 只保存，应用从不执行。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use skill_store::{SkillError, SkillInfo, SkillStore, Trash, TrashEntry, KEEP_MS};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// 技能与回收站的应用状态。
pub struct SkillsState {
    store: SkillStore,
}

/// 当前时间（Unix 毫秒）。
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// 错误转成错误码。
fn code(e: &SkillError) -> String {
    if let SkillError::Invalid(why) = e {
        tracing::info!(reason = %why, "技能包不合规");
    }
    e.code().to_owned()
}

impl SkillsState {
    /// 创建状态，并清掉回收站里超过 30 天的条目。
    ///
    /// # Arguments
    ///
    /// * `app` - 应用句柄，用于定位数据根目录。
    ///
    /// # Returns
    ///
    /// 状态。
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let root = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        let trash = Trash::new(root.join("trash"));
        let purged = trash.purge(now_ms(), KEEP_MS);
        if purged > 0 {
            tracing::info!(count = purged, "已清理回收站里过期的条目");
        }
        Self { store: SkillStore::new(root.join("skills"), trash) }
    }

    /// 把一段 JSON 放进回收站（给其它模块用，例如删除的 MCP 服务器配置）。
    ///
    /// # Arguments
    ///
    /// * `kind` - 种类。
    /// * `label` - 显示名。
    /// * `json` - 内容。
    ///
    /// # Returns
    ///
    /// 新条目。
    ///
    /// # Errors
    ///
    /// 内容不合规或写盘失败时返回错误码。
    pub fn trash_put_json(&self, kind: &str, label: &str, json: &str) -> Result<TrashEntry, String> {
        self.store.trash().put_json(kind, label, json, now_ms()).map_err(|e| code(&e))
    }

    /// 把一个目录挪进回收站（给其它模块用，例如清理掉的灯具资源）。
    ///
    /// # Arguments
    ///
    /// * `kind` - 种类。
    /// * `label` - 显示名。
    /// * `dir` - 要挪走的目录（之后不再存在）。
    ///
    /// # Returns
    ///
    /// 新条目。
    ///
    /// # Errors
    ///
    /// 种类不合规或挪动失败时返回错误码。
    pub fn trash_put_dir(&self, kind: &str, label: &str, dir: &std::path::Path) -> Result<TrashEntry, String> {
        self.store.trash().put_dir(kind, label, dir, now_ms()).map_err(|e| code(&e))
    }

    /// 取回一个指定种类的 JSON 条目（并从回收站删除）。
    ///
    /// # Arguments
    ///
    /// * `id` - 条目 id。
    /// * `kind` - 期望的种类。
    ///
    /// # Returns
    ///
    /// JSON 文本。
    ///
    /// # Errors
    ///
    /// 条目不存在或种类不对时返回 `not_found`。
    pub fn trash_take_json(&self, id: &str, kind: &str) -> Result<String, String> {
        let entry = self.store.trash().entry(id).map_err(|e| code(&e))?;
        if entry.kind != kind {
            return Err("not_found".into());
        }
        self.store.trash().take_json(id).map(|(_, json)| json).map_err(|e| code(&e))
    }
}

/// 列出用户技能。
///
/// # Arguments
///
/// * `state` - 技能状态。
///
/// # Returns
///
/// 技能（按名称排序）。
#[tauri::command]
pub async fn skills_list(state: State<'_, SkillsState>) -> Result<Vec<SkillInfo>, String> {
    Ok(state.store.list())
}

/// 读取一个技能的 `SKILL.md`。
///
/// # Arguments
///
/// * `state` - 技能状态。
/// * `name` - 技能名。
///
/// # Returns
///
/// 全文。
///
/// # Errors
///
/// 不存在（`not_found`）或读取失败（`io` / `invalid`）。
#[tauri::command]
pub async fn skills_read(state: State<'_, SkillsState>, name: String) -> Result<String, String> {
    state.store.read(&name).map_err(|e| code(&e))
}

/// 导入技能包（`.zip`、文件夹或单个 `SKILL.md`）。
///
/// # Arguments
///
/// * `state` - 技能状态。
/// * `path` - 用户选择 / 拖入的路径。
/// * `replace` - 同名已存在时替换（旧的进回收站）。
///
/// # Returns
///
/// 导入的技能。
///
/// # Errors
///
/// 包不合规（`invalid` / `too_large` / `symlink` / `unsafe_path`）、同名已存在（`exists`）或读写失败。
#[tauri::command]
pub async fn skills_import(state: State<'_, SkillsState>, path: String, replace: bool) -> Result<SkillInfo, String> {
    state.store.import(&PathBuf::from(path), replace, now_ms()).map_err(|e| code(&e))
}

/// 把技能导出成 zip。
///
/// # Arguments
///
/// * `state` - 技能状态。
/// * `name` - 技能名。
/// * `dest` - 目标 `.zip` 路径（用户在保存对话框里选的）。
///
/// # Errors
///
/// 技能不存在或写入失败。
#[tauri::command]
pub async fn skills_export(state: State<'_, SkillsState>, name: String, dest: String) -> Result<(), String> {
    let dest = PathBuf::from(dest);
    if !dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        return Err("invalid".into());
    }
    state.store.export(&name, &dest).map_err(|e| code(&e))
}

/// 删除技能（进回收站，30 天内可恢复）。
///
/// # Arguments
///
/// * `state` - 技能状态。
/// * `name` - 技能名。
///
/// # Returns
///
/// 回收站条目。
///
/// # Errors
///
/// 技能不存在或挪动失败。
#[tauri::command]
pub async fn skills_delete(state: State<'_, SkillsState>, name: String) -> Result<TrashEntry, String> {
    state.store.delete(&name, now_ms()).map_err(|e| code(&e))
}

/// 从回收站恢复技能。
///
/// # Arguments
///
/// * `state` - 技能状态。
/// * `trash_id` - 回收站条目 id。
///
/// # Returns
///
/// 恢复的技能。
///
/// # Errors
///
/// 条目不存在（`not_found`）、同名技能已存在（`exists`）或读写失败。
#[tauri::command]
pub async fn skills_restore(state: State<'_, SkillsState>, trash_id: String) -> Result<SkillInfo, String> {
    state.store.restore(&trash_id).map_err(|e| code(&e))
}

/// 在系统文件管理器里显示技能目录（没有指定技能时显示技能根目录）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 技能状态。
/// * `name` - 技能名；省略时打开技能根目录。
///
/// # Errors
///
/// 技能不存在或打开失败。
#[tauri::command]
pub async fn skills_reveal(app: AppHandle, state: State<'_, SkillsState>, name: Option<String>) -> Result<(), String> {
    let dir = if let Some(n) = name {
        state.store.dir_of(&n).map_err(|e| code(&e))?.join("SKILL.md")
    } else {
        let root = app.state::<crate::data_dir::DataRoot>().path().join("skills");
        std::fs::create_dir_all(&root).map_err(|_| "io".to_owned())?;
        root
    };
    app.opener().reveal_item_in_dir(dir).map_err(|e| e.to_string())
}

/// 列出回收站。
///
/// # Arguments
///
/// * `state` - 技能状态（共用回收站）。
///
/// # Returns
///
/// 条目（新的在前）。
#[tauri::command]
pub async fn trash_list(state: State<'_, SkillsState>) -> Result<Vec<TrashEntry>, String> {
    Ok(state.store.trash().list())
}

/// 把一段 JSON（删除的 MCP 服务器配置、记忆…）放进回收站。
///
/// # Arguments
///
/// * `state` - 技能状态（共用回收站）。
/// * `kind` - 种类（小写字母、数字与连字符）。
/// * `label` - 显示名。
/// * `json` - 内容（合法 JSON，最多 2 MiB）。
///
/// # Returns
///
/// 新条目。
///
/// # Errors
///
/// 种类 / 内容不合规（`invalid` / `too_large`）或写盘失败（`io`）。
#[tauri::command]
pub async fn trash_put_json(state: State<'_, SkillsState>, kind: String, label: String, json: String) -> Result<TrashEntry, String> {
    state.store.trash().put_json(&kind, &label, &json, now_ms()).map_err(|e| code(&e))
}

/// 取回一个 JSON 条目（并从回收站删除）。
///
/// # Arguments
///
/// * `state` - 技能状态（共用回收站）。
/// * `id` - 条目 id。
///
/// # Returns
///
/// JSON 文本。
///
/// # Errors
///
/// 条目不存在或不是 JSON 条目（`not_found`）。
#[tauri::command]
pub async fn trash_take_json(state: State<'_, SkillsState>, id: String) -> Result<String, String> {
    state.store.trash().take_json(&id).map(|(_, json)| json).map_err(|e| code(&e))
}

/// 彻底删除一个回收站条目。
///
/// # Arguments
///
/// * `state` - 技能状态（共用回收站）。
/// * `id` - 条目 id。
///
/// # Errors
///
/// 条目不存在（`not_found`）或删除失败（`io`）。
#[tauri::command]
pub async fn trash_remove(state: State<'_, SkillsState>, id: String) -> Result<(), String> {
    state.store.trash().remove(&id).map_err(|e| code(&e))
}
