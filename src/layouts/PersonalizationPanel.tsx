import { useTranslation } from "react-i18next";
import { Check, Palette } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  ACCENT_COLORS,
  LANGUAGES,
  usePrefsStore,
  type AccentColor,
  type Language,
  type ThemeMode,
} from "@/shared/stores/prefsStore";

/** 强调色 -> i18n key */
const ACCENT_LABEL_KEYS: Record<AccentColor, string> = {
  blue: "appearance.accentBlue",
  cyan: "appearance.accentCyan",
  green: "appearance.accentGreen",
  orange: "appearance.accentOrange",
  violet: "appearance.accentViolet",
  rose: "appearance.accentRose",
};

/**
 * 个性化面板：顶栏按钮点击后从右侧滑出，
 * 提供界面语言、主题与强调色设置（仅保存在本机）。
 */
export function PersonalizationPanel() {
  const { t } = useTranslation();
  const language = usePrefsStore((s) => s.language);
  const setLanguage = usePrefsStore((s) => s.setLanguage);
  const theme = usePrefsStore((s) => s.theme);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const accent = usePrefsStore((s) => s.accent);
  const setAccent = usePrefsStore((s) => s.setAccent);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("appearance.open")}
          title={t("appearance.open")}
        >
          <Palette />
        </Button>
      </SheetTrigger>

      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("appearance.section")}</SheetTitle>
          <SheetDescription>{t("appearance.panelDesc")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <span id="pref-language" className="text-sm font-medium">
              {t("language.label")}
            </span>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as Language)}
            >
              <SelectTrigger aria-labelledby="pref-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {t(`language.${l}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span id="pref-theme" className="text-sm font-medium">
              {t("appearance.theme")}
            </span>
            <Select value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
              <SelectTrigger aria-labelledby="pref-theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t("theme.dark")}</SelectItem>
                <SelectItem value="light">{t("theme.light")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span id="pref-accent" className="text-sm font-medium">
              {t("appearance.accent")}
            </span>
            <p className="text-xs text-muted-foreground">
              {t("appearance.accentHint")}
            </p>
            <div
              role="radiogroup"
              aria-labelledby="pref-accent"
              className="flex flex-wrap items-center gap-3 pt-1"
            >
              {ACCENT_COLORS.map((c) => {
                const selected = c === accent;
                const label = t(ACCENT_LABEL_KEYS[c]);
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    title={label}
                    data-accent={c}
                    onClick={() => setAccent(c)}
                    // 在带 data-accent 的元素上直接解析色相变量，预览各预设颜色
                    style={{
                      backgroundColor: "oklch(0.62 var(--accent-c) var(--accent-h))",
                    }}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full text-white transition-shadow",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      selected &&
                        "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                    )}
                  >
                    {selected && <Check className="size-4" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
