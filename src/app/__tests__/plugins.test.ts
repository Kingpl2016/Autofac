// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

import en from "@/shared/i18n/locales/en.json";
import zh from "@/shared/i18n/locales/zh.json";
import { groupNavItems } from "@/shared/plugin";
import { createTestHost } from "@/shared/plugin/testing";
import type { PluginHost } from "@/shared/plugin";
import { appPlugins } from "../plugins";

/** 按 `a.b.c` 取语言包里的值。 */
function lookup(pack: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], pack);
}

let host: PluginHost;

beforeAll(async () => {
  ({ host } = await createTestHost(appPlugins));
});

describe("应用插件清单", () => {
  it("导航分组与导航项的顺序与原先硬编码的侧栏一致", () => {
    const groups = groupNavItems(host.nav.sections.list(), host.nav.items.list());
    expect(groups.map((g) => [g.section.id, g.items.map((i) => i.to)])).toEqual([
      ["signal", ["/", "/universes", "/discovery", "/forwarding", "/signal-flow"]],
      ["program", ["/recording", "/library", "/editor", "/thing-model"]],
      ["network", ["/network"]],
      ["system", ["/settings", "/about"]],
    ]);
  });

  it("不包含已移除的“回路配置”和“场景队列”", () => {
    const paths = host.nav.items.list().map((i) => i.to);
    expect(paths).not.toContain("/loops");
    expect(paths).not.toContain("/scenes");
    for (const pack of [zh, en]) {
      expect(lookup(pack, "nav.loops")).toBeUndefined();
      expect(lookup(pack, "nav.scenes")).toBeUndefined();
    }
  });

  it("依赖实时信号的导航项被标记 liveOnly，且对应路由带有模式守卫", () => {
    const liveOnly = host.nav.items.list().filter((i) => i.liveOnly).map((i) => i.to);
    expect(liveOnly.toSorted()).toEqual(["/discovery", "/recording", "/universes"]);
    const guarded = host.routes.list().filter((r) => r.guard).map((r) => r.path);
    expect(guarded.toSorted()).toEqual(["discovery", "universes"]);
  });

  it("每个导航项的文案和分组标题在中英文语言包里都存在", () => {
    const keys = [
      ...host.nav.items.list().map((i) => i.labelKey),
      ...host.nav.sections.list().map((s) => s.labelKey),
    ];
    for (const key of keys) {
      expect(typeof lookup(zh, key), key).toBe("string");
      expect(typeof lookup(en, key), key).toBe("string");
    }
  });

  it("路径不重复，每个有导航的页面都有对应路由", () => {
    const navPaths = host.nav.items.list().map((i) => i.to);
    expect(new Set(navPaths).size).toBe(navPaths.length);

    const routePaths = host.routes.list().map((r) => (r.index ? "/" : `/${r.path}`));
    expect(new Set(routePaths).size).toBe(routePaths.length);
    for (const to of navPaths) expect(routePaths, to).toContain(to);
  });

  it("播放器页有路由但没有独立导航入口；编辑器占满内容区", () => {
    const routes = host.routes.list();
    expect(routes.some((r) => r.path === "player")).toBe(true);
    expect(host.nav.items.list().some((i) => i.to === "/player")).toBe(false);
    expect(routes.find((r) => r.path === "editor")?.handle).toEqual({ fullBleed: true, playerMode: true });
    // 节目库与节目编辑页进入即进入播放器模式
    expect(routes.filter((r) => r.handle?.playerMode).map((r) => r.path).toSorted()).toEqual(["editor", "library", "library/edit"]);
  });
});
