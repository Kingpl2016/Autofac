import type { TFunction } from "i18next";

import { errorMessage } from "@/shared/lib/errors";
import type { ConfigError, ManualError, SenderError, SignalProtocol } from "./types";

const CONFIG_CODES = new Set<ConfigError["code"]>([
  "invalidIp",
  "invalidPort",
  "emptyRange",
  "invalidRange",
  "outOfRange",
  "tooMany",
]);

/** 后端命令的错误是序列化后的普通对象（带 `code`），不是 `Error`。 */
function codeOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null || !("code" in e)) return null;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 是否为配置校验错误。 */
export function isConfigError(e: unknown): e is ConfigError {
  const code = codeOf(e);
  return code !== null && CONFIG_CODES.has(code as ConfigError["code"]);
}

/** 是否为发送器（套接字）错误。 */
export function isSenderError(e: unknown): e is SenderError {
  return codeOf(e) === "socket";
}

/** 是否为手动数据错误。 */
export function isManualError(e: unknown): e is ManualError {
  return codeOf(e) === "channelOutOfRange";
}

/** 协议的显示名。 */
export function protocolLabel(protocol: SignalProtocol): string {
  return protocol === "artNet" ? "Art-Net" : "sACN";
}

/**
 * 把配置校验错误说成用户能照着改的话。
 *
 * # Arguments
 *
 * * `e` - 后端返回的校验错误。
 * * `t` - i18next 翻译函数。
 * * `protocol` - 当前协议（用于"超出范围"的提示）。
 */
export function describeConfigError(e: ConfigError, t: TFunction, protocol: SignalProtocol): string {
  switch (e.code) {
    case "invalidIp":
      return t("signalChecker.errInvalidIp", { value: e.value });
    case "invalidPort":
      return t("signalChecker.errInvalidPort");
    case "emptyRange":
      return t("signalChecker.errEmptyRange");
    case "invalidRange":
      return t("signalChecker.errInvalidRange", { fragment: e.fragment });
    case "outOfRange":
      return t("signalChecker.errOutOfRange", {
        universe: e.universe,
        min: e.min,
        max: e.max,
        protocol: protocolLabel(protocol),
      });
    case "tooMany":
      return t("signalChecker.errTooMany", { count: e.count, max: e.max });
  }
}

/**
 * 把任意异常说成一句话：已知的后端错误码走本地化文案，其余取原始信息。
 *
 * # Arguments
 *
 * * `e` - 捕获到的异常。
 * * `t` - i18next 翻译函数。
 * * `protocol` - 当前协议。
 */
export function describeError(e: unknown, t: TFunction, protocol: SignalProtocol): string {
  if (isConfigError(e)) return describeConfigError(e, t, protocol);
  if (isSenderError(e)) return t("signalChecker.errSocket", { message: e.message });
  if (isManualError(e)) return t("signalChecker.errChannel", { channel: e.channel });
  return errorMessage(e);
}
