// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { InlineNameEditor } from "../InlineNameEditor";

function setup(initial = "", placeholder = "node-1") {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const outerKey = vi.fn();
  const outerClick = vi.fn();
  render(
    <div onKeyDown={outerKey} onClick={outerClick}>
      <InlineNameEditor
        initial={initial}
        placeholder={placeholder}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>,
  );
  return { onCommit, onCancel, outerKey, outerClick, input: screen.getByRole("textbox") as HTMLInputElement };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("InlineNameEditor", () => {
  it("自动聚焦，带出当前自定义名，占位符是设备自己的名字", () => {
    const { input } = setup("舞台左", "node-1");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("舞台左");
    expect(input.placeholder).toBe("node-1");
  });

  it("Enter 提交去掉首尾空白后的名称", () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: "  主舞台  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("主舞台");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("清空后 Enter 提交空串（表示清除自定义名）", () => {
    const { input, onCommit } = setup("旧名");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("Esc 取消，且不向外冒泡（不会连带关闭详情面板）", () => {
    const { input, onCommit, onCancel, outerKey } = setup("旧名");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(outerKey).not.toHaveBeenCalled();
  });

  it("输入时的方向键、字母键不会冒泡给表格快捷键", () => {
    const { input, outerKey } = setup();
    for (const key of ["ArrowDown", "f", "c", "F2"]) fireEvent.keyDown(input, { key });
    expect(outerKey).not.toHaveBeenCalled();
  });

  it("失去焦点视为取消，不保存", () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: "改了但没提交" } });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("提交之后再触发失焦不会被当成取消；也不会重复提交", () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("保存 / 取消按钮：按下鼠标时阻止失焦，点击生效", () => {
    const { input, onCommit, onCancel } = setup("旧名");
    const save = screen.getByRole("button", { name: "保存名称" });
    // mouseDown 被 preventDefault（返回 false）才能保证输入框不先失焦
    expect(fireEvent.mouseDown(save)).toBe(false);
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.click(save);
    expect(onCommit).toHaveBeenCalledWith("新名");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("取消按钮", () => {
    const { onCommit, onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("在编辑器内点击不会冒泡成“点击行”", () => {
    const { input, outerClick } = setup();
    fireEvent.click(input);
    expect(outerClick).not.toHaveBeenCalled();
  });
});