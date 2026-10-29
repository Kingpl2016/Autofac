//! 已保存设备的注册表：设备清单持久化为 JSON，Token 交给 [`SecretStore`]。

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::client::DeviceClient;
use crate::error::{NetdevError, Result};
use crate::secret::SecretStore;
use crate::validate::{check_host, check_port, check_token};

/// 设备名称最大字符数。
const MAX_NAME_CHARS: usize = 40;

/// 已保存的设备（不含 Token）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SavedDevice {
    /// 稳定 id（UUID）。
    pub id: String,
    /// 显示名称。
    pub name: String,
    /// 主机（IP 或主机名）。
    pub host: String,
    /// HTTP 端口。
    pub port: u16,
}

/// 返回给前端的设备视图：设备信息加"是否已保存 Token"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    /// 设备信息。
    #[serde(flatten)]
    pub device: SavedDevice,
    /// 凭据库中是否有该设备的 Token。
    pub has_token: bool,
}

/// 新增 / 更新设备的输入。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DeviceInput {
    /// 已有设备 id；新增时为空。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub id: Option<String>,
    /// 显示名称；为空时用主机代替。
    #[serde(default)]
    pub name: String,
    /// 主机。
    pub host: String,
    /// 端口。
    pub port: u16,
}

/// 磁盘文件结构。
#[derive(Debug, Default, Serialize, Deserialize)]
struct FileData {
    #[serde(default)]
    devices: Vec<SavedDevice>,
}

/// 设备注册表。
pub struct DeviceRegistry {
    path: PathBuf,
    devices: Mutex<Vec<SavedDevice>>,
    secrets: Arc<dyn SecretStore>,
}

impl DeviceRegistry {
    /// 从磁盘加载注册表；文件缺失得到空表，损坏时备份为 `.bad` 后得到空表。
    ///
    /// # Arguments
    ///
    /// * `path` - 注册表 JSON 路径。
    /// * `secrets` - Token 存储。
    ///
    /// # Returns
    ///
    /// 已加载的注册表。
    #[must_use]
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        let devices = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileData>(&text) {
                Ok(d) => d.devices,
                Err(e) => {
                    tracing::warn!(error = %e, "设备注册表损坏，已备份并重置");
                    let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { path, devices: Mutex::new(devices), secrets }
    }

    fn lock(&self) -> MutexGuard<'_, Vec<SavedDevice>> {
        self.devices.lock()
    }

    /// 原子写盘：先写临时文件再重命名。
    fn persist(&self, devices: &[SavedDevice]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&FileData { devices: devices.to_vec() })
            .map_err(|e| NetdevError::LocalIo(e.to_string()))?;
        fsutil::write_atomic(&self.path, text.as_bytes())?;
        Ok(())
    }

    /// 列出全部设备及其 Token 状态。
    ///
    /// # Returns
    ///
    /// 设备视图列表；凭据库读取失败的设备按"无 Token"处理。
    #[must_use]
    pub fn list(&self) -> Vec<DeviceView> {
        let devices = self.lock().clone();
        devices
            .into_iter()
            .map(|device| {
                let has_token = matches!(self.secrets.get(&device.id), Ok(Some(_)));
                DeviceView { device, has_token }
            })
            .collect()
    }

    /// 新增或更新设备。
    ///
    /// # Arguments
    ///
    /// * `input` - 设备信息；带 `id` 表示更新。
    ///
    /// # Returns
    ///
    /// 保存后的设备。
    ///
    /// # Errors
    ///
    /// 主机 / 端口 / 名称非法、更新的 id 不存在、同一 `主机:端口` 已被其它设备占用，或写盘失败时返回 [`NetdevError`]。
    pub fn save(&self, input: &DeviceInput) -> Result<SavedDevice> {
        let host = check_host(&input.host)?;
        check_port(input.port)?;
        let name = input.name.trim();
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(NetdevError::Invalid(format!("名称最多 {MAX_NAME_CHARS} 个字符")));
        }
        let name = if name.is_empty() { host.clone() } else { name.to_string() };

        let mut devices = self.lock();
        let dup = devices
            .iter()
            .any(|d| d.host.eq_ignore_ascii_case(&host) && d.port == input.port && Some(&d.id) != input.id.as_ref());
        if dup {
            return Err(NetdevError::Invalid("该主机和端口已添加过".into()));
        }
        let saved = if let Some(id) = &input.id {
            let slot = devices.iter_mut().find(|d| &d.id == id).ok_or(NetdevError::UnknownDevice)?;
            slot.name = name;
            slot.host = host;
            slot.port = input.port;
            slot.clone()
        } else {
            let d = SavedDevice { id: uuid::Uuid::new_v4().to_string(), name, host, port: input.port };
            devices.push(d.clone());
            d
        };
        self.persist(&devices)?;
        Ok(saved)
    }

    /// 删除设备并清除其 Token。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    ///
    /// # Errors
    ///
    /// 设备不存在、写盘失败或凭据删除失败时返回 [`NetdevError`]。
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut devices = self.lock();
        let before = devices.len();
        devices.retain(|d| d.id != id);
        if devices.len() == before {
            return Err(NetdevError::UnknownDevice);
        }
        self.persist(&devices)?;
        drop(devices);
        self.secrets.delete(id)
    }

    /// 设置或清除设备 Token。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    /// * `token` - 新 Token；空串表示清除。
    ///
    /// # Errors
    ///
    /// 设备不存在、Token 格式非法或凭据存储失败时返回 [`NetdevError`]。
    pub fn set_token(&self, id: &str, token: &str) -> Result<()> {
        self.find(id)?;
        check_token(token)?;
        if token.is_empty() {
            self.secrets.delete(id)
        } else {
            self.secrets.set(id, token)
        }
    }

    fn find(&self, id: &str) -> Result<SavedDevice> {
        self.lock().iter().find(|d| d.id == id).cloned().ok_or(NetdevError::UnknownDevice)
    }

    /// 为已保存设备创建带 Token 的客户端。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    ///
    /// # Returns
    ///
    /// 可直接发请求的 [`DeviceClient`]。
    ///
    /// # Errors
    ///
    /// 设备不存在、凭据读取失败或客户端构建失败时返回 [`NetdevError`]。
    pub fn client_for(&self, id: &str) -> Result<DeviceClient> {
        let d = self.find(id)?;
        let token = self.secrets.get(id)?;
        DeviceClient::new(&d.host, d.port, token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::MemoryStore;

    fn registry(dir: &tempfile::TempDir) -> (DeviceRegistry, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::default());
        let r = DeviceRegistry::load(dir.path().join("net-devices.json"), store.clone());
        (r, store)
    }

    fn input(host: &str, port: u16) -> DeviceInput {
        DeviceInput { id: None, name: String::new(), host: host.into(), port }
    }

    #[test]
    fn add_update_remove_roundtrip_via_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (r, _) = registry(&dir);
        let a = r.save(&input("10.0.0.2", 80)).unwrap();
        assert_eq!(a.name, "10.0.0.2");
        let upd = DeviceInput { id: Some(a.id.clone()), name: "主舞台".into(), host: "10.0.0.3".into(), port: 8080 };
        r.save(&upd).unwrap();

        let (reloaded, _) = registry(&dir);
        let list = reloaded.list();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].device.name.as_str(), list[0].device.port), ("主舞台", 8080));

        reloaded.remove(&a.id).unwrap();
        assert!(reloaded.list().is_empty());
        assert!(matches!(reloaded.remove(&a.id), Err(NetdevError::UnknownDevice)));
    }

    #[test]
    fn rejects_invalid_and_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let (r, _) = registry(&dir);
        assert!(r.save(&input("http://x", 80)).is_err());
        assert!(r.save(&input("10.0.0.2", 0)).is_err());
        let long = DeviceInput { name: "x".repeat(41), ..input("10.0.0.2", 80) };
        assert!(r.save(&long).is_err());
        r.save(&input("10.0.0.2", 80)).unwrap();
        assert!(r.save(&input("10.0.0.2", 80)).is_err());
        r.save(&input("10.0.0.2", 81)).unwrap();
        let missing = DeviceInput { id: Some("nope".into()), ..input("10.0.0.9", 80) };
        assert!(matches!(r.save(&missing), Err(NetdevError::UnknownDevice)));
    }

    #[test]
    fn tokens_live_in_secret_store_only() {
        let dir = tempfile::tempdir().unwrap();
        let (r, store) = registry(&dir);
        let d = r.save(&input("10.0.0.2", 80)).unwrap();
        assert!(!r.list()[0].has_token);
        r.set_token(&d.id, "abcd1234").unwrap();
        assert!(r.list()[0].has_token);
        assert_eq!(store.get(&d.id).unwrap().as_deref(), Some("abcd1234"));
        let on_disk = std::fs::read_to_string(dir.path().join("net-devices.json")).unwrap();
        assert!(!on_disk.contains("abcd1234"));

        assert!(r.set_token(&d.id, "short").is_err());
        r.set_token(&d.id, "").unwrap();
        assert!(!r.list()[0].has_token);

        r.set_token(&d.id, "abcd1234").unwrap();
        r.remove(&d.id).unwrap();
        assert_eq!(store.get(&d.id).unwrap(), None);
        assert!(matches!(r.set_token("nope", "abcd1234"), Err(NetdevError::UnknownDevice)));
    }

    #[test]
    fn corrupt_file_is_backed_up_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("net-devices.json");
        std::fs::write(&p, "{ not json").unwrap();
        let (r, _) = registry(&dir);
        assert!(r.list().is_empty());
        assert!(dir.path().join("net-devices.json.bad").exists());
    }

    #[test]
    fn client_for_uses_stored_token() {
        let dir = tempfile::tempdir().unwrap();
        let (r, _) = registry(&dir);
        let d = r.save(&input("10.0.0.2", 80)).unwrap();
        r.set_token(&d.id, "abcd1234").unwrap();
        assert_eq!(r.client_for(&d.id).unwrap().base_url(), "http://10.0.0.2:80");
        assert!(matches!(r.client_for("nope"), Err(NetdevError::UnknownDevice)));
    }
}
