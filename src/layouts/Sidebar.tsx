import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Waypoints } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  NAV_ITEMS,
  NAV_SECTIONS,
  NAV_SECTION_LABELS,
} from "@/shared/navigation/items";
import { usePrefsStore } from "@/shared/stores/prefsStore";

/**
 * 左侧导航栏：按分组列出全部功能页面。折叠按钮是贴在侧栏右边缘的圆形把手，
 * 折叠时收窄为仅图标的窄栏。
 *
 * 折叠 / 展开时 DOM 结构保持不变：图标始终固定在同一位置（折叠宽度 4rem 的正中，中心 32px），
 * 文字标签与分组标题只做淡入淡出并被外层裁剪。这样宽度过渡期间不会出现图标跳动、
 * 文字换行或分组标题挤压的混乱。
 */
export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = usePrefsStore((s) => s.toggleSidebar);
  const toggleLabel = collapsed ? t("nav.expand") : t("nav.collapse");

  // 标签与分组标题的淡入淡出；折叠时不可见也不应被读屏朗读
  const fade = cn(
    "whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none",
    collapsed ? "opacity-0" : "opacity-100",
  );

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        data-collapsed={collapsed}
        className={cn(
          "relative h-full shrink-0 border-r border-sidebar-border bg-sidebar",
          "transition-[width] duration-200 motion-reduce:transition-none",
          collapsed ? "w-16" : "w-52",
        )}
      >
        {/* 内容层裁剪溢出；把手在它之外，才能半悬在侧栏右边缘 */}
        <div className="flex h-full w-full flex-col overflow-hidden">
          {/* 图标列：折叠宽 64px；pl-5 (20px) + 24px 品牌图标，中心恰好落在 32px；高度与顶栏 h-14 对齐 */}
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border pl-5">
            <Waypoints className="size-6 shrink-0 text-sidebar-primary" aria-hidden />
            <span
              className={cn(
                fade,
                "truncate font-semibold tracking-tight text-sidebar-foreground",
              )}
              aria-hidden={collapsed}
            >
              {t("common.appName")}
            </span>
          </div>

          <nav
            className={cn(
              "min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-2",
              // 折叠后可用宽度只有 40px，经典滚动条会把图标挤偏；折叠时隐藏滚动条（仍可滚动）
              collapsed && "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
            aria-label={t("common.appName")}
          >
            {NAV_SECTIONS.map((section) => {
              const items = NAV_ITEMS.filter((i) => i.section === section);
              if (items.length === 0) return null;
              return (
                <div key={section} className="mb-1 tall:mb-1.5 taller:mb-2">
                  {/* 分组标题：展开时显示文字，折叠时显示一条分隔线，高度恒定 */}
                  <div className="relative h-6 tall:h-7 taller:h-8" role="presentation">
                    <span
                      className={cn(
                        fade,
                        "absolute inset-y-0 left-2.5 flex items-center text-[0.7rem] font-medium uppercase tracking-wider text-muted-foreground",
                      )}
                      aria-hidden={collapsed}
                    >
                      {t(NAV_SECTION_LABELS[section])}
                    </span>
                    <div
                      className={cn(
                        "absolute inset-x-2 top-1/2 border-t border-sidebar-border transition-opacity duration-150 motion-reduce:transition-none",
                        collapsed ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </div>
                  <ul className="flex flex-col gap-0.5 tall:gap-1 taller:gap-1.5">
                    {items.map((item) => {
                      const label = t(item.labelKey);
                      const Icon = item.icon;
                      return (
                        <li key={item.to}>
                          {/* Tooltip 始终挂载（结构不变，折叠切换不会重挂载链接）；仅折叠时才有提示内容 */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <NavLink
                                to={item.to}
                                end={item.to === "/"}
                                aria-label={label}
                                // 必须传字符串：外层 TooltipTrigger asChild 的 Radix Slot 会把函数形式的
                                // className 直接 toString() 成垃圾类名，导致整个链接样式失效。
                                // 选中态改用 NavLink 自动设置的 aria-current="page" 来驱动样式。
                                className={cn(
                                  // nav px-3 + 链接 px-2.5：图标左缘 22px、宽 20px，中心 32px，恰为折叠宽度 64px 的正中
                                  "flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-2 text-sm font-medium transition-colors tall:py-2.5 taller:py-3",
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                                  "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                                  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
                                )}
                              >
                                <Icon className="size-5 shrink-0" aria-hidden />
                                <span className={cn(fade, "truncate")} aria-hidden={collapsed}>
                                  {label}
                                </span>
                              </NavLink>
                            </TooltipTrigger>
                            {collapsed && (
                              <TooltipContent side="right">{label}</TooltipContent>
                            )}
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </nav>
        </div>

        {/* 边缘折叠把手：主流侧栏（Linear / Vercel / Supabase）的常见位置 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={toggleLabel}
              aria-expanded={!collapsed}
              className={cn(
                "absolute -right-3 top-4 z-20 flex size-6 items-center justify-center rounded-full",
                "border border-border bg-background text-muted-foreground shadow-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {collapsed ? (
                <ChevronRight className="size-3.5" aria-hidden />
              ) : (
                <ChevronLeft className="size-3.5" aria-hidden />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{toggleLabel}</TooltipContent>
        </Tooltip>
      </aside>
    </TooltipProvider>
  );
}
