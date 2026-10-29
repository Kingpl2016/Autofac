import type { TFunction } from "i18next";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { getRecordingPreset, useRecordingPresetStore } from "../stores/useRecordingPresetStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import { recordingStart, recordingStop } from "./api";
import { buildStartArgs, hasIndexPlaceholder } from "./recordingPreset";
import {
  PLAYER_ERR_PLAYBACK_ACTIVE,
  PLAYER_ERR_SHOW_ACTIVE,
  REC_ERR_ALREADY,
  REC_ERR_DISK_LOW,
  REC_ERR_NOT_RECORDING,
  REC_ERR_NO_UNIVERSES,
} from "./types";

interface StartOptions {
  /** 仅本次有效的备注（顶栏 / 快捷键开始时为空） */
  notes?: string;
  /** 是否启用 sACN；缺省取录制运行时从设置同步到预设 store 的值 */
  sacnEnabled?: boolean;
}

/**
 * 按“当前录制预设”开始录制，并用 toast 反馈结果。
 *
 * 录制页按钮、顶栏录制按钮与全局快捷键共用这一份实现，三条路径录到的内容完全一致。
 * 成功后：模板含序号时序号加一；失败时序号不变。开始前清掉上一次的结果。
 *
 * @param t i18next 翻译函数。
 * @param opts 备注与协议开关。
 * @returns 成功开始返回 `true`；失败（已弹出错误提示）返回 `false`。
 */
export async function startRecording(t: TFunction, opts: StartOptions = {}): Promise<boolean> {
  const { preset, sacnEnabled } = getRecordingPreset();
  const args = buildStartArgs(preset, {
    now: new Date(),
    notes: opts.notes,
    sacnEnabled: opts.sacnEnabled ?? sacnEnabled,
  });
  useRecordingStore.getState().setLast(null);
  try {
    const res = await recordingStart(args);
    if (hasIndexPlaceholder(preset.nameTemplate)) {
      useRecordingPresetStore.getState().advanceIndex();
    }
    const n = res.plan.accepted.length;
    toast.success(
      args.name
        ? t("recording.startedNamed", { name: args.name, n })
        : t("recording.started", { n }),
    );
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
  const raw = errorMessage(e);
  if (raw === REC_ERR_NO_UNIVERSES) return t("recording.errNoUniverses");
  if (raw === REC_ERR_ALREADY) return t("recording.errAlready");
  if (raw === PLAYER_ERR_PLAYBACK_ACTIVE) return t("recording.errPlaybackActive");
  if (raw === PLAYER_ERR_SHOW_ACTIVE) return t("recording.errShowActive");
  if (raw === REC_ERR_NOT_RECORDING) return t("recording.errNotRecording");
  if (raw === REC_ERR_DISK_LOW) return t("recording.errDiskLow");
  return t(fallbackKey, { reason: raw });
}
