import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { MAX_MEMORY_ITEMS, MAX_MEMORY_TEXT, type MemoryItem } from "../lib/memory";

/** 记忆列表的属性。 */
export interface MemoryNoteListProps {
  items: readonly MemoryItem[];
  /**
   * 添加。
   *
   * @returns 是否已经有同样的内容。
   */
  onAdd: (text: string) => boolean;
  onUpdate: (id: string, patch: Partial<Pick<MemoryItem, "text" | "enabled">>) => void;
  onRemove: (id: string) => void;
  /** 输入框的占位文字 */
  placeholder: string;
  /** 列表的读屏名称 */
  label: string;
  className?: string;
}

/** 一条记忆：文字、启用开关、编辑、删除。 */
function Row({ item, onUpdate, onRemove }: { item: MemoryItem } & Pick<MemoryNoteListProps, "onUpdate" | "onRemove">) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const save = () => {
      onUpdate(item.id, { text: draft });
      setDraft(null);
    };
    return (
      <li className="flex items-center gap-1.5 py-1">
        <Input
          value={draft}
          maxLength={MAX_MEMORY_TEXT}
          aria-label={t("ai.memory.editLabel")}
          className="h-8 flex-1 text-sm"
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setDraft(null);
          }}
        />
        <Button variant="ghost" size="icon" className="size-8" aria-label={t("common.save")} onClick={save}>
          <Check />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label={t("common.cancel")} onClick={() => setDraft(null)}>
          <X />
        </Button>
      </li>
    );
  }
  return (
    <li className="group flex items-center gap-2 py-1">
      <Switch
        checked={item.enabled}
        aria-label={t("ai.memory.enabled", { text: item.text })}
        onCheckedChange={(enabled) => onUpdate(item.id, { enabled })}
      />
      <span className={cn("min-w-0 flex-1 break-words text-sm", !item.enabled && "text-muted-foreground line-through")}>{item.text}</span>
      <Button variant="ghost" size="icon" className="size-8" aria-label={t("ai.memory.edit", { text: item.text })} onClick={() => setDraft(item.text)}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon" className="size-8" aria-label={t("ai.memory.remove", { text: item.text })} onClick={() => onRemove(item.id)}>
        <Trash2 />
      </Button>
    </li>
  );
}

/**
 * 可编辑的记忆列表（个人偏好、工程笔记共用）：添加、改文字、启用 / 停用、删除。
 * 停用的条目划掉显示，不会放进提示词。
 */
export function MemoryNoteList({ items, onAdd, onUpdate, onRemove, placeholder, label, className }: MemoryNoteListProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const full = items.length >= MAX_MEMORY_ITEMS;
  const add = () => {
    if (!text.trim()) return;
    setDuplicate(onAdd(text));
    setText("");
  };
  return (
    <div className={cn("grid gap-1", className)}>
      {items.length > 0 && (
        <ul aria-label={label} className="divide-y divide-border">
          {items.map((m) => (
            <Row key={m.id} item={m} onUpdate={onUpdate} onRemove={onRemove} />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          value={text}
          maxLength={MAX_MEMORY_TEXT}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-8 flex-1 text-sm"
          onChange={(e) => {
            setText(e.target.value);
            setDuplicate(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button variant="outline" size="sm" className="h-8" disabled={!text.trim()} onClick={add}>
          <Plus />
          {t("ai.memory.add")}
        </Button>
      </div>
      {duplicate && <p className="text-xs text-muted-foreground">{t("ai.memory.duplicate")}</p>}
      {full && <p className="text-xs text-muted-foreground">{t("ai.memory.full", { max: MAX_MEMORY_ITEMS })}</p>}
    </div>
  );
}
