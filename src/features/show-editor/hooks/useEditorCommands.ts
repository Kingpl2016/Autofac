import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { cuesAfter, cuesAt, rippleDeleteCues, splitCues } from "../lib/cueOps";
import { applyPattern, invertSelection, stepSelection } from "../lib/fixtureSelection";
import { adjacentCue, adjacentEditPoint, editPoints, toggleCuesDisabled, trimCuesAt, trimMediaAt } from "../lib/editOps";
import { removeMediaClips, splitMediaClips } from "../lib/mediaClips";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { addSection, sectionAt } from "../lib/sections";
import { hasProgrammerValues, recordScene } from "../lib/programmer";
import { setLoopEdge, setLoopRange } from "../lib/ops";
import { OUTPUT_FPS } from "../lib/project";
import { clamp } from "../lib/time";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, zoomPxPerSec } from "../lib/zoom";
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
 * 编辑器的全部命令（工具条、快捷键、命令面板共用）。默认快捷键与剪映一致：
 * 空格播放、Ctrl+B 分割、Delete 删除、Shift+Delete 波纹删除、I / O 入点出点、+ / - 缩放、Shift+Z 适应窗口。
 *
 * @param onSave 保存动作（来自文件操作）。
 * @returns 命令列表（稳定引用，内部读取最新状态）。
 */
export function useEditorCommands(onSave?: () => void): Command[] {
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

    const commands: Command[] = [
      { id: "file.save", titleKey: "editor.commands.save", category: "file", keys: ["mod+s"], global: true, run: () => onSave?.() },
      { id: "edit.undo", titleKey: "editor.commands.undo", category: "edit", keys: ["mod+z"], enabled: () => temporal().pastStates.length > 0, run: () => temporal().undo() },
      { id: "edit.redo", titleKey: "editor.commands.redo", category: "edit", keys: ["mod+shift+z", "mod+y"], enabled: () => temporal().futureStates.length > 0, run: () => temporal().redo() },
      {
        id: "edit.cut",
        titleKey: "editor.commands.cut",
        category: "edit",
        keys: ["mod+x"],
        enabled: hasSelection,
        run: () => {
          actions.copySelected();
          actions.removeSelected();
        },
      },
      { id: "edit.copy", titleKey: "editor.commands.copy", category: "edit", keys: ["mod+c"], enabled: hasSelection, run: actions.copySelected },
      { id: "edit.paste", titleKey: "editor.commands.paste", category: "edit", keys: ["mod+v"], enabled: () => ui().clipboard.length > 0, run: actions.pasteAtPlayhead },
      { id: "edit.duplicate", titleKey: "editor.commands.duplicate", category: "edit", keys: ["mod+d"], enabled: hasSelection, run: actions.duplicateSelected },
      {
        id: "edit.delete",
        titleKey: "editor.commands.delete",
        category: "edit",
        keys: ["delete", "backspace"],
        enabled: () => hasSelection() || aliveMedia().length > 0 || ui().selectedTimelineObject !== null,
        run: () => {
          // 最后点选的是标记点 / 段落时删它（与片段选择互斥）
          if (deleteSelectedObject()) return;
          const media = aliveMedia();
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
        enabled: hasSelection,
        run: () => {
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
      { id: "select.all", titleKey: "editor.commands.selectAll", category: "select", keys: ["mod+a"], run: () => ui().selectCues(project().cues.map((c) => c.id)) },
      {
        id: "select.after",
        titleKey: "editor.commands.selectAfter",
        category: "select",
        keys: ["mod+shift+arrowright"],
        run: () => ui().selectCues(cuesAfter(project(), ui().playheadMs, ui().selectedTrackId)),
      },
      { id: "select.none", titleKey: "editor.commands.selectNone", category: "select", keys: ["escape"], run: () => ui().clearSelection() },
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
          ui().setPxPerSec(Math.round(clamp((width - 40) / seconds, MIN_PX_PER_SEC, MAX_PX_PER_SEC)));
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
          let created = 0;
          update((d) => {
            created = recordScene(d, programmer().values, ui().playheadMs, 2000, t("editor.programmer.sceneTrack")).cueIds.length;
          });
          announce(t(created > 0 ? "editor.programmer.recordedScene" : "editor.programmer.noRoom"));
        },
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
  }, [t, actions, onSave]);
}
