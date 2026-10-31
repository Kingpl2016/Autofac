import { useRef, type FC } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useAISDKChat, useAISDKError } from "@assistant-ui/react-ai-sdk";
import { ArrowDown, ArrowUp, Bot, Check, ChevronLeft, ChevronRight, Copy, Pencil, RefreshCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { aiErrorText } from "@/features/ai";
import { cn } from "@/lib/utils";
import { AutoApplyToggle } from "./AutoApplyToggle";
import { ContextMeter } from "./ContextMeter";
import { MarkdownText } from "./MarkdownText";
import { MemorySources } from "./MemorySources";
import { ModelMenu } from "./ModelMenu";
import { RewindButton } from "./RewindButton";
import { SkillMenuButton, SkillTriggerPopover } from "./SkillCommands";
import { useSlashSkills, withSkill, type SlashSkill } from "./slashSkills";
import { ToolCallPart } from "./ToolStep";
import { TooltipIconButton } from "./TooltipIconButton";

/**
 * AI 对话的界面（基于 assistant-ui 的原语，参照其 `Thread` 组件改写）：消息列表（流式吸底、往上翻时出现
 * “回到底部”）、Markdown 回复、可展开的工具步骤、复制 / 重新生成 / 编辑后重发 / 分支切换，以及输入框
 * （底部可切换模型）。运行时由 `AssistantRuntimeProvider` 提供。
 */
export const Thread: FC = () => (
  <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
    <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3">
      <AuiIf condition={(s) => s.thread.messages.length === 0}>
        <ThreadWelcome />
      </AuiIf>
      <div className="flex flex-col gap-y-4 pb-4 empty:hidden">
        <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
      </div>
      <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-2 bg-surface-2 pb-3">
        <ThreadScrollToBottom />
        <ThreadError />
        <Composer />
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

/** 一条消息：按角色与编辑状态选择样式。 */
const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const editing = useAuiState((s) => s.message.composer.isEditing);
  if (editing) return <EditComposer />;
  return role === "user" ? <UserMessage /> : <AssistantMessage />;
};

/** 空状态：说明与建议问题。 */
const ThreadWelcome: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col justify-center gap-3 px-1 py-6">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Bot className="size-4" aria-hidden />
        </span>
        <p className="text-base font-medium">{t("editor.ai.welcome")}</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("editor.ai.chatHint")}</p>
      <div className="grid gap-1.5">
        <ThreadPrimitive.Suggestions>
          {() => (
            <SuggestionPrimitive.Trigger send asChild>
              <button
                type="button"
                className="flex w-full cursor-pointer items-baseline gap-2 rounded-md border border-border px-2.5 py-2 text-start text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden className="font-mono text-xs text-muted-foreground">›</span>
                <SuggestionPrimitive.Title className="min-w-0 flex-1" />
              </button>
            </SuggestionPrimitive.Trigger>
          )}
        </ThreadPrimitive.Suggestions>
      </div>
    </div>
  );
};

/** 回到底部（只在没有停在底部时显示）。 */
const ThreadScrollToBottom: FC = () => {
  const { t } = useTranslation();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("editor.ai.scrollToBottom")}
        variant="outline"
        className="absolute -top-10 size-8 self-center rounded-full bg-background shadow-sm disabled:invisible"
      >
        <ArrowDown aria-hidden />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** 请求失败：本地化的说明与重试。 */
const ThreadError: FC = () => {
  const { t } = useTranslation();
  const error = useAISDKError();
  const chat = useAISDKChat();
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
      <p className="min-w-0 flex-1 break-words">{aiErrorText(t, error)}</p>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => {
          chat?.clearError();
          void chat?.regenerate();
        }}
      >
        <RefreshCw aria-hidden />
        {t("editor.ai.retry")}
      </Button>
    </div>
  );
};

/**
 * 输入框：多行、Enter 发送、Shift+Enter 换行，打 `/` 点名技能；底部是技能按钮、模型菜单、自动写入开关与发送 / 停止。
 */
const Composer: FC = () => {
  const { t } = useTranslation();
  const aui = useAui();
  const input = useRef<HTMLTextAreaElement>(null);
  const skills = useSlashSkills();
  const pickSkill = (name: string) => {
    const composer = aui.thread().composer();
    const text = withSkill(composer.getState().text, name);
    composer.setText(text);
    // 菜单关闭后把焦点交给输入框，光标放在末尾接着写
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  return (
    <ComposerPrimitive.TriggerPopoverRoot>
      <ComposerPrimitive.Root
        data-tour="ai-composer"
        className="relative flex w-full flex-col rounded-xl border border-border bg-background p-1.5 shadow-sm transition-colors focus-within:border-ring/60"
      >
        <SkillTriggerPopover skills={skills} />
        <ComposerPrimitive.Input
          ref={input}
          data-ai-input
          rows={1}
          placeholder={t("editor.ai.inputPlaceholder")}
          aria-label={t("editor.ai.inputLabel")}
          className="max-h-40 min-h-9 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
        />
        <ComposerFooter onPickSkill={pickSkill} skills={skills} />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.TriggerPopoverRoot>
  );
};

/** 输入框底部：技能按钮、模型菜单、自动写入开关与发送 / 停止。 */
const ComposerFooter: FC<{ skills: readonly SlashSkill[]; onPickSkill: (name: string) => void }> = ({ skills, onPickSkill }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 pt-1">
      <SkillMenuButton skills={skills} onPick={onPickSkill} />
      <ModelMenu />
      <div className="ms-auto flex shrink-0 items-center gap-1">
        <ContextMeter />
        <AutoApplyToggle />
        <AuiIf condition={(s) => !s.composer.canCancel}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton tooltip={t("editor.ai.send")} variant="default" className="size-7 rounded-full">
              <ArrowUp aria-hidden />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.composer.canCancel}>
          <ComposerPrimitive.Cancel asChild>
            <TooltipIconButton tooltip={t("editor.ai.stop")} variant="default" className="size-7 rounded-full">
              <Square className="fill-current" aria-hidden />
            </TooltipIconButton>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

/** 用户消息：右侧气泡，悬停时出现复制 / 编辑。 */
const UserMessage: FC = () => {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="group flex flex-col items-end gap-1" data-role="user">
      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
      <div className="flex items-center gap-0.5">
        <BranchPicker />
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex items-center text-muted-foreground">
          <CopyButton />
          <ActionBarPrimitive.Edit asChild>
            <TooltipIconButton tooltip={t("editor.ai.edit")}>
              <Pencil aria-hidden />
            </TooltipIconButton>
          </ActionBarPrimitive.Edit>
          <RewindButton />
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
};

/** 编辑一条已发出的消息：保存后从这里重新生成（产生新分支）。 */
const EditComposer: FC = () => {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="flex flex-col items-end">
      <ComposerPrimitive.Root className="flex w-full max-w-[92%] flex-col rounded-xl border border-ring/60 bg-background p-1.5">
        <ComposerPrimitive.Input aria-label={t("editor.ai.editLabel")} className="min-h-14 w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none" autoFocus />
        <div className="flex justify-end gap-1.5">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-7 px-3 text-xs">
              {t("common.cancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-7 px-3 text-xs">
              {t("editor.ai.resend")}
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

/** 还没有内容时的“正在思考”。 */
const Thinking: FC = () => {
  const { t } = useTranslation();
  const running = useAuiState((s) => s.message.status?.type === "running");
  if (!running) return null;
  return (
    <span role="status" className="inline-flex animate-pulse items-center gap-1 text-xs text-muted-foreground motion-reduce:animate-none">
      {t("editor.ai.thinking")}
    </span>
  );
};

/** 助手消息：Markdown 文本与工具步骤，底部是分支切换、复制、重新生成，以及参考了哪些记忆。 */
const AssistantMessage: FC = () => {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="flex flex-col gap-1" data-role="assistant">
      <div className="min-w-0 break-words px-0.5 text-sm text-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, Empty: Thinking, tools: { Fallback: ToolCallPart } }} />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <ErrorPrimitive.Message className="line-clamp-3" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="flex min-h-7 items-center gap-0.5">
        <BranchPicker />
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex items-center text-muted-foreground">
          <CopyButton />
          <ActionBarPrimitive.Reload asChild>
            <TooltipIconButton tooltip={t("editor.ai.regenerate")}>
              <RefreshCw aria-hidden />
            </TooltipIconButton>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
      <MemorySources />
    </MessagePrimitive.Root>
  );
};

/** 复制消息文字（复制后短暂显示对勾）。 */
const CopyButton: FC = () => {
  const { t } = useTranslation();
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip={t("editor.ai.copy")}>
        <AuiIf condition={(s) => s.message.isCopied}>
          <Check aria-hidden />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <Copy aria-hidden />
        </AuiIf>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  );
};

/** 分支切换（编辑重发或重新生成后，在几个版本之间切换；只有一个版本时不显示）。 */
const BranchPicker: FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch className={cn("inline-flex items-center text-xs text-muted-foreground", className)}>
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip={t("editor.ai.prevBranch")}>
          <ChevronLeft aria-hidden />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip={t("editor.ai.nextBranch")}>
          <ChevronRight aria-hidden />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
