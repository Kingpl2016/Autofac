//! 设备 Token 的凭据存储抽象：生产环境用系统凭据管理器，测试用内存实现。
//!
//! Token 永远不写入注册表 JSON、日志或返回给前端的数据。

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use crate::error::{NetdevError, Result};

/// 凭据服务名（系统凭据管理器中的分组）。
const SERVICE: &str = "art-net-studio.netdev";

/// 按设备 id 存取 Bearer Token 的存储。
pub trait SecretStore: Send + Sync {
    /// 读取设备 Token。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    ///
    /// # Returns
    ///
    /// 已保存的 Token；未保存返回 `None`。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`NetdevError::Secret`]。
    fn get(&self, id: &str) -> Result<Option<String>>;

    /// 保存（覆盖）设备 Token。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    /// * `token` - 明文 Token。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`NetdevError::Secret`]。
    fn set(&self, id: &str, token: &str) -> Result<()>;

    /// 删除设备 Token；不存在视为成功。
    ///
    /// # Arguments
    ///
    /// * `id` - 设备 id。
    ///
    /// # Errors
    ///
    /// 底层凭据存储不可用时返回 [`NetdevError::Secret`]。
    fn delete(&self, id: &str) -> Result<()>;
}

/// 基于系统凭据管理器（Windows 凭据管理器 / macOS 钥匙串 / Secret Service）的实现。
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringStore;

impl KeyringStore {
    fn entry(id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, id).map_err(|e| NetdevError::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, id: &str) -> Result<Option<String>> {
        match Self::entry(id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(NetdevError::Secret(e.to_string())),
        }
    }

    fn set(&self, id: &str, token: &str) -> Result<()> {
        Self::entry(id)?
            .set_password(token)
            .map_err(|e| NetdevError::Secret(e.to_string()))
    }

    fn delete(&self, id: &str) -> Result<()> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(NetdevError::Secret(e.to_string())),
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
        Ok(self.map.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned())
    }

    fn set(&self, id: &str, token: &str) -> Result<()> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string(), token.to_string());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_lifecycle() {
        let s = MemoryStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "token-1234").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("token-1234"));
        s.set("a", "token-5678").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("token-5678"));
        s.delete("a").unwrap();
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
    }
}
