import type { AppInfo } from "./api";

/**
 * 把 RFC 3339 时间转为本地日期文本；无法解析时返回 `null`（调用方据此隐藏该行）。
 *
 * @param iso 更新服务器返回的发布时间。
 * @param locale BCP 47 语言标签。
 */
export function formatPublishDate(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
}

/**
 * 生成可粘贴到问题反馈里的纯文本诊断信息。
 *
 * @param info 应用元信息。
 * @returns 多行文本：名称 + 版本 + 构建类型，随后是框架、系统与标识符。
 */
export function buildDiagnostics(info: AppInfo): string {
  return [
    `${info.name} ${info.version} (${info.profile})`,
    `Tauri ${info.tauriVersion}`,
    `OS: ${info.os} ${info.arch}`,
    `Identifier: ${info.identifier}`,
  ].join("\n");
}
