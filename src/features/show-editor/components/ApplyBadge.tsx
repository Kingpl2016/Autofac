import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Applicability } from "../lib/cueDefaults";

/**
 * 素材对所选轨道的适用提示：完全适用时不显示；部分适用显示“部分 n/m”；不适用显示“不适用”。
 * 原因（需要哪项能力）放在 `title` 与无障碍描述里。
 *
 * @param props.app 适用情况；没有目标轨道时为 `null`。
 * @param props.id 描述元素 id（供按钮的 `aria-describedby` 引用）。
 */
export function ApplyBadge({ app, id }: { app: Applicability | null; id?: string }) {
  const { t } = useTranslation();
  if (!app || app.level === "full") return null;
  const reason = t(`editor.apply.needs.${app.needs}`);
  return (
    <span
      id={id}
      title={reason}
      className={cn(
        "shrink-0 rounded-sm px-1 text-[10px] leading-4",
        app.level === "none" ? "bg-muted text-muted-foreground" : "bg-warning/15 text-warning",
      )}
    >
      {app.level === "none"
        ? t("editor.apply.none")
        : t("editor.apply.partial", { supported: app.supported, total: app.total })}
      <span className="sr-only">{`（${reason}）`}</span>
    </span>
  );
}
