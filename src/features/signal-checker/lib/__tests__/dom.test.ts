// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isInteractiveTarget } from "../dom";

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
