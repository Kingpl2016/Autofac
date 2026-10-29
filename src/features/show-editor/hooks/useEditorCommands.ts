import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { FILE_COMMANDS, type FileCommandHandlers, type FileCommandId } from "../lib/fileCommands";
import { useDocumentStore } from "../stores/useDocumentStore";
import { cuesAfter, cuesAt, rippleDeleteCues, splitCues } from "../lib/cueOps";
import { applyPattern, invertSelection, stepSelection } from "../lib/fixtureSelection";
import { adjacentCue, adjacentEditPoint, editPoints, setCueLengths, toggleCuesDisabled, trimCuesAt, trimMediaAt } from "../lib/editOps";
import { removeMediaClips, splitMediaClips } from "../lib/mediaClips";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { addSection, sectionAt } from "../lib/sections";
import { hasProgrammerValues, knockout, recordLengthMs, recordLooks, recordScene } from "../lib/programmer";
import { setLoopEdge, setLoopRange } from "../lib/ops";
import { OUTPUT_FPS } from "../lib/project";
import { normalizeZoom, zoomPxPerSec, zoomToRange } from "../lib/zoom";
import { beatsToMs } from "../lib/tempo";
import {
  alignCueStarts,
  chainCues,
  closeGaps,
  copyRange,
  deleteRange,
  extendCue,
  insertGap,
  moveTracks,
  moveTracksBy,
  quantizeCues,
  spaceCues,
  type EditScope,
} from "../lib/timelineEdit";
import { pasteCuesToTracks } from "../lib/cueOps";
import { START_LEFT } from "../timeline/timelineData";
import type { ShowProject } from "../lib/project";
import { CENTER_VIEWS, useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { LIBRARY_TABS, useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { readTimelineViewport } from "../timeline/timelineView";
import { addMarkerAtPlayhead, fitShowDuration, requestShowDuration, tapTempoNow } from "./editorActions";
import { seekTo, stopPlayback, togglePlay } from "./transportActions";
import { useCueActions } from "./useCueActions";
import { clearLoop, deleteSelectedObject } from "./timelineObjectActions";
import { runTour } from "../onboarding/runTour";
import { useOnboardingStore } from "../stores/useOnboardingStore";
import { togglePanel } from "./panelControl";

/** 一帧的毫秒数（逐帧移动播放头 / 微调片段用）。 */
const FRAME = Math.round(1000 / OUTPUT_FPS);

/**
 * 文件类命令（新建、打开、导入、导出…）。
 *
 * @param handlers 文件动作（引用稳定，见 `useShowFile` 的 `handlers`）。
 * @returns 命令列表。
 */
function fileCommands(handlers: FileCommandHandlers): Command[] {
  const f = () => handlers;
  const hasOrigin = () => useDocumentStore.getState().origin.kind !== "none";
  const entry = (id: Exclude<FileCommandId, "file.save">, run: () => void, enabled?: () => boolean): Command => ({
    id,
    titleKey: FILE_COMMANDS[id].titleKey,
    category: "file",
    keys: FILE_COMMANDS[id].keys,
    global: FILE_COMMANDS[id].keys.length > 0,
    ...(enabled ? { enabled } : {}),
    run,
  });
  return [
    entry("file.new", () => f()?.requestNew()),
    entry("file.openLibrary", () => f()?.requestOpenLibrary()),
    entry("file.openFile", () => f()?.requestOpenFile()),
    entry("file.saveAsNew", () => f()?.openSaveDialog(true)),
    entry("file.import", () => f()?.requestImport()),
    entry("file.exportArtrec", () => f()?.exportArtrec()),
    entry("file.reload", () => f()?.requestReload(), hasOrigin),
    entry("file.reveal", () => f()?.revealInFolder(), hasOrigin),
    entry("file.info", () => f()?.openInfo()),
  ];
}

/**
 * 编辑器的全部命令（工具条、快捷键、命令面板共用）。默认快捷键与剪映一致：
 * 空格播放、Ctrl+B 分割、Delete 删除、Shift+Delete 波纹删除、I / O 入点出点、+ / - 缩放、Shift+Z 适应窗口。
 *
 * @param onSave 保存动作（来自文件操作）。
 * @param file 其它文件命令的动作（新建、打开、导入、导出…；引用应稳定）；省略时这些命令不注册。
 * @returns 命令列表（稳定引用，内部读取最新状态）。
 */
export function useEditorCommands(onSave?: () => void, file?: FileCommandHandlers): Command[] {
  const { t } = useTranslation();
  const actions = useCueActions();

  return useMemo<Command[]>(() => {
    const ui = () => useEditorUiStore.getState();
    const project = () => useProjectStore.getState().project;
    const update = useProjectStore.getState().update;
    const alive = () => {
      const ids = new Set(project().cues.map((c) => c.id));
      return ui().selectedCueIds.filter((id) => ids.has(id));
    };
    const hasSelection = () => alive().length > 0;
    const aliveMedia = () => {
      const ids = new Set(project().mediaClips.map((c) => c.id));
      return ui().selectedMediaClipIds.filter((id) => ids.has(id));
    };
    const temporal = () => useProjectStore.temporal.getState();
    const allFixtures = () => project().fixtures.map((f) => f.id);
    const programmer = () => useProgrammerStore.getState();

    // ---- 时间范围（标尺上 Shift + 拖动选出的一段时间） ----
    const rangeActive = () => ui().timeRange !== null;
    /** 影响范围：默认是选中的轨道（没有时为全部轨道）；`all` 时全部轨道，标记、段落、循环区、媒体一起移动。 */
    const scopeOf = (all: boolean): EditScope =>
      all ? { trackIds: null, objects: true } : { trackIds: ui().selectedTrackIds.length > 0 ? ui().selectedTrackIds : null, objects: false };
    const copyTimeRange = () => {
      const range = ui().timeRange;
      if (!range) return;
      const clip = copyRange(project(), range, scopeOf(false).trackIds);
      ui().setClipboard(clip);
      announce(t("editor.range.copied", { count: clip.length }));
    };
    const deleteTimeRange = (close: boolean, all: boolean) => {
      const range = ui().timeRange;
      if (!range) return;
      let n = 0;
      update((d) => {
        n = deleteRange(d, range, scopeOf(all), close);
      });
      if (close) ui().setTimeRange(null);
      announce(t(close ? "editor.range.deletedClosed" : "editor.range.deleted", { count: n }));
    };
    const insertRangeGap = (all: boolean) => {
      const range = ui().timeRange;
      if (!range) return;
      let ok = false;
      update((d) => {
        ok = insertGap(d, range.startMs, range.endMs - range.startMs, scopeOf(all));
      });
      announce(t(ok ? "editor.range.gapInserted" : "editor.range.nothingMoved"));
    };
    /** 一组片段的时间跨度。 */
    const cueSpan = (ids: readonly string[]) => {
      const cues = project().cues.filter((c) => ids.includes(c.id));
      return cues.length > 0 ? { startMs: Math.min(...cues.map((c) => c.startMs)), endMs: Math.max(...cues.map((c) => c.endMs)) } : null;
    };
    /** 排列片段（一步撤销；放不下时整次放弃并说明）。 */
    const arrange = (fn: (d: ShowProject, ids: string[]) => boolean) => {
      let ok = false;
      update((d) => {
        ok = fn(d, alive());
      });
      announce(t(ok ? "editor.arrange.done" : "editor.arrange.failed"));
    };
    const moveSelectedTracks = (fn: (d: ShowProject, ids: string[]) => boolean) => {
      const ids = ui().selectedTrackIds.length > 0 ? ui().selectedTrackIds : ui().selectedTrackId ? [ui().selectedTrackId as string] : [];
      if (ids.length === 0) return;
      update((d) => void fn(d, ids));
    };
    const hasTracksSelected = () => ui().selectedTrackIds.length > 0 || ui().selectedTrackId !== null;

    const commands: Command[] = [
      { id: "file.save", titleKey: FILE_COMMANDS["file.save"].titleKey, category: "file", keys: FILE_COMMANDS["file.save"].keys, global: true, run: () => onSave?.() },
      ...(file ? fileCommands(file) : []),
      { id: "edit.undo", titleKey: "editor.commands.undo", category: "edit", keys: ["mod+z"], enabled: () => temporal().pastStates.length > 0, run: () => temporal().undo() },
      { id: "edit.redo", titleKey: "editor.commands.redo", category: "edit", keys: ["mod+shift+z", "mod+y"], enabled: () => temporal().futureStates.length > 0, run: () => temporal().redo() },
      {
        id: "edit.cut",
        titleKey: "editor.commands.cut",
        category: "edit",
        keys: ["mod+x"],
        enabled: () => hasSelection() || rangeActive(),
        run: () => {
          if (!hasSelection() && rangeActive()) {
            copyTimeRange();
            deleteTimeRange(useEditorPrefsStore.getState().rippleEdit, false);
            return;
          }
          actions.copySelected();
          actions.removeSelected();
        },
      },
      {
        id: "edit.copy",
        titleKey: "editor.commands.copy",
        category: "edit",
        keys: ["mod+c"],
        enabled: () => hasSelection() || rangeActive(),
        run: () => (!hasSelection() && rangeActive() ? copyTimeRange() : actions.copySelected()),
      },
      { id: "edit.paste", titleKey: "editor.commands.paste", category: "edit", keys: ["mod+v"], enabled: () => ui().clipboard.length > 0, run: actions.pasteAtPlayhead },
      { id: "edit.duplicate", titleKey: "editor.commands.duplicate", category: "edit", keys: ["mod+d"], enabled: hasSelection, run: actions.duplicateSelected },
      {
        id: "edit.delete",
        titleKey: "editor.commands.delete",
        category: "edit",
        keys: ["delete", "backspace"],
        enabled: () => hasSelection() || aliveMedia().length > 0 || ui().selectedTimelineObject !== null || rangeActive(),
        run: () => {
          // 最后点选的是标记点 / 段落时删它（与片段选择互斥）
          if (deleteSelectedObject()) return;
          const media = aliveMedia();
          // 没有选中的片段、有时间范围：删除这段时间（波纹编辑开着时合拢）
          if (media.length === 0 && !hasSelection() && rangeActive()) {
            deleteTimeRange(useEditorPrefsStore.getState().rippleEdit, false);
            return;
          }
          if (media.length === 0) {
            // 波纹编辑开着时，删除片段等同于波纹删除（后面的片段前移补齐）
            if (useEditorPrefsStore.getState().rippleEdit && hasSelection()) {
              let removed = 0;
              update((d) => {
                removed = rippleDeleteCues(d, alive());
              });
              ui().selectCues([]);
              if (removed > 0) announce(t("editor.timeline.removedCues", { count: removed }));
              return;
            }
            actions.removeSelected();
            return;
          }
          update((d) => removeMediaClips(d, media));
          ui().selectMediaClips([]);
          announce(t("editor.mediaTracks.removed", { count: media.length }));
        },
      },
      {
        id: "edit.rippleDelete",
        titleKey: "editor.commands.rippleDelete",
        category: "edit",
        keys: ["shift+delete", "shift+backspace"],
        enabled: () => hasSelection() || rangeActive(),
        run: () => {
          if (!hasSelection() && rangeActive()) {
            deleteTimeRange(true, false);
            return;
          }
          let removed = 0;
          update((d) => {
            removed = rippleDeleteCues(d, alive());
          });
          ui().selectCues([]);
          if (removed > 0) announce(t("editor.timeline.removedCues", { count: removed }));
        },
      },
      {
        id: "edit.toggleDisabled",
        titleKey: "editor.commands.toggleDisabled",
        category: "edit",
        keys: ["shift+e"],
        enabled: hasSelection,
        run: () => {
          let disabled: boolean | null = null;
          update((d) => {
            disabled = toggleCuesDisabled(d, alive());
          });
          if (disabled !== null) announce(t(disabled ? "editor.edit.disabled" : "editor.edit.enabled", { count: alive().length }));
        },
      },
      ...(["start", "end"] as const).map(
        (side): Command => ({
          id: side === "start" ? "timeline.trimStart" : "timeline.trimEnd",
          titleKey: side === "start" ? "editor.commands.trimStart" : "editor.commands.trimEnd",
          category: "timeline",
          keys: [side === "start" ? "q" : "w"],
          run: () => {
            const at = ui().playheadMs;
            const media = aliveMedia();
            let n = 0;
            update((d) => {
              if (media.length > 0) {
                n = trimMediaAt(d, media, at, side);
                return;
              }
              // 有选中的片段时只修剪它们，否则修剪选中轨道（没有选中轨道时为全部轨道）上跨过播放头的片段
              const selected = alive();
              const tracks = ui().selectedTrackIds;
              const ids =
                selected.length > 0
                  ? selected
                  : tracks.length > 0
                    ? tracks.flatMap((tr) => cuesAt(d, at, tr))
                    : cuesAt(d, at, null);
              n = trimCuesAt(d, ids, at, side);
            });
            announce(n > 0 ? t("editor.edit.trimmed", { count: n }) : t("editor.edit.nothingToTrim"));
          },
        }),
      ),
      ...([-1, 1] as const).map(
        (dir): Command => ({
          id: dir < 0 ? "transport.prevEdit" : "transport.nextEdit",
          titleKey: dir < 0 ? "editor.commands.prevEdit" : "editor.commands.nextEdit",
          category: "transport",
          keys: [dir < 0 ? "arrowup" : "arrowdown"],
          run: () => {
            const next = adjacentEditPoint(editPoints(project()), ui().playheadMs, dir);
            if (next !== null) void seekTo(next);
          },
        }),
      ),
      ...([-1, 1] as const).map(
        (dir): Command => ({
          id: dir < 0 ? "select.prevCue" : "select.nextCue",
          titleKey: dir < 0 ? "editor.commands.prevCue" : "editor.commands.nextCue",
          category: "select",
          keys: [dir < 0 ? "[" : "]"],
          run: () => {
            const current = alive().at(-1) ?? null;
            const trackId = (current && project().cues.find((c) => c.id === current)?.trackId) ?? ui().selectedTrackId ?? project().tracks[0]?.id;
            if (!trackId) return;
            const id = adjacentCue(project(), trackId, current, ui().playheadMs, dir);
            if (!id) return;
            ui().selectCues([id]);
            ui().selectTrack(trackId);
          },
        }),
      ),
      {
        id: "transport.backFrame",
        titleKey: "editor.commands.backFrame",
        category: "transport",
        keys: ["j"],
        run: () => void seekTo(Math.max(0, ui().playheadMs - FRAME)),
      },
      {
        id: "transport.pause",
        titleKey: "editor.commands.pause",
        category: "transport",
        keys: ["k"],
        run: () => {
          if (usePlaybackStore.getState().state?.transport === "playing") void togglePlay();
        },
      },
      {
        id: "transport.play",
        titleKey: "editor.commands.play",
        category: "transport",
        keys: ["l"],
        run: () => {
          if (usePlaybackStore.getState().state?.transport !== "playing") void togglePlay();
        },
      },
      { id: "transport.toggle", titleKey: "editor.commands.playPause", category: "transport", keys: ["space"], run: () => void togglePlay() },
      { id: "transport.stop", titleKey: "editor.commands.stop", category: "transport", keys: ["shift+space"], run: () => void stopPlayback() },
      { id: "transport.start", titleKey: "editor.commands.toStart", category: "transport", keys: ["home"], run: () => void seekTo(0) },
      { id: "transport.end", titleKey: "editor.commands.toEnd", category: "transport", keys: ["end"], run: () => void seekTo(project().durationMs) },
      { id: "transport.prevFrame", titleKey: "editor.commands.prevFrame", category: "transport", keys: [","], run: () => void seekTo(Math.max(0, ui().playheadMs - FRAME)) },
      { id: "transport.nextFrame", titleKey: "editor.commands.nextFrame", category: "transport", keys: ["."], run: () => void seekTo(Math.min(project().durationMs, ui().playheadMs + FRAME)) },
      {
        id: "timeline.split",
        titleKey: "editor.commands.split",
        category: "timeline",
        keys: ["mod+b"],
        run: () => {
          const at = ui().playheadMs;
          const media = aliveMedia();
          if (media.length > 0) {
            // 选中的是媒体片段：在播放头处剪开
            let made: string[] = [];
            update((d) => {
              made = splitMediaClips(d, media, at);
            });
            if (made.length > 0) announce(t("editor.commands.splitDone", { count: made.length }));
            return;
          }
          const selected = alive();
          const ids = selected.length > 0 ? selected : cuesAt(project(), at, ui().selectedTrackId);
          let created: string[] = [];
          update((d) => {
            created = splitCues(d, ids, at);
          });
          if (created.length > 0) announce(t("editor.commands.splitDone", { count: created.length }));
        },
      },
      { id: "timeline.nudgeLeft", titleKey: "editor.commands.nudgeLeft", category: "timeline", keys: ["arrowleft"], enabled: hasSelection, run: () => actions.nudgeSelected(-FRAME) },
      { id: "timeline.nudgeRight", titleKey: "editor.commands.nudgeRight", category: "timeline", keys: ["arrowright"], enabled: hasSelection, run: () => actions.nudgeSelected(FRAME) },
      { id: "timeline.nudgeLeft10", titleKey: "editor.commands.nudgeLeft10", category: "timeline", keys: ["shift+arrowleft"], enabled: hasSelection, run: () => actions.nudgeSelected(-10 * FRAME) },
      { id: "timeline.nudgeRight10", titleKey: "editor.commands.nudgeRight10", category: "timeline", keys: ["shift+arrowright"], enabled: hasSelection, run: () => actions.nudgeSelected(10 * FRAME) },
      { id: "timeline.marker", titleKey: "editor.commands.marker", category: "timeline", keys: ["m"], run: () => void addMarkerAtPlayhead() },
      { id: "timeline.tap", titleKey: "editor.commands.tap", category: "timeline", keys: ["t"], run: () => void tapTempoNow(performance.now()) },
      { id: "timeline.snap", titleKey: "editor.commands.snap", category: "timeline", keys: ["s"], run: () => ui().toggleSnap() },
      { id: "timeline.loopIn", titleKey: "editor.commands.loopIn", category: "timeline", keys: ["i"], run: () => update((d) => setLoopEdge(d, "in", ui().playheadMs)) },
      { id: "timeline.loopOut", titleKey: "editor.commands.loopOut", category: "timeline", keys: ["o"], run: () => update((d) => setLoopEdge(d, "out", ui().playheadMs)) },
      {
        id: "timeline.addSection",
        titleKey: "editor.commands.addSection",
        category: "timeline",
        keys: ["shift+m"],
        run: () => {
          const p = project();
          // 默认 8 小节（有节拍时），否则 8 秒
          const length = p.tempo ? (60_000 / p.tempo.bpm) * p.tempo.beatsPerBar * 8 : 8000;
          let id: string | null = null;
          update((d) => {
            id = addSection(d, ui().playheadMs, length, t("editor.sections.defaultName", { n: d.sections.length + 1 }));
          });
          announce(t(id ? "editor.sections.added" : "editor.sections.noRoom"));
        },
      },
      {
        id: "timeline.loopSection",
        titleKey: "editor.commands.loopSection",
        category: "timeline",
        keys: ["shift+l"],
        enabled: () => sectionAt(project(), ui().playheadMs) !== undefined,
        run: () => {
          const s = sectionAt(project(), ui().playheadMs);
          if (!s) return;
          update((d) => setLoopRange(d, { startMs: s.startMs, endMs: s.endMs }));
          announce(t("editor.sections.looped", { name: s.name }));
        },
      },
      { id: "timeline.fitDuration", titleKey: "editor.commands.fitDuration", category: "timeline", run: () => void fitShowDuration() },
      {
        id: "timeline.endAtPlayhead",
        titleKey: "editor.commands.endAtPlayhead",
        category: "timeline",
        enabled: () => ui().playheadMs > 0,
        run: () => void requestShowDuration(ui().playheadMs),
      },
      { id: "timeline.loopClear", titleKey: "editor.commands.loopClear", category: "timeline", keys: ["alt+x"], enabled: () => project().loopRange !== null, run: clearLoop },
      // ---- 快捷操作：绘制模式、延伸、合拢空隙、数字键设长度 ----
      {
        id: "timeline.drawMode",
        titleKey: "editor.commands.drawMode",
        category: "timeline",
        keys: ["d"],
        run: () => {
          ui().toggleDrawMode();
          announce(t(ui().drawMode ? "editor.timeline.drawOn" : "editor.timeline.drawOff"));
        },
      },
      ...(["start", "end"] as const).map(
        (side): Command => ({
          id: side === "start" ? "timeline.extendStart" : "timeline.extendEnd",
          titleKey: side === "start" ? "editor.commands.extendStart" : "editor.commands.extendEnd",
          category: "timeline",
          enabled: hasSelection,
          run: () => {
            let n = 0;
            update((d) => {
              for (const id of alive()) if (extendCue(d, id, side, ui().playheadMs)) n += 1;
            });
            announce(t(n > 0 ? "editor.timeline.extended" : "editor.timeline.extendNone"));
          },
        }),
      ),
      ...([false, true] as const).map(
        (all): Command => ({
          id: all ? "timeline.closeGapsAll" : "timeline.closeGaps",
          titleKey: all ? "editor.commands.closeGapsAll" : "editor.commands.closeGaps",
          category: "timeline",
          // 不是“全部轨道”时：选中的轨道，没有时为选中片段所在的轨道
          enabled: () => all || hasTracksSelected() || hasSelection(),
          run: () => {
            const trackIds = all
              ? null
              : hasTracksSelected()
                ? ui().selectedTrackIds.length > 0
                  ? ui().selectedTrackIds
                  : [ui().selectedTrackId as string]
                : [...new Set(project().cues.filter((c) => alive().includes(c.id)).map((c) => c.trackId))];
            let n = 0;
            update((d) => {
              n = closeGaps(d, trackIds);
            });
            announce(t("editor.timeline.gapsClosed", { count: n }));
          },
        }),
      ),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
        (n): Command => ({
          id: `timeline.length${n}`,
          titleKey: `editor.commands.length${n}`,
          category: "timeline",
          keys: [String(n)],
          enabled: hasSelection,
          run: () => {
            // 有节拍网格时按拍，没有时按秒
            const tempo = project().tempo;
            const lengthMs = tempo ? beatsToMs(n, tempo.bpm) : n * 1000;
            let changed = 0;
            update((d) => {
              changed = setCueLengths(d, alive(), lengthMs);
            });
            announce(t(tempo ? "editor.timeline.lengthBeats" : "editor.timeline.lengthSeconds", { n, count: changed }));
          },
        }),
      ),
      { id: "select.all", titleKey: "editor.commands.selectAll", category: "select", keys: ["mod+a"], run: () => ui().selectCues(project().cues.map((c) => c.id)) },
      {
        id: "select.after",
        titleKey: "editor.commands.selectAfter",
        category: "select",
        keys: ["mod+shift+arrowright"],
        run: () => ui().selectCues(cuesAfter(project(), ui().playheadMs, ui().selectedTrackId)),
      },
      { id: "select.none", titleKey: "editor.commands.selectNone", category: "select", keys: ["escape"], run: () => ui().clearSelection() },
      {
        id: "select.sameTag",
        titleKey: "editor.commands.selectSameTag",
        category: "select",
        enabled: () => alive().some((id) => project().cues.find((c) => c.id === id)?.tag),
        run: () => {
          const tags = new Set(alive().flatMap((id) => project().cues.find((c) => c.id === id)?.tag ?? []));
          ui().selectCues(project().cues.filter((c) => c.tag && tags.has(c.tag)).map((c) => c.id));
        },
      },
      // ---- 时间范围 ----
      {
        id: "range.deleteAll",
        titleKey: "editor.commands.rangeDeleteAll",
        category: "timeline",
        keys: ["alt+shift+delete", "alt+shift+backspace"],
        enabled: rangeActive,
        run: () => deleteTimeRange(true, true),
      },
      { id: "range.insertGap", titleKey: "editor.commands.rangeInsertGap", category: "timeline", enabled: rangeActive, run: () => insertRangeGap(false) },
      {
        id: "range.insertGapAll",
        titleKey: "editor.commands.rangeInsertGapAll",
        category: "timeline",
        keys: ["alt+shift+g"],
        enabled: rangeActive,
        run: () => insertRangeGap(true),
      },
      { id: "range.clear", titleKey: "editor.commands.rangeClear", category: "timeline", enabled: rangeActive, run: () => ui().setTimeRange(null) },
      // ---- 片段排列 ----
      { id: "arrange.alignStart", titleKey: "editor.commands.alignStart", category: "timeline", enabled: () => alive().length > 1, run: () => arrange((d, ids) => alignCueStarts(d, ids)) },
      {
        id: "arrange.alignPlayhead",
        titleKey: "editor.commands.alignPlayhead",
        category: "timeline",
        enabled: hasSelection,
        run: () => arrange((d, ids) => alignCueStarts(d, ids, ui().playheadMs)),
      },
      { id: "arrange.chain", titleKey: "editor.commands.chain", category: "timeline", enabled: () => alive().length > 1, run: () => arrange((d, ids) => chainCues(d, ids)) },
      {
        id: "arrange.space",
        titleKey: "editor.commands.space",
        category: "timeline",
        enabled: () => alive().length > 1,
        // 有节拍时每拍一个，否则每秒一个
        run: () => arrange((d, ids) => spaceCues(d, ids, d.tempo ? 60_000 / d.tempo.bpm : 1000)),
      },
      {
        id: "arrange.quantize",
        titleKey: "editor.commands.quantize",
        category: "timeline",
        enabled: () => hasSelection() && project().tempo !== null,
        run: () => arrange((d, ids) => (d.tempo ? quantizeCues(d, ids, d.tempo, 1) : false)),
      },
      { id: "edit.repeat", titleKey: "editor.commands.repeat", category: "edit", enabled: hasSelection, run: () => ui().setRepeatOpen(true) },
      {
        id: "edit.pasteAtPointer",
        titleKey: "editor.commands.pasteAtPointer",
        category: "edit",
        keys: ["mod+shift+v"],
        enabled: () => ui().clipboard.length > 0 && ui().pointerTimeMs !== null,
        run: () => {
          const at = ui().pointerTimeMs;
          if (at === null) return;
          let created: string[] = [];
          update((d) => {
            created = pasteCuesToTracks(d, ui().clipboard, at, ui().selectedTrackIds);
          });
          if (created.length > 0) ui().selectCues(created);
          announce(t(created.length > 0 ? "editor.commands.pasted" : "editor.templates.noRoom", { count: created.length }));
        },
      },
      // ---- 轨道排序 ----
      { id: "tracks.moveUp", titleKey: "editor.commands.tracksMoveUp", category: "timeline", keys: ["alt+shift+arrowup"], enabled: hasTracksSelected, run: () => moveSelectedTracks((d, ids) => moveTracksBy(d, ids, -1)) },
      { id: "tracks.moveDown", titleKey: "editor.commands.tracksMoveDown", category: "timeline", keys: ["alt+shift+arrowdown"], enabled: hasTracksSelected, run: () => moveSelectedTracks((d, ids) => moveTracksBy(d, ids, 1)) },
      { id: "tracks.moveTop", titleKey: "editor.commands.tracksMoveTop", category: "timeline", enabled: hasTracksSelected, run: () => moveSelectedTracks((d, ids) => moveTracks(d, ids, 0)) },
      { id: "tracks.moveBottom", titleKey: "editor.commands.tracksMoveBottom", category: "timeline", enabled: hasTracksSelected, run: () => moveSelectedTracks((d, ids) => moveTracks(d, ids, d.tracks.length)) },
      // ---- 标记导航与缩放 ----
      ...([-1, 1] as const).map(
        (dir): Command => ({
          id: dir < 0 ? "transport.prevMarker" : "transport.nextMarker",
          titleKey: dir < 0 ? "editor.commands.prevMarker" : "editor.commands.nextMarker",
          category: "transport",
          keys: [dir < 0 ? "shift+arrowup" : "shift+arrowdown"],
          enabled: () => project().markers.length > 0,
          run: () => {
            const at = ui().playheadMs;
            const times = project().markers.map((m) => m.timeMs).sort((a, b) => a - b);
            const next = dir > 0 ? times.find((m) => m > at) : [...times].reverse().find((m) => m < at);
            if (next !== undefined) void seekTo(next);
          },
        }),
      ),
      {
        id: "view.zoomRange",
        titleKey: "editor.commands.zoomRange",
        category: "view",
        keys: ["z"],
        enabled: () => rangeActive() || hasSelection() || project().loopRange !== null,
        run: () => {
          const target = ui().timeRange ?? cueSpan(alive()) ?? project().loopRange;
          const vp = readTimelineViewport();
          if (!target) return;
          const { pxPerSec, scrollLeft } = zoomToRange(target, vp?.rect.width ?? 1000, START_LEFT);
          ui().setPxPerSec(pxPerSec);
          requestAnimationFrame(() => {
            const el = document.getElementById("timeline-body");
            if (el) el.scrollLeft = scrollLeft;
          });
        },
      },
      { id: "view.zoomIn", titleKey: "editor.commands.zoomIn", category: "view", keys: ["+", "mod++"], run: () => ui().setPxPerSec(zoomPxPerSec(ui().pxPerSec, 1)) },
      { id: "view.zoomOut", titleKey: "editor.commands.zoomOut", category: "view", keys: ["-", "mod+-"], run: () => ui().setPxPerSec(zoomPxPerSec(ui().pxPerSec, -1)) },
      {
        id: "view.zoomFit",
        titleKey: "editor.commands.zoomFit",
        category: "view",
        keys: ["shift+z"],
        run: () => {
          const width = readTimelineViewport()?.rect.width ?? 1000;
          const seconds = Math.max(1, project().durationMs / 1000);
          // 下限足够小：几个小时的节目也能整场放进一屏
          ui().setPxPerSec(normalizeZoom((width - 40) / seconds));
          requestAnimationFrame(() => {
            const el = document.getElementById("timeline-body");
            if (el) el.scrollLeft = 0;
          });
        },
      },
      { id: "view.palette", titleKey: "editor.commands.palette", category: "view", keys: ["mod+k", "mod+shift+k"], global: true, run: () => ui().setPaletteOpen(true) },
      {
        id: "view.radial",
        titleKey: "editor.commands.radial",
        category: "view",
        keys: ["shift+q"],
        run: () => {
          // 键盘打开时放在时间线中间（没有时间线时放在窗口中间）
          const vp = readTimelineViewport();
          ui().setRadial(
            vp
              ? { x: vp.rect.left + vp.rect.width / 2, y: vp.rect.top + vp.rect.height / 2 }
              : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
          );
        },
      },
      { id: "view.mute", titleKey: "editor.commands.muteMedia", category: "view", run: () => ui().toggleMuted() },
      // ---- 灯具选择与编程器 ----
      { id: "fixtures.all", titleKey: "editor.commands.fixturesAll", category: "select", keys: ["mod+shift+a"], run: () => ui().setSelectedFixtures(allFixtures()) },
      {
        id: "fixtures.invert",
        titleKey: "editor.commands.fixturesInvert",
        category: "select",
        keys: ["mod+shift+i"],
        run: () => ui().setSelectedFixtures(invertSelection(allFixtures(), ui().selectedFixtureIds)),
      },
      {
        id: "fixtures.next",
        titleKey: "editor.commands.fixturesNext",
        category: "select",
        keys: ["alt+arrowright"],
        run: () => ui().setSelectedFixtures(stepSelection(allFixtures(), ui().selectedFixtureIds, 1)),
      },
      {
        id: "fixtures.prev",
        titleKey: "editor.commands.fixturesPrev",
        category: "select",
        keys: ["alt+arrowleft"],
        run: () => ui().setSelectedFixtures(stepSelection(allFixtures(), ui().selectedFixtureIds, -1)),
      },
      {
        id: "fixtures.odd",
        titleKey: "editor.commands.fixturesOdd",
        category: "select",
        run: () => ui().setSelectedFixtures(applyPattern(allFixtures(), ui().selectedFixtureIds, { kind: "odd" })),
      },
      {
        id: "fixtures.even",
        titleKey: "editor.commands.fixturesEven",
        category: "select",
        run: () => ui().setSelectedFixtures(applyPattern(allFixtures(), ui().selectedFixtureIds, { kind: "even" })),
      },
      { id: "programmer.open", titleKey: "editor.commands.programmerOpen", category: "view", keys: ["p"], run: () => ui().setInspectorTab("program") },
      {
        id: "programmer.clear",
        titleKey: "editor.commands.programmerClear",
        category: "edit",
        keys: ["alt+backspace"],
        enabled: () => hasProgrammerValues(programmer().values) || programmer().live,
        run: () => {
          programmer().clear();
          announce(t("editor.programmer.cleared"));
        },
      },
      {
        id: "programmer.recordScene",
        titleKey: "editor.commands.programmerRecordScene",
        category: "edit",
        keys: ["alt+r"],
        enabled: () => hasProgrammerValues(programmer().values),
        run: () => {
          // 长度与淡入用编程器面板上的记录设置
          const rec = useEditorPrefsStore.getState().programmerRecord;
          const length = recordLengthMs(rec, project().tempo);
          let created = 0;
          update((d) => {
            created = recordScene(d, programmer().values, ui().playheadMs, length, t("editor.programmer.sceneTrack"), {
              fadeInMs: rec.fadeInMs,
            }).cueIds.length;
          });
          announce(t(created > 0 ? "editor.programmer.recordedScene" : "editor.programmer.noRoom"));
        },
      },
      {
        id: "programmer.recordLooks",
        titleKey: "editor.commands.programmerRecordLooks",
        category: "edit",
        keys: ["alt+shift+r"],
        enabled: () => hasProgrammerValues(programmer().values),
        run: () => {
          const rec = useEditorPrefsStore.getState().programmerRecord;
          let r = { cueIds: [] as string[], skipped: [] as string[] };
          update((d) => {
            r = recordLooks(d, programmer().values, ui().playheadMs, recordLengthMs(rec, project().tempo), { fadeInMs: rec.fadeInMs });
          });
          announce(
            r.cueIds.length > 0
              ? t("editor.programmer.recordedLooks", { count: r.cueIds.length, skipped: r.skipped.length })
              : t("editor.programmer.noRoom"),
          );
        },
      },
      {
        id: "programmer.knockout",
        titleKey: "editor.commands.programmerKnockout",
        category: "edit",
        keys: ["alt+k"],
        enabled: () => ui().selectedFixtureIds.some((id) => programmer().values[id] !== undefined),
        run: () => {
          programmer().setValues(knockout(programmer().values, ui().selectedFixtureIds));
          announce(t("editor.programmer.knocked", { count: ui().selectedFixtureIds.length }));
        },
      },
      {
        id: "programmer.highlight",
        titleKey: "editor.commands.programmerHighlight",
        category: "output",
        keys: ["h"],
        run: () => {
          const on = !programmer().highlight;
          programmer().setHighlight(on);
          announce(t(on ? "editor.programmer.highlightOn" : "editor.programmer.highlightOff"));
        },
      },
      {
        id: "programmer.undo",
        titleKey: "editor.commands.programmerUndo",
        category: "edit",
        keys: ["alt+z"],
        enabled: () => programmer().past.length > 0,
        run: () => programmer().undo(),
      },
      {
        id: "programmer.redo",
        titleKey: "editor.commands.programmerRedo",
        category: "edit",
        keys: ["alt+shift+z"],
        enabled: () => programmer().future.length > 0,
        run: () => programmer().redo(),
      },
      {
        id: "programmer.live",
        titleKey: "editor.commands.programmerLive",
        category: "output",
        run: () => programmer().setLive(!programmer().live),
      },
      { id: "draft.open", titleKey: "editor.draft.title", category: "edit", run: () => ui().setDraftOpen(true) },
      {
        id: "view.contextMenu",
        titleKey: "editor.commands.contextMenu",
        category: "view",
        keys: ["shift+f10", "contextmenu"],
        run: () => {
          // 在选中的片段（或选中的轨道头）上模拟一次右键，打开对应的右键菜单
          const cueId = alive().at(-1);
          const trackId = ui().selectedTrackId;
          const el =
            (cueId && document.querySelector<HTMLElement>(`[data-cue-id="${CSS.escape(cueId)}"]`)) ||
            (trackId && document.querySelector<HTMLElement>(`[data-track-header-id="${CSS.escape(trackId)}"]`)) ||
            null;
          if (!el) return;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(24, r.width / 2), clientY: r.top + r.height / 2 }),
          );
        },
      },
      { id: "view.keymap", titleKey: "editor.keymap.open", category: "view", run: () => ui().setKeymapOpen(true) },
      { id: "help.menu", titleKey: "editor.guide.help", category: "view", keys: ["f1"], global: true, run: () => ui().setHelpOpen(true) },
      {
        id: "help.tour",
        titleKey: "editor.guide.replay",
        category: "view",
        // 等命令面板关闭后再开始，避免导览落在面板下面
        run: () => void window.setTimeout(() => void runTour(t), 150),
      },
      {
        id: "help.resetGuide",
        titleKey: "editor.guide.reset",
        category: "view",
        run: () => {
          useOnboardingStore.getState().reset();
          announce(t("editor.guide.resetDone"));
        },
      },
      {
        id: "output.blackout",
        titleKey: "editor.commands.blackout",
        category: "output",
        keys: ["shift+b"],
        run: () => {
          const on = !ui().blackout;
          ui().setBlackout(on);
          announce(t(on ? "editor.stage.blackoutOn" : "editor.commands.blackoutOff"));
        },
      },
    ];
    for (const view of CENTER_VIEWS) {
      commands.push({
        id: `view.center.${view}`,
        titleKey: `editor.commands.center.${view}`,
        category: "view",
        run: () => useEditorPrefsStore.getState().setCenterView(view),
      });
    }
    // 收起 / 展开左右侧栏（Ctrl+B 已是“分割”，所以用 Ctrl+Shift+B / Ctrl+Alt+B）
    commands.push(
      { id: "view.toggleLibrary", titleKey: "editor.commands.toggleLibrary", category: "view", keys: ["mod+shift+b"], run: () => togglePanel("library") },
      { id: "view.toggleInspector", titleKey: "editor.commands.toggleInspector", category: "view", keys: ["mod+alt+b"], run: () => togglePanel("inspector") },
    );
    for (const tab of LIBRARY_TABS) {
      commands.push({
        id: `view.library.${tab}`,
        titleKey: `editor.commands.library.${tab}`,
        category: "view",
        run: () => ui().setLibraryTab(tab),
      });
    }
    return commands;
  }, [t, actions, onSave, file]);
}
