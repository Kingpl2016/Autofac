//! Art-Net Studio 的 Tauri 宿主入口。
//!
//! 装配窗口、插件、状态与命令；具体领域逻辑位于各 workspace 库 crate
//! （`artrec-core`、`settings` 等），宿主层只做提取 → 调用领域 → 返回 DTO。

mod commands;
mod dispatch;
mod esp;
mod esp_commands;
mod netif;
mod playback;
mod playback_commands;
mod recording;
mod recording_commands;
mod runtime;
mod state;

use tauri::Manager;

use crate::state::AppState;

/// 返回应用版本号（来自 Cargo 包版本）。
///
/// # Returns
///
/// 形如 `"0.1.0"` 的版本字符串。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 启动 Tauri 应用主循环。
///
/// # Panics
///
/// 当 Tauri 运行时初始化失败时 panic（仅应用入口，不在库边界）。
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 配置目录
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::new(config_dir);

            // 以当前配置启动接收引擎、设备发现与事件推送
            let cfg = state.settings.lock().map(|g| g.clone()).unwrap_or_default();
            state.runtime.spawn(app.handle().clone(), &cfg);

            // 恢复上次异常退出遗留的录制（必须在任何新录制开始之前执行）
            let rec_dir = recording_commands::recording_dir(app.handle(), &cfg.recording.directory);
            let controller = state.runtime.recording().clone();
            std::thread::spawn(move || {
                let outcomes = recorder::recover_orphans(&rec_dir);
                if !outcomes.is_empty() {
                    tracing::info!(count = outcomes.len(), "已处理上次遗留的孤立录制");
                    controller.set_recovered(outcomes);
                }
            });

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            commands::get_settings,
            commands::save_settings,
            commands::import_settings,
            commands::export_settings,
            commands::list_network_interfaces,
            commands::get_universe_snapshot,
            commands::set_viewed_universes,
            commands::get_devices,
            commands::scan_network,
            commands::clear_offline_devices,
            commands::set_device_name,
            commands::get_forwarding,
            commands::save_forwarding,
            recording_commands::get_recording_dir,
            recording_commands::get_source_stats,
            recording_commands::recording_start,
            recording_commands::recording_stop,
            recording_commands::recording_status,
            recording_commands::recording_take_recovered,
            recording_commands::recordings_list,
            recording_commands::recordings_rename,
            recording_commands::recordings_delete,
            esp_commands::esp_upload_recording,
            playback_commands::player_open,
            playback_commands::player_play,
            playback_commands::player_pause,
            playback_commands::player_stop,
            playback_commands::player_close,
            playback_commands::player_seek,
            playback_commands::player_set_speed,
            playback_commands::player_set_loop,
            playback_commands::player_set_target,
            playback_commands::player_set_viewed,
            playback_commands::player_status,
            playback_commands::player_overview,
            playback_commands::player_series,
            esp_commands::esp_get_status,
            esp_commands::esp_connect,
            esp_commands::esp_disconnect,
            esp_commands::esp_board_op,
            esp_commands::esp_set_work_mode,
            esp_commands::esp_get_work_mode,
            esp_commands::esp_program_op,
            esp_commands::esp_write_channels,
            esp_commands::esp_read_channels,
            esp_commands::esp_list_files,
            esp_commands::esp_download_file,
            esp_commands::esp_upload_file,
            esp_commands::esp_delete_file,
            esp_commands::esp_rename_file,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
