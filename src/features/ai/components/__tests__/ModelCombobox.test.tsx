// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";

const api = vi.hoisted(() => ({ aiListModels: vi.fn() }));
vi.mock("../../lib/api", () => api);

import { ModelCombobox } from "../ModelCombobox";

const query = { kind: "openaiCompatible" as const, baseUrl: "https://api.deepseek.com/v1", profileId: "p1", key: null };

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  stubResizeObserver();
  api.aiListModels.mockReset();
});
afterEach(() => cleanup());

function renderBox(value = "deepseek-chat") {
  const onChange = vi.fn();
  render(<ModelCombobox value={value} onChange={onChange} query={query} suggested={["deepseek-chat", "deepseek-reasoner"]} />);
  return onChange;
}

describe("ModelCombobox", () => {
  it("已经有值时仍然列出全部候选（拉取的 + 建议的），选中后回调", async () => {
    api.aiListModels.mockResolvedValue([{ id: "deepseek-v4", name: "deepseek-v4" }, { id: "deepseek-chat", name: "deepseek-chat" }]);
    const onChange = renderBox();
    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: /deepseek-v4/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /deepseek-reasoner/ })).toBeTruthy();
    expect(api.aiListModels).toHaveBeenCalledWith(query);
    fireEvent.click(screen.getByRole("option", { name: /deepseek-reasoner/ }));
    expect(onChange).toHaveBeenCalledWith("deepseek-reasoner");
  });

  it("可以使用不在列表里的模型", async () => {
    api.aiListModels.mockResolvedValue([]);
    const onChange = renderBox("");
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText("搜索或输入模型 id"), { target: { value: "my-model" } });
    fireEvent.click(await screen.findByRole("option", { name: "使用“my-model”" }));
    expect(onChange).toHaveBeenCalledWith("my-model");
  });

  it("拉取失败时说明原因，建议的模型仍可选", async () => {
    api.aiListModels.mockRejectedValue({ code: "unauthorized", message: "x" });
    renderBox();
    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/拒绝/);
    expect(screen.getByRole("option", { name: /deepseek-chat/ })).toBeTruthy();
    // 刷新再拉一次
    api.aiListModels.mockResolvedValue([{ id: "x", name: "x" }]);
    fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /^x/ })).toBeTruthy());
  });
});
