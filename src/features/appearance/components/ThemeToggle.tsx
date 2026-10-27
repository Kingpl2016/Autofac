import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_MODES, type ThemeMode } from "../lib/appearanceSettings";
import { setModeWithTransition } from "../lib/themeTransition";
import { useAppearanceStore } from "../stores/useAppearanceStore";

const MODE_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * 顶栏的明暗模式菜单：浅色 / 深色 / 跟随系统。
 * 触发按钮的图标反映当前选择（跟随系统时显示显示器图标，而不是当下实际的明暗）。
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const mode = useAppearanceStore((s) => s.mode);
  const Icon = MODE_ICON[mode];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("theme.toggle")} title={t("theme.toggle")}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setModeWithTransition(value as ThemeMode)}>
          {THEME_MODES.map((value) => {
            const ItemIcon = MODE_ICON[value];
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                <ItemIcon aria-hidden />
                {t(`theme.${value}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
