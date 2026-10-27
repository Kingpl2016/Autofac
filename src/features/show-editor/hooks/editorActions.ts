import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { addMarker, setTempo } from "../lib/ops";
import { tapTempo } from "../lib/tempo";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 不依赖组件的编辑器全局动作（快捷键和工具条共用）。 */

/** 最近的敲击时刻，用于 Tap Tempo。 */
let taps: number[] = [];

/**
 * 清除 Tap Tempo 的敲击记录（测试和切换工程时使用）。
 */
export function resetTaps(): void {
  taps = [];
}

/**
 * 在播放头处添加一个标记点。
 *
 * @returns 新标记的 id；同一帧已有标记时为 `null`。
 */
export function addMarkerAtPlayhead(): string | null {
  const { playheadMs } = useEditorUiStore.getState();
  let id: string | null = null;
  useProjectStore.getState().update((d) => {
    id = addMarker(d, playheadMs, i18n.t("editor.markers.defaultName", { n: d.markers.length + 1 }));
  });
  announce(i18n.t(id ? "editor.markers.added" : "editor.markers.exists"));
  return id;
}

/**
 * 敲击一次节拍：用最近几次敲击的平均间隔更新 BPM（已有的偏移和拍号保持不变）。
 *
 * @param nowMs 敲击时刻（毫秒，单调时钟）。
 * @returns 更新后的 BPM；敲击次数不足时为 `null`。
 */
export function tapTempoNow(nowMs: number): number | null {
  taps = [...taps.slice(-15), nowMs];
  const bpm = tapTempo(taps);
  if (bpm === null) return null;
  useProjectStore.getState().update((d) => {
    setTempo(d, { bpm, offsetMs: d.tempo?.offsetMs ?? 0, beatsPerBar: d.tempo?.beatsPerBar ?? 4 });
  });
  announce(i18n.t("editor.tempo.tapped", { bpm }));
  return bpm;
}

/**
 * 把第一拍设在播放头处（对齐音乐的节拍）。没有节拍设置时按 120 BPM、4/4 新建。
 */
export function alignBeatToPlayhead(): void {
  const { playheadMs } = useEditorUiStore.getState();
  useProjectStore.getState().update((d) => {
    setTempo(d, { bpm: d.tempo?.bpm ?? 120, offsetMs: playheadMs, beatsPerBar: d.tempo?.beatsPerBar ?? 4 });
  });
}
