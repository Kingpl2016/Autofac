/** 回退用的自增序号（仅在运行环境没有 `crypto.randomUUID` 时使用）。 */
let fallbackCounter = 0;

/**
 * 生成工程内对象（灯具、分组、轨道、Cue 等）的唯一 id。
 *
 * @returns UUID 字符串；运行环境不支持 `crypto.randomUUID` 时回退为随机串加自增序号。
 */
export function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${fallbackCounter}`;
}
