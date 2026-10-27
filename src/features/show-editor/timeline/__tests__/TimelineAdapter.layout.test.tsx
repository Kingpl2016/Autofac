// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { TimelineAdapter } from "../TimelineAdapter";
import { CUE_EFFECT_ID, ROW_HEIGHT } from "../timelineData";

/**
 * 在 jsdom 里给元素“伪造”尺寸，让时间线库（基于 react-virtualized）真正渲染出轨道和块，
 * 用来确认我们依赖的类名、选中样式钩子和自定义渲染确实生效。
 */
const originals = new Map<string, PropertyDescriptor | undefined>();
const SIZED = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const key of SIZED) {
    originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get() {
        return key.endsWith("Width") ? 1200 : 400;
      },
    });
  }
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 400, width: 1200, height: 400, toJSON() {} };
  };
});

afterAll(() => {
  for (const key of SIZED) {
    const original = originals.get(key);
    if (original) Object.defineProperty(HTMLElement.prototype, key, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

afterEach(() => cleanup());

const rows = [
  {
    id: "t1",
    rowHeight: ROW_HEIGHT,
    actions: [
      { id: "c1", start: 1, end: 3, effectId: CUE_EFFECT_ID, selected: true, minStart: 0, maxEnd: 10 },
      { id: "c2", start: 4, end: 6, effectId: CUE_EFFECT_ID, selected: false, movable: false, flexible: false },
    ],
  },
];

describe("TimelineAdapter 真实渲染", () => {
  it("渲染轨道行和 Cue 块，使用我们的自定义内容与主题类名", () => {
    const { container } = render(
      <div style={{ width: 1200, height: 400 }}>
        <TimelineAdapter
          editorData={rows}
          scaleWidth={100}
          minScaleCount={20}
          maxScaleCount={20}
          getActionRender={(action) => <span data-testid={`cue-${action.id}`}>{action.id}</span>}
        />
      </div>,
    );
    // 库会在数据行之后再补一个撑满可视高度的空行，所以第一行才是我们的轨道
    const trackRow = container.querySelector(".timeline-editor-edit-row");
    expect(trackRow?.querySelectorAll(".timeline-editor-action")).toHaveLength(2);
    expect((trackRow as HTMLElement).style.height).toBe(`${ROW_HEIGHT}px`);
    const actions = container.querySelectorAll(".timeline-editor-action");
    expect(actions).toHaveLength(2);
    expect(container.querySelector("[data-testid=cue-c1]")).not.toBeNull();
    // 选中状态由库打上类名，主题 CSS 靠它画描边
    expect(actions[0].classList.contains("timeline-editor-action-selected")).toBe(true);
    expect(actions[1].classList.contains("timeline-editor-action-selected")).toBe(false);
    // 锁定轨道上的块没有 movable / flexible 类名
    expect(actions[0].classList.contains("timeline-editor-action-movable")).toBe(true);
    expect(actions[1].classList.contains("timeline-editor-action-movable")).toBe(false);
    expect(actions[1].classList.contains("timeline-editor-action-flexible")).toBe(false);
  });

  it("标尺使用我们传入的刻度文字", () => {
    const { container } = render(
      <div style={{ width: 1200, height: 400 }}>
        <TimelineAdapter
          editorData={rows}
          scaleWidth={100}
          minScaleCount={20}
          maxScaleCount={20}
          getScaleRender={(s) => `T${s}`}
        />
      </div>,
    );
    const labels = [...container.querySelectorAll(".timeline-editor-time-unit-scale")].map((n) => n.textContent);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels[0]).toBe("T0");
    expect(labels).toContain("T1");
  });
});
