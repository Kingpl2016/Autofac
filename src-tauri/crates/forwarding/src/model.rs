//! 转发目的地与覆盖规则的数据模型。

use serde::{Deserialize, Serialize};

/// 转发使用的协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardProtocol {
    /// Art-Net。
    ArtNet,
    /// sACN。
    Sacn,
}

/// 转发模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardMode {
    /// 转发全部 Universe（可被 Exclude 覆盖排除）。
    All,
    /// 仅转发被 Forward 覆盖显式选中的 Universe。
    Selected,
}

/// 覆盖动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverrideAction {
    /// 转发。
    Forward,
    /// 排除。
    Exclude,
}

/// per-universe 覆盖规则。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseOverride {
    /// 本规则对应的源 Universe。
    pub source_universe: u16,
    /// 动作。
    pub action: OverrideAction,
    /// 单独指定的目标 Universe；省略时套用偏移。
    #[serde(default)]
    pub target_universe: Option<u16>,
    /// 单独延迟（毫秒）；省略时套用默认延迟。
    #[serde(default)]
    pub delay_ms: Option<u16>,
}

/// 一个转发目的地。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardDestination {
    /// 唯一 ID。
    pub id: String,
    /// 名称（必填）。
    pub name: String,
    /// 目标 IP。
    pub target_ip: String,
    /// 协议。
    pub protocol: ForwardProtocol,
    /// 目标端口。
    pub port: u16,
    /// 模式。
    pub mode: ForwardMode,
    /// Universe 偏移（转发时加到源 Universe 编号上）。
    #[serde(default)]
    pub universe_offset: i32,
    /// 默认延迟（0~2000ms）。
    #[serde(default)]
    pub default_delay_ms: u16,
    /// 备注。
    #[serde(default)]
    pub description: String,
    /// 是否启用。
    pub enabled: bool,
    /// per-universe 覆盖规则。
    #[serde(default)]
    pub overrides: Vec<UniverseOverride>,
}

/// 对源 Universe 套用偏移。
///
/// # Arguments
///
/// * `source_universe` - 源 Universe 编号。
/// * `offset` - Universe 偏移（可为负）。
///
/// # Returns
///
/// 结果落在 `0..=65535` 内时返回 `Some(目标 Universe)`；越界（含变为负数、`i32` 溢出）返回 `None`。
#[must_use]
pub fn offset_universe(source_universe: u16, offset: i32) -> Option<u16> {
    i32::from(source_universe)
        .checked_add(offset)
        .and_then(|t| u16::try_from(t).ok())
}

/// 解析后的单条转发路由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedRoute {
    /// 目标 Universe。
    pub target_universe: u16,
    /// 延迟（毫秒）。
    pub delay_ms: u16,
}

impl ForwardDestination {
    /// 针对某源 Universe 解析本目的地的转发决策。
    ///
    /// # Arguments
    ///
    /// * `source_universe` - 源 Universe 编号。
    ///
    /// # Returns
    ///
    /// 需转发时返回 [`ResolvedRoute`]；不转发（被排除、未选中或越界）返回 `None`。
    #[must_use]
    pub fn resolve(&self, source_universe: u16) -> Option<ResolvedRoute> {
        if !self.enabled {
            return None;
        }
        let ov = self
            .overrides
            .iter()
            .find(|o| o.source_universe == source_universe);

        let forward = match self.mode {
            ForwardMode::All => !matches!(ov.map(|o| o.action), Some(OverrideAction::Exclude)),
            ForwardMode::Selected => {
                matches!(ov.map(|o| o.action), Some(OverrideAction::Forward))
            }
        };
        if !forward {
            return None;
        }

        let target = if let Some(t) = ov.and_then(|o| o.target_universe) {
            t
        } else {
            // 偏移越界（含变为负数、i32 溢出）→ 不转发
            offset_universe(source_universe, self.universe_offset)?
        };
        let delay = ov.and_then(|o| o.delay_ms).unwrap_or(self.default_delay_ms);

        Some(ResolvedRoute {
            target_universe: target,
            delay_ms: delay,
        })
    }
}
