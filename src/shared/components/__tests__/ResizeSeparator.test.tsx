// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { clamp } from "@/shared/lib/math";
import { ResizeSeparator } from "../ResizeSeparator";

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
});
afterEach(() => cleanup());

/** 受控的宽度分隔条：右方向键变宽，拖动按横向位移。 */
function Harness(props: { preview?: boolean; homeTo?: "min" | "max"; onCommit?: (v: number) => void; onPreview?: (v: number) => void }) {
  const [value, setValue] = useState(100);
  const commit = (v: number) => {
    props.onCommit?.(v);
    setValue(v);
  };
  return (
    <ResizeSeparator
      orientation="vertical"
      value={value}
      min={50}
      max={300}
      label="宽度"
      step={10}
      bigStep={40}
      increaseKey="ArrowRight"
      homeTo={props.homeTo}
      dragValue={(start, p) => start.value + p.clientX - start.x}
      normalize={(v) => clamp(Math.round(v), 50, 300)}
      onPreview={props.preview ? props.onPreview : undefined}
      onCommit={commit}
      defaultValue={120}
    />
  );
}

const sep = () => screen.getByRole("separator", { name: "宽度" });
const now = () => sep().getAttribute("aria-valuenow");

describe("ResizeSeparator", () => {
  it("带分隔条语义与范围", () => {
    render(<Harness />);
    expect(sep().getAttribute("aria-orientation")).toBe("vertical");
    expect(sep().getAttribute("aria-valuemin")).toBe("50");
    expect(sep().getAttribute("aria-valuemax")).toBe("300");
    expect(now()).toBe("100");
    expect(sep().tabIndex).toBe(0);
  });

  it("方向键按步长调整（Shift 大步长），Home / End 到两端，处理过的按键不冒泡", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: "ArrowRight" });
    expect(now()).toBe("110");
    fireEvent.keyDown(sep(), { key: "ArrowLeft", shiftKey: true });
    expect(now()).toBe("70");
    fireEvent.keyDown(sep(), { key: "End" });
    expect(now()).toBe("300");
    fireEvent.keyDown(sep(), { key: "Home" });
    expect(now()).toBe("50");
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(sep(), { key: "a" });
    expect(outer).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", outer);
  });

  it("homeTo=max 时 Home / End 方向相反", () => {
    render(<Harness homeTo="max" />);
    fireEvent.keyDown(sep(), { key: "Home" });
    expect(now()).toBe("300");
    fireEvent.keyDown(sep(), { key: "End" });
    expect(now()).toBe("50");
  });

  it("没有预览时拖动每一步都提交，并夹在范围内；非主键不开始拖动", () => {
    render(<Harness />);
    fireEvent.pointerDown(sep(), { button: 2, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 50, pointerId: 1 });
    expect(now()).toBe("100");
    fireEvent.pointerDown(sep(), { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 30, pointerId: 1 });
    expect(now()).toBe("130");
    fireEvent.pointerMove(sep(), { clientX: 9999, pointerId: 1 });
    expect(now()).toBe("300");
    fireEvent.pointerUp(sep(), { pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 0, pointerId: 1 });
    expect(now()).toBe("300");
  });

  it("有预览时拖动只预览，松手且有变化才提交一次", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(<Harness preview onPreview={onPreview} onCommit={onCommit} />);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 40, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(140);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(140);

    // 没有移动的点击不提交
    fireEvent.pointerDown(sep(), { button: 0, clientX: 0, pointerId: 2 });
    fireEvent.pointerUp(sep(), { pointerId: 2 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("双击恢复默认值", () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: "End" });
    fireEvent.doubleClick(sep());
    expect(now()).toBe("120");
  });
});
