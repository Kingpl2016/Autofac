import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { announce } from "@/shared/stores/announcerStore";
import { reapplyPoints, revertSources, useRestorePointStore } from "../../../stores/useRestorePointStore";
import { TooltipIconButton } from "./TooltipIconButton";

/** 消息里出现的工具调用 id。 */
function toolCallIds(messages: readonly UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      const id = (p as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** 消息的文字。 */
const textOf = (m: UIMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/**
 * 回退到这条消息之前：这条消息与之后的对话从当前版本移除，这条消息的文字放回输入框；
 * 可以同时撤回这之后写入工程的 AI 改动（之后手动改过的部分保留）。提示里可以撤销。
 */
export function RewindButton() {
  const { t } = useTranslation();
  const aui = useAui();
  const chat = useAISDKChat();
  const id = useAuiState((s) => s.message.id);
  const points = useRestorePointStore((s) => s.points);
  const [open, setOpen] = useState(false);
  const [alsoRevert, setAlsoRevert] = useState(true);
  if (!chat) return null;

  const messages = chat.messages;
  const at = messages.findIndex((m) => m.id === id);
  const later = at >= 0 ? toolCallIds(messages.slice(at)) : new Set<string>();
  const applied = points.filter((p) => p.sourceId && later.has(p.sourceId) && p.state === "applied").length;

  const rewind = () => {
    if (at < 0) return;
    const backup = messages;
    const reverted = alsoRevert && applied > 0 ? revertSources(later) : { ids: [], skipped: 0 };
    chat.setMessages(messages.slice(0, at));
    aui.thread().composer().setText(textOf(messages[at]));
    setOpen(false);
    const text =
      reverted.ids.length > 0
        ? t(reverted.skipped > 0 ? "editor.ai.rewind.doneRevertedPartial" : "editor.ai.rewind.doneReverted", { count: reverted.ids.length, skipped: reverted.skipped })
        : t("editor.ai.rewind.done");
    announce(text);
    toast.success(text, {
      action: {
        label: t("editor.ai.undo"),
        onClick: () => {
          chat.setMessages(backup);
          reapplyPoints(reverted.ids);
        },
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TooltipIconButton tooltip={t("editor.ai.rewind.button")}>
          <Undo2 aria-hidden />
        </TooltipIconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-64 gap-2 p-3 text-xs">
        <p className="font-medium">{t("editor.ai.rewind.title")}</p>
        <p className="text-muted-foreground">{t("editor.ai.rewind.hint")}</p>
        {applied > 0 && (
          <label className="flex items-start gap-2">
            <Checkbox className="mt-0.5" checked={alsoRevert} onCheckedChange={(v) => setAlsoRevert(v === true)} />
            <span>{t("editor.ai.rewind.alsoRevert", { count: applied })}</span>
          </label>
        )}
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={rewind}>
            {t("editor.ai.rewind.confirm")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
