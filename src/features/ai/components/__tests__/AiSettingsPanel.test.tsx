// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { AiProfileView } from "../../lib/types";

const api = vi.hoisted(() => ({
  aiProfilesList: vi.fn(),
  aiProfileSave: vi.fn(),
  aiProfileDelete: vi.fn(),
  aiKeySet: vi.fn(),
  aiHistoryLibraryPath: vi.fn(),
  aiHistoryRead: vi.fn(),
  aiHistoryWrite: vi.fn(),
}));
vi.mock("../../lib/api", () => api);
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));

import { useAiMemoryStore } from "../../stores/useAiMemoryStore";
import { useAiPrefsStore } from "../../stores/useAiPrefsStore";
import { AiSettingsPanel } from "../AiSettingsPanel";

const profile = (over: Partial<AiProfileView> = {}): AiProfileView => ({
  id: "p1",
  name: "DeepSeek",
  kind: "openaiCompatible",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  supportsStructuredOutputs: false,
  inputModalities: [],
  temperature: 0,
  seed: null,
  hasKey: true,
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  stubResizeObserver();
  Object.values(api).forEach((f) => f.mockReset());
  useAiPrefsStore.setState({ defaultProfileId: null, autoApply: false });
});
afterEach(() => cleanup());

describe("AiSettingsPanel", () => {
  it("没有配置时提示添加", async () => {
    api.aiProfilesList.mockResolvedValue([]);
    renderWithProviders(<AiSettingsPanel />);
    expect(await screen.findByText(/还没有 AI 配置/)).toBeTruthy();
  });

  it("列出配置；默认配置被删除时星标落在第一个", async () => {
    useAiPrefsStore.setState({ defaultProfileId: "gone" });
    api.aiProfilesList.mockResolvedValue([profile(), profile({ id: "p2", name: "本机", hasKey: false })]);
    renderWithProviders(<AiSettingsPanel />);
    expect(await screen.findByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("无 Key")).toBeTruthy();
    const stars = screen.getAllByRole("button", { name: "设为默认" });
    expect(stars.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    fireEvent.click(stars[1]);
    expect(useAiPrefsStore.getState().defaultProfileId).toBe("p2");
  });

  it("新建配置：按预设填好表单，保存后写入 Key", async () => {
    api.aiProfilesList.mockResolvedValue([]);
    api.aiProfileSave.mockResolvedValue(profile({ id: "new", hasKey: false }));
    api.aiKeySet.mockResolvedValue(undefined);
    renderWithProviders(<AiSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /添加配置/ }));
    expect((screen.getByLabelText("接口地址") as HTMLInputElement).value).toBe("https://api.deepseek.com/v1");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.aiKeySet).toHaveBeenCalledWith("new", "sk-1"));
    expect(api.aiProfileSave.mock.calls[0][0]).toMatchObject({ kind: "openaiCompatible", model: "deepseek-chat", temperature: 0 });
    // 第一个配置自动成为默认
    expect(useAiPrefsStore.getState().defaultProfileId).toBe("new");
  });

  it("删除要点两次确认", async () => {
    api.aiProfilesList.mockResolvedValue([profile()]);
    api.aiProfileDelete.mockResolvedValue(undefined);
    renderWithProviders(<AiSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(api.aiProfileDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.aiProfileDelete).toHaveBeenCalledWith("p1"));
  });

  it("列出内置技能（可用 / 点名）；总是允许的外部工具可以逐个撤销", async () => {
    api.aiProfilesList.mockResolvedValue([]);
    useAiPrefsStore.setState({ mcpAlwaysAllow: ["mcp__files__read_file", "mcp__web__fetch"] });
    renderWithProviders(<AiSettingsPanel />);
    expect(await screen.findByText("内置技能")).toBeTruthy();
    expect(screen.getByText("/song-structure")).toBeTruthy();
    expect(screen.getByText("总是允许的外部工具")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销“read_file”的总是允许" }));
    expect(useAiPrefsStore.getState().mcpAlwaysAllow).toEqual(["mcp__web__fetch"]);
  });

  it("自动写入开关写入偏好", async () => {
    api.aiProfilesList.mockResolvedValue([]);
    renderWithProviders(<AiSettingsPanel />);
    fireEvent.click(await screen.findByRole("switch", { name: "自动写入" }));
    expect(useAiPrefsStore.getState().autoApply).toBe(true);
  });

  it("个人偏好记忆：读入文件；添加、去重、编辑、停用、删除，每次都写回文件", async () => {
    const path = "D:/data/ai-history/memory-user.ai.json";
    const files = new Map([[path, JSON.stringify({ version: 1, items: [{ id: "u-1", text: "回复简短", enabled: true, createdAt: 1 }] })]]);
    api.aiProfilesList.mockResolvedValue([]);
    api.aiHistoryLibraryPath.mockImplementation(async (entry: string) => `D:/data/ai-history/${entry}.ai.json`);
    api.aiHistoryRead.mockImplementation(async (p: string) => files.get(p) ?? null);
    api.aiHistoryWrite.mockImplementation(async (p: string, text: string) => void files.set(p, text));
    useAiMemoryStore.setState({ status: "idle", prefs: [] });
    const saved = () => (JSON.parse(files.get(path) ?? "{}") as { items: { text: string; enabled: boolean }[] }).items;

    renderWithProviders(<AiSettingsPanel />);
    expect(await screen.findByText("回复简短")).toBeTruthy();
    const input = screen.getByLabelText(/例如：不要频闪/);
    fireEvent.change(input, { target: { value: "不要频闪" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(saved().map((m) => m.text)).toEqual(["回复简短", "不要频闪"]));
    // 同样的内容不重复存
    fireEvent.change(input, { target: { value: "不要频闪。" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("记忆里已经有这一条")).toBeTruthy();
    expect(useAiMemoryStore.getState().prefs).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "编辑：回复简短" }));
    const edit = screen.getByLabelText("编辑记忆");
    fireEvent.change(edit, { target: { value: "回复尽量简短" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    fireEvent.click(screen.getByRole("switch", { name: "启用：不要频闪" }));
    await waitFor(() => expect(saved()).toMatchObject([{ text: "回复尽量简短", enabled: true }, { text: "不要频闪", enabled: false }]));
    fireEvent.click(screen.getByRole("button", { name: "删除：回复尽量简短" }));
    await waitFor(() => expect(saved().map((m) => m.text)).toEqual(["不要频闪"]));
  });
});
