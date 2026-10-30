import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Settings, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MemoryNoteList, useAiMemoryStore } from "@/features/ai";
import { cn } from "@/lib/utils";
import type { Exemplar } from "../../ai/memory";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { useAiExemplarStore } from "../../stores/useAiExemplarStore";

/** 一节：标题、说明与内容。 */
function Section({ title, hint, action, children }: { title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 范例列表：用户当时的话、模型的说明、启用开关与删除。 */
function ExemplarList({
  items,
  onEnabled,
  onRemove,
  label,
}: {
  items: readonly Exemplar[];
  onEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  label: string;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{t("editor.ai.memory.noExemplars")}</p>;
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {[...items].reverse().map((e) => (
        <li key={e.id} className="flex items-center gap-2 py-1.5">
          <Switch checked={e.enabled} aria-label={t("ai.memory.enabled", { text: e.request })} onCheckedChange={(on) => onEnabled(e.id, on)} />
          <div className={cn("min-w-0 flex-1", !e.enabled && "text-muted-foreground line-through")}>
            <p className="break-words text-sm">“{e.request}”</p>
            {e.summary && <p className="truncate text-xs text-muted-foreground">→ {e.summary}</p>}
          </div>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("ai.memory.remove", { text: e.request })} onClick={() => onRemove(e.id)}>
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 对话栏里的“记忆”页：本工程笔记（可增删改、停用）、本工程范例与所有工程共用的范例（可停用、删除、清空）。
 * 个人偏好在设置页管理。
 */
export function AiMemoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notes = useAiChatStore((s) => s.notes);
  const exemplars = useAiChatStore((s) => s.exemplars);
  const shared = useAiExemplarStore((s) => s.items);
  const prefCount = useAiMemoryStore((s) => s.prefs.length);
  const [confirmClear, setConfirmClear] = useState(false);
  const chat = useAiChatStore.getState();
  const sharedStore = useAiExemplarStore.getState();

  useEffect(() => {
    void useAiMemoryStore.getState().load();
    void useAiExemplarStore.getState().load();
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title={t("editor.ai.memory.notesTitle")} hint={t("editor.ai.memory.notesHint")}>
        <MemoryNoteList
          items={notes}
          onAdd={chat.addNote}
          onUpdate={chat.updateNote}
          onRemove={chat.removeNote}
          placeholder={t("editor.ai.memory.notePlaceholder")}
          label={t("editor.ai.memory.notesTitle")}
        />
      </Section>
      <Section title={t("editor.ai.memory.exemplarsTitle")} hint={t("editor.ai.memory.exemplarsHint")}>
        <ExemplarList items={exemplars} onEnabled={chat.setExemplarEnabled} onRemove={chat.removeExemplar} label={t("editor.ai.memory.exemplarsTitle")} />
      </Section>
      <Section
        title={t("editor.ai.memory.sharedTitle")}
        hint={t("editor.ai.memory.sharedHint")}
        action={
          shared.length > 0 && (
            <Button
              variant={confirmClear ? "destructive" : "ghost"}
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              onBlur={() => setConfirmClear(false)}
              onClick={() => {
                if (!confirmClear) return setConfirmClear(true);
                sharedStore.clear();
                setConfirmClear(false);
              }}
            >
              {t(confirmClear ? "editor.ai.memory.confirmClear" : "editor.ai.memory.clearShared")}
            </Button>
          )
        }
      >
        <ExemplarList items={shared} onEnabled={sharedStore.setEnabled} onRemove={sharedStore.remove} label={t("editor.ai.memory.sharedTitle")} />
      </Section>
      <Section title={t("editor.ai.memory.prefsTitle")} hint={t("editor.ai.memory.prefsHint", { count: prefCount })}>
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => navigate("/settings#ai")}>
          <Settings />
          {t("editor.ai.memory.openPrefs")}
        </Button>
      </Section>
    </div>
  );
}
