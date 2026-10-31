import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useAskAiStore } from "../../stores/useAskAiStore";

/** 弹层内容引入 AI SDK，按需加载。 */
const AskAiBody = lazy(() => import("./AskAiBody").then((m) => ({ default: m.AskAiBody })));

/**
 * 时间线上的“问 AI”弹层（外壳）：锚在右键 / 快捷条按钮的位置，内容按需加载。
 * 打开方式：右键菜单“问 AI…”、片段快捷条的星光按钮、`Ctrl+Shift+J`。
 */
export function AskAiPopover() {
  const open = useAskAiStore((s) => s.open);
  const x = useAskAiStore((s) => s.x);
  const y = useAskAiStore((s) => s.y);
  const scope = useAskAiStore((s) => s.scope);
  const seq = useAskAiStore((s) => s.seq);
  return (
    <Popover open={open} onOpenChange={(next) => !next && useAskAiStore.getState().close()}>
      <PopoverAnchor asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: x, top: y }} />
      </PopoverAnchor>
      <PopoverContent data-tour="ask-ai" side="bottom" align="start" className="w-80 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
        {open && scope && (
          <Suspense fallback={<Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}>
            <AskAiBody key={seq} scope={scope} />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  );
}
