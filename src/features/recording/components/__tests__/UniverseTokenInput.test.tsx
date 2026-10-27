// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { UniverseTokenInput } from "../UniverseTokenInput";

let latest: string[] = [];

/** 受控包装：把片段保存在本地状态里，并暴露最新值给断言。 */
function Harness({ initial = [] as string[], disabled = false }) {
  const [tokens, setTokens] = useState(initial);
  return (
    <>
      <label htmlFor="u">范围</label>
      <UniverseTokenInput
        id="u"
        label="范围"
        tokens={tokens}
        onChange={(next) => {
          latest = next;
          setTokens(next);
        }}
        hintId="u-hint"
        disabled={disabled}
      />
      <p id="u-hint">说明</p>
    </>
  );
}

const input = () => screen.getByLabelText("范围", { selector: "input" }) as HTMLInputElement;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  latest = [];
});
afterEach(() => cleanup());

describe("UniverseTokenInput", () => {
  it("回车 / 逗号提交片段，重复片段自动合并", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "3-0" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "10" } });
    fireEvent.keyDown(input(), { key: "," });
    fireEvent.change(input(), { target: { value: "0-3" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(latest).toEqual(["0-3", "10"]);
    expect(input().value).toBe("");
    expect(screen.getByRole("list", { name: "范围" }).textContent).toContain("0-3");
  });

  it("粘贴自动拆分；无法识别的部分留在输入框里并说明原因", () => {
    render(<Harness />);
    fireEvent.paste(input(), { clipboardData: { getData: () => "0-3, 10, abc" } });
    expect(latest).toEqual(["0-3", "10"]);
    expect(input().value).toBe("abc");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    const err = screen.getByText(/无法识别：abc/);
    expect(input().getAttribute("aria-describedby")).toContain(err.id);
    expect(input().getAttribute("aria-describedby")).toContain("u-hint");

    // 继续输入即清除错误
    fireEvent.change(input(), { target: { value: "5" } });
    expect(screen.queryByText(/无法识别/)).toBeNull();
  });

  it("超出 ArtRec 范围的编号单独说明", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "2500" } });
    fireEvent.blur(input());
    expect(latest).toEqual([]);
    expect(screen.getByText(/超出 ArtRec 可表示范围（0–2047）：2500/)).toBeTruthy();
  });

  it("每个片段有带名称的删除按钮；输入为空时退格删除最后一个", () => {
    render(<Harness initial={["1", "2-4", "9"]} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 2-4" }));
    expect(latest).toEqual(["1", "9"]);
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(latest).toEqual(["1"]);
  });

  it("禁用时不显示删除按钮", () => {
    render(<Harness initial={["1"]} disabled />);
    expect(screen.queryByRole("button", { name: "移除 1" })).toBeNull();
    expect(input().disabled).toBe(true);
  });
});
