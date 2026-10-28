import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import type { ContextActionId } from "../lib/contextMenus";
import { convertToLook } from "../lib/cueOps";
import { setCueTag } from "../lib/editOps";
import {
  DEFAULT_SYNC_FIELDS,
  fixturesOfTracks,
  groupFixtures,
  sameModelIds,
  syncFixtures,
  tracksOfFixtures,
} from "../lib/fixtureBatch";
import { removeMediaTrack, setMediaClip, setMediaTrack } from "../lib/mediaClips";
import { addMarker, setLoopEdge, setTrackFlag, setTrackView, TRACK_HEIGHT_ORDER } from "../lib/ops";
import { createPreset } from "../lib/presetOps";
import type { CueTag } from "../lib/project";
import { addSection } from "../lib/sections";
import { removeTracks } from "../lib/trackOps";
import { useEditorUiStore, type ContextTarget } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { requestShowDuration } from "./editorActions";
import { seekTo } from "./transportActions";
import { useCueActions } from "./useCueActions";

/** 右键菜单动作的执行器。 */
export interface ContextActions {
  /**
   * 执行一个与点击位置相关的动作。
   *
   * @param id 动作。
   * @param target 菜单目标。
   */
  run: (id: ContextActionId, target: ContextTarget) => void;
  /**
   * 给选中的片段设置 / 清除颜色标签。
   *
   * @param tag 标签；`null` 清除。
   */
  tag: (tag: CueTag | null) => void;
}

/**
 * 右键菜单动作：读取最新的工程与选择执行，一次动作一步撤销。
 *
 * @returns 执行器。
 */
export function useContextActions(): ContextActions {
  const { t } = useTranslation();
  const actions = useCueActions();

  const run = useCallback(
    (id: ContextActionId, target: ContextTarget) => {
      const ui = useEditorUiStore.getState();
      const { project, update } = useProjectStore.getState();
      const timeOf = () => ("timeMs" in target ? target.timeMs : ui.playheadMs);
      /** 轨道类动作作用的轨道：右键的轨道在多选里时作用于全部选中的轨道。 */
      const tracksOf = (trackId: string) =>
        ui.selectedTrackIds.includes(trackId) && ui.selectedTrackIds.length > 1 ? ui.selectedTrackIds : [trackId];
      const trackIdOf = (): string | null => {
        if (target.kind === "track") return target.id;
        if (target.kind === "empty") return target.trackId;
        if (target.kind === "cue") return project.cues.find((c) => c.id === target.id)?.trackId ?? null;
        return null;
      };

      switch (id) {
        case "addCueHere": {
          const trackId = trackIdOf();
          if (!trackId) return;
          actions.addAtTracks(target.kind === "track" ? tracksOf(trackId) : [trackId], timeOf());
          if (target.kind !== "track") ui.setInspectorTab("cue");
          return;
        }
        case "pasteHere":
          if (target.kind === "empty") ui.setPlayhead(target.timeMs);
          actions.pasteAtPlayhead();
          return;
        case "markerHere": {
          let created: string | null = null;
          update((d) => {
            created = addMarker(d, timeOf(), t("editor.markers.defaultName", { n: d.markers.length + 1 }));
          });
          announce(t(created ? "editor.markers.added" : "editor.markers.exists"));
          return;
        }
        case "sectionHere": {
          const tempo = project.tempo;
          const length = tempo ? (60_000 / tempo.bpm) * tempo.beatsPerBar * 8 : 8000;
          let created: string | null = null;
          update((d) => {
            created = addSection(d, timeOf(), length, t("editor.sections.defaultName", { n: d.sections.length + 1 }));
          });
          announce(t(created ? "editor.sections.added" : "editor.sections.noRoom"));
          return;
        }
        case "playheadHere":
          void seekTo(timeOf());
          return;
        case "loopIn":
        case "loopOut":
          update((d) => setLoopEdge(d, id === "loopIn" ? "in" : "out", timeOf()));
          return;
        case "endHere":
          requestShowDuration(timeOf());
          return;
        case "convertToLook": {
          let n = 0;
          update((d) => {
            n = convertToLook(d, ui.selectedCueIds);
          });
          if (n > 0) announce(t("editor.context.converted", { count: n }));
          return;
        }
        case "saveAsPreset": {
          if (target.kind !== "cue") return;
          const cue = project.cues.find((c) => c.id === target.id);
          if (cue?.kind !== "look") return;
          update((d) => {
            const name = t("editor.context.presetName", { n: d.presets.length + 1 });
            createPreset(d, name, cue.look, name);
          });
          announce(t("editor.context.presetSaved"));
          return;
        }
        case "selectTrackCues": {
          const trackId = trackIdOf();
          if (!trackId) return;
          const tracks = new Set(target.kind === "track" ? tracksOf(trackId) : [trackId]);
          ui.selectCues(project.cues.filter((c) => tracks.has(c.trackId)).map((c) => c.id));
          return;
        }
        case "toggleMute":
        case "toggleSolo":
        case "toggleLock": {
          if (target.kind !== "track") return;
          const flag = id === "toggleMute" ? "mute" : id === "toggleSolo" ? "solo" : "lock";
          const value = !project.tracks.find((tr) => tr.id === target.id)?.[flag];
          update((d) => {
            for (const trackId of tracksOf(target.id)) setTrackFlag(d, trackId, flag, value);
          });
          return;
        }
        case "toggleCollapse": {
          if (target.kind !== "track") return;
          const collapsed = !project.tracks.find((tr) => tr.id === target.id)?.collapsed;
          update((d) => {
            for (const trackId of tracksOf(target.id)) setTrackView(d, trackId, { collapsed });
          });
          return;
        }
        case "cycleHeight": {
          if (target.kind !== "track") return;
          const current = project.tracks.find((tr) => tr.id === target.id)?.height ?? "normal";
          const next = TRACK_HEIGHT_ORDER[(TRACK_HEIGHT_ORDER.indexOf(current) + 1) % TRACK_HEIGHT_ORDER.length];
          update((d) => {
            for (const trackId of tracksOf(target.id)) setTrackView(d, trackId, { height: next });
          });
          return;
        }
        case "selectSameModel": {
          if (target.kind !== "track") return;
          const fixtures = sameModelIds(project, fixturesOfTracks(project, tracksOf(target.id)));
          ui.selectTracks(tracksOfFixtures(project, fixtures), target.id);
          ui.setSelectedFixtures(fixtures);
          announce(t("editor.batch.selectedSame", { count: fixtures.length }));
          return;
        }
        case "groupTracks": {
          if (target.kind !== "track") return;
          const fixtures = fixturesOfTracks(project, tracksOf(target.id));
          let created: string | null = null;
          update((d) => {
            created = groupFixtures(d, t("editor.patch.defaultGroupName", { n: d.groups.length + 1 }), fixtures);
          });
          if (created) announce(t("editor.patch.grouped", { count: fixtures.length }));
          return;
        }
        case "syncTracks": {
          if (target.kind !== "track") return;
          // 以 Patch 顺序的第一台为准，同步默认的几项（模式 / 高度 / 朝向 / 倒装）
          const picked = new Set(fixturesOfTracks(project, tracksOf(target.id)));
          const fixtures = project.fixtures.filter((f) => picked.has(f.id)).map((f) => f.id);
          let r = { changed: 0, modeSkipped: 0 };
          update((d) => {
            r = syncFixtures(d, fixtures[0], fixtures, DEFAULT_SYNC_FIELDS);
          });
          announce(
            r.modeSkipped > 0
              ? t("editor.batch.syncedSkipped", { count: r.changed, skipped: r.modeSkipped })
              : t("editor.batch.synced", { count: r.changed }),
          );
          return;
        }
        case "deleteTracks":
        case "deleteGroupWithMembers": {
          if (target.kind !== "track") return;
          const ids = id === "deleteTracks" ? tracksOf(target.id) : [target.id];
          let r = { fixtures: 0, groups: 0, tracks: 0, cues: 0 };
          update((d) => {
            r = removeTracks(d, ids, id === "deleteGroupWithMembers");
          });
          ui.selectTracks([], null);
          ui.selectCues([]);
          announce(t("editor.context.deleted", { fixtures: r.fixtures, tracks: r.tracks, cues: r.cues }));
          return;
        }
        case "toggleClipMute": {
          if (target.kind !== "mediaClip") return;
          const muted = !project.mediaClips.find((c) => c.id === target.id)?.muted;
          const ids = ui.selectedMediaClipIds.includes(target.id) ? ui.selectedMediaClipIds : [target.id];
          update((d) => setMediaClip(d, ids, { muted }));
          return;
        }
        case "pixelMap":
          if (target.kind !== "mediaClip") return;
          ui.selectMediaClips([target.id]);
          ui.setInspectorTab("cue");
          return;
        case "toggleMediaMute":
        case "toggleMediaSolo":
        case "toggleMediaLock": {
          if (target.kind !== "mediaTrack") return;
          const flag = id === "toggleMediaMute" ? "mute" : id === "toggleMediaSolo" ? "solo" : "lock";
          const value = !project.mediaTracks.find((tr) => tr.id === target.id)?.[flag];
          update((d) => setMediaTrack(d, target.id, { [flag]: value }));
          return;
        }
        case "deleteMediaTrack":
          if (target.kind !== "mediaTrack") return;
          update((d) => removeMediaTrack(d, target.id));
          return;
      }
    },
    [actions, t],
  );

  const tag = useCallback((value: CueTag | null) => {
    const ids = useEditorUiStore.getState().selectedCueIds;
    useProjectStore.getState().update((d) => void setCueTag(d, ids, value));
  }, []);

  return { run, tag };
}
