import type { TFunction } from "i18next";
import { toast } from "sonner";

import { recordingStart, recordingStop } from "./api";
import { EMPTY_FILTER, buildFileStem } from "./filter";
import {
  PLAYER_ERR_PLAYBACK_ACTIVE,
  REC_ERR_ALREADY,
  REC_ERR_DISK_LOW,
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
 * 以“快速录制”（全量采集）开始录制，并用 toast 反馈结果。
 *
 * 顶栏录制按钮与全局快捷键共用这一份实现，保证两条路径的行为与文案完全一致。
 *
 * @param t i18next 翻译函数。
 * @returns 成功开始返回 `true`；失败（已弹出错误提示）返回 `false`。
 */
export async function startQuickRecording(t: TFunction): Promise<boolean> {
  try {
    const res = await recordingStart(quickRecordArgs());
    toast.success(t("recording.started", { n: res.plan.accepted.length }));
    return true;
  } catch (e: unknown) {
    toast.error(describeRecordingError(e, t, "recording.startFailed"));
    return false;
  }
}

/**
 * 停止录制，并用 toast 反馈结果（没有录到数据时给出警告）。
 *
 * @param t i18next 翻译函数。
 * @returns 成功停止返回 `true`；失败（已弹出错误提示）返回 `false`。
 */
export async function stopRecordingWithToast(t: TFunction): Promise<boolean> {
  try {
    const res = await recordingStop();
    const frames = res.files.reduce((n, f) => n + f.frames, 0);
    if (frames === 0) toast.warning(t("recording.noData"));
    else toast.success(t("recording.stopped", { n: res.files.length }));
    return true;
  } catch (e: unknown) {
    toast.error(describeRecordingError(e, t, "recording.stopFailed"));
    return false;
  }
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
  if (raw === REC_ERR_DISK_LOW) return t("recording.errDiskLow");
  return t(fallbackKey, { reason: raw });
}
