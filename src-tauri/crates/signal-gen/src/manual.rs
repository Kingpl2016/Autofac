//! 手动模式的通道数据：每个 Universe 一份 512 字节，由用户逐通道或整体设置。
//!
//! 通道号统一采用操作员看到的 **1 起始**（`1..=512`），避免界面与后端之间的下标换算。

use std::collections::BTreeMap;

use serde::Serialize;
use thiserror::Error;

use crate::pattern::CHANNELS;

/// 手动数据操作错误。序列化为 `{ "code": "...", ... }`，前端按 `code` 本地化文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ManualError {
    /// 通道号不在 `1..=512` 内。
    #[error("通道号 {channel} 超出 1 到 512")]
    ChannelOutOfRange {
        /// 越界的通道号。
        channel: u16,
    },
}

/// 手动模式下各 Universe 的通道数据。未设置过的 Universe 按全 0 发送。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManualData {
    universes: BTreeMap<u16, [u8; CHANNELS]>,
}

impl ManualData {
    /// 创建空数据（所有 Universe 全 0）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置单个通道。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    /// * `channel` - 通道号，`1..=512`。
    /// * `value` - 通道值。
    ///
    /// # Errors
    ///
    /// `channel` 不在 `1..=512` 时返回 [`ManualError::ChannelOutOfRange`]，数据不变。
    pub fn set_channel(&mut self, universe: u16, channel: u16, value: u8) -> Result<(), ManualError> {
        let index = usize::from(channel)
            .checked_sub(1)
            .filter(|&i| i < CHANNELS)
            .ok_or(ManualError::ChannelOutOfRange { channel })?;
        self.universes.entry(universe).or_insert([0; CHANNELS])[index] = value;
        Ok(())
    }

    /// 把某个 Universe 的全部 512 个通道设为同一个值。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    /// * `value` - 通道值。
    pub fn set_all(&mut self, universe: u16, value: u8) {
        self.universes.insert(universe, [value; CHANNELS]);
    }

    /// 清除某个 Universe 的手动数据（之后按全 0 发送）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    pub fn clear_universe(&mut self, universe: u16) {
        self.universes.remove(&universe);
    }

    /// 清除全部手动数据。
    pub fn clear_all(&mut self) {
        self.universes.clear();
    }

    /// 读取某个 Universe 当前的 512 通道数据。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    ///
    /// # Returns
    ///
    /// 已设置过则返回其数据，否则返回全 0。
    #[must_use]
    pub fn get(&self, universe: u16) -> [u8; CHANNELS] {
        self.universes.get(&universe).copied().unwrap_or([0; CHANNELS])
    }

    /// 是否没有任何手动数据。
    ///
    /// # Returns
    ///
    /// 没有任何 Universe 被设置过时为 `true`。
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.universes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_universes_read_as_zeros() {
        let m = ManualData::new();
        assert!(m.is_empty());
        assert_eq!(m.get(7), [0; CHANNELS]);
    }

    #[test]
    fn channels_are_one_based_and_bounds_checked() {
        let mut m = ManualData::new();
        m.set_channel(1, 1, 10).unwrap();
        m.set_channel(1, 512, 20).unwrap();
        let d = m.get(1);
        assert_eq!((d[0], d[511]), (10, 20));
        assert_eq!(d.iter().filter(|&&v| v != 0).count(), 2);

        assert_eq!(m.set_channel(1, 0, 1), Err(ManualError::ChannelOutOfRange { channel: 0 }));
        assert_eq!(m.set_channel(1, 513, 1), Err(ManualError::ChannelOutOfRange { channel: 513 }));
        // 失败的操作不改变数据
        assert_eq!(m.get(1), d);
    }

    #[test]
    fn error_serializes_with_a_code_for_the_frontend() {
        let e = ManualError::ChannelOutOfRange { channel: 513 };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({ "code": "channelOutOfRange", "channel": 513 })
        );
    }

    #[test]
    fn universes_are_independent() {
        let mut m = ManualData::new();
        m.set_channel(1, 5, 100).unwrap();
        m.set_channel(2, 5, 200).unwrap();
        assert_eq!(m.get(1)[4], 100);
        assert_eq!(m.get(2)[4], 200);
        assert_eq!(m.get(3)[4], 0);
    }

    #[test]
    fn set_all_overwrites_the_whole_universe() {
        let mut m = ManualData::new();
        m.set_channel(1, 3, 9).unwrap();
        m.set_all(1, 128);
        assert_eq!(m.get(1), [128; CHANNELS]);
        m.set_all(2, 0);
        assert!(!m.is_empty(), "显式设为 0 也算设置过");
    }

    #[test]
    fn clearing_one_universe_keeps_the_others() {
        let mut m = ManualData::new();
        m.set_all(1, 255);
        m.set_all(2, 255);
        m.clear_universe(1);
        assert_eq!(m.get(1), [0; CHANNELS]);
        assert_eq!(m.get(2), [255; CHANNELS]);
        m.clear_all();
        assert!(m.is_empty());
        assert_eq!(m.get(2), [0; CHANNELS]);
    }
}
