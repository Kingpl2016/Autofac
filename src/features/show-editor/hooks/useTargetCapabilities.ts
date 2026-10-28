import { useMemo } from "react";

import { trackSupports } from "../lib/cueDefaults";
import { trackCapabilities, type FixtureCapability, type TrackCapabilities } from "../lib/fixtureProfile";
import type { ShowProject, Track } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 素材库“点击添加”的目标轨道：多选了轨道时为全部选中的（可编辑的）轨道，否则为所选轨道，
 * 没有选中时为第一条可编辑的轨道。
 *
 * @param project 工程（只读）。
 * @param selection 轨道选择。
 * @param accept 额外的过滤（例如排除场景轨道）。
 * @returns 轨道 id（按轨道顺序）；没有可用轨道时为空。
 */
export function resolveTargetTracks(
  project: Pick<ShowProject, "tracks">,
  selection: { selectedTrackIds: readonly string[]; selectedTrackId: string | null },
  accept: (track: Track) => boolean = () => true,
): string[] {
  const ok = (tr: Track) => !tr.lock && accept(tr);
  if (selection.selectedTrackIds.length > 1) {
    const set = new Set(selection.selectedTrackIds);
    return project.tracks.filter((tr) => set.has(tr.id) && ok(tr)).map((tr) => tr.id);
  }
  const track = project.tracks.find((tr) => tr.id === selection.selectedTrackId && ok(tr)) ?? project.tracks.find(ok);
  return track ? [track.id] : [];
}

/** 排除场景轨道（外观类素材用）。 */
export const notScene = (track: Track) => track.target.kind !== "scene";

/**
 * 当前目标轨道的能力汇总（素材库据此显示“部分适用 / 不适用”）。
 *
 * @returns 每条目标轨道的能力（场景轨道除外）。
 */
export function useTargetCapabilities(): TrackCapabilities[] {
  const project = useProjectStore((s) => s.project);
  const selectedTrackIds = useEditorUiStore((s) => s.selectedTrackIds);
  const selectedTrackId = useEditorUiStore((s) => s.selectedTrackId);
  const { tracks, fixtures, fixtureModels, groups, cues } = project;
  return useMemo(() => {
    const p = { tracks, fixtures, fixtureModels, groups, cues };
    return resolveTargetTracks(p, { selectedTrackIds, selectedTrackId }, notScene).flatMap((id) => {
      const track = tracks.find((tr) => tr.id === id);
      return track ? [trackCapabilities(p, track)] : [];
    });
  }, [tracks, fixtures, fixtureModels, groups, cues, selectedTrackIds, selectedTrackId]);
}

/**
 * 目标轨道里支持某项能力的那些（点击素材添加时用：不支持的轨道跳过）。
 *
 * @param project 工程（只读）。
 * @param selection 轨道选择。
 * @param needs 需要的能力。
 * @returns 全部目标轨道与其中支持的轨道。
 */
export function supportedTargets(
  project: Pick<ShowProject, "tracks" | "fixtures" | "fixtureModels" | "groups" | "cues">,
  selection: { selectedTrackIds: readonly string[]; selectedTrackId: string | null },
  needs: FixtureCapability,
): { all: string[]; supported: string[] } {
  const all = resolveTargetTracks(project, selection, notScene);
  return { all, supported: all.filter((id) => trackSupports(project, id, needs)) };
}
