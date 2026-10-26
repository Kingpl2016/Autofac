/** 日志级别（ESP-IDF 行首字母：E / W / I / D / V）。 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * 从 ESP-IDF 日志行首（如 `E (1234) tag: ...`）识别级别。
 *
 * # Arguments
 *
 * * `line` - 一行日志。
 *
 * # Returns
 *
 * 识别到的级别；没有标准前缀时为 `info`。
 */
export function lineLevel(line: string): LogLevel {
  // eslint-disable-next-line no-control-regex
  const m = /^(?:\x1b\[[0-9;]*m)?([EWIDV]) \(/.exec(line);
  switch (m?.[1]) {
    case "E":
      return "error";
    case "W":
      return "warn";
    case "D":
    case "V":
      return "debug";
    default:
      return "info";
  }
}

/** 去掉 ANSI 颜色转义序列。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 把日志文本拆成行并按关键字过滤（不区分大小写，空关键字不过滤）。
 *
 * # Arguments
 *
 * * `text` - 设备返回的日志文本。
 * * `keyword` - 过滤关键字。
 *
 * # Returns
 *
 * 保留的日志行（已去 ANSI、去掉空行）。
 */
export function filterLogLines(text: string, keyword: string): string[] {
  const k = keyword.trim().toLowerCase();
  return text
    .split(/\r?\n/)
    .map(stripAnsi)
    .filter((l) => l.trim() !== "" && (k === "" || l.toLowerCase().includes(k)));
}

/**
 * 是否已滚动到底部附近（用于决定新日志到来时是否自动跟随）。
 *
 * # Arguments
 *
 * * `scrollTop` - 当前滚动位置。
 * * `clientHeight` - 可视高度。
 * * `scrollHeight` - 内容总高度。
 * * `slack` - 容差像素。
 */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 24): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}
