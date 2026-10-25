import type { TFunction } from "i18next";

import { EMPTY_FILTER, buildFileStem } from "./filter";
import {
  PLAYER_ERR_PLAYBACK_ACTIVE,
  REC_ERR_ALREADY,
  REC_ERR_NOT_RECORDING,
  REC_ERR_NO_UNIVERSES,
  type RecordingStartArgs,
} from "./types";

/**
 * 构造“快速录制”参数：不限制任何来源 / Universe / 协议，文件名用当前时间戳。
 *
 * 供全局热键等无界面上下文触发录制时使用（界面上的精细过滤仍走录制面板本地状态）。
 *
 * # Returns
 *
 * 一份全量采集的 [`RecordingStartArgs`]。
 */
export function quickRecordArgs(): RecordingStartArgs {
  return {
    name: "",
    notes: "",
    fileStem: buildFileStem(new Date(), ""),
    filter: { ...EMPTY_FILTER },
    universes: [],
  };
}

/**
 * 把录制 / 回放相关的后端错误码映射为本地化文案。
 *
 * # Arguments
 *
 * * `e` - 捕获到的异常。
 * * `t` - i18next 翻译函数。
 * * `fallbackKey` - 未命中已知错误码时使用的文案键（以 `{ reason }` 插值原始信息）。
 *
 * # Returns
 *
 * 可直接展示的本地化错误文案。
 */
export function describeRecordingError(
  e: unknown,
  t: TFunction,
  fallbackKey: string,
): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw === REC_ERR_NO_UNIVERSES) return t("recording.errNoUniverses");
  if (raw === REC_ERR_ALREADY) return t("recording.errAlready");
  if (raw === PLAYER_ERR_PLAYBACK_ACTIVE) return t("recording.errPlaybackActive");
  if (raw === REC_ERR_NOT_RECORDING) return t("recording.errNotRecording");
  return t(fallbackKey, { reason: raw });
}
