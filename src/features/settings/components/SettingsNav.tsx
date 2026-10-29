import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { SettingsSectionMeta } from "../lib/sections";

interface SettingsNavProps {
  /** 要列出的分区（已按搜索 / 构建类型过滤） */
  sections: readonly SettingsSectionMeta[];
  /** 当前分区 id */
  active: string | undefined;
  /** 点击某个分区 */
  onSelect: (id: SettingsSectionMeta["id"]) => void;
}

/**
 * 设置页目录：宽屏是左侧竖排列表（当前项带主色竖条），窄屏是横向可滚动的标签条。
 * 用真实的 `<a href="#id">`，键盘 Tab 可达，当前项标 `aria-current="location"`。
 */
export function SettingsNav({ sections, active, onSelect }: SettingsNavProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("settings.navLabel")}>
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {sections.map((s) => {
          const Icon = s.icon;
          const current = s.id === active;
          return (
            <li key={s.id} className="shrink-0">
              <a
                href={`#${s.id}`}
                aria-current={current ? "location" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onSelect(s.id);
                }}
                className={cn(
                  "relative flex h-8 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // 宽屏下当前项左侧的主色竖条；窄屏改用底色区分
                  "lg:before:absolute lg:before:inset-y-1.5 lg:before:left-0 lg:before:w-0.5 lg:before:rounded-full lg:before:bg-transparent lg:before:transition-colors",
                  current
                    ? "bg-accent font-medium text-foreground lg:before:bg-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn("flex size-5 shrink-0 items-center justify-center rounded", s.tileClass)}
                  aria-hidden
                >
                  <Icon className="size-3" />
                </span>
                {t(s.titleKey)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
