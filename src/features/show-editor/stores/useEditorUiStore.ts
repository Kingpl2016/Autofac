import { create } from "zustand";

import type { ClipCue } from "../lib/cueOps";
import { DEFAULT_PX_PER_SEC } from "../lib/zoom";

interface EditorUiState {
  /** 在 Patch 面板里勾选的灯具 */
  selectedFixtureIds: string[];
  /** 在 Patch 面板里选中的分组 */
  selectedGroupId: string | null;
  /** 在时间线上选中的 Cue */
  selectedCueIds: string[];
  /** 选中的轨道（点轨道头选中；模板“点击添加”会加到这条轨道） */
  selectedTrackId: string | null;
  /** 播放头位置（毫秒）；播放引擎接入后由后端状态驱动 */
  playheadMs: number;
  /** 剪贴板里复制的 Cue */
  clipboard: ClipCue[];
  /** 右侧属性区当前的标签页 */
  inspectorTab: "patch" | "cue";
  /** 时间线缩放：每秒像素数 */
  pxPerSec: number;
  /** 是否吸附（网格 / 其他 Cue 边缘 / 标记点 / 播放头 / 节拍） */
  snapEnabled: boolean;
  /** 音视频素材是否静音（只影响本机监听，不进工程） */
  mediaMuted: boolean;
  /**
   * 勾选 / 取消勾选一个灯具。
   *
   * @param id 灯具 id。
   * @param on `true` 勾选，`false` 取消。
   */
  setFixtureSelected: (id: string, on: boolean) => void;
  /**
   * 整体替换勾选的灯具。
   *
   * @param ids 灯具 id 列表。
   */
  setSelectedFixtures: (ids: string[]) => void;
  /**
   * 选中一个分组（`null` 取消）。
   *
   * @param id 分组 id。
   */
  selectGroup: (id: string | null) => void;
  /**
   * 整体替换选中的 Cue。
   *
   * @param ids Cue id 列表。
   */
  selectCues: (ids: string[]) => void;
  /**
   * 切换一个 Cue 的选中状态（Ctrl / Shift 点击用）。
   *
   * @param id Cue id。
   */
  toggleCue: (id: string) => void;
  /**
   * 选中一条轨道（`null` 取消）。
   *
   * @param id 轨道 id。
   */
  selectTrack: (id: string | null) => void;
  /**
   * 设置播放头位置。
   *
   * @param ms 毫秒，负数按 0 处理。
   */
  setPlayhead: (ms: number) => void;
  /**
   * 设置剪贴板内容。
   *
   * @param clip 复制得到的 Cue 列表。
   */
  setClipboard: (clip: ClipCue[]) => void;
  /**
   * 切换右侧属性区的标签页。
   *
   * @param tab 标签页。
   */
  setInspectorTab: (tab: "patch" | "cue") => void;
  /**
   * 设置时间线缩放。
   *
   * @param px 每秒像素数。
   */
  setPxPerSec: (px: number) => void;
  /** 切换吸附开关。 */
  toggleSnap: () => void;
  /** 切换素材静音。 */
  toggleMuted: () => void;
  /** 清空全部选择（不影响播放头和剪贴板）。 */
  clearSelection: () => void;
}

/**
 * 编辑器界面状态（选择、播放头、剪贴板等）。不进入撤销历史，也不随工程保存。
 *
 * 选中的 id 可能指向已被删除的对象，使用方需要对照工程过滤。
 */
export const useEditorUiStore = create<EditorUiState>((set) => ({
  selectedFixtureIds: [],
  selectedGroupId: null,
  selectedCueIds: [],
  selectedTrackId: null,
  playheadMs: 0,
  clipboard: [],
  inspectorTab: "patch",
  pxPerSec: DEFAULT_PX_PER_SEC,
  snapEnabled: true,
  mediaMuted: false,
  setFixtureSelected: (id, on) =>
    set((s) => ({
      selectedFixtureIds: on
        ? s.selectedFixtureIds.includes(id)
          ? s.selectedFixtureIds
          : [...s.selectedFixtureIds, id]
        : s.selectedFixtureIds.filter((x) => x !== id),
    })),
  setSelectedFixtures: (ids) => set({ selectedFixtureIds: ids }),
  selectGroup: (id) => set({ selectedGroupId: id }),
  selectCues: (ids) => set({ selectedCueIds: ids }),
  toggleCue: (id) =>
    set((s) => ({
      selectedCueIds: s.selectedCueIds.includes(id)
        ? s.selectedCueIds.filter((x) => x !== id)
        : [...s.selectedCueIds, id],
    })),
  selectTrack: (id) => set({ selectedTrackId: id }),
  setPlayhead: (ms) => set({ playheadMs: Math.max(0, Math.round(ms)) }),
  setClipboard: (clip) => set({ clipboard: clip }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setPxPerSec: (px) => set({ pxPerSec: px }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  toggleMuted: () => set((s) => ({ mediaMuted: !s.mediaMuted })),
  clearSelection: () =>
    set({ selectedFixtureIds: [], selectedGroupId: null, selectedCueIds: [], selectedTrackId: null }),
}));
