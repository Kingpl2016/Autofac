// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { DRAFT_PALETTES } from "../../lib/autoDraft";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { AutoDraftDialog } from "../AutoDraftDialog";

// 没有 AI 配置：对话框默认用“按规则生成”（AI 生成另有测试）
vi.mock("@/features/ai", async () => ({
  // 记忆的纯函数与 schema 用真的（对话记录的结构依赖它们）
  ...(await vi.importActual<typeof import("@/features/ai/lib/memory")>("@/features/ai/lib/memory")),
  memoryFile: () => ({ read: async () => null, write: async () => undefined }),
  useAiMemoryStore: { getState: () => ({ prefs: [], load: async () => undefined }) },
  useActiveAiProfile: () => ({ profiles: [], profile: null, loading: false }),
  useAiPrefsStore: { getState: () => ({ autoApply: false }) },
  loadLanguageModel: vi.fn(),
  aiErrorText: (_t: unknown, e: unknown) => String(e),
  isAiAbort: () => false,
}));

beforeAll(() => {
  // Radix 对话框在 jsdom 里需要
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 32_000;
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    }),
  );
  useEditorUiStore.setState({ draftOpen: true });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

describe("一键草稿对话框", () => {
  it("预览按 8 小节切分的编排，选配色后生成（一步撤销）并关闭", () => {
    render(<AutoDraftDialog />);
    const dialog = screen.getByRole("dialog", { name: "一键生成灯光草稿" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByText(/按 8 小节切分/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: /霓虹/ }));
    // 只有 RGBW 灯：摇头灯动作不可用
    expect(within(dialog).getByRole("switch", { name: "摇头灯加动作" }).hasAttribute("disabled")).toBe(true);
    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "生成 2 段" }));
    expect(project().groups.map((g) => g.name)).toEqual(["全部灯具"]);
    expect(project().cues).toHaveLength(2);
    const first = project().cues[0];
    expect(first.kind === "look" && first.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: DRAFT_PALETTES.neon[0] } });
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect(useAnnouncerStore.getState().message).toBe("已生成 2 个片段");
    expect(useEditorUiStore.getState().draftOpen).toBe(false);
  });

  it("没有节拍时提示并内嵌节拍分析；没有灯具时不能生成", () => {
    act(() => useProjectStore.getState().update((d) => void (d.tempo = null)));
    render(<AutoDraftDialog />);
    expect(screen.getByText(/需要先有节拍/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "从音乐分析" })).toBeTruthy();
    cleanup();
    act(() => useProjectStore.getState().load(produce(createEmptyProject("空"), (d) => void (d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 }))));
    render(<AutoDraftDialog />);
    expect(screen.getByRole("button", { name: "先添加灯具" }).hasAttribute("disabled")).toBe(true);
  });
});
