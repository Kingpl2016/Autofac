// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { installNativeGuards, isBrowserShortcut, keepsNativeMenu } from "../nativeGuards";

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
});

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

describe("屏蔽浏览器自带交互", () => {
  it("文本输入框、可编辑区域与标记的元素保留浏览器右键菜单", () => {
    document.body.innerHTML = `
      <input id="text" type="text" /><input id="range" type="range" /><textarea id="area"></textarea>
      <div contenteditable="true"><span id="editable">x</span></div>
      <div data-native-contextmenu><b id="marked">x</b></div><button id="btn">x</button>`;
    const el = (id: string) => document.getElementById(id);
    expect(keepsNativeMenu(el("text"))).toBe(true);
    expect(keepsNativeMenu(el("area"))).toBe(true);
    expect(keepsNativeMenu(el("editable"))).toBe(true);
    expect(keepsNativeMenu(el("marked"))).toBe(true);
    expect(keepsNativeMenu(el("range"))).toBe(false);
    expect(keepsNativeMenu(el("btn"))).toBe(false);
    expect(keepsNativeMenu(null)).toBe(false);
  });

  it("识别刷新、打印、查找、源码、开发者工具等浏览器快捷键；应用快捷键不受影响", () => {
    for (const e of [key("F5"), key("r", { ctrl: true }), key("R", { ctrl: true, shift: true }), key("p", { ctrl: true }), key("f", { ctrl: true }), key("u", { ctrl: true }), key("F12"), key("I", { ctrl: true, shift: true }), key("F7")]) {
      expect(isBrowserShortcut(e)).toBe(true);
    }
    for (const e of [key("b", { ctrl: true }), key("z", { ctrl: true }), key("s", { ctrl: true }), key("r", { alt: true }), key("r"), key(" "), key("k", { ctrl: true })]) {
      expect(isBrowserShortcut(e)).toBe(false);
    }
  });

  it("安装后：右键默认菜单被阻止（输入框除外）；发布版阻止浏览器快捷键，开发版放行；开关可临时恢复右键菜单", () => {
    document.body.innerHTML = `<div id="area">x</div><input id="text" type="text" />`;
    let allow = false;
    dispose = installNativeGuards(window, { dev: false, allowNativeMenu: () => allow });
    const fire = (id: string, type: "contextmenu") => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true });
      document.getElementById(id)?.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire("area", "contextmenu")).toBe(true);
    expect(fire("text", "contextmenu")).toBe(false);
    allow = true;
    expect(fire("area", "contextmenu")).toBe(false);

    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press({ key: "F5" })).toBe(true);
    expect(press({ key: "b", ctrlKey: true })).toBe(false);
    dispose();
    dispose = installNativeGuards(window, { dev: true, allowNativeMenu: () => false });
    expect(press({ key: "F5" })).toBe(false);
  });
});
