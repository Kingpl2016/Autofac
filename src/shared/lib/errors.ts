/**
 * 把任意抛出值转成可展示的文本。
 *
 * Tauri 命令的 `Err(String)` 会原样 reject 为字符串；结构化错误（`{ code, message }`）取 `message`；
 * 前端异常是 `Error`。
 *
 * @param e 捕获到的值。
 * @returns 文本。
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}
