import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SettingsSearchProps {
  /** 当前输入（未归一化） */
  value: string;
  onChange: (next: string) => void;
}

/** 设置搜索框：按标签 / 说明 / 分区名过滤；Esc 清空。 */
export function SettingsSearch({ value, onChange }: SettingsSearchProps) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
        aria-label={t("settings.searchLabel")}
        placeholder={t("settings.searchPlaceholder")}
        className="h-9 pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-0.5 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
          aria-label={t("settings.searchClear")}
          title={t("settings.searchClear")}
          onClick={() => onChange("")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}
