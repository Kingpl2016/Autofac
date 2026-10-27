import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { effectiveKeys, formatChord, rankCommands, type Command, type RankedCommand } from "../lib/commands";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useKeymapStore } from "../stores/useKeymapStore";

/**
 * 把命中的字符加粗显示。
 *
 * @param props.text 标题。
 * @param props.indices 命中的字符下标。
 */
function Highlighted({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const hit = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        hit.has(i) ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/**
 * 命令面板（Ctrl+K）：模糊搜索全部编辑器命令并执行，右侧显示当前生效的快捷键。
 *
 * 键盘：↑ / ↓ 移动、Enter 执行、Esc 关闭；不可用的命令置灰且不能执行。
 * 采用 WAI-ARIA combobox + listbox 模式（焦点留在搜索框，`aria-activedescendant` 指向当前项）。
 *
 * @param props.commands 全部命令（来自 `useEditorHotkeys`）。
 */
export function CommandPalette({ commands }: { commands: readonly Command[] }) {
  const open = useEditorUiStore((s) => s.paletteOpen);
  const setOpen = useEditorUiStore((s) => s.setPaletteOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[18%] max-w-xl -translate-y-0 gap-0 overflow-hidden p-0">
        {/* 关闭时内容卸载，下次打开自然从空查询开始 */}
        <PaletteBody commands={commands} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 命令面板的内容（搜索框 + 结果列表）。
 *
 * @param props.commands 全部命令。
 * @param props.onClose 关闭面板。
 */
function PaletteBody({ commands, onClose }: { commands: readonly Command[]; onClose: () => void }) {
  const { t } = useTranslation();
  const overrides = useKeymapStore((s) => s.overrides);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo<RankedCommand[]>(() => {
    const title = (c: Command) => t(c.titleKey);
    const category = (c: Command) => t(`editor.commands.category.${c.category}`);
    if (query.trim() === "") {
      // 空查询保持命令表的自然顺序（按分类排列）
      return commands.map((command) => ({ command, title: title(command), match: { score: 0, indices: [] } }));
    }
    return rankCommands(commands, query, title, category);
  }, [commands, query, t]);

  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // 让当前项保持在可视范围内
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const run = (item: RankedCommand | undefined) => {
    if (!item) return;
    const { command } = item;
    if (command.enabled && !command.enabled()) return;
    onClose();
    command.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      setActive(results.length === 0 ? 0 : (current + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      setActive(results.length === 0 ? 0 : (current - 1 + results.length) % results.length);
    } else if (e.key === "Home") {
      setActive(0);
    } else if (e.key === "End") {
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      run(results[current]);
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    <>
      <DialogTitle className="sr-only">{t("editor.commands.paletteTitle")}</DialogTitle>
      <DialogDescription className="sr-only">{t("editor.commands.paletteHint")}</DialogDescription>
      <div className="flex items-center gap-3 border-b border-border px-4 pr-12">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label={t("editor.commands.paletteSearch")}
          placeholder={t("editor.commands.paletteSearch")}
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("editor.commands.paletteTitle")}
        className="max-h-[50vh] overflow-y-auto p-1.5"
      >
        {results.length === 0 && (
          <li role="presentation" className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t("editor.commands.paletteEmpty")}
          </li>
        )}
        {results.map((item, i) => {
          const { command } = item;
          const disabled = command.enabled ? !command.enabled() : false;
          const keys = effectiveKeys(command, overrides);
          return (
            <li
              key={command.id}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={i === current}
              aria-disabled={disabled || undefined}
              title={disabled ? t("editor.commands.disabled") : undefined}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
                i === current && "bg-accent text-accent-foreground",
                disabled && "cursor-not-allowed opacity-50",
              )}
              onPointerMove={() => setActive(i)}
              onClick={() => run(item)}
            >
              <span className="w-14 shrink-0 text-xs text-muted-foreground">
                {t(`editor.commands.category.${command.category}`)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <Highlighted text={item.title} indices={item.match.indices} />
              </span>
              {keys.length > 0 && (
                <span className="flex shrink-0 gap-1">
                  {keys.slice(0, 2).map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {formatChord(k)}
                    </kbd>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground" aria-hidden>
        {t("editor.commands.paletteHint")}
      </div>
    </>
  );
}
