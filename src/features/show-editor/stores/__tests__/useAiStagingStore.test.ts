import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));

import { buildAliases } from "../../ai/aliases";
import type { CompileEnv } from "../../ai/compile";
import { aiOpsSchema } from "../../ai/opsSchema";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { applyStaged, makeStaged, useAiStagingStore } from "../useAiStagingStore";
import { useEditorUiStore } from "../useEditorUiStore";
import { useProjectStore } from "../useProjectStore";

const env: CompileEnv = { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [], lang: "zh", playheadMs: 0, selection: [] };
const ops = (list: unknown[]) => aiOpsSchema.parse({ summary: "s", ops: list }).ops;

/** 载入一个 3 台灯、16 秒、120 BPM 的工程，并按当前工程暂存一份改动。 */
function stageBreathe(list: unknown[] = [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "breathe" }]) {
  const base = useProjectStore.getState().project;
  const staged = makeStaged({ summary: "s", ops: ops(list), base, aliases: buildAliases(base), env, source: "chat" });
  if (!staged) throw new Error("应能暂存");
  useAiStagingStore.getState().stage(staged);
  return staged;
}

beforeEach(() => {
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 16_000;
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    }),
  );
  useAiStagingStore.setState({ staged: null, previewing: true });
});

describe("AI 改动的暂存与应用", () => {
  it("试运行有错误时不暂存", () => {
    const base = useProjectStore.getState().project;
    expect(makeStaged({ summary: "", ops: ops([{ op: "deleteCues", cues: ["C9"] }]), base, aliases: buildAliases(base), env, source: "chat" })).toBeNull();
  });

  it("工程没变：写入预览过的结果（一步撤销），选中新片段，清空暂存区", () => {
    const staged = stageBreathe();
    expect(staged.changes.map((c) => [c.collection, c.op])).toEqual([
      ["cues", "added"],
      ["groups", "added"],
    ]);
    const steps = useProjectStore.temporal.getState().pastStates.length;
    const r = applyStaged();
    expect(r.ok).toBe(true);
    const project = useProjectStore.getState().project;
    expect(project.cues).toEqual(staged.next.cues);
    // 没变的字段保持同一引用
    expect(project.fixtures).toBe(staged.base.fixtures);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect(useEditorUiStore.getState().selectedCueIds).toEqual(project.cues.map((c) => c.id));
    expect(useAiStagingStore.getState().staged).toBeNull();
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project.cues).toHaveLength(0);
  });

  it("期间手动改过工程：在当前工程上重新执行；对不上时不写入", () => {
    stageBreathe();
    useProjectStore.getState().update((d) => void (d.name = "改了名"));
    expect(applyStaged().ok).toBe(true);
    expect(useProjectStore.getState().project).toMatchObject({ name: "改了名" });
    expect(useProjectStore.getState().project.cues).toHaveLength(1);

    stageBreathe([{ op: "editCues", cues: ["C1"], brightness: 50 }]);
    useProjectStore.getState().update((d) => void (d.cues = []));
    expect(applyStaged()).toEqual({ ok: false, reason: "stale" });
  });

  it("配接与输出改动标为敏感", () => {
    expect(stageBreathe([{ op: "setOutput", mode: "broadcast" }]).sensitive).toBe(true);
    expect(stageBreathe().sensitive).toBe(false);
  });
});
