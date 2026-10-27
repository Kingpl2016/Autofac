import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { chordOf, effectiveKeys, findConflicts, formatChord, rankCommands, type Command } from "../lib/commands";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useKeymapStore } from "../stores/useKeymapStore";

/**
 * 快捷键设置：搜索命令，点击快捷键后按下新的组合键录入（Esc 取消，Backspace / Delete 单独按下也可录入），
 * 清除、恢复单个或全部默认；冲突的组合键标红并列出冲突命令。自定义保存在界面偏好里。
 */
export function KeymapDialog({ commands }: { commands: readonly Command[] }) {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.keymapOpen);
  const setOpen = useEditorUiStore((s) => s.setKeymapOpen);
  const overrides = useKeymapStore((s) => s.overrides);
  const setKeys = useKeymapStore((s) => s.setKeys);
  const reset = useKeymapStore((s) => s.reset);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);

  const titleOf = (c: Command) => t(c.titleKey);
  const ranked = useMemo(() => {
    const title = (c: Command) => t(c.titleKey);
    // 空查询保持命令表的自然顺序（按分类排列）
    if (query.trim() === "") return commands.map((command) => ({ command, title: title(command) }));
    return rankCommands(commands, query, title, (c) => t(`editor.commands.category.${c.category}`));
  }, [commands, query, t]);
  const conflicts = useMemo(() => new Map(findConflicts(commands, overrides)), [commands, overrides]);
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands]);

  const onRecordKey = (command: Command) => (e: KeyboardEvent<HTMLButtonElement>) => {
    // 录入时拦下所有按键，不让编辑器快捷键响应
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      return;
    }
    const chord = chordOf(e);
    if (chord === "") return; // 只按了修饰键，继续等
    setKeys(command.id, [chord]);
    setRecording(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setRecording(null);
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-hidden p-6"
        onEscapeKeyDown={(e) => {
          // 录入中按 Esc 只取消录入，不关闭对话框
          if (recording) {
            e.preventDefault();
            setRecording(null);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("editor.keymap.title")}</DialogTitle>
          <DialogDescription>{t("editor.keymap.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("editor.keymap.search")}
            placeholder={t("editor.keymap.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => reset()}>
            {t("editor.keymap.resetAll")}
          </Button>
        </div>
        <ul aria-label={t("editor.keymap.title")} className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          {ranked.length === 0 && <li className="p-3 text-sm text-muted-foreground">{t("editor.keymap.empty")}</li>}
          {ranked.map(({ command, title }) => {
            const keys = effectiveKeys(command, overrides);
            const custom = overrides[command.id] !== undefined;
            const clashes = keys.flatMap((k) => (conflicts.get(k) ?? []).filter((id) => id !== command.id));
            const isRecording = recording === command.id;
            return (
              <li key={command.id} className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{title}</span>
                  {clashes.length > 0 && (
                    <span className="block truncate text-xs text-destructive">
                      {t("editor.keymap.conflict", {
                        names: [...new Set(clashes)].map((id) => {
                          const c = byId.get(id);
                          return c ? titleOf(c) : id;
                        }).join("、"),
                      })}
                    </span>
                  )}
                </span>
                {custom && <span className="shrink-0 text-[10px] text-primary">{t("editor.keymap.custom")}</span>}
                <button
                  type="button"
                  aria-label={t("editor.keymap.record", { name: title })}
                  aria-pressed={isRecording}
                  onClick={() => setRecording(isRecording ? null : command.id)}
                  onKeyDown={isRecording ? onRecordKey(command) : undefined}
                  onBlur={() => isRecording && setRecording(null)}
                  className={cn(
                    "num min-w-28 shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isRecording ? "border-primary bg-primary/10" : clashes.length > 0 ? "border-destructive text-destructive" : "border-border",
                  )}
                >
                  {isRecording ? t("editor.keymap.recording") : keys.length > 0 ? keys.map(formatChord).join(" / ") : t("editor.keymap.none")}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={t("editor.keymap.clear", { name: title })}
                  title={t("editor.keymap.clear", { name: title })}
                  disabled={keys.length === 0}
                  onClick={() => setKeys(command.id, [])}
                >
                  <X aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={t("editor.keymap.reset", { name: title })}
                  title={t("editor.keymap.reset", { name: title })}
                  disabled={!custom}
                  onClick={() => reset(command.id)}
                >
                  <RotateCcw aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
