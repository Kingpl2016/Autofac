/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 直接读文件：vitest 默认不会给 CSS 的 ?raw 导入返回内容
const css = readFileSync(new URL("../appearance.css", import.meta.url), "utf8");

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
const productionSources = Object.entries(sources)
  .filter(([file]) => !file.includes("/__tests__/"))
  .map(([, text]) => text)
  .join("\n");

/** 取出样式表里用到的某类属性选择器的值，如 data-layout="sidebar" 里的 sidebar。 */
function selectorValues(attribute: string): string[] {
  const found = new Set<string>();
  for (const match of css.matchAll(new RegExp(`\\[${attribute}=["']([\\w-]+)["']\\]`, "g"))) found.add(match[1]);
  return [...found];
}

describe("个性化样式表的钩子都有对应的元素", () => {
  it("data-layout：样式表用到的布局钩子，主布局里都带上了", () => {
    const values = selectorValues("data-layout");
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(productionSources, `data-layout="${value}"`).toContain(`data-layout="${value}"`);
    }
  });

  it("data-slot：样式表用到的组件标记，组件里都带上了（否则对应的个性化设置不会起作用）", () => {
    const values = selectorValues("data-slot");
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(productionSources, `data-slot="${value}"`).toContain(`data-slot="${value}"`);
    }
  });

  it("data-surface：分层面板带上了卡片风格的钩子", () => {
    expect(productionSources).toContain("data-surface");
    // 页面里手写的主要面板
    for (const file of ["SurfacePanel", "UniverseCard", "DeviceDetailPanel", "DiscoveryView", "UniversesView"]) {
      const entry = Object.entries(sources).find(([path]) => path.endsWith(`/${file}.tsx`) && !path.includes("__tests__"));
      expect(entry?.[1], file).toContain("data-surface");
    }
  });

  it("加载占位统一使用 Skeleton，开启“骨架屏流光”后全部生效", () => {
    const leftovers = Object.entries(sources)
      .filter(([file]) => !file.includes("/__tests__/") && !file.endsWith("/components/ui/skeleton.tsx"))
      .filter(([, text]) => /animate-pulse[^"]*bg-(surface-1|surface-2|muted)/.test(text))
      .map(([file]) => file);
    expect(leftovers).toEqual([]);
  });
});

describe("侧栏折叠把手", () => {
  const sidebarSource = readFileSync(new URL("../../layouts/Sidebar.tsx", import.meta.url), "utf8");

  it("侧栏整体带 z-20：把手半悬在侧栏外，玻璃/悬浮样式下不能被内容列盖住", () => {
    const aside = sidebarSource.slice(sidebarSource.indexOf("<aside"), sidebarSource.indexOf("</aside>"));
    expect(aside).toMatch(/"relative z-20 /);
  });

  it("悬浮样式四周留间距，把手右半边有位置可点", () => {
    const rule = css.match(/\[data-sidebar-style="floating"\] \[data-layout="sidebar"\] \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/margin:\s*0\.5rem;/);
  });
});
