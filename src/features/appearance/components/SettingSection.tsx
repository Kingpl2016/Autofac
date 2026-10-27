import { useId, type ReactNode } from "react";

interface SettingSectionProps {
  /** 分区标题。 */
  title: string;
  /** 可选的说明文字。 */
  hint?: string;
  /** 分区内容。 */
  children: ReactNode;
}

/** 设置分区：带标题与说明的一组设置项，标题通过 `aria-labelledby` 关联到分区。 */
export function SettingSection({ title, hint, children }: SettingSectionProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-medium">
          {title}
        </h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}