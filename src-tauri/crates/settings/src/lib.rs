//! 应用配置：模型定义、持久化与校验。
//!
//! 配置以单个 JSON 文件持久化（由宿主层提供路径，通常位于应用配置目录）。
//! 前端在任意变更后约 2 秒防抖调用保存命令；本 crate 只负责模型与读写。

mod error;
mod model;
mod store;

pub use error::{Result, SettingsError};
pub use model::{
    AppSettings, ChannelFormat, DisplaySettings, MergeMode, MergeSettings, NetworkMode,
    NetworkSettings, NicConfig, ProtocolSettings, RecordingCompression, RecordingSettings,
    UniverseFormat,
    UpdateChannel, UpdateSettings, ValueFormat,
};
pub use store::{from_json, load, save, to_json};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_roundtrip_json() {
        let s = AppSettings::default();
        let json = to_json(&s).unwrap();
        let back = from_json(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn defaults_match_manual() {
        let s = AppSettings::default();
        assert_eq!(s.protocol.artnet_port, 6454);
        assert_eq!(s.protocol.sacn_port, 5568);
        assert!(s.protocol.artnet_enabled);
        assert_eq!(s.protocol.sacn_universes, vec![1]);
        assert_eq!(s.display.ui_update_rate, 30);
        assert_eq!(s.merge.mode, MergeMode::Htp);
        assert_eq!(s.network.mode, NetworkMode::Single);
        assert_eq!(s.network.interface, "0.0.0.0");
    }

    #[test]
    fn load_missing_returns_default() {
        let path = std::env::temp_dir().join("artnet-studio-does-not-exist-xyz.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load(&path).unwrap(), AppSettings::default());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let path = std::env::temp_dir().join("artnet-studio-settings-test.json");
        let mut s = AppSettings::default();
        s.protocol.artnet_port = 6455;
        s.display.ui_update_rate = 60;
        save(&path, &s).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.protocol.artnet_port, 6455);
        assert_eq!(back.display.ui_update_rate, 60);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn normalize_clamps_values() {
        let mut s = AppSettings::default();
        s.display.ui_update_rate = 999;
        s.merge.source_timeout_ms = 10;
        s.protocol.sacn_universes = vec![3, 1, 1, 2];
        s.normalize();
        assert_eq!(s.display.ui_update_rate, 60);
        assert_eq!(s.merge.source_timeout_ms, 1000);
        assert_eq!(s.protocol.sacn_universes, vec![1, 2, 3]);
    }

    #[test]
    fn legacy_recording_section_still_loads() {
        // 旧版本只有 directory 字段；新增字段缺失时必须回落默认而不是整体解析失败
        let mut v: serde_json::Value =
            serde_json::from_str(&to_json(&AppSettings::default()).unwrap()).unwrap();
        v["recording"] = serde_json::json!({ "directory": "D:/rec" });
        let s = from_json(&v.to_string()).unwrap();
        assert_eq!(s.recording.directory, "D:/rec");
        assert_eq!(s.recording.compression, RecordingCompression::Zstd);
        assert_eq!(s.recording.zstd_level, 3);
        assert_eq!(s.recording.split_minutes, 0);
    }

    #[test]
    fn recording_values_are_clamped() {
        let mut s = AppSettings::default();
        s.recording.zstd_level = 0;
        s.recording.split_minutes = 99_999;
        s.normalize();
        assert_eq!(s.recording.zstd_level, 1);
        assert_eq!(s.recording.split_minutes, 24 * 60);
    }

    #[test]
    fn ui_rate_snaps_to_nearest_tier() {
        let mut s = AppSettings::default();
        s.display.ui_update_rate = 20;
        s.normalize();
        assert_eq!(s.display.ui_update_rate, 15);
        s.display.ui_update_rate = 30;
        s.normalize();
        assert_eq!(s.display.ui_update_rate, 30);
    }
}
