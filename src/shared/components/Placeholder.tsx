import { useTranslation } from "react-i18next";
import { Construction } from "lucide-react";

/**
 * 功能占位内容：标注该页将在后续任务实现。
 */
export function Placeholder() {
  const { t } = useTranslation();
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground">
      <Construction className="size-8" aria-hidden />
      <p className="text-sm">{t("placeholder.comingSoon")}</p>
    </div>
  );
}
