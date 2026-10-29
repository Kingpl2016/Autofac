import type { TFunction } from "i18next";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import i18n from "@/shared/i18n";
import {
  SHOW_ERR,
  showLocate,
  showPause,
  showPlay,
  showSeek,
  showSetOutputEnabled,
  showStop,
  type ShowState,
} from "../lib/playbackApi";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { flushProjectSync } from "./playbackSync";

/** 传输控制动作（工具条按钮、快捷键、Patch 面板共用）。失败以 toast 报告。 */

/**
 * 把播放 / 定位相关的后端错误转成用户能看懂的文案。
 *
 * @param t 翻译函数。
 * @param error 后端 reject 的值（错误码字符串或 `Error`）。
 * @returns 本地化文案；未知错误带上原始描述。
 */
export function playbackErrorText(t: TFunction, error: unknown): string {
  const raw = errorMessage(error);
  switch (raw) {
    case SHOW_ERR.noShow:
      return t("editor.playback.errors.noShow");
    case SHOW_ERR.emptyShow:
      return t("editor.playback.errors.emptyShow");
    case SHOW_ERR.unknownFixture:
      return t("editor.playback.errors.unknownFixture");
    case SHOW_ERR.recordingActive:
      return t("editor.playback.errors.recordingActive");
    case SHOW_ERR.playbackActive:
      return t("editor.playback.errors.playbackActive");
    case SHOW_ERR.showActive:
      return t("editor.playback.errors.showActive");
    case SHOW_ERR.badTarget:
      return t("editor.playback.errors.badTarget");
    default:
      return t("editor.playback.errors.generic", { reason: raw });
  }
}

/**
 * 报告一次播放相关的失败。
 *
 * @param error 后端 reject 的值。
 */
export function reportPlaybackError(error: unknown): void {
  const text = playbackErrorText(i18n.t.bind(i18n) as TFunction, error);
  // 同一条错误只保留一个提示（工程每次修改都会重新同步，目标不合法时会反复失败）
  toast.error(text, { id: `playback-error:${text}` });
}

/** 执行一个后端命令，失败时报告。 */
async function attempt(run: () => Promise<ShowState>): Promise<void> {
  try {
    usePlaybackStore.getState().setState(await run());
  } catch (e) {
    reportPlaybackError(e);
  }
}

/** 播放 / 暂停切换。播放前先等最新工程送达后端。 */
export async function togglePlay(): Promise<void> {
  const playing = usePlaybackStore.getState().state?.transport === "playing";
  if (playing) {
    await attempt(showPause);
    return;
  }
  await attempt(async () => {
    await flushProjectSync();
    return showPlay();
  });
}

/** 停止：位置回到 0，输出黑场。 */
export async function stopPlayback(): Promise<void> {
  await attempt(showStop);
}

/**
 * 跳转到指定位置，并同步播放头。
 *
 * @param ms 目标位置（毫秒）。
 */
export async function seekTo(ms: number): Promise<void> {
  useEditorUiStore.getState().setPlayhead(ms);
  await attempt(() => showSeek(ms));
}

/**
 * 打开 / 关闭“输出到网络”。失败（播放中打开、而录制 / 回放进行中）时以 toast 报告，开关保持关闭。
 *
 * @param enabled 是否向网络发送。
 */
export async function setOutputEnabled(enabled: boolean): Promise<void> {
  await attempt(() => showSetOutputEnabled(enabled));
}

/**
 * 开始 / 结束某台灯具的定位（再次点击同一台则结束）。
 *
 * @param fixtureId 灯具实例 id。
 */
export async function toggleLocate(fixtureId: string): Promise<void> {
  const current = usePlaybackStore.getState().state?.locate ?? null;
  await attempt(async () => {
    if (current === fixtureId) return showLocate(null);
    await flushProjectSync();
    return showLocate(fixtureId);
  });
}
