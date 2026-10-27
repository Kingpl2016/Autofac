// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { createPluginHost, PluginHostContext, type PluginHost } from "@/shared/plugin";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { getDefaultSettings } from "../../lib/appearanceSettings";
import { registerBuiltinPresets } from "../../lib/presets/builtinPresets";
import { useAppearanceStore } from "../../stores/useAppearanceStore";
import { PANEL_WIDTH, clampPanelWidth, usePanelPrefsStore } from "../../stores/usePanelPrefsStore";
import { usePanelStore } from "../../stores/usePanelStore";
import { AppearanceSheet } from "../AppearanceSheet";
import { AppearanceTrigger } from "../AppearanceTrigger";

// Radix Slider 依赖 ResizeObserver，jsdom 里没有
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

let host: PluginHost;

function renderPanel() {
  return render(
    <PluginHostContext value={host}>
      <AppearanceTrigger />
      <AppearanceSheet />
    </PluginHostContext>,
  );
}

/** Radix 标签页在鼠标按下时激活（而不是 click）。 */
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  host = createPluginHost();
  registerBuiltinPresets(host.appearance);
  useAppearanceStore.getState().replaceSettings(getDefaultSettings());
  usePanelStore.setState({ open: false, tab: "colors" });
  usePanelPrefsStore.setState({ width: PANEL_WIDTH.default, previewOpen: false });
});

afterEach(() => cleanup());

describe("个性化面板", () => {
  it("点击顶栏按钮后弹出面板；默认比原来的 24rem 更宽", () => {
    renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.style.getPropertyValue("--appearance-panel-width")).toBe("32rem");
    expect(dialog.className).toContain("sm:w-(--appearance-panel-width)");
    // 不再被 max-w-sm（24rem）限制
    expect(dialog.className).toContain("sm:max-w-full");
  });

  it("宽度预设与键盘调整会更新面板宽度，并限制在允许范围内", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    fireEvent.click(screen.getByRole("button", { name: "宽" }));
    expect(screen.getByRole("dialog").style.getPropertyValue("--appearance-panel-width")).toBe("42rem");

    const handle = screen.getByRole("separator", { name: "拖动调整面板宽度" });
    fireEvent.keyDown(handle, { key: "End" });
    expect(usePanelPrefsStore.getState().width).toBe(PANEL_WIDTH.max);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(usePanelPrefsStore.getState().width).toBe(PANEL_WIDTH.max);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(usePanelPrefsStore.getState().width).toBe(PANEL_WIDTH.min);
  });

  it("clampPanelWidth：取整到 0.5rem，越界与非法值回到范围内", () => {
    expect(clampPanelWidth(31.3)).toBe(31.5);
    expect(clampPanelWidth(5)).toBe(PANEL_WIDTH.min);
    expect(clampPanelWidth(500)).toBe(PANEL_WIDTH.max);
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_WIDTH.default);
  });

  it("颜色标签页：明暗模式提供“跟随系统”，选择后更新设置", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    const group = screen.getByRole("region", { name: "明暗模式" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    expect(within(group).getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: "跟随系统" }));
    expect(useAppearanceStore.getState().mode).toBe("system");
  });

  it("颜色标签页：选择主题和主色会写入设置；选默认主题则清除覆盖", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    fireEvent.click(screen.getByRole("button", { name: "海洋" }));
    expect(useAppearanceStore.getState().theme?.id).toBe("ocean");
    expect(useAppearanceStore.getState().theme?.tokens.dark["--background"]).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "玫红" }));
    expect(useAppearanceStore.getState().accent).toEqual({ id: "rose", color: "#e11d48" });
    expect(screen.getByRole("button", { name: "玫红" }).getAttribute("aria-pressed")).toBe("true");

    const themeSection = screen.getByRole("region", { name: "主题" });
    fireEvent.click(within(themeSection).getByRole("button", { name: "默认" }));
    expect(useAppearanceStore.getState().theme).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(useAppearanceStore.getState().accent).toBeNull();
  });

  it("颜色标签页：自定义取色会以 custom 保存", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    fireEvent.click(screen.getByRole("button", { name: "自定义主色" }));
    fireEvent.change(screen.getByRole("textbox", { name: "十六进制颜色" }), { target: { value: "#ff8800" } });

    expect(useAppearanceStore.getState().accent).toEqual({ id: "custom", color: "#ff8800" });
  });

  it("所选主色对按钮文字的对比度会显示出来", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    expect(screen.queryByText(/按钮文字对比度/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "蓝色" }));
    expect(screen.getByText(/按钮文字对比度 \d+\.\d:1/)).toBeTruthy();
  });

  it("标签页：颜色 / 形状与字体 / 卡片 / 特效 / 布局（没有“高级”）", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "颜色",
      "形状与字体",
      "卡片",
      "特效",
      "布局",
    ]);
  });

  it("形状与字体标签页：圆角预设、字体、密度；界面缩放滑块", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("形状与字体");

    const radius = within(screen.getByRole("region", { name: "圆角" }));
    fireEvent.click(radius.getByRole("button", { name: "直角" }));
    expect(useAppearanceStore.getState().radius).toBe(0);
    fireEvent.click(radius.getByRole("button", { name: "圆润" }));
    expect(useAppearanceStore.getState().radius).toBe(1.25);

    // 字体：默认字体是“不覆盖”，选其它字体写入字体栈，再选回默认则清除
    const fonts = within(screen.getByRole("region", { name: "字体" }));
    fireEvent.click(fonts.getByRole("button", { name: "微软雅黑" }));
    expect(useAppearanceStore.getState().font?.id).toBe("yahei");
    fireEvent.click(fonts.getByRole("button", { name: "默认（Inter）" }));
    expect(useAppearanceStore.getState().font).toBeNull();

    const density = within(screen.getByRole("region", { name: "界面密度" }));
    fireEvent.click(density.getByRole("button", { name: "紧凑" }));
    expect(useAppearanceStore.getState().density).toBe("compact");

    expect(screen.getByRole("slider", { name: "界面缩放比例" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "基础圆角" })).toBeTruthy();
  });

  it("卡片标签页：样式、阴影、圆角、内边距、描边与悬停反馈", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("卡片");

    const style = within(screen.getByRole("region", { name: "卡片样式" }));
    expect(style.getAllByRole("button")).toHaveLength(6);
    // 悬浮样式靠阴影区分层次：阴影还是默认的“轻”时顺手提到“中”
    fireEvent.click(style.getByRole("button", { name: "悬浮" }));
    expect(useAppearanceStore.getState()).toMatchObject({ cardStyle: "elevated", cardShadow: "md" });
    // 毛玻璃出现模糊半径滑块
    fireEvent.click(style.getByRole("button", { name: "毛玻璃" }));
    expect(screen.getByRole("slider", { name: "毛玻璃模糊半径" })).toBeTruthy();

    // 扁平样式没有阴影，阴影选项被禁用
    fireEvent.click(style.getByRole("button", { name: "扁平" }));
    const shadow = within(screen.getByRole("region", { name: "阴影" }));
    expect((shadow.getByRole("button", { name: "重" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(style.getByRole("button", { name: "描边" }));
    fireEvent.click(shadow.getByRole("button", { name: "重" }));
    expect(useAppearanceStore.getState().cardShadow).toBe("lg");

    const radius = within(screen.getByRole("region", { name: "卡片圆角" }));
    fireEvent.click(radius.getByRole("button", { name: "圆润" }));
    expect(useAppearanceStore.getState().cardRadius).toBe(2);
    fireEvent.click(radius.getByRole("button", { name: "跟随全局" }));
    expect(useAppearanceStore.getState().cardRadius).toBeNull();

    fireEvent.click(within(screen.getByRole("region", { name: "内边距" })).getByRole("button", { name: "紧凑" }));
    expect(useAppearanceStore.getState().cardPadding).toBe("compact");

    const border = within(screen.getByRole("region", { name: "描边" }));
    fireEvent.click(border.getByRole("button", { name: "3px" }));
    expect(useAppearanceStore.getState().cardBorderWidth).toBe(3);
    fireEvent.click(border.getByRole("switch", { name: "渐变描边" }));
    fireEvent.click(border.getByRole("switch", { name: "发光边框" }));
    expect(useAppearanceStore.getState()).toMatchObject({ cardGradientBorder: true, cardGlow: true });

    const hover = within(screen.getByRole("region", { name: "悬停反馈" }));
    expect(hover.getAllByRole("button")).toHaveLength(6);
    fireEvent.click(hover.getByRole("button", { name: "聚光灯" }));
    expect(useAppearanceStore.getState().cardHover).toBe("spotlight");
    fireEvent.click(hover.getByRole("switch", { name: "页眉页脚分隔线" }));
    fireEvent.click(hover.getByRole("switch", { name: "顶部强调条" }));
    expect(useAppearanceStore.getState()).toMatchObject({ cardDividers: true, cardAccent: true });
  });

  it("特效标签页：背景特效、动态参数、动效开关、动效偏好与细节", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("特效");

    // 没有选背景特效时，不显示“动态”相关选项
    expect(screen.queryByRole("switch", { name: "动态效果" })).toBeNull();
    const bg = within(screen.getByRole("region", { name: "页面背景" }));
    fireEvent.click(bg.getByRole("button", { name: "极光" }));
    expect(useAppearanceStore.getState().bgEffect).toBe("aurora");
    fireEvent.click(screen.getByRole("switch", { name: "动态效果" }));
    expect(useAppearanceStore.getState().bgAnimated).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "快" }));
    fireEvent.click(screen.getByRole("button", { name: "强烈" }));
    expect(useAppearanceStore.getState()).toMatchObject({ bgSpeed: "fast", bgIntensity: "strong" });

    fireEvent.click(screen.getByRole("switch", { name: "按钮按下反馈" }));
    fireEvent.click(screen.getByRole("switch", { name: "内容淡入" }));
    fireEvent.click(screen.getByRole("switch", { name: "骨架屏流光" }));
    expect(useAppearanceStore.getState()).toMatchObject({ pressFeedback: true, entrance: true, shimmer: true });

    const motion = within(screen.getByRole("region", { name: "动效" }));
    fireEvent.click(motion.getByRole("button", { name: "减少动画" }));
    expect(useAppearanceStore.getState().motion).toBe("reduce");
    fireEvent.click(motion.getByRole("switch", { name: "页面切换动画" }));
    expect(useAppearanceStore.getState().pageTransition).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "细滚动条" }));
    fireEvent.click(screen.getByRole("switch", { name: "加强焦点环" }));
    expect(useAppearanceStore.getState()).toMatchObject({ thinScrollbar: true, focusRing: "strong" });
    fireEvent.click(screen.getByRole("switch", { name: "加强焦点环" }));
    expect(useAppearanceStore.getState().focusRing).toBe("keyboard");
  });

  it("特效标签页：自定义背景——选类型、渐变参数、图片地址的校验", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("特效");

    const bg = within(screen.getByRole("region", { name: "自定义背景" }));
    expect(bg.getByRole("button", { name: "无" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(bg.getByRole("button", { name: "渐变" }));
    expect(useAppearanceStore.getState().background.type).toBe("gradient");
    fireEvent.click(bg.getByRole("button", { name: "网格渐变" }));
    expect(useAppearanceStore.getState().background.type).toBe("mesh");
    fireEvent.click(bg.getByRole("button", { name: "粒子" }));
    expect(useAppearanceStore.getState().background.type).toBe("particles");

    // 图片地址：只接受 http(s)；非法地址给出提示且不写入设置
    fireEvent.click(bg.getByRole("button", { name: "图片地址" }));
    const input = bg.getByRole("textbox", { name: "图片地址" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(bg.getByRole("button", { name: "应用" }));
    expect(bg.getByText("请输入有效的 http(s) 图片地址")).toBeTruthy();
    expect(useAppearanceStore.getState().background.url).toBeNull();

    fireEvent.change(input, { target: { value: "https://example.com/bg.jpg" } });
    fireEvent.click(bg.getByRole("button", { name: "应用" }));
    expect(useAppearanceStore.getState().background.url).toBe("https://example.com/bg.jpg");

    fireEvent.click(bg.getByRole("button", { name: "无" }));
    expect(useAppearanceStore.getState().background.type).toBe("none");
  });

  it("布局标签页：侧栏样式、内容宽度、状态条", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("布局");

    const sidebar = screen.getByRole("region", { name: "侧栏样式" });
    expect(within(sidebar).getByRole("button", { name: "通栏" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sidebar).getByRole("button", { name: "悬浮" }));
    expect(useAppearanceStore.getState().sidebarStyle).toBe("floating");
    fireEvent.click(within(sidebar).getByRole("button", { name: "内嵌" }));
    expect(useAppearanceStore.getState().sidebarStyle).toBe("inset");

    const width = screen.getByRole("region", { name: "内容宽度" });
    fireEvent.click(within(width).getByRole("button", { name: "窄" }));
    expect(useAppearanceStore.getState().contentWidth).toBe("narrow");

    expect(screen.getByRole("switch", { name: "显示底部状态条" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "显示底部状态条" }));
    expect(useAppearanceStore.getState().statusBar).toBe(false);
  });

  it("布局标签页：选“固定展开”会同时把已折叠的侧栏展开（否则把手隐藏后无法再展开）", () => {
    usePrefsStore.setState({ sidebarCollapsed: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    openTab("布局");

    fireEvent.click(screen.getByRole("radio", { name: "固定展开" }));

    expect(useAppearanceStore.getState().sidebarCollapsible).toBe("none");
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
  });
  it("没有插件贡献设置分区时不显示“扩展”标签页；有贡献后出现", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    expect(screen.queryByRole("tab", { name: "扩展" })).toBeNull();

    act(() => {
      host.slots.register("appearance.sections", { id: "demo", component: () => <p>插件分区</p> });
    });
    expect(screen.getByRole("tab", { name: "扩展" })).toBeTruthy();
  });

  it("预览默认折叠，展开状态被记住", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    expect(screen.queryByText("示例卡片")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /实时预览/ }));
    expect(screen.getByText("示例卡片")).toBeTruthy();
    expect(usePanelPrefsStore.getState().previewOpen).toBe(true);
  });
});
