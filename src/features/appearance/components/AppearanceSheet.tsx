import { LayoutPanelLeft, LayoutPanelTop, Palette, Puzzle, Shapes, WandSparkles, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slot, useSlotContributions } from "@/shared/plugin";
import { usePanelStore, type AppearanceTab } from "../stores/usePanelStore";
import { usePanelPrefsStore } from "../stores/usePanelPrefsStore";
import { CardsTab } from "./CardsTab";
import { ColorsTab } from "./ColorsTab";
import { EffectsTab } from "./EffectsTab";
import { LayoutTab } from "./LayoutTab";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PanelWidthPresets } from "./PanelWidthPresets";
import { PreviewCard } from "./PreviewCard";
import { ShapeTab } from "./ShapeTab";

/** 内置标签页：顺序即展示顺序。扩展标签页只在有插件贡献时追加。 */
const BASE_TABS: readonly { value: Exclude<AppearanceTab, "extensions">; Icon: LucideIcon; Content: ComponentType }[] = [
  { value: "colors", Icon: Palette, Content: ColorsTab },
  { value: "shape", Icon: Shapes, Content: ShapeTab },
  { value: "cards", Icon: LayoutPanelTop, Content: CardsTab },
  { value: "effects", Icon: WandSparkles, Content: EffectsTab },
  { value: "layout", Icon: LayoutPanelLeft, Content: LayoutTab },
];

/**
 * 个性化面板：从右侧滑出，分为多个标签页。状态由 `usePanelStore` 控制，
 * 因此入口按钮、快捷键或其他插件都能打开它；它本身挂在全局覆盖层里，整个应用只有一个。
 *
 * - 关闭后焦点回到打开它的元素（入口按钮在面板外，Radix 无法自动识别，这里手动记录）。
 * - 其他插件通过 `appearance.sections` 扩展点贡献的分区会出现在“扩展”标签页，没有贡献时该标签页不显示。
 * - 宽度可以用三档预设或拖动左缘调整，并被记住。
 */
export function AppearanceSheet() {
  const { t } = useTranslation();
  const open = usePanelStore((s) => s.open);
  const setOpen = usePanelStore((s) => s.setOpen);
  const tab = usePanelStore((s) => s.tab);
  const setTab = usePanelStore((s) => s.setTab);
  const extensions = useSlotContributions("appearance.sections");
  const width = usePanelPrefsStore((s) => s.width);
  const openerRef = useRef<HTMLElement | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  const hasExtensions = extensions.length > 0;
  // 扩展标签页不存在时（插件被移除），回退到第一个标签页
  const activeTab: AppearanceTab = tab === "extensions" && !hasExtensions ? BASE_TABS[0].value : tab;

  // 标签栏可横向滚动：切换标签页后把选中项滚动到可见区域
  useEffect(() => {
    const active = tabListRef.current?.querySelector('[data-state="active"]');
    active?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeTab, open]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        style={{ "--appearance-panel-width": `${width}rem` } as CSSProperties}
        className="w-full gap-0 p-0 sm:w-(--appearance-panel-width) sm:max-w-full"
        onOpenAutoFocus={() => {
          // 此时焦点还没移动，activeElement 就是打开面板的那个元素
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (!openerRef.current?.isConnected) return;
          event.preventDefault();
          openerRef.current.focus();
        }}
      >
        <PanelResizeHandle />
        <SheetHeader className="flex-row items-center gap-3 px-5 pb-4 pr-14 pt-5">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
          >
            <Palette className="size-5" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <SheetTitle>{t("appearance.title")}</SheetTitle>
            <SheetDescription className="text-xs leading-relaxed">{t("appearance.description")}</SheetDescription>
          </div>
          <div className="ml-auto shrink-0">
            <PanelWidthPresets />
          </div>
        </SheetHeader>

        <div className="px-5 pb-3">
          <PreviewCard />
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setTab(value as AppearanceTab)} className="flex min-h-0 flex-1 flex-col">
          <div
            ref={tabListRef}
            className="overflow-x-auto border-y border-border px-5 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <TabsList aria-label={t("appearance.tabs.label")} className="w-max min-w-full justify-start rounded-xl">
              {BASE_TABS.map(({ value, Icon }) => (
                <TabsTrigger key={value} value={value} className="flex-none gap-1.5 rounded-lg px-3 text-[13px]">
                  <Icon aria-hidden className="size-3.5" />
                  {t(`appearance.tabs.${value}`)}
                </TabsTrigger>
              ))}
              {hasExtensions ? (
                <TabsTrigger value="extensions" className="flex-none gap-1.5 rounded-lg px-3 text-[13px]">
                  <Puzzle aria-hidden className="size-3.5" />
                  {t("appearance.tabs.extensions")}
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 py-5">
              {BASE_TABS.map(({ value, Content }) => (
                <TabsContent key={value} value={value} className="mt-0">
                  <Content />
                </TabsContent>
              ))}
              {hasExtensions ? (
                <TabsContent value="extensions" className="mt-0">
                  <div className="space-y-6">
                    <Slot name="appearance.sections" />
                  </div>
                </TabsContent>
              ) : null}
            </div>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
