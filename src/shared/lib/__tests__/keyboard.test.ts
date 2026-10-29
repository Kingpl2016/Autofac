// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useSlashToFocus, useWindowKeydown } from "@/shared/hooks/useWindowKeydown";
import { isInteractiveTarget, isTextEntry } from "../keyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

/** 在 body 里放一段 HTML，返回指定选择器命中的元素。 */
function mount(html: string, selector: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>(selector)!;
}

describe("isInteractiveTarget", () => {
  it.each([
    ["输入框", '<input id="x" />'],
    ["文本域", '<textarea id="x"></textarea>'],
    ["下拉", '<select id="x"><option>1</option></select>'],
    ["按钮", '<button id="x">go</button>'],
    ["链接", '<a id="x" href="#a">a</a>'],
    ["折叠摘要", '<details><summary id="x">s</summary></details>'],
    ["单选", '<input id="x" type="radio" />'],
    ["滑块", '<input id="x" type="range" />'],
    ["role=radio", '<div id="x" role="radio"></div>'],
    ["role=tab", '<div id="x" role="tab"></div>'],
    ["role=slider", '<div id="x" role="slider"></div>'],
  ])("%s 自己处理按键，全局快捷键不该抢", (_name, html) => {
    expect(isInteractiveTarget(mount(html, "#x"))).toBe(true);
  });

  it("位于按钮或对话框里的子元素同样算", () => {
    expect(isInteractiveTarget(mount('<button><span id="x">图标</span></button>', "#x"))).toBe(true);
    expect(isInteractiveTarget(mount('<div role="dialog"><p id="x">正文</p></div>', "#x"))).toBe(true);
  });

  it("contenteditable 元素算", () => {
    const el = mount('<div id="x" contenteditable="true"></div>', "#x");
    // jsdom 不实现 isContentEditable，这里按浏览器行为补上
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(isInteractiveTarget(el)).toBe(true);
  });

  it("普通内容、body 和非元素目标不算", () => {
    expect(isInteractiveTarget(mount('<div id="x">文字</div>', "#x"))).toBe(false);
    expect(isInteractiveTarget(document.body)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(window)).toBe(false);
  });
});

describe("isTextEntry", () => {
  it("只认文本输入控件，按钮不算", () => {
    expect(isTextEntry(mount('<input id="x" />', "#x"))).toBe(true);
    expect(isTextEntry(mount('<textarea id="x"></textarea>', "#x"))).toBe(true);
    expect(isTextEntry(mount('<select id="x"></select>', "#x"))).toBe(true);
    expect(isTextEntry(mount('<button id="x"></button>', "#x"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("useWindowKeydown / useSlashToFocus", () => {
  const press = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("enabled 为 false 时不监听；卸载后不再响应", () => {
    const fn = vi.fn();
    const { rerender, unmount } = renderHook(({ on }) => useWindowKeydown(fn, { enabled: on }), {
      initialProps: { on: false },
    });
    press("a");
    expect(fn).not.toHaveBeenCalled();
    rerender({ on: true });
    press("a");
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
    press("a");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("按 / 聚焦搜索框；在输入框里或带修饰键时不抢", () => {
    document.body.innerHTML = '<input id="search" /><input id="other" />';
    const search = document.getElementById("search") as HTMLInputElement;
    const other = document.getElementById("other") as HTMLInputElement;
    renderHook(() => useSlashToFocus({ current: search }));

    expect(press("/")).toBe(true);
    expect(document.activeElement).toBe(search);

    other.focus();
    expect(press("/", other)).toBe(false);
    expect(document.activeElement).toBe(other);

    other.blur();
    expect(press("/", window, { ctrlKey: true })).toBe(false);
  });
});
