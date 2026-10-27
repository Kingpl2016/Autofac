import { describe, expect, it } from "vitest";

/** 全部源码（原始文本）。 */
const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 匹配会在鼠标点击后也亮起外框的 `focus:` 前缀类（`focus-visible:` 与 `group-focus-visible:` 不会命中）。 */
const POINTER_FOCUS_DECORATION = /(?<![\w-])focus:(ring|outline-(?!none)|border|shadow)/;

describe("焦点环守卫", () => {
  it("源码里不使用 focus:ring 等会在点击后亮边的类，统一用 focus-visible:", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.includes("/__tests__/"))
      .filter(([, text]) => POINTER_FOCUS_DECORATION.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
