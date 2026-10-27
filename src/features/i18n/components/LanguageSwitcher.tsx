import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGES, usePrefsStore, type Language } from "@/shared/stores/prefsStore";

/** 顶栏的界面语言菜单。每种语言用它自己的名字显示，不依赖当前界面语言，方便找不到入口时辨认。 */
export function LanguageSwitcher() {
  const { t } = useTranslation();
  const language = usePrefsStore((s) => s.language);
  const setLanguage = usePrefsStore((s) => s.setLanguage);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("language.switch")} title={t("language.switch")}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={language} onValueChange={(value) => setLanguage(value as Language)}>
          {LANGUAGES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} lang={value === "zh" ? "zh-CN" : "en"}>
              {t(`language.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
