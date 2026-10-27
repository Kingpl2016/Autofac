import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { usePanelStore } from "../stores/usePanelStore";

/** 顶栏的个性化入口：点击打开全局唯一的个性化面板。 */
export function AppearanceTrigger() {
  const { t } = useTranslation();
  const open = usePanelStore((s) => s.open);
  const setOpen = usePanelStore((s) => s.setOpen);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("appearance.open")}
      title={t("appearance.open")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      <Palette />
    </Button>
  );
}
