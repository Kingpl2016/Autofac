import { lazy, Suspense } from "react";

/** 帮助菜单按需加载：它依赖编辑器的状态与引导，不打进首屏包。 */
const HeaderHelpMenu = lazy(() => import("./HelpMenu").then((m) => ({ default: m.HeaderHelpMenu })));

/**
 * 顶栏最右侧的帮助按钮（`header.actions` 扩展点）。加载完成前用同尺寸的占位，避免顶栏抖动。
 */
export function HeaderHelpSlot() {
  return (
    <Suspense fallback={<span className="size-8 shrink-0" aria-hidden />}>
      <HeaderHelpMenu />
    </Suspense>
  );
}
