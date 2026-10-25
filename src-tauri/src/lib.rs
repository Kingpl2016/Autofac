//! Art-Net Studio 的 Tauri 宿主入口。
//!
//! 装配窗口与插件。配置与实时子系统由 `host-core` 插件承载（配置/信号引擎/发现/转发/录制/回放），
//! 外接控制器为 `controller` 库 + 宿主侧薄命令（见 [`controller_commands`]）。
//! 宿主层只做装配与命令注册。

mod controller_commands;
mod playback_commands;
mod recording_commands;

use tauri::Manager;

use host_core::{ArtnetCoreExt, SettingsExt};

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 键值持久化：前端界面偏好（如设备发现的筛选 / 排序）落盘到 app_data_dir。
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(host_core::init())
        .setup(|app| {
            // 外接控制器句柄（默认未配置）。
            app.manage(controller::ControllerHandle::default());

            // 恢复上次异常退出遗留的录制（配置与录制控制器均来自 host-core，已先行 setup）。
            let cfg = app.settings_snapshot();
            let rec_dir = recording_commands::recording_dir(app.handle(), &cfg.recording.directory);
            let controller = app.artnet_core().recording().clone();
            std::thread::spawn(move || {
                let outcomes = recorder::recover_orphans(&rec_dir);
                if !outcomes.is_empty() {
                    tracing::info!(count = outcomes.len(), "已处理上次遗留的孤立录制");
                    controller.set_recovered(outcomes);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            host_core::commands::get_settings,
            host_core::commands::save_settings,
            host_core::commands::import_settings,
            host_core::commands::export_settings,
            host_core::commands::list_network_interfaces,
            host_core::commands::get_universe_snapshot,
            host_core::commands::set_viewed_universes,
            host_core::commands::get_source_stats,
            host_core::commands::get_devices,
            host_core::commands::scan_network,
            host_core::commands::clear_offline_devices,
            host_core::commands::set_device_name,
            host_core::commands::get_forwarding,
            host_core::commands::save_forwarding,
            recording_commands::get_recording_dir,
            recording_commands::recording_start,
            recording_commands::recording_stop,
            recording_commands::recording_status,
            recording_commands::recording_take_recovered,
            recording_commands::recordings_list,
            recording_commands::recordings_rename,
            recording_commands::recordings_delete,
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
            controller_commands::controller_get_status,
            controller_commands::controller_connect,
            controller_commands::controller_disconnect,
            controller_commands::controller_board_op,
            controller_commands::controller_set_work_mode,
            controller_commands::controller_get_work_mode,
            controller_commands::controller_program_op,
            controller_commands::controller_write_channels,
            controller_commands::controller_read_channels,
            controller_commands::controller_list_files,
            controller_commands::controller_download_file,
            controller_commands::controller_upload_file,
            controller_commands::controller_delete_file,
            controller_commands::controller_rename_file,
            controller_commands::controller_upload_recording,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
