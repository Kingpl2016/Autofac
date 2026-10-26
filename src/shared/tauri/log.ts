import {
  info,
  warn,
  error,
  debug,
  attachLogger as pluginAttachLogger,
  LogLevel,
} from "@tauri-apps/plugin-log";

import { getDemoBackend } from "./demoBridge";

export { LogLevel };

/**
 * 订阅 tauri-plugin-log 的日志记录。
 *
 * 演示模式下日志面板的内容由演示数据提供，这里不再接入真实后端日志，避免两者混在一起。
 *
 * # Arguments
 *
 * * `fn` - 每条日志的回调。
 *
 * # Returns
 *
 * 取消订阅函数的 Promise。
 */
export function attachLogger(
  fn: Parameters<typeof pluginAttachLogger>[0],
): ReturnType<typeof pluginAttachLogger> {
  if (getDemoBackend()) return Promise.resolve(() => {});
  return pluginAttachLogger(fn);
}

/** 把任意异常规整为文本。 */
function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * 记录一条 info 级日志（经 tauri-plugin-log 落盘 / 推送 webview）。
 *
 * # Arguments
 *
 * * `message` - 日志文本。
 */
export function logInfo(message: string): Promise<void> {
  return info(message);
}

/**
 * 记录一条 warn 级日志。
 *
 * # Arguments
 *
 * * `message` - 日志文本。
 */
export function logWarn(message: string): Promise<void> {
  return warn(message);
}

/**
 * 记录一条 error 级日志，可附带异常对象（自动拼接其栈 / 文本）。
 *
 * # Arguments
 *
 * * `message` - 日志文本。
 * * `err` - 可选异常对象。
 */
export function logError(message: string, err?: unknown): Promise<void> {
  return error(err === undefined ? message : `${message}: ${errText(err)}`);
}

/**
 * 记录一条 debug 级日志。
 *
 * # Arguments
 *
 * * `message` - 日志文本。
 */
export function logDebug(message: string): Promise<void> {
  return debug(message);
}
