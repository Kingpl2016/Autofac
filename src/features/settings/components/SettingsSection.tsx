import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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
 * 设置分区：标题行在卡片之外（图标徽章 + 标题 + 说明），卡片本身只放设置行，
 * 行与行之间用细线分隔。这是 macOS 系统设置 / Linear 常见的「分组列表」结构，
 * 比把标题塞进卡片内部更轻、层次更清晰。
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
    <section id={id} aria-labelledby={titleId}>
      <header className="mb-3 flex items-center gap-3 px-1">
        {Icon && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              tileClass ?? "bg-accent/60 text-primary",
            )}
            aria-hidden
          >
            <Icon className="size-4" />
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h2 id={titleId} className="text-sm font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
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
 */
export function SettingsSectionById({ id, children }: SettingsSectionByIdProps) {
  const { t } = useTranslation();
  const meta = SECTION_BY_ID.get(id);
  if (!meta) return null;
  return (
    <SettingsSection
      id={meta.id}
      title={t(meta.titleKey)}
      description={t(meta.descKey)}
      icon={meta.icon}
      tileClass={meta.tileClass}
    >
      {children}
    </SettingsSection>
  );
}
