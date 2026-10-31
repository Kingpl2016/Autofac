//! Art-Net Studio 的 Tauri 宿主入口。
//!
//! 装配窗口与插件。配置与实时子系统由 `host-core` 插件承载（配置/信号引擎/发现/转发/录制/回放），
//! 网络设备为 `netdev` 库 + 宿主侧薄命令（见 `netdev_commands` 模块）。
//! 宿主层只做装配与命令注册。

mod about_commands;
mod ai_commands;
mod cue_template_commands;
mod data_dir;
mod devtools_commands;
mod effect_commands;
mod app_mode_commands;
mod fixture_commands;
mod library_commands;
mod media_commands;
mod netdev_commands;
mod ofl_catalog_commands;
mod playback_commands;
mod recording_commands;
mod show_bake;
mod show_commands;
mod show_file_commands;
mod show_runtime;
mod signal_checker_commands;
mod mcp_commands;
mod skills_commands;

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

/// 构造向前端广播事件的 [`host_core::recording::Emitter`]：把 `AppHandle::emit` 封装成
/// 领域层使用的 `(事件名, JSON 载荷)` 回调。录制 / 回放 / 模式切换等命令共用，避免各处重复闭包。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 把事件广播到所有窗口的 [`host_core::recording::Emitter`]。
pub(crate) fn app_emitter(app: &tauri::AppHandle) -> host_core::recording::Emitter {
    let app = app.clone();
    std::sync::Arc::new(move |name, payload| {
        let _ = tauri::Emitter::emit(&app, name, payload);
    })
}

/// 启动 Tauri 应用主循环。
///
/// # Panics
///
/// 当 Tauri 运行时初始化失败时 panic（仅应用入口，不在库边界）。
pub fn run() {
    // 数据放在软件目录下的 `data`（确认有写权限；没有则退回系统应用数据目录），并迁移旧位置的设置。
    let data_root = data_dir::resolve();
    let log_dir = data_root.logs_dir();
    if data_root.fallback_used() {
        // 日志插件此时还没初始化，这条只会出现在标准错误；界面上由前端读取 `data_dir_info` 后提示用户
        eprintln!("软件目录没有写权限，数据保存在 {}", data_root.path().display());
    }
    let mut builder = tauri::Builder::default()
        .manage(data_root.clone())
        // 统一日志：stdout + 滚动文件（data/logs）+ webview。Rust 侧 `tracing` 事件经 `log`
        // 桥接特性转为 `log` 记录后也由本插件处理，前端经 attachLogger 汇入应用内日志面板。
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: log_dir,
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
        // 键值持久化：前端界面偏好（如外观 / 设备发现的筛选、排序）；前端用数据根目录下的绝对路径打开。
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(host_core::init_in(data_root.path().to_path_buf()));

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
            // 网络设备：多设备注册表（Token 存系统凭据管理器）与传输登记表。
            app.manage(netdev_commands::NetdevState::new(
                app.handle(),
                std::sync::Arc::new(netdev::KeyringStore),
            ));
            // 节目编辑器 AI 助手：厂商配置（data/ai-profiles.json）、Key（系统凭据管理器）、流式代理。
            app.manage(ai_commands::AiState::new(app.handle(), std::sync::Arc::new(ai_gateway::KeyringStore)));
            // AI 助手的用户技能（data/skills）与回收站（data/trash，30 天）。
            app.manage(skills_commands::SkillsState::new(app.handle()));
            // AI 助手的 MCP 客户端：服务器配置（data/mcp-servers.json）、密钥（系统凭据管理器）、按需连接。
            app.manage(mcp_commands::McpState::new(app.handle(), std::sync::Arc::new(ai_gateway::KeyringStore)));
            // 灯具素材库：内置模型 + 用户模型（app_data_dir/fixtures.json）。
            app.manage(fixture_commands::FixtureState::new(app.handle()));
            // OFL 整库目录（数据根目录/ofl-catalog.json，首次使用时读取）。
            app.manage(ofl_catalog_commands::OflCatalogState::new(app.handle()));
            // 节目预览引擎：30 FPS 灯光输出会话按需创建。
            app.manage(show_runtime::ShowRuntime::new());
            // 保存时的后台烘焙（.artrec）：串行调度。
            app.manage(show_bake::ShowBakeState::default());
            // 节目库编辑导出：按任务 id 登记的取消标志。
            app.manage(library_commands::EditJobs::default());
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
                    let emit = app_emitter(&handle);
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
        // 关闭窗口：录制、播放、编辑器输出灯光 / 有未保存修改 / 正在烘焙时先拦下，交给前端确认（见 `app_quit`）；否则直接关闭。
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let app = window.app_handle();
                let core = app.artnet_core();
                let recording = core.recording().is_recording();
                let playing =
                    core.playback().status().state == host_core::playback::PlaybackState::Playing;
                // 节目编辑器：正在输出灯光、工程有未保存的修改、后台正在生成回放文件，都需要用户确认
                let show_output = core.is_show_active();
                let show_unsaved = app.state::<show_runtime::ShowRuntime>().is_dirty();
                let baking = app.state::<show_bake::ShowBakeState>().is_busy();
                if recording || playing || show_output || show_unsaved || baking {
                    api.prevent_close();
                    let _ = tauri::Emitter::emit(
                        window,
                        "app:close-requested",
                        serde_json::json!({
                            "recording": recording,
                            "playing": playing,
                            "showOutput": show_output,
                            "showUnsaved": show_unsaved,
                            "baking": baking,
                        }),
                    );
                }
            }
            // 主窗口销毁时一并关掉信号检测器；检测器窗口销毁时停止发送并清零
            tauri::WindowEvent::Destroyed => signal_checker_commands::on_window_destroyed(window),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            data_dir::data_dir_info,
            about_commands::app_info,
            about_commands::logs_reveal,
            devtools_commands::devtools_state,
            devtools_commands::devtools_set,
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
            recording_commands::recording_activity,
            recording_commands::recording_take_recovered,
            recording_commands::recordings_list,
            recording_commands::recordings_rename,
            recording_commands::recordings_delete,
            library_commands::recordings_set_notes,
            library_commands::recordings_duplicate,
            library_commands::recordings_edit,
            library_commands::recordings_edit_cancel,
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
            show_commands::show_project_save,
            show_commands::show_project_open,
            show_commands::show_external_save,
            show_commands::show_external_read,
            show_commands::show_autosave_write,
            show_commands::show_autosave_read,
            show_commands::show_autosave_clear,
            show_file_commands::show_file_info,
            show_file_commands::show_reveal,
            show_file_commands::show_export_artrec,
            media_commands::media_probe,
            media_commands::media_authorize,
            media_commands::stage_image_authorize,
            media_commands::media_analyze_beats,
            media_commands::media_analyze,
            media_commands::media_cancel,
            media_commands::media_excerpt,
            media_commands::media_cache_get,
            media_commands::media_cache_put,
            skills_commands::skills_list,
            skills_commands::skills_read,
            skills_commands::skills_import,
            skills_commands::skills_export,
            skills_commands::skills_delete,
            skills_commands::skills_restore,
            skills_commands::skills_reveal,
            skills_commands::trash_list,
            skills_commands::trash_put_json,
            skills_commands::trash_take_json,
            skills_commands::trash_remove,
            mcp_commands::mcp_servers_list,
            mcp_commands::mcp_server_save,
            mcp_commands::mcp_server_approve,
            mcp_commands::mcp_server_delete,
            mcp_commands::mcp_server_restore,
            mcp_commands::mcp_connect,
            mcp_commands::mcp_disconnect,
            mcp_commands::mcp_status,
            mcp_commands::mcp_call_tool,
            media_commands::media_peaks,
            show_runtime::show_load,
            show_runtime::show_play,
            show_runtime::show_pause,
            show_runtime::show_stop,
            show_runtime::show_seek,
            show_runtime::show_locate,
            show_runtime::show_status,
            show_runtime::show_set_dirty,
            show_runtime::show_set_output_enabled,
            cue_template_commands::cue_templates_read,
            cue_template_commands::cue_templates_write,
            cue_template_commands::cue_templates_import,
            cue_template_commands::cue_templates_export,
            cue_template_commands::cue_templates_reveal,
            ai_commands::ai_profiles_list,
            ai_commands::ai_profile_save,
            ai_commands::ai_profile_delete,
            ai_commands::ai_key_set,
            ai_commands::ai_fetch,
            ai_commands::ai_fetch_cancel,
            ai_commands::ai_list_models,
            ai_commands::ai_history_read,
            ai_commands::ai_history_write,
            ai_commands::ai_history_library_path,
            effect_commands::effects_read,
            effect_commands::effects_write,
            effect_commands::effects_import,
            effect_commands::effects_export,
            effect_commands::effects_reveal,
            fixture_commands::fixture_list,
            fixture_commands::fixture_import_xlsx,
            fixture_commands::fixture_import_ofl,
            fixture_commands::fixture_save,
            fixture_commands::fixture_delete,
            ofl_catalog_commands::ofl_catalog_open,
            ofl_catalog_commands::ofl_catalog_summary,
            ofl_catalog_commands::ofl_catalog_search,
            ofl_catalog_commands::ofl_catalog_keys,
            ofl_catalog_commands::ofl_catalog_import,
            netdev_commands::netdev_list,
            netdev_commands::netdev_save,
            netdev_commands::netdev_remove,
            netdev_commands::netdev_set_token,
            netdev_commands::netdev_probe,
            netdev_commands::netdev_status,
            netdev_commands::netdev_set_workmode,
            netdev_commands::netdev_board_op,
            netdev_commands::netdev_program_op,
            netdev_commands::netdev_player,
            netdev_commands::netdev_seek,
            netdev_commands::netdev_speed,
            netdev_commands::netdev_get_config,
            netdev_commands::netdev_put_config,
            netdev_commands::netdev_diag,
            netdev_commands::netdev_logs,
            netdev_commands::netdev_list_files,
            netdev_commands::netdev_list_programs,
            netdev_commands::netdev_assign_programs,
            netdev_commands::netdev_delete_file,
            netdev_commands::netdev_rename_file,
            netdev_commands::netdev_upload_file,
            netdev_commands::netdev_download_file,
            netdev_commands::netdev_upload_recording,
            netdev_commands::netdev_cancel,
            netdev_commands::netdev_ota_status,
            netdev_commands::netdev_ota_confirm,
            netdev_commands::netdev_inspect_firmware,
            netdev_commands::netdev_ota_upload,
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
