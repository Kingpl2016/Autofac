import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import {
  addEffectCue,
  copyCues,
  nudgeCues,
  pasteCues,
  pasteCuesToTracks,
  removeCues,
} from "../lib/cueOps";
import { addDefaultLook, type TemplateStyle } from "../lib/cueDefaults";
import { resolveTargetTracks } from "./useTargetCapabilities";
import type { EffectPreset } from "../lib/effectPresets";
import type { ShowProject, Track } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 时间线上对 Cue 的编辑动作（新建、删除、复制、粘贴、复制一份）。 */
export interface CueActions {
  /**
   * 在轨道上新建一个外观片段（按灯具类型给默认值，见 `addDefaultLook`）并选中它。
   *
   * @param trackId 目标轨道。
   * @param timeMs 起点（毫秒）。
   * @param style 可选的外观与长度。
   * @returns 新 Cue 的 id；放不下时为 `null`。
   */
  addAt: (trackId: string, timeMs: number, style?: TemplateStyle) => string | null;
  /**
   * 在轨道上新建一个特效 Cue 并选中它。
   *
   * @param trackId 目标轨道。
   * @param timeMs 起点（毫秒）。
   * @param preset 特效预设（参数、默认长度）。
   * @returns 新 Cue 的 id；放不下时为 `null`。
   */
  addEffectAt: (trackId: string, timeMs: number, preset: EffectPreset) => string | null;
  /**
   * 在多条轨道的同一时刻各新建一个片段（一步撤销），选中新片段；放不下的轨道跳过并汇总提示。
   *
   * @param trackIds 目标轨道（顺序即新片段的顺序）。
   * @param timeMs 起点（毫秒）。
   * @param style 可选的外观与长度。
   * @returns 新片段 id。
   */
  addAtTracks: (trackIds: readonly string[], timeMs: number, style?: TemplateStyle) => string[];
  /**
   * 在多条轨道上各新建一个片段（一步撤销），选中新片段；放不下的轨道跳过，多条轨道时汇总提示。
   *
   * @param trackIds 目标轨道。
   * @param make 在一条轨道上新建片段，返回 id（放不下时 `null`）。
   * @returns 新片段 id。
   */
  insertOnTracks: (trackIds: readonly string[], make: (draft: ShowProject, trackId: string) => string | null) => string[];
  /**
   * 素材库“点击添加”的目标轨道：多选了轨道时为全部选中的（可编辑的）轨道，否则为所选轨道，
   * 没有选中时为第一条可编辑的轨道。
   *
   * @param accept 过滤轨道（例如排除场景轨道）。
   * @returns 轨道 id；没有可用轨道时为空。
   */
  targetTracks: (accept?: (track: Track) => boolean) => string[];
  /** 删除当前选中的 Cue。 */
  removeSelected: () => void;
  /** 把当前选中的 Cue 复制到剪贴板。 */
  copySelected: () => void;
  /** 把剪贴板里的 Cue 粘贴到播放头处并选中。 */
  pasteAtPlayhead: () => void;
  /** 复制选中的 Cue，紧接着放在这组 Cue 的末尾之后，并选中新的。 */
  duplicateSelected: () => void;
  /**
   * 把选中的 Cue 整体平移（键盘微调）。
   *
   * @param deltaMs 平移量（毫秒，可为负）；越界或压住别的 Cue 时整体不动。
   */
  nudgeSelected: (deltaMs: number) => void;
}

/**
 * 时间线的 Cue 编辑动作。每个动作读取最新的工程与选择（不依赖渲染时的快照），
 * 一次动作对应一步撤销。
 *
 * @returns 稳定的动作集合。
 */
export function useCueActions(): CueActions {
  const { t } = useTranslation();
  return useMemo<CueActions>(() => {
    const ui = () => useEditorUiStore.getState();
    const project = () => useProjectStore.getState().project;
    const update = (recipe: Parameters<ReturnType<typeof useProjectStore.getState>["update"]>[0]) =>
      useProjectStore.getState().update(recipe);
    const insertOnTracks = (trackIds: readonly string[], make: (d: ShowProject, trackId: string) => string | null) => {
      const created: string[] = [];
      update((d) => {
        for (const trackId of trackIds) {
          const id = make(d, trackId);
          if (id) created.push(id);
        }
      });
      if (created.length > 0) ui().selectCues(created);
      const skipped = trackIds.length - created.length;
      if (trackIds.length > 1) {
        announce(
          skipped > 0
            ? t("editor.timeline.addedSkipped", { count: created.length, skipped })
            : t("editor.timeline.addedOnTracks", { count: created.length }),
        );
      }
      return created;
    };
    /** 选中的 Cue 里仍存在于工程的那些。 */
    const selectedIds = () => {
      const alive = new Set(project().cues.map((c) => c.id));
      return ui().selectedCueIds.filter((id) => alive.has(id));
    };

    return {
      addAt: (trackId, timeMs, style) => {
        let id: string | null = null;
        update((d) => {
          id = addDefaultLook(d, trackId, timeMs, style);
        });
        if (id) ui().selectCues([id]);
        return id;
      },
      addAtTracks: (trackIds, timeMs, style) => insertOnTracks(trackIds, (d, trackId) => addDefaultLook(d, trackId, timeMs, style)),
      insertOnTracks: (trackIds, make) => insertOnTracks(trackIds, make),
      targetTracks: (accept) => resolveTargetTracks(project(), ui(), accept),
      addEffectAt: (trackId, timeMs, preset) => {
        let id: string | null = null;
        update((d) => {
          id = addEffectCue(d, trackId, timeMs, preset);
        });
        if (id) ui().selectCues([id]);
        return id;
      },
      removeSelected: () => {
        const ids = selectedIds();
        if (ids.length === 0) return;
        let removed = 0;
        update((d) => {
          removed = removeCues(d, ids);
        });
        ui().selectCues([]);
        if (removed > 0) announce(t("editor.timeline.removedCues", { count: removed }));
      },
      copySelected: () => {
        const clip = copyCues(project(), selectedIds());
        if (clip.length === 0) return;
        ui().setClipboard(clip);
        announce(t("editor.timeline.copiedCues", { count: clip.length }));
      },
      pasteAtPlayhead: () => {
        const clip = ui().clipboard;
        if (clip.length === 0) return;
        // 多选了轨道时，单轨的剪贴板粘贴到每条选中的轨道
        const targets = ui().selectedTrackIds.length > 1 ? ui().selectedTrackIds : [];
        let created: string[] = [];
        update((d) => {
          created = pasteCuesToTracks(d, clip, ui().playheadMs, targets);
        });
        if (created.length > 0) {
          ui().selectCues(created);
          announce(t("editor.timeline.pastedCues", { count: created.length }));
        }
      },
      nudgeSelected: (deltaMs) => {
        const ids = selectedIds();
        if (ids.length === 0) return;
        update((d) => {
          nudgeCues(d, ids, deltaMs);
        });
      },
      duplicateSelected: () => {
        const ids = selectedIds();
        const clip = copyCues(project(), ids);
        if (clip.length === 0) return;
        const wanted = new Set(ids);
        const end = Math.max(...project().cues.filter((c) => wanted.has(c.id)).map((c) => c.endMs));
        let created: string[] = [];
        update((d) => {
          created = pasteCues(d, clip, end);
        });
        if (created.length > 0) {
          ui().selectCues(created);
          announce(t("editor.timeline.pastedCues", { count: created.length }));
        }
      },
    };
  }, [t]);
}
