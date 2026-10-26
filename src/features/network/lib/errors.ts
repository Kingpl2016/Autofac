import type { TFunction } from "i18next";

/** 后端返回的错误载荷（Rust `ErrorPayload`）。 */
export interface NetError {
  /** 稳定错误码，见 Rust `NetdevError::code`。 */
  code: string;
  /** 后端给出的中文描述（兜底展示）。 */
  message: string;
}

/** 有对应国际化文案的错误码。 */
const KNOWN_CODES = new Set([
  "unauthorized",
  "invalid_arg",
  "not_found",
  "busy",
  "wrong_mode",
  "bad_file",
  "not_supported",
  "not_ready",
  "no_space",
  "device_io",
  "http",
  "timeout",
  "network",
  "cancelled",
  "unknown_device",
  "secret",
  "bad_response",
  "version_mismatch",
  "boot_timeout",
]);

/**
 * 把任意抛出值规整为 [`NetError`]。
 *
 * Tauri 命令的 `Err({code,message})` 会原样 reject 为对象；演示模式与旧代码路径可能抛字符串或 `Error`。
 *
 * # Arguments
 *
 * * `e` - 捕获到的值。
 *
 * # Returns
 *
 * 一定带 `code` 与 `message` 的错误。
 */
export function toNetError(e: unknown): NetError {
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (typeof o.code === "string" && typeof o.message === "string") {
      return { code: o.code, message: o.message };
    }
    if (e instanceof Error) return { code: "unknown", message: e.message };
  }
  return { code: "unknown", message: typeof e === "string" ? e : String(e) };
}

/** 是否为用户主动取消。 */
export function isCancelled(e: unknown): boolean {
  return toNetError(e).code === "cancelled";
}

/** 是否需要用户提供 / 更正 Token。 */
export function isUnauthorized(e: unknown): boolean {
  return toNetError(e).code === "unauthorized";
}

/**
 * 取错误的面向用户文案：已知错误码走国际化；本地校验类（`invalid` / `local_io`）与未知错误直接显示后端描述。
 *
 * # Arguments
 *
 * * `t` - 翻译函数。
 * * `e` - 捕获到的值。
 *
 * # Returns
 *
 * 可直接展示的文案。
 */
export function errorText(t: TFunction, e: unknown): string {
  const err = toNetError(e);
  if (KNOWN_CODES.has(err.code)) return t(`network.errors.${err.code}`);
  return err.message;
}
