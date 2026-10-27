import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { useBakeStore } from "../stores/useBakeStore";

/** 工具条上的提示：后台正在生成回放文件（`.artrec`）时显示进度。 */
export function BakeStatus() {
  const { t } = useTranslation();
  const percent = useBakeStore((s) => {
    const values = Object.values(s.running);
    return values.length === 0 ? null : Math.round(Math.min(...values) * 100);
  });
  if (percent === null) return null;
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {t("editor.bake.running", { percent })}
    </span>
  );
}
