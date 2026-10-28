import { invoke } from "@/shared/tauri/invoke";

/** 构建配置，与 Rust `BuildProfile` 一一对应（小写）。 */
export type BuildProfile = "debug" | "release";

/** 与 Rust `AppInfo` 对应的应用元信息（camelCase 一致）。 */
export interface AppInfo {
  /** 应用名称 */
  name: string;
  /** 应用版本号，如 `0.1.0` */
  version: string;
  /** 应用标识符，如 `com.artnetstudio.app` */
  identifier: string;
  /** 编译时链接的 Tauri 版本 */
  tauriVersion: string;
  /** 操作系统，如 `windows` */
  os: string;
  /** CPU 架构，如 `x86_64` */
  arch: string;
  /** 构建配置 */
  profile: BuildProfile;
}

/** 读取应用元信息。 */
export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/**
 * 在系统文件管理器里打开日志文件夹（不存在时先创建）。
 *
 * @returns 日志文件夹路径。
 */
export function revealLogs(): Promise<string> {
  return invoke<string>("logs_reveal");
}
