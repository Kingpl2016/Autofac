//! Art-Net Studio 的 Tauri 宿主入口。
//!
//! 装配窗口与插件。配置与实时子系统由 `host-core` 插件承载（配置/信号引擎/发现/转发/录制/回放），
//! 外接控制器为 `controller` 库 + 宿主侧薄命令（见 [`controller_commands`]）。
//! 宿主层只做装配与命令注册。

mod about_commands;
mod app_mode_commands;
mod controller_commands;
mod playback_commands;
mod recording_commands;
mod signal_checker_commands;

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
    let mut builder = tauri::Builder::default()
        // 统一日志：stdout + 滚动文件（LogDir）+ webview。Rust 侧 `tracing` 事件经 `log`
        // 桥接特性转为 `log` 记录后也由本插件处理，前端经 attachLogger 汇入应用内日志面板。
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 文件传输（HTTP 上传 / 下载，带进度）。
        .plugin(tauri_plugin_upload::init())
        // 键值持久化：前端界面偏好（如外观 / 设备发现的筛选、排序）落盘到 app_data_dir。
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(host_core::init());

    // 桌面专用插件：全局快捷键 / 持久化已授权的文件范围 / 自动更新。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_persisted_scope::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // 外接控制器句柄（默认未配置）。
            app.manage(controller::ControllerHandle::default());
            // 信号检测器（测试信号发生器）：发送器常驻，窗口按需打开。
            app.manage(signal_checker_commands::SignalCheckerState::new(
                app.handle(),
            ));

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
            // 无人值守的播放机：设置里勾选后，一启动就进入播放器模式（停止实时接收，只播放节目）。
            // 须在 Tokio 上下文中切换（重建 / 拆除接收套接字需要 reactor）。
            if cfg.player.start_in_player_mode {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let emit: host_core::recording::Emitter = std::sync::Arc::new({
                        let handle = handle.clone();
                        move |name, payload| {
                            let _ = tauri::Emitter::emit(&handle, name, payload);
                        }
                    });
                    if let Err(e) = handle
                        .artnet_core()
                        .set_app_mode(host_core::app_mode::AppMode::Player, &emit)
                    {
                        tracing::warn!(error = %e, "启动时进入播放器模式失败，保持实时模式");
                    }
                });
            }
            Ok(())
        })
        // 关闭窗口：录制或播放进行中先拦下，交给前端确认（见 `app_quit`）；否则直接关闭。
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let app = window.app_handle();
                let core = app.artnet_core();
                let recording = core.recording().is_recording();
                let playing =
                    core.playback().status().state == host_core::playback::PlaybackState::Playing;
                if recording || playing {
                    api.prevent_close();
                    let _ = tauri::Emitter::emit(
                        window,
                        "app:close-requested",
                        serde_json::json!({ "recording": recording, "playing": playing }),
                    );
                }
            }
            // 主窗口销毁时一并关掉信号检测器；检测器窗口销毁时停止发送并清零
            tauri::WindowEvent::Destroyed => signal_checker_commands::on_window_destroyed(window),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            about_commands::app_info,
            host_core::commands::get_settings,
            host_core::commands::save_settings,
            host_core::commands::import_settings,
            host_core::commands::export_settings,
            host_core::commands::list_network_interfaces,
            host_core::commands::get_universe_snapshot,
            host_core::commands::set_viewed_universes,
            host_core::commands::dmx_stream_subscribe,
            host_core::commands::dmx_stream_unsubscribe,
            host_core::commands::get_source_stats,
            host_core::commands::get_devices,
            host_core::commands::scan_network,
            host_core::commands::clear_offline_devices,
            host_core::commands::set_device_name,
            host_core::commands::get_forwarding,
            host_core::commands::save_forwarding,
            app_mode_commands::app_mode_get,
            app_mode_commands::app_mode_set,
            app_mode_commands::app_quit,
            recording_commands::get_recording_dir,
            recording_commands::recording_disk_info,
            recording_commands::recording_check_dir,
            recording_commands::recording_open_dir,
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
            playback_commands::player_set_repeat,
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
            signal_checker_commands::signal_checker_open,
            signal_checker_commands::signal_checker_status,
            signal_checker_commands::signal_checker_validate,
            signal_checker_commands::signal_checker_configure,
            signal_checker_commands::signal_checker_start,
            signal_checker_commands::signal_checker_stop,
            signal_checker_commands::signal_checker_set_mode,
            signal_checker_commands::signal_checker_set_pattern,
            signal_checker_commands::signal_checker_set_speed,
            signal_checker_commands::signal_checker_set_channel,
            signal_checker_commands::signal_checker_set_all,
            signal_checker_commands::signal_checker_clear,
            signal_checker_commands::signal_checker_list_patterns,
            signal_checker_commands::signal_checker_set_preview,
            signal_checker_commands::signal_checker_frame,
            signal_checker_commands::signal_checker_targets,
            signal_checker_commands::signal_checker_context,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败")
        .run(|app, event| {
            // 兜底：任何途径触发的退出，只要录制还在进行就先收尾再退出，
            // 保证录制文件总是被完整保存（正常关闭窗口时前端已确认并走 `app_quit`）。
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let ctl = app.artnet_core().recording().clone();
                if ctl.is_recording() {
                    api.prevent_exit();
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let _ = ctl.stop();
                        handle.exit(0);
                    });
                }
            }
        });
}
