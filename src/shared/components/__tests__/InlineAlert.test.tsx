// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { InlineAlert } from "../InlineAlert";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("InlineAlert", () => {
  it("默认礼貌播报（status），带图标与文字", () => {
    render(<InlineAlert>空间偏低</InlineAlert>);
    const el = screen.getByRole("status");
    expect(el.textContent).toBe("空间偏低");
    expect(el.querySelector("svg")).toBeTruthy();
    expect(el.className).toContain("text-warning");
  });

  it("assertive 时用 alert 角色；提供 onDismiss 时显示可读名称的关闭按钮", () => {
    const onDismiss = vi.fn();
    render(
      <InlineAlert tone="destructive" assertive onDismiss={onDismiss}>
        已停止
      </InlineAlert>,
    );
    expect(screen.getByRole("alert").className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
