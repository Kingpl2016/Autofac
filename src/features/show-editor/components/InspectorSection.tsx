import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useEditorPrefsStore, type SectionId, type SectionScope } from "../stores/useEditorPrefsStore";
import { HelpTip } from "./HelpTip";

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
  /** “?”说明的 i18n 前缀（见 `HelpTip`）；按钮画在标题按钮之外，点它不会展开 / 收起分区 */
  help?: string;
  children: ReactNode;
}

/**
 * 属性面板的一个可折叠分区（Figma / 剪映属性面板式）：标题行点击展开 / 收起，状态按页记住。
 * 分区本身是一个以标题命名的区域（`section`），里面的子组件不再自带同名的区域和标题。
 */
export function InspectorSection<S extends SectionScope>({ scope, id, title, defaultOpen = true, aside, help, children }: InspectorSectionProps<S>) {
  const stored = useEditorPrefsStore((s) => (scope === "patch" ? s.patchSections : scope === "program" ? s.programSections : s.cueSections) as Partial<Record<string, boolean>>)[id];
  const setSection = useEditorPrefsStore((s) => s.setSection);
  const open = stored ?? defaultOpen;
  const trigger = (
    <CollapsibleTrigger
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        help && "pr-1",
      )}
    >
      <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {aside}
    </CollapsibleTrigger>
  );
  return (
    <Collapsible open={open} onOpenChange={(o) => setSection(scope, id, o)} asChild>
      <section aria-label={title} className="border-t border-border first:border-t-0">
        {help ? (
          // 标题按钮与“?”并排（按钮里不能再套按钮）
          <div className="flex items-center pr-2">
            <div className="min-w-0 flex-1">{trigger}</div>
            <HelpTip topic={help} />
          </div>
        ) : (
          trigger
        )}
        <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}
