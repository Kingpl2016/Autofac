// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Button } from "../button";
import { FIELD_BASE } from "../fieldStyles";
import { Input } from "../input";
import { Switch } from "../switch";
import { Textarea } from "../textarea";

afterEach(() => cleanup());

describe("Button", () => {
  it("默认 44px 高（触控目标），带 data-slot 供个性化的“按下反馈”使用", () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.className).toContain("h-11");
    expect(button.getAttribute("data-slot")).toBe("button");
  });

  it("各变体都有悬停与按下态，状态切换带过渡（不是瞬间跳变）", () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "soft", "ghost"] as const) {
      render(<Button variant={variant}>{variant}</Button>);
      const cls = screen.getByRole("button", { name: variant }).className;
      expect(cls, variant).toContain("hover:");
      expect(cls, variant).toContain("active:");
      expect(cls, variant).toContain("duration-150");
      cleanup();
    }
  });

  it("loading：禁用点击、声明 aria-busy、显示旋转图标，且不触发 onClick", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        提交
      </Button>,
    );
    const button = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("图标按钮 loading 时用旋转图标替换原内容；不 loading 时没有 aria-busy", () => {
    const { rerender } = render(
      <Button size="icon" aria-label="刷新" loading>
        <span data-testid="icon" />
      </Button>,
    );
    expect(screen.queryByTestId("icon")).toBeNull();
    rerender(
      <Button size="icon" aria-label="刷新">
        <span data-testid="icon" />
      </Button>,
    );
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" }).getAttribute("aria-busy")).toBeNull();
  });

  it("asChild 时仍可渲染成链接并保留样式", () => {
    render(
      <Button asChild>
        <a href="/x">去看看</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "去看看" });
    expect(link.className).toContain("bg-primary");
  });
});

describe("输入类控件", () => {
  it("Input 与 Textarea 共用同一套外观，聚焦用边框 + 柔和外环，出错用 aria-invalid 驱动危险色", () => {
    render(
      <>
        <Input aria-label="名称" />
        <Textarea aria-label="备注" />
      </>,
    );
    for (const name of ["名称", "备注"]) {
      const cls = screen.getByLabelText(name).className;
      expect(cls).toContain(FIELD_BASE.split(" ")[0]);
      expect(cls).toContain("focus-visible:border-ring");
      expect(cls).toContain("aria-[invalid=true]:border-destructive");
      expect(cls).toContain("disabled:cursor-not-allowed");
    }
  });

  it("没有被换成 focus: 前缀（点击后不应亮实心焦点环）", () => {
    expect(FIELD_BASE).not.toMatch(/(?<![\w-])focus:/);
  });
});

describe("Switch", () => {
  it("尺寸为 44×24，点击切换选中，滑块位移跟随状态", () => {
    const onChange = vi.fn();
    render(<Switch aria-label="启用" onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "启用" });
    expect(toggle.className).toContain("h-6");
    expect(toggle.className).toContain("w-11");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("data-state")).toBe("checked");
  });
});
