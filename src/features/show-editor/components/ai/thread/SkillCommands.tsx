import { useMemo, type FC } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ComposerPrimitive, useAuiState, type DirectiveFormatter, type TriggerAdapter, type TriggerItem } from "@assistant-ui/react";
import { Settings, Sparkles } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { filterSkills, type SlashSkill } from "./slashSkills";
import { TooltipIconButton } from "./TooltipIconButton";

/**
 * 斜杠调用技能：输入框里打 `/` 弹出技能列表（内置技能 + 启用的用户技能），上下键选择、Enter / Tab 插入
 * `/技能名`，Esc 关闭；输入框底部的“技能”按钮打开同一个列表。发送时运行时识别 `/技能名`，这一轮一定注入
 * 对应技能（见 `ai/skills` 的 `invokedSkills`）。
 */

/** 插入输入框的文字就是 `/技能名`（模型和用户都看得懂；手打也一样生效）。 */
const SLASH_FORMATTER: DirectiveFormatter = {
  serialize: (item) => `/${item.id}`,
  parse: (text) => [{ kind: "text", text }],
};

/** 技能 → 弹层列表项。 */
const toItem = (s: SlashSkill): TriggerItem => ({
  id: s.name,
  type: "skill",
  label: `/${s.name}`,
  description: s.description,
  metadata: { title: s.title, source: s.source },
});

/** 一项的内容：`/名称`、标题、来源与说明。 */
const SkillLabel: FC<{ skill: Pick<SlashSkill, "name" | "title" | "description" | "source"> }> = ({ skill }) => {
  const { t } = useTranslation();
  return (
    <span className="grid min-w-0 flex-1 gap-0.5 text-start">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <code className="shrink-0 font-mono text-xs text-primary">/{skill.name}</code>
        <span className="truncate text-xs font-medium">{skill.title}</span>
        <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">{t(`editor.ai.skills.source.${skill.source}`)}</span>
      </span>
      <span className="line-clamp-1 text-[11px] text-muted-foreground">{skill.description}</span>
    </span>
  );
};

/**
 * 输入框里 `/` 触发的技能弹层（放在 `ComposerPrimitive.TriggerPopoverRoot` 里、输入框的上方）。
 * 弹层打开时 Enter 选择技能而不是发送。
 */
export const SkillTriggerPopover: FC<{ skills: readonly SlashSkill[] }> = ({ skills }) => {
  const { t } = useTranslation();
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      // 没有分类：直接列出（空输入时列出全部）
      categories: () => [],
      categoryItems: () => [],
      search: (query) => filterSkills(skills, query).map(toItem),
    }),
    [skills],
  );
  return (
    <ComposerPrimitive.TriggerPopover
      char="/"
      adapter={adapter}
      aria-label={t("editor.ai.skills.popover")}
      className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <ComposerPrimitive.TriggerPopover.Directive formatter={SLASH_FORMATTER} />
      {/* TriggerPopover 关闭时仍会渲染子元素（只是不包外框）：提示条只在弹层（listbox）里显示 */}
      <div className="hidden items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground in-[[role=listbox]]:flex">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("editor.ai.skills.popoverHint")}</span>
      </div>
      <ComposerPrimitive.TriggerPopoverItems className="max-h-64 overflow-y-auto p-1">
        {(items) =>
          items.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("editor.ai.skills.noMatch")}</p>
          ) : (
            items.map((item, index) => (
              <ComposerPrimitive.TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <SkillLabel
                  skill={{
                    name: item.id,
                    title: String(item.metadata?.title ?? item.id),
                    description: item.description ?? "",
                    source: item.metadata?.source === "user" ? "user" : "builtin",
                  }}
                />
              </ComposerPrimitive.TriggerPopoverItem>
            ))
          )
        }
      </ComposerPrimitive.TriggerPopoverItems>
    </ComposerPrimitive.TriggerPopover>
  );
};

/**
 * 输入框底部的“技能”按钮：列出可以点名的技能，选中后把 `/技能名` 插到输入框开头。
 *
 * @param props.skills 技能。
 * @param props.onPick 选中一个技能。
 */
export const SkillMenuButton: FC<{ skills: readonly SlashSkill[]; onPick: (name: string) => void }> = ({ skills, onPick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const running = useAuiState((s) => s.thread.isRunning);
  const builtin = skills.filter((s) => s.source === "builtin");
  const mine = skills.filter((s) => s.source === "user");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip={t("editor.ai.skills.button")} disabled={running} className="size-7 text-muted-foreground">
          <Sparkles aria-hidden />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      {/* 关闭时不把焦点还给按钮：焦点交给输入框（见 onPick） */}
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("editor.ai.skills.builtin")}</DropdownMenuLabel>
        {builtin.map((s) => (
          <DropdownMenuItem key={s.name} onSelect={() => onPick(s.name)}>
            <SkillLabel skill={s} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("editor.ai.skills.mine")}</DropdownMenuLabel>
        {mine.length === 0 ? (
          <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">{t("editor.ai.skills.mineEmpty")}</p>
        ) : (
          mine.map((s) => (
            <DropdownMenuItem key={s.name} onSelect={() => onPick(s.name)}>
              <SkillLabel skill={s} />
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings#ai")}>
          <Settings aria-hidden />
          {t("editor.ai.skills.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
