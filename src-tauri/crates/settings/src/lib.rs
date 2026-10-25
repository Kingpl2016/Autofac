//! 应用配置：模型定义、持久化与校验。
//!
//! 配置以单个 JSON 文件持久化（由宿主层提供路径，通常位于应用配置目录）。
//! 前端在任意变更后约 2 秒防抖调用保存命令；本 crate 只负责模型与读写。

mod error;
mod model;
mod store;

pub use error::{Result, SettingsError};
pub use model::{
    AppSettings, ChannelFormat, DisplaySettings, CURRENT_SCHEMA_VERSION, MergeMode, MergeSettings, NetworkMode,
    NetworkSettings, NicConfig, PlayerSettings, ProtocolSettings, RecordingCompression,
    RecordingSettings,
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
        assert!(!s.protocol.sacn_enabled, "sACN 默认应关闭");
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION);
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
    fn player_section_defaults_off_and_old_files_still_load() {
        // 默认：始终以实时模式启动
        assert!(!AppSettings::default().player.start_in_player_mode);
        // 旧配置文件没有 player 分区：回落默认，而不是整体解析失败
        let mut v: serde_json::Value =
            serde_json::from_str(&to_json(&AppSettings::default()).unwrap()).unwrap();
        v.as_object_mut().unwrap().remove("player");
        let s = from_json(&v.to_string()).unwrap();
        assert_eq!(s.player, PlayerSettings::default());
        // 显式开启后能往返
        let mut on = AppSettings::default();
        on.player.start_in_player_mode = true;
        let back = from_json(&to_json(&on).unwrap()).unwrap();
        assert!(back.player.start_in_player_mode);
        // 序列化键名是 camelCase，与前端一致
        assert!(to_json(&on).unwrap().contains("startInPlayerMode"));
    }

    #[test]
    fn missing_sections_fall_back_to_default() {
        // 配置文件缺少整个 section（如旧版本没有 merge/update）时，应逐节回落默认，
        // 而非整体解析失败。验证所有顶层 section 均带 #[serde(default)]。
        let s = from_json("{}").unwrap();
        assert_eq!(s, AppSettings::default());

        // 仅提供部分 section，其余缺失的仍回落默认
        let partial = serde_json::json!({
            "protocol": { "artnetPort": 6460 }
        });
        let s = from_json(&partial.to_string()).unwrap();
        assert_eq!(s.protocol.artnet_port, 6460);
        // 缺失字段回落默认
        assert!(s.protocol.artnet_enabled);
        // 缺失 section 回落默认
        assert_eq!(s.merge, MergeSettings::default());
        assert_eq!(s.display, DisplaySettings::default());
        assert_eq!(s.network, NetworkSettings::default());
    }

    #[test]
    fn legacy_file_without_version_turns_sacn_off() {
        // 旧文件：保存过 sacnEnabled=true 且没有 schemaVersion
        let legacy = serde_json::json!({
            "protocol": { "sacnEnabled": true, "sacnPort": 5570 }
        });
        let s = from_json(&legacy.to_string()).unwrap();
        assert!(!s.protocol.sacn_enabled);
        assert_eq!(s.protocol.sacn_port, 5570, "迁移只关开关，不动其他字段");
        assert_eq!(s.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrated_file_keeps_user_choice() {
        // 迁移后用户手动开启并保存（版本 1），再次加载不能被改回
        let mut s = from_json(r#"{"protocol":{"sacnEnabled":true}}"#).unwrap();
        s.protocol.sacn_enabled = true;
        let json = to_json(&s).unwrap();
        let back = from_json(&json).unwrap();
        assert!(back.protocol.sacn_enabled);
    }

    #[test]
    fn load_migrates_legacy_file_from_disk() {
        let path = std::env::temp_dir().join("artnet-studio-settings-legacy.json");
        std::fs::write(&path, r#"{"protocol":{"sacnEnabled":true}}"#).unwrap();
        assert!(!load(&path).unwrap().protocol.sacn_enabled);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn normalize_fixes_sacn_port_and_universes() {
        let mut s = AppSettings::default();
        s.protocol.sacn_port = 0;
        s.protocol.sacn_universes = vec![0, 5, 64000, 5, 63999, 2];
        s.normalize();
        assert_eq!(s.protocol.sacn_port, 5568);
        assert_eq!(s.protocol.sacn_universes, vec![2, 5, 63999]);
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
