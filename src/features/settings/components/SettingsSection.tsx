import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SectionMatchContext, useSectionMatch } from "../hooks/useSettingsFilter";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/sections";

interface SettingsSectionProps {
  /** 分区标识（DOM id），同时用于关联标题的无障碍名称 */
  id?: string;
  /** 分区标题 */
  title: string;
  /** 分区一句话说明 */
  description?: string;
  /** 分区图标 */
  icon?: LucideIcon;
  /** 图标徽章的底色 + 图标色 */
  tileClass?: string;
  /** 分区内容（通常为若干 SettingRow） */
  children: ReactNode;
}

/**
 * 设置分区：标题行在卡片之外（图标徽章 + 标题 + 说明两行），卡片本身只放设置行，
 * 行与行之间用细线分隔，即 macOS 系统设置 / Linear 的“分组列表”结构。
 *
 * 搜索时如果分区里所有行都被过滤掉（例如命中的行因为开关关闭没有渲染），整块隐藏，
 * 不留空卡片。
 */
export function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  tileClass,
  children,
}: SettingsSectionProps) {
  const titleId = id ? `${id}-title` : undefined;

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      // 窄屏时目录横排吸顶，锚点要多留出它的高度
      className="scroll-mt-28 lg:scroll-mt-6 [&:not(:has([data-slot=setting-row]))]:hidden"
    >
      <header className="mb-3 flex items-center gap-3 px-1">
        {Icon && (
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-current/15",
              tileClass ?? "bg-accent/60 text-primary",
            )}
            aria-hidden
          >
            <Icon className="size-4" />
          </span>
        )}
        <div className="min-w-0">
          <h2 id={titleId} className="text-[0.9375rem] font-semibold leading-tight tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </header>

      <Card className="overflow-hidden rounded-xl">
        <div className="divide-y divide-border">{children}</div>
      </Card>
    </section>
  );
}

/** 分区元数据按 id 建表，避免每次线性查找。 */
const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));

interface SettingsSectionByIdProps {
  /** 分区标识，从 {@link SETTINGS_SECTIONS} 取标题 / 说明 / 图标 */
  id: SettingsSectionId;
  children: ReactNode;
}

/**
 * 便捷包装：按分区 id 自动套用标题、说明、图标与配色（经 i18n 翻译），
 * 让表单只关心内容本身，文案与样式保持单一事实来源。
 *
 * 搜索没有命中这个分区时不渲染；命中时把匹配方式传给分区内的行。
 */
export function SettingsSectionById({ id, children }: SettingsSectionByIdProps) {
  const { t } = useTranslation();
  const meta = SECTION_BY_ID.get(id);
  const match = useSectionMatch(id);
  if (!meta || match === null) return null;
  return (
    <SectionMatchContext value={match}>
      <SettingsSection
        id={meta.id}
        title={t(meta.titleKey)}
        description={t(meta.descKey)}
        icon={meta.icon}
        tileClass={meta.tileClass}
      >
        {children}
      </SettingsSection>
    </SectionMatchContext>
  );
}
