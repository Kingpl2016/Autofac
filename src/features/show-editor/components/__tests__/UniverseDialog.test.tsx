// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import type { Device } from "@/shared/domain/device";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { addMirror } from "../../lib/universeOps";
import { RGBW } from "../../lib/__tests__/testkit";
import { useProjectStore } from "../../stores/useProjectStore";
import { UniverseDialog } from "../UniverseDialog";
import { makeDevice } from "@/test/factories";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useEngineDataStore.setState({ devices: [] });
  // 两台灯：U0，其中一台镜像到 U2
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      addMirror(d, d.fixtures[0].id, { universe: 2, address: 1 });
    }),
  );
});

afterEach(() => cleanup());

const node: Device = makeDevice({
  ip: "10.0.0.9",
  customName: "舞台节点",
  artnetPorts: 2,
  ports: [
    { index: 0, direction: "output", universe: 32, active: false },
    { index: 1, direction: "output", universe: 33, active: false },
  ],
});

describe("UniverseDialog", () => {
  it("空表时提示；补全用到的 Universe 后列出容量，打开按表路由", () => {
    render(<UniverseDialog open onOpenChange={() => undefined} />);
    expect(screen.getByText(/路由表是空的/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "补全用到的 Universe" }));
    expect(project().output.universes.map((u) => u.universe)).toEqual([0, 2]);
    const meter = screen.getByRole("meter", { name: "Universe 0 的通道占用" });
    expect(meter.getAttribute("aria-valuenow")).toBe("8");

    expect(project().output.target.kind).not.toBe("routed");
    fireEvent.click(screen.getByRole("switch", { name: "按 Universe 表路由输出" }));
    expect(project().output.target).toEqual({ kind: "routed" });
    // 可撤销
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().output.target.kind).not.toBe("routed");
  });

  it("非法 IP 就地报错；改成合法地址后消失", () => {
    render(<UniverseDialog open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "补全用到的 Universe" }));
    const ip = screen.getAllByRole("textbox", { name: /IP 地址/ })[0];
    fireEvent.change(ip, { target: { value: "10.0.0.300" } });
    fireEvent.blur(ip);
    expect(screen.getByRole("alert").textContent).toContain("不是合法的 IPv4");
    expect(screen.getByText(/1 个端口设置有误/)).toBeTruthy();
    const again = screen.getAllByRole("textbox", { name: /IP 地址/ })[0];
    fireEvent.change(again, { target: { value: "10.0.0.30" } });
    fireEvent.blur(again);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(project().output.universes[0].ports[0].ip).toBe("10.0.0.30");
  });

  it("从发现的节点一键分配：按 Universe 顺序对应节点输出口", () => {
    useEngineDataStore.setState({ devices: [node] });
    render(<UniverseDialog open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "从发现的节点分配（2 个输出口）" }));
    const table = project().output.universes;
    expect(table.map((u) => [u.universe, u.label, u.ports[0].ip, u.ports[0].remoteUniverse])).toEqual([
      [0, "舞台节点 #1", "10.0.0.9", 32],
      [2, "舞台节点 #2", "10.0.0.9", 33],
    ]);
    // Art-Net 远端 Universe 旁显示 Net:Sub:Uni
    const card = screen.getByRole("textbox", { name: "Universe 0 的名称" }).closest("li") as HTMLElement;
    expect(within(card).getByText("0:2:0")).toBeTruthy();
  });

  it("帧同步：ArtSync 开关与 sACN 同步 Universe", () => {
    render(<UniverseDialog open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole("switch", { name: "ArtSync" }));
    expect(project().output.sync.artSync).toBe(true);
    const sync = screen.getByRole("textbox", { name: "sACN 同步 Universe" });
    fireEvent.change(sync, { target: { value: "9" } });
    fireEvent.blur(sync);
    expect(project().output.sync.sacnSyncUniverse).toBe(9);
    const again = screen.getByRole("textbox", { name: "sACN 同步 Universe" });
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.blur(again);
    expect(project().output.sync.sacnSyncUniverse).toBeNull();
  });
});
