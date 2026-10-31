import type { Cue, ShowProject, Track } from "../lib/project";
import { trackName } from "../lib/ops";
import type { StagedChange } from "../stores/useAiStagingStore";

/**
 * 时间线上的改动虚影：待审阅的 AI 改动里每个新增 / 修改 / 删除的片段，画在它所在的轨道上，
 * 并记下是哪条操作产生的（悬停时可以只拒绝这一条）。纯函数。
 */

/** 一个虚影片段。 */
export interface Ghost {
  /** 片段（新增 / 修改为改动后的片段，删除为原来的片段） */
  cue: Cue;
  kind: "add" | "change" | "remove";
  /** 产生它的操作（`allOps` 下标） */
  opIndex: number;
}

/** 一条轨道上虚影超过这么多时合并成一条“改动带”。 */
export const MAX_GHOSTS_PER_TRACK = 200;

/**
 * 待审阅改动的虚影。同一片段被几条操作改过时算在最后一条上（拒绝它才会改回去）。
 *
 * @param staged 待审阅的改动。
 * @returns 虚影（按轨道、起点排序）。
 */
export function stagedGhosts(staged: StagedChange): Ghost[] {
  const nextById = new Map(staged.next.cues.map((c) => [c.id, c]));
  const baseById = new Map(staged.base.cues.map((c) => [c.id, c]));
  const byCue = new Map<string, Ghost>();
  staged.effects.forEach((e, opIndex) => {
    if (!e) return;
    for (const id of e.added) {
      const cue = nextById.get(id);
      if (cue) byCue.set(id, { cue, kind: "add", opIndex });
    }
    for (const id of e.changed) {
      const cue = nextById.get(id);
      // 本批新增后又被改：仍算新增，归到最后改它的操作
      if (cue) byCue.set(id, { cue, kind: byCue.get(id)?.kind === "add" ? "add" : "change", opIndex });
    }
    for (const id of e.removed) {
      const cue = baseById.get(id);
      if (cue) byCue.set(id, { cue, kind: "remove", opIndex });
      // 本批新增又删掉：没有虚影
      else byCue.delete(id);
    }
  });
  return [...byCue.values()].sort((a, b) => a.cue.trackId.localeCompare(b.cue.trackId) || a.cue.startMs - b.cue.startMs);
}

/** 时间线上显示的轨道：当前工程的轨道，加上待审阅改动新建的轨道（锁定、只用来显示虚影）。 */
export interface DisplayTracks {
  tracks: Track[];
  names: string[];
  /** 待审阅改动新建的轨道 */
  pendingIds: ReadonlySet<string>;
}

/**
 * 把待审阅改动新建的轨道插到它在改动后工程里的位置（紧跟在前面最近的一条已有轨道之后）。
 *
 * @param project 当前工程。
 * @param staged 待审阅的改动；没有时原样返回。
 * @returns 轨道、显示名与新建轨道的 id。
 */
export function displayTracks(project: ShowProject, staged: Pick<StagedChange, "next"> | null): DisplayTracks {
  const names = project.tracks.map((t) => trackName(project, t));
  if (!staged) return { tracks: project.tracks, names, pendingIds: new Set() };
  const have = new Set(project.tracks.map((t) => t.id));
  const pending = staged.next.tracks.filter((t) => !have.has(t.id));
  if (pending.length === 0) return { tracks: project.tracks, names, pendingIds: new Set() };
  const tracks = [...project.tracks];
  const out = [...names];
  for (const t of pending) {
    const at = staged.next.tracks.indexOf(t);
    // 前面最近的一条已有（或已插入）轨道
    let insert = tracks.length;
    for (let k = at - 1; k >= 0; k -= 1) {
      const idx = tracks.findIndex((x) => x.id === staged.next.tracks[k].id);
      if (idx >= 0) {
        insert = idx + 1;
        break;
      }
    }
    tracks.splice(insert, 0, { ...t, lock: true });
    out.splice(insert, 0, trackName(staged.next, t));
  }
  return { tracks, names: out, pendingIds: new Set(pending.map((t) => t.id)) };
}
