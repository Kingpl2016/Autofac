import { useTranslation } from "react-i18next";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePrefsStore } from "@/shared/stores/prefsStore";

/**
 * 主题切换按钮（深 / 浅）。
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = usePrefsStore((s) => s.theme);
  const toggleTheme = usePrefsStore((s) => s.toggleTheme);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={t("theme.toggle")}
      title={t("theme.toggle")}
    >
      {theme === "dark" ? <Moon /> : <Sun />}
    </Button>
  );
}
