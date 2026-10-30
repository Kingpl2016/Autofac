// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";

vi.mock("@/features/ai/lib/api", () => ({
  aiHistoryLibraryPath: async (entry: string) => `D:/data/ai-history/${entry}.ai.json`,
  aiHistoryRead: async () => null,
  aiHistoryWrite: async () => undefined,
}));

import { useAiMemoryStore } from "@/features/ai/stores/useAiMemoryStore";
import { makeExemplar } from "../../../ai/memory";
import { useAiChatStore } from "../../../stores/useAiChatStore";
import { useAiExemplarStore } from "../../../stores/useAiExemplarStore";
import { AiMemoryPage } from "../AiMemoryPage";

const ex = (id: string, request: string) => ({ ...makeExemplar(request, `说明 ${id}`, [{ op: "editCues", cues: ["selection"] }])!, id });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  stubResizeObserver();
  useAiChatStore.setState({ notes: [], exemplars: [ex("e1", "副歌改蓝紫")], path: null });
  useAiExemplarStore.setState({ status: "ready", items: [ex("g1", "这个快一倍"), ex("g2", "主歌暗一点")] });
  useAiMemoryStore.setState({ status: "ready", prefs: [{ id: "u1", text: "不要频闪", enabled: true, createdAt: 0 }] });
});
afterEach(() => cleanup());

const renderPage = () =>
  render(
    <MemoryRouter>
      <AiMemoryPage />
    </MemoryRouter>,
  );

describe("AI 记忆页", () => {
  it("本工程笔记：添加、停用、删除", () => {
    renderPage();
    const notes = screen.getByRole("region", { name: "本工程笔记" });
    const input = within(notes).getByLabelText(/G1 是前排帕灯/);
    fireEvent.change(input, { target: { value: "G1 是前排帕灯" } });
    fireEvent.click(within(notes).getByRole("button", { name: "添加" }));
    expect(useAiChatStore.getState().notes.map((n) => n.text)).toEqual(["G1 是前排帕灯"]);
    fireEvent.click(within(notes).getByRole("switch", { name: "启用：G1 是前排帕灯" }));
    expect(useAiChatStore.getState().notes[0].enabled).toBe(false);
    fireEvent.click(within(notes).getByRole("button", { name: "删除：G1 是前排帕灯" }));
    expect(useAiChatStore.getState().notes).toEqual([]);
  });

  it("范例：本工程的可以停用、删除；共用的可以全部清空（要确认）", () => {
    renderPage();
    const mine = screen.getByRole("region", { name: "本工程范例" });
    expect(within(mine).getByText("“副歌改蓝紫”")).toBeTruthy();
    fireEvent.click(within(mine).getByRole("switch", { name: "启用：副歌改蓝紫" }));
    expect(useAiChatStore.getState().exemplars[0].enabled).toBe(false);
    fireEvent.click(within(mine).getByRole("button", { name: "删除：副歌改蓝紫" }));
    expect(useAiChatStore.getState().exemplars).toEqual([]);
    expect(within(mine).getByText(/还没有范例/)).toBeTruthy();

    const shared = screen.getByRole("region", { name: "所有工程共用的范例" });
    // 新的在前
    expect(within(shared).getAllByText(/^“/).map((e) => e.textContent)).toEqual(["“主歌暗一点”", "“这个快一倍”"]);
    fireEvent.click(within(shared).getByRole("button", { name: "全部清空" }));
    expect(useAiExemplarStore.getState().items).toHaveLength(2);
    fireEvent.click(within(shared).getByRole("button", { name: "确认清空" }));
    expect(useAiExemplarStore.getState().items).toEqual([]);
  });

  it("个人偏好显示条数并指向设置页", () => {
    renderPage();
    const prefs = screen.getByRole("region", { name: "个人偏好" });
    expect(within(prefs).getByText(/共 1 条/)).toBeTruthy();
    expect(within(prefs).getByRole("button", { name: /管理个人偏好/ })).toBeTruthy();
  });
});
