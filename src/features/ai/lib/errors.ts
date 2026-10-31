import type { TFunction } from "i18next";

/** 规整后的 AI 错误。 */
export interface AiError {
  /** 稳定错误码：后端 `AiError::code`，或前端补充的 `http` / `no_object` / `aborted` / `unknown`。 */
  code: string;
  /** 兜底展示的描述。 */
  message: string;
  /** 模型接口返回的 HTTP 状态（`http` 时有）。 */
  status?: number;
}

/** 有对应国际化文案的错误码。 */
const KNOWN_CODES = new Set([
  "invalid_profile",
  "unknown_profile",
  "url_not_allowed",
  "insecure_url",
  "bad_request",
  "network",
  "timeout",
  "cancelled",
  "aborted",
  "response_too_large",
  "secret",
  "io",
  "file_too_large",
  "invalid_json",
  "bad_path",
  "no_object",
  "no_profile",
  "unauthorized",
  "http_status",
  "bad_response",
]);

/**
 * 把任意抛出值规整为 {@link AiError}。
 *
 * 能识别三类来源：后端命令的 `{ code, message }`、AI SDK 的错误（按 `name` / `statusCode` 鸭子类型判断，
 * 不在这里引入 SDK）、浏览器的 `AbortError`。
 *
 * @param e 捕获到的值。
 * @returns 一定带 `code` 与 `message` 的错误。
 */
export function toAiError(e: unknown): AiError {
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (o.name === "AbortError") return { code: "aborted", message: String(o.message ?? "") };
    if (typeof o.code === "string" && typeof o.message === "string") return { code: o.code, message: o.message };
    if (typeof o.statusCode === "number") {
      return { code: "http", status: o.statusCode, message: String(o.message ?? "") };
    }
    if (typeof o.name === "string" && /NoObjectGenerated|TypeValidation|JSONParse/.test(o.name)) {
      return { code: "no_object", message: String(o.message ?? "") };
    }
    // SDK 把底层错误放在 `cause` 里（例如代理返回的错误码）
    if (o.cause !== undefined && o.cause !== e) {
      const inner = toAiError(o.cause);
      if (inner.code !== "unknown") return inner;
    }
    if (e instanceof Error) return { code: "unknown", message: e.message };
  }
  return { code: "unknown", message: typeof e === "string" ? e : String(e) };
}

/**
 * 是否为用户主动中止（取消请求 / 停止生成）。
 *
 * @param e 捕获到的值。
 * @returns 中止时为 `true`。
 */
export function isAiAbort(e: unknown): boolean {
  const code = toAiError(e).code;
  return code === "aborted" || code === "cancelled";
}

/** 接口说不认识的内容类型（例如 `unknown variant \`input_audio\``）。 */
const UNKNOWN_VARIANT = /unknown variant [`'"]?(input_audio|audio|image_url|image)[`'"]?/i;
/** 接口说不支持音频 / 图片输入的其它常见写法。 */
const NO_AUDIO = /(input_audio|audio input|audio content|audio).{0,40}(not supported|unsupported|not allowed|is not valid|invalid)|(does not|doesn't|cannot|can't) (support|accept|process) (audio|input_audio)/i;
const NO_IMAGE = /(image_url|image input|image content|images?).{0,40}(not supported|unsupported|not allowed)|(does not|doesn't|cannot|can't) (support|accept|process) (images?|image_url|vision)/i;

/**
 * 模型服务因为不接受音频 / 图片输入而拒绝了请求（配置里勾选了“模型还能看 / 听”，但模型其实不支持）。
 *
 * @param e 捕获到的值。
 * @returns 不接受的输入；不是这类错误时为 `null`。
 */
export function unsupportedInput(e: unknown): "audio" | "image" | null {
  const err = toAiError(e);
  if (err.code !== "http" && err.code !== "bad_request" && err.code !== "unknown") return null;
  const variant = UNKNOWN_VARIANT.exec(err.message);
  if (variant) return /audio/i.test(variant[1]) ? "audio" : "image";
  if (NO_AUDIO.test(err.message)) return "audio";
  if (NO_IMAGE.test(err.message)) return "image";
  return null;
}

/**
 * 取错误的面向用户文案：已知错误码走国际化，HTTP 错误带上状态码与接口给出的说明，其它显示原始描述。
 *
 * @param t 翻译函数。
 * @param e 捕获到的值。
 * @returns 可直接展示的文案。
 */
export function aiErrorText(t: TFunction, e: unknown): string {
  const err = toAiError(e);
  const input = unsupportedInput(e);
  if (input) return t(`ai.errors.unsupported_${input}`, { status: err.status ?? "" });
  if (err.code === "http") return t("ai.errors.http", { status: err.status, message: err.message });
  if (KNOWN_CODES.has(err.code)) return t(`ai.errors.${err.code}`);
  return err.message || t("common.unknownError");
}
