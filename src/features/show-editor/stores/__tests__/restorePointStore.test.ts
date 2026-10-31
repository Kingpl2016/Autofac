import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));
vi.mock("@/features/ai", async (orig) => ({
  ...(await orig<typeof import("@/features/ai")>()),
  aiHistoryLibraryPath: async (entry: string) => `D:/data/ai-history/${entry}.ai.json`,
  aiHistoryRead: async (path: string) => api.files.get(path) ?? null,
  aiHistoryWrite: async (path: string, text: string) => void api.files.set(path, text),
}));

import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type StaticCue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useProjectStore } from "../useProjectStore";
import { flushRestorePoints, reapplyRestorePoint, revertRestorePoint, switchRestorePoints, useRestorePointStore } from "../useRestorePointStore";

const cue = (trackId: string, id: string): StaticCue => ({
  id,
  kind: "static",
  trackId,
  startMs: 0,
  endMs: 1000,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  rgb: [1, 2, 3],
});

beforeEach(() => {
  api.files.clear();
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
    }),
  );
  useRestorePointStore.setState({ points: [], path: null, generation: -1 });
});

describe("还原点 store", () => {
  it("记下 AI 改动；撤回、重新应用都是一步撤销；按工程写进数据目录并能读回", async () => {
    await switchRestorePoints(1, { kind: "external", path: "D:/shows/a.artshow" } as never);
    const before = useProjectStore.getState().project;
    useProjectStore.getState().update((d) => {
      d.cues.push(cue(d.tracks[0].id, "ai"));
    });
    const after = useProjectStore.getState().project;
    useRestorePointStore.getState().record(before, after, { summary: "加一个片段", source: "chat" });
    const [point] = useRestorePointStore.getState().points;
    expect(point).toMatchObject({ summary: "加一个片段", state: "applied", cueCount: 1 });

    expect(revertRestorePoint(point.id)?.applied).toBe(1);
    expect(useProjectStore.getState().project.cues).toEqual([]);
    expect(useRestorePointStore.getState().points[0].state).toBe("reverted");
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project.cues.map((c) => c.id)).toEqual(["ai"]);
    useProjectStore.temporal.getState().redo();
    expect(reapplyRestorePoint(point.id)?.applied).toBe(1);
    expect(useProjectStore.getState().project.cues.map((c) => c.id)).toEqual(["ai"]);

    await flushRestorePoints();
    const [path] = [...api.files.keys()];
    expect(path).toMatch(/ai-history\/restore-external-[0-9a-f]{16}\.ai\.json$/);
    useRestorePointStore.setState({ points: [], path: null, generation: -1 });
    await switchRestorePoints(2, { kind: "external", path: "D:/shows/a.artshow" } as never);
    expect(useRestorePointStore.getState().points.map((p) => p.id)).toEqual([point.id]);
  });
});
