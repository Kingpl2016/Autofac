import { isPixelRef } from "./fixtureRef";
import { removeFixtures, removeGroup } from "./ops";
import type { ShowProject } from "./project";

/**
 * 时间线上的轨道删除（含灯具）：
 *
 * - 灯具轨道：删除灯具本身（连同它的轨道、片段，并从分组里移除）；
 * - 分组轨道：默认只删分组（灯具保留在各自轨道上），`withMembers` 时连同成员灯具一起删；
 * - 场景轨道：删除轨道及其片段。
 *
 * 一次调用 = 一步撤销。
 */

/** 删除结果。 */
export interface RemoveTracksResult {
  /** 删除的灯具 */
  fixtures: number;
  /** 删除的分组 */
  groups: number;
  /** 删除的轨道（含因此连带删除的） */
  tracks: number;
  /** 随轨道删除的片段 */
  cues: number;
}

/**
 * 删除一组轨道会删掉什么（不修改工程，供提示 / 确认用）。
 *
 * @param project 工程（只读）。
 * @param trackIds 轨道。
 * @param withMembers 分组轨道是否连同成员灯具一起删。
 * @returns 预计的删除数量。
 */
export function previewRemoveTracks(project: ShowProject, trackIds: readonly string[], withMembers = false): RemoveTracksResult {
  // 在副本上演算一遍，保证与实际删除的规则完全一致
  const copy = structuredClone(project);
  return removeTracks(copy, trackIds, withMembers);
}

/**
 * 删除一组轨道（规则见模块说明）。
 *
 * @param d 工程草稿。
 * @param trackIds 轨道。
 * @param withMembers 分组轨道是否连同成员灯具一起删。
 * @returns 实际删除的数量。
 */
export function removeTracks(d: ShowProject, trackIds: readonly string[], withMembers = false): RemoveTracksResult {
  const before = { fixtures: d.fixtures.length, groups: d.groups.length, tracks: d.tracks.length, cues: d.cues.length };
  const wanted = new Set(trackIds);
  const picked = d.tracks.filter((t) => wanted.has(t.id));
  const fixtureIds = new Set<string>();
  const groupIds = new Set<string>();
  // 场景轨道与像素轨道只删轨道本身（像素不是可删除的灯具）
  const sceneTracks = new Set<string>();
  for (const t of picked) {
    const target = t.target;
    if (target.kind === "fixture" && isPixelRef(target.id)) sceneTracks.add(t.id);
    else if (target.kind === "fixture") fixtureIds.add(target.id);
    else if (target.kind === "group") {
      groupIds.add(target.id);
      if (withMembers) for (const id of d.groups.find((g) => g.id === target.id)?.fixtureIds ?? []) fixtureIds.add(id);
    } else sceneTracks.add(t.id);
  }
  for (const g of groupIds) removeGroup(d, g);
  if (fixtureIds.size > 0) {
    removeFixtures(d, [...fixtureIds]);
    // 场景片段里引用了被删灯具的条目一并去掉（空了的场景片段保留，可以继续编辑）
    for (const c of d.cues) {
      if (c.kind === "scene" && c.entries.some((e) => fixtureIds.has(e.fixtureId))) {
        c.entries = c.entries.filter((e) => !fixtureIds.has(e.fixtureId));
      }
    }
  }
  if (sceneTracks.size > 0) {
    d.tracks = d.tracks.filter((t) => !sceneTracks.has(t.id));
    d.cues = d.cues.filter((c) => !sceneTracks.has(c.trackId));
  }
  return {
    fixtures: before.fixtures - d.fixtures.length,
    groups: before.groups - d.groups.length,
    tracks: before.tracks - d.tracks.length,
    cues: before.cues - d.cues.length,
  };
}
