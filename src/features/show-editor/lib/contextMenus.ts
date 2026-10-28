import type { ContextTarget } from "../stores/useEditorUiStore";
import { fixturesOfTracks } from "./fixtureBatch";
import { templateFromCue } from "./templateOps";
import type { ShowProject } from "./project";

/**
 * 时间线右键菜单的内容（纯函数，按点击位置生成）：片段、媒体片段、轨道头、媒体轨道头、轨道区空白处、标尺。
 *
 * 能用命令表表达的项直接引用命令 id（标题、快捷键提示、可用状态都来自命令表，与快捷键 / 命令面板一致）；
 * 依赖点击位置的项（“在这里新建”“结尾设在这里”…）是动作，由 `useContextActions` 执行。
 */

/** 与点击位置相关的动作。 */
export type ContextActionId =
  | "addCueHere"
  | "pasteHere"
  | "markerHere"
  | "sectionHere"
  | "playheadHere"
  | "loopIn"
  | "loopOut"
  | "endHere"
  | "convertToLook"
  | "saveAsPreset"
  | "saveAsTemplate"
  | "selectTrackCues"
  | "toggleMute"
  | "toggleSolo"
  | "toggleLock"
  | "toggleCollapse"
  | "cycleHeight"
  | "selectSameModel"
  | "groupTracks"
  | "syncTracks"
  | "deleteTracks"
  | "deleteGroupWithMembers"
  | "toggleClipMute"
  | "pixelMap"
  | "toggleMediaMute"
  | "toggleMediaSolo"
  | "toggleMediaLock"
  | "deleteMediaTrack"
  | "deleteMarker"
  | "renameObject"
  | "markerToPlayhead"
  | "sectionFromMarker"
  | "deleteSection"
  | "loopSection"
  | "selectSectionCues"
  | "clearLoop"
  | "playLoop"
  | "loopToSection"
  | "deleteKey"
  | "clearKeys"
  | "playheadToKey"
  | "clearTempo";

/** 菜单里的一项。 */
export type MenuEntry =
  | { kind: "command"; id: string }
  | {
      kind: "action";
      id: ContextActionId;
      labelKey: string;
      labelArgs?: Record<string, string | number>;
      disabled?: boolean;
      /** 开关类：当前状态 */
      checked?: boolean;
      destructive?: boolean;
    }
  | { kind: "separator" }
  /** 颜色标签子菜单（作用于选中的片段） */
  | { kind: "tags" }
  /** 段落颜色子菜单 */
  | { kind: "sectionColors" };

/** 生成菜单需要的界面状态。 */
export interface MenuContext {
  selectedTrackIds: readonly string[];
  /** 剪贴板里有片段 */
  hasClipboard: boolean;
}

const sep: MenuEntry = { kind: "separator" };
const cmd = (id: string): MenuEntry => ({ kind: "command", id });
const act = (id: ContextActionId, labelKey: string, extra: Partial<Extract<MenuEntry, { kind: "action" }>> = {}): MenuEntry => ({
  kind: "action",
  id,
  labelKey: `editor.context.${labelKey}`,
  ...extra,
});

/**
 * 右键菜单的内容。
 *
 * @param target 点击的目标。
 * @param project 工程（只读）。
 * @param ctx 界面状态。
 * @returns 菜单项（含分隔线；目标已不存在时为空）。
 */
export function buildContextMenu(target: ContextTarget, project: ShowProject, ctx: MenuContext): MenuEntry[] {
  switch (target.kind) {
    case "cue": {
      const cue = project.cues.find((c) => c.id === target.id);
      if (!cue) return [];
      return [
        cmd("edit.cut"),
        cmd("edit.copy"),
        cmd("edit.paste"),
        cmd("edit.duplicate"),
        sep,
        cmd("timeline.split"),
        cmd("timeline.trimStart"),
        cmd("timeline.trimEnd"),
        cmd("edit.toggleDisabled"),
        { kind: "tags" },
        sep,
        ...(cue.kind === "static" ? [act("convertToLook", "convertToLook")] : []),
        ...(cue.kind === "look" ? [act("saveAsPreset", "saveAsPreset")] : []),
        ...(cue.kind === "look" || cue.kind === "static"
          ? [act("saveAsTemplate", "saveAsTemplate", { disabled: templateFromCue(cue) === null })]
          : []),
        cmd("select.after"),
        act("selectTrackCues", "selectTrackCues"),
        sep,
        cmd("edit.delete"),
        cmd("edit.rippleDelete"),
      ];
    }
    case "mediaClip": {
      const clip = project.mediaClips.find((c) => c.id === target.id);
      if (!clip) return [];
      const video = project.media.find((m) => m.id === clip.mediaId)?.kind === "video";
      return [
        cmd("timeline.split"),
        cmd("timeline.trimStart"),
        cmd("timeline.trimEnd"),
        act("toggleClipMute", "clipMute", { checked: clip.muted === true }),
        ...(video ? [act("pixelMap", "pixelMap")] : []),
        sep,
        cmd("edit.delete"),
      ];
    }
    case "track": {
      const track = project.tracks.find((t) => t.id === target.id);
      if (!track) return [];
      const many = ctx.selectedTrackIds.includes(track.id) && ctx.selectedTrackIds.length > 1;
      const count = many ? ctx.selectedTrackIds.length : 1;
      const deleteKey =
        many ? "deleteTracks" : track.target.kind === "fixture" ? "deleteFixture" : track.target.kind === "group" ? "deleteGroup" : "deleteScene";
      // 多台灯具的批量操作：右键的是灯具轨道时可用；选中的轨道里有两台以上灯具时可编组 / 同步
      const fixtureCount = many ? fixturesOfTracks(project, ctx.selectedTrackIds).length : 0;
      const batch: MenuEntry[] =
        track.target.kind === "fixture"
          ? [
              sep,
              act("selectSameModel", "selectSameModel"),
              ...(fixtureCount >= 2
                ? [
                    act("groupTracks", "groupTracks", { labelArgs: { count: fixtureCount } }),
                    act("syncTracks", "syncTracks", { labelArgs: { count: fixtureCount } }),
                  ]
                : []),
            ]
          : [];
      return [
        act("addCueHere", many ? "addCueTracks" : "addCueTrack", { labelArgs: { count }, disabled: track.lock && !many }),
        act("pasteHere", "pasteAtPlayhead", { disabled: !ctx.hasClipboard }),
        act("selectTrackCues", "selectTrackCues"),
        sep,
        act("toggleMute", "mute", { checked: track.mute }),
        act("toggleSolo", "solo", { checked: track.solo }),
        act("toggleLock", "lock", { checked: track.lock }),
        act("toggleCollapse", "collapse", { checked: track.collapsed === true }),
        act("cycleHeight", "cycleHeight"),
        ...batch,
        sep,
        act("deleteTracks", deleteKey, { labelArgs: { count }, destructive: true }),
        ...(!many && track.target.kind === "group"
          ? [act("deleteGroupWithMembers", "deleteGroupWithMembers", { destructive: true })]
          : []),
      ];
    }
    case "mediaTrack": {
      const track = project.mediaTracks.find((t) => t.id === target.id);
      if (!track) return [];
      return [
        act("toggleMediaMute", "mute", { checked: track.mute }),
        act("toggleMediaSolo", "solo", { checked: track.solo }),
        act("toggleMediaLock", "lock", { checked: track.lock }),
        sep,
        act("deleteMediaTrack", "deleteMediaTrack", { destructive: true }),
      ];
    }
    case "empty": {
      const track = target.trackId ? project.tracks.find((t) => t.id === target.trackId) : undefined;
      return [
        act("addCueHere", "addCueHere", { disabled: !track || track.lock }),
        act("pasteHere", "pasteHere", { disabled: !ctx.hasClipboard }),
        act("markerHere", "markerHere"),
        act("playheadHere", "playheadHere"),
      ];
    }
    case "ruler":
      return [
        act("playheadHere", "playheadHere"),
        act("markerHere", "markerHere"),
        act("sectionHere", "sectionHere"),
        sep,
        act("loopIn", "loopIn"),
        act("loopOut", "loopOut"),
        cmd("timeline.loopClear"),
        sep,
        act("endHere", "endHere", { disabled: target.timeMs <= 0 }),
        cmd("timeline.fitDuration"),
        ...(project.tempo ? [sep, act("clearTempo", "clearTempo", { destructive: true })] : []),
      ];
    case "marker": {
      if (!project.markers.some((m) => m.id === target.id)) return [];
      return [
        act("renameObject", "rename"),
        act("markerToPlayhead", "markerToPlayhead"),
        act("sectionFromMarker", "sectionFromMarker"),
        sep,
        act("deleteMarker", "deleteMarker", { destructive: true }),
      ];
    }
    case "section": {
      if (!project.sections.some((s) => s.id === target.id)) return [];
      return [
        act("renameObject", "rename"),
        { kind: "sectionColors" },
        act("loopSection", "loopSection"),
        act("selectSectionCues", "selectSectionCues"),
        sep,
        act("deleteSection", "deleteSection", { destructive: true }),
      ];
    }
    case "loop":
      if (!project.loopRange) return [];
      return [
        act("playLoop", "playLoop"),
        act("loopToSection", "loopToSection"),
        sep,
        act("clearLoop", "clearLoop", { destructive: true }),
      ];
    case "keyframe": {
      const cue = project.cues.find((c) => c.id === target.cueId);
      if (!cue) return [];
      const locked = project.tracks.find((t) => t.id === cue.trackId)?.lock === true;
      return [
        act("playheadToKey", "playheadToKey"),
        sep,
        act("deleteKey", "deleteKey", { destructive: true, disabled: locked }),
        act("clearKeys", "clearKeys", { destructive: true, disabled: locked }),
      ];
    }
  }
}
