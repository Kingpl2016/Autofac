import { describe, expect, it, vi } from "vitest";

import { createNavRegistry, groupNavItems } from "../navigation";

const Icon = () => null;

describe("groupNavItems", () => {
  it("按分组归并并排序，空分组被省略", () => {
    const nav = createNavRegistry();
    nav.sections.register({ id: "program", labelKey: "p", order: 20 });
    nav.sections.register({ id: "signal", labelKey: "s", order: 10 });
    nav.sections.register({ id: "empty", labelKey: "e", order: 30 });
    nav.items.register({ id: "editor", to: "/editor", labelKey: "e", icon: Icon, section: "program", order: 10 });
    nav.items.register({ id: "forwarding", to: "/forwarding", labelKey: "f", icon: Icon, section: "signal", order: 20 });
    nav.items.register({ id: "home", to: "/", labelKey: "h", icon: Icon, section: "signal", order: 10 });

    const groups = groupNavItems(nav.sections.list(), nav.items.list());

    expect(groups.map((g) => g.section.id)).toEqual(["signal", "program"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["home", "forwarding"]);
  });

  it("引用未注册分组的导航项被忽略并告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nav = createNavRegistry();
    nav.sections.register({ id: "signal", labelKey: "s" });
    nav.items.register({ id: "x", to: "/x", labelKey: "x", icon: Icon, section: "ghost" });

    expect(groupNavItems(nav.sections.list(), nav.items.list())).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
