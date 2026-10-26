// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { ConfirmDialog } from "../ConfirmDialog";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

function setup(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="删除目的地“A”？"
      description="此操作无法撤销。"
      confirmLabel="删除"
      destructive
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe("ConfirmDialog", () => {
  it("显示标题与说明", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("删除目的地“A”？")).toBeTruthy();
    expect(screen.getByText("此操作无法撤销。")).toBeTruthy();
  });

  it("确认：执行回调并关闭", () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("取消：只关闭，不执行回调", () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("关闭状态不渲染", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});