// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TimelineAdapter, type TimelineHandle } from "../TimelineAdapter";

// jsdom 没有 ResizeObserver，时间线库在挂载时会用它测量容器宽度
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => cleanup());

/**
 * 时间线库可行性验证（Task 1）：在 React 19 下能挂载，
 * 并且可通过命令式句柄同步播放头 —— 编辑器以后端时钟为准，靠 setTime 驱动光标。
 */
describe("TimelineAdapter（库可行性验证）", () => {
  it("能在 React 19 下挂载并渲染时间线容器", () => {
    const { container } = render(<TimelineAdapter editorData={[]} />);
    expect(container.querySelector(".timeline-editor")).not.toBeNull();
  });

  it("setTime / getTime 可用于同步播放头", () => {
    const ref = createRef<TimelineHandle>();
    render(<TimelineAdapter ref={ref} editorData={[]} />);
    expect(ref.current).not.toBeNull();
    act(() => ref.current?.setTime(2.5));
    expect(ref.current?.getTime()).toBeCloseTo(2.5, 5);
  });
});
