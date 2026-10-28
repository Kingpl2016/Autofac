import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useEditorPrefsStore, type SectionId, type SectionScope } from "../stores/useEditorPrefsStore";

interface InspectorSectionProps<S extends SectionScope> {
  /** 所在的页（各页分别记住展开状态） */
  scope: S;
  /** 分区（展开状态按它记住；Cue 页同名分区在各片段类型之间共用） */
  id: SectionId<S>;
  title: string;
  /** 没记过展开状态时是否展开 */
  defaultOpen?: boolean;
  /** 标题右侧的附加信息（收起时也显示，例如计数、色块） */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * 属性面板的一个可折叠分区（Figma / 剪映属性面板式）：标题行点击展开 / 收起，状态按页记住。
 * 分区本身是一个以标题命名的区域（`section`），里面的子组件不再自带同名的区域和标题。
 */
export function InspectorSection<S extends SectionScope>({ scope, id, title, defaultOpen = true, aside, children }: InspectorSectionProps<S>) {
  const stored = useEditorPrefsStore((s) => (scope === "patch" ? s.patchSections : scope === "program" ? s.programSections : s.cueSections) as Partial<Record<string, boolean>>)[id];
  const setSection = useEditorPrefsStore((s) => s.setSection);
  const open = stored ?? defaultOpen;
  return (
    <Collapsible open={open} onOpenChange={(o) => setSection(scope, id, o)} asChild>
      <section aria-label={title} className="border-t border-border first:border-t-0">
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
        >
          <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {aside}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}
