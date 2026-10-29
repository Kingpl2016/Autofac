// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MetricChip } from "../MetricChip";
import { Segmented } from "@/shared/components/Segmented";
import { StatusPill, type StatusTone } from "@/shared/components/StatusPill";
import { TimeCode } from "../TimeCode";

afterEach(() => cleanup());

const OPTIONS = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
] as const;

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [v, setV] = useState<string>("a");
  return (
    <Segmented
      ariaLabel="倍速"
      value={v}
      options={OPTIONS}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Segmented", () => {
  it("暴露 radiogroup / radio 语义，只有当前项在 Tab 序列里", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "倍速" })).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("方向键循环移动并选中，Home / End 回到两端", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];

    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radios()[1], { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");

    // 末项再按右键回到首项
    fireEvent.keyDown(radios()[2], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");

    fireEvent.keyDown(radios()[0], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(radios()[2], { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("manual 激活：方向键只移动焦点，Enter / Space（点击）才触发切换", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="模式"
        activation="manual"
        value="a"
        options={OPTIONS}
        onChange={onChange}
      />,
    );
    const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];

    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(radios()[1]);
    // 焦点移到 B 后，Tab 停靠点跟随焦点，已选项仍是 A
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radios()[1]);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("忙碌时整组禁用并声明 aria-busy；禁用项被方向键跳过", () => {
    const { rerender } = render(
      <Segmented ariaLabel="模式" busy value="a" options={OPTIONS} onChange={() => {}} />,
    );
    expect(screen.getByRole("radiogroup").getAttribute("aria-busy")).toBe("true");
    for (const r of screen.getAllByRole("radio")) expect((r as HTMLButtonElement).disabled).toBe(true);

    const onChange = vi.fn();
    rerender(
      <Segmented
        ariaLabel="模式"
        value="a"
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }, OPTIONS[2]]}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(screen.getAllByRole("radio")[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("c");
  });

  it("点击直接选中", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("TimeCode", () => {
  it("格式化当前时间与总时长", () => {
    render(<TimeCode valueUs={65_000_000} totalUs={3_725_000_000} />);
    expect(screen.getByText("1:05.0")).toBeTruthy();
    expect(screen.getByText("/ 1:02:05.0")).toBeTruthy();
  });

  it("不传总时长时只显示当前时间", () => {
    render(<TimeCode valueUs={5_000_000} />);
    expect(screen.getByText("0:05.0")).toBeTruthy();
    expect(screen.queryByText(/\//)).toBeNull();
  });
});

describe("StatusPill", () => {
  const tones: StatusTone[] = [
    "recording",
    "playing",
    "paused",
    "idle",
    "warning",
    "player",
    "ready",
    "error",
  ];

  it.each(tones)("%s 状态同时有图标和文字（不只靠颜色）", (tone) => {
    const { container } = render(<StatusPill tone={tone}>状态文字</StatusPill>);
    expect(screen.getByText("状态文字")).toBeTruthy();
    const icon = container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("MetricChip", () => {
  it("在 dl 中输出 dt / dd，warn 时使用警告样式", () => {
    const { container } = render(
      <dl>
        <MetricChip label="丢帧" value="3" warn />
      </dl>,
    );
    expect(container.querySelector("dt")?.textContent).toBe("丢帧");
    expect(container.querySelector("dd")?.textContent).toBe("3");
    expect(container.querySelector("dt")?.className).toContain("text-warning");
  });
});
