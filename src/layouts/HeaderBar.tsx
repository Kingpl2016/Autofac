import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Slot } from "@/shared/plugin";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";

/**
 * 顶部状态条。本身不知道有哪些功能：左侧是 `header.status` 扩展点（引擎状态等），
 * 右侧是 `header.actions` 扩展点（模式开关、录制、信号检测器、主题、语言、个性化等），
 * 由各插件按 `order` 贡献。侧栏折叠把手位于侧栏右边缘（见 `Sidebar`）。
 */
export function HeaderBar() {
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");

  return (
    <TooltipProvider delayDuration={200}>
      <header
        data-layout="header"
        // 播放器模式：底边换成强调色 + 极淡底色，任何页面都能一眼看出当前模式（只改颜色，不引起布局位移）
        className={cn(
          "flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-card px-6",
          playerMode ? "border-b-2 border-primary/60 bg-primary/5" : "border-border",
        )}
      >
        {/* 左侧可收缩（内容多时被裁掉而不是挤压右侧），右侧操作区保持原宽，文字都不换行 */}
        <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden whitespace-nowrap">
          <Slot name="header.status" />
        </div>
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
          <Slot name="header.actions" />
        </div>
      </header>
    </TooltipProvider>
  );
}
