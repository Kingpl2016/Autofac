import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { buildContextMenu, type MenuEntry } from "../contextMenus";
import { addStaticCue } from "../cueOps";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { RGBW } from "./testkit";

function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    const ids = addFixtures(d, RGBW, 2);
    createGroup(d, "前排", ids);
    addStaticCue(d, d.tracks[0].id, 0);
    d.media.push({ id: "v", kind: "video", path: "v.mp4", name: "v.mp4", durationMs: 5000 });
    d.mediaTracks.push({ id: "mt", kind: "video", name: "视频", mute: false, solo: false, lock: false, volume: 1 });
    d.mediaClips.push({ id: "mc", trackId: "mt", mediaId: "v", startMs: 0, inMs: 0, durationMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
  });
}

const ctx = { selectedTrackIds: [] as string[], hasClipboard: false };
/** 菜单项的简写：命令 id / 动作 id / `-` / `tags` */
const ids = (m: MenuEntry[]) => m.map((e) => (e.kind === "separator" ? "-" : e.kind === "tags" ? "tags" : e.id));
const action = (m: MenuEntry[], id: string) => m.find((e) => e.kind === "action" && e.id === id) as Extract<MenuEntry, { kind: "action" }>;

describe("右键菜单内容", () => {
  it("静态片段：剪辑命令、标签子菜单、转为外观；目标不存在时为空", () => {
    const p = base();
    const m = buildContextMenu({ kind: "cue", id: p.cues[0].id }, p, ctx);
    expect(ids(m)).toContain("edit.cut");
    expect(ids(m)).toContain("tags");
    expect(ids(m)).toContain("convertToLook");
    expect(ids(m)).not.toContain("saveAsPreset");
    expect(ids(m).at(-1)).toBe("edit.rippleDelete");
    expect(buildContextMenu({ kind: "cue", id: "gone" }, p, ctx)).toEqual([]);
  });

  it("视频片段带像素映射与静音开关", () => {
    const p = base();
    const m = buildContextMenu({ kind: "mediaClip", id: "mc" }, p, ctx);
    expect(ids(m)).toContain("pixelMap");
    expect(action(m, "toggleClipMute").checked).toBe(false);
  });

  it("轨道头：按轨道类型给出删除文案；分组可连同成员删除；多选时作用于全部选中轨道", () => {
    const p = base();
    const fixture = p.tracks.find((t) => t.target.kind === "fixture")!;
    const group = p.tracks.find((t) => t.target.kind === "group")!;
    const one = buildContextMenu({ kind: "track", id: fixture.id }, p, ctx);
    expect(action(one, "deleteTracks")).toMatchObject({ labelKey: "editor.context.deleteFixture", destructive: true });
    expect(action(one, "pasteHere").disabled).toBe(true);
    expect(ids(one)).not.toContain("deleteGroupWithMembers");

    const g = buildContextMenu({ kind: "track", id: group.id }, p, { ...ctx, hasClipboard: true });
    expect(action(g, "deleteTracks").labelKey).toBe("editor.context.deleteGroup");
    expect(ids(g)).toContain("deleteGroupWithMembers");
    expect(action(g, "pasteHere").disabled).toBe(false);

    const sel = p.tracks.map((t) => t.id);
    const many = buildContextMenu({ kind: "track", id: fixture.id }, p, { ...ctx, selectedTrackIds: sel });
    expect(action(many, "deleteTracks")).toMatchObject({ labelKey: "editor.context.deleteTracks", labelArgs: { count: sel.length } });
    expect(action(many, "addCueHere").labelKey).toBe("editor.context.addCueTracks");
    expect(ids(many)).not.toContain("deleteGroupWithMembers");
    // 多台灯具：编组 / 同步按选中的灯具轨道计数；分组轨道没有批量项
    expect(action(many, "groupTracks").labelArgs).toEqual({ count: 2 });
    expect(ids(many)).toContain("syncTracks");
    expect(ids(one)).toContain("selectSameModel");
    expect(ids(one)).not.toContain("groupTracks");
    expect(ids(g)).not.toContain("selectSameModel");
  });

  it("空白处：没有轨道或轨道锁定时不能新建；标尺：0 处不能设结尾", () => {
    const p = produce(base(), (d) => {
      d.tracks[0].lock = true;
    });
    expect(action(buildContextMenu({ kind: "empty", trackId: null, timeMs: 0 }, p, ctx), "addCueHere").disabled).toBe(true);
    expect(action(buildContextMenu({ kind: "empty", trackId: p.tracks[0].id, timeMs: 0 }, p, ctx), "addCueHere").disabled).toBe(true);
    expect(action(buildContextMenu({ kind: "empty", trackId: p.tracks[1].id, timeMs: 0 }, p, ctx), "addCueHere").disabled).toBe(false);
    expect(action(buildContextMenu({ kind: "ruler", timeMs: 0 }, p, ctx), "endHere").disabled).toBe(true);
    expect(action(buildContextMenu({ kind: "ruler", timeMs: 5000 }, p, ctx), "endHere").disabled).toBe(false);
  });

  it("媒体轨道头：开关反映当前状态", () => {
    const p = produce(base(), (d) => {
      d.mediaTracks[0].solo = true;
    });
    const m = buildContextMenu({ kind: "mediaTrack", id: "mt" }, p, ctx);
    expect(action(m, "toggleMediaSolo").checked).toBe(true);
    expect(action(m, "toggleMediaMute").checked).toBe(false);
  });
});
