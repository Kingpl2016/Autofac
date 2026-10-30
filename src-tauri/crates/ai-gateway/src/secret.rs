//! API Key 的凭据存储抽象：生产环境用系统凭据管理器，测试用内存实现。
//!
//! Key 永远不写入配置 JSON、日志或返回给前端的数据。

use std::collections::HashMap;

use parking_lot::Mutex;

use crate::error::{AiError, Result};

/// 凭据服务名（系统凭据管理器中的分组）。
const SERVICE: &str = "art-net-studio.ai";

/// 按配置 id 存取 API Key 的存储。
pub trait SecretStore: Send + Sync {
    /// 读取 Key。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    ///
    /// # Returns
    ///
    /// 已保存的 Key；未保存返回 `None`。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`AiError::Secret`]。
    fn get(&self, id: &str) -> Result<Option<String>>;

    /// 保存（覆盖）Key。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    /// * `key` - 明文 Key。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`AiError::Secret`]。
    fn set(&self, id: &str, key: &str) -> Result<()>;

    /// 删除 Key；不存在视为成功。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`AiError::Secret`]。
    fn delete(&self, id: &str) -> Result<()>;
}

/// 基于系统凭据管理器（Windows 凭据管理器 / macOS 钥匙串 / Secret Service）的实现。
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringStore;

impl KeyringStore {
    fn entry(id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, id).map_err(|e| AiError::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, id: &str) -> Result<Option<String>> {
        match Self::entry(id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AiError::Secret(e.to_string())),
        }
    }

    fn set(&self, id: &str, key: &str) -> Result<()> {
        Self::entry(id)?.set_password(key).map_err(|e| AiError::Secret(e.to_string()))
    }

    fn delete(&self, id: &str) -> Result<()> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AiError::Secret(e.to_string())),
        }
    }
}

/// 内存实现（测试与不支持系统凭据的环境）。
#[derive(Debug, Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.map.lock().get(id).cloned())
    }

    fn set(&self, id: &str, key: &str) -> Result<()> {
        self.map.lock().insert(id.to_owned(), key.to_owned());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        self.map.lock().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 内存存储的增删改查() {
        let s = MemoryStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "sk-1").unwrap();
        s.set("a", "sk-2").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("sk-2"));
        s.delete("a").unwrap();
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
    }
}
