import type { TFunction } from "i18next";

import { errorMessage } from "@/shared/lib/errors";
import { MODE_ERR_BUSY, MODE_ERR_RECORDING_ACTIVE } from "./types";

/**
 * 把模式切换相关的后端错误码映射为本地化文案。
 *
 * @param e 捕获到的异常。
 * @param t i18next 翻译函数。
 * @returns 可直接展示的文案；未知错误原样带上原因。
 */
export function describeModeError(e: unknown, t: TFunction): string {
  const raw = errorMessage(e);
  if (raw === MODE_ERR_RECORDING_ACTIVE) return t("mode.errRecordingActive");
  if (raw === MODE_ERR_BUSY) return t("mode.errBusy");
  return t("mode.errGeneric", { reason: raw });
}
