import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatChord } from "@/shared/lib/keyboard";
import { effectiveKeys, rankCommands, type Command, type CommandCategory } from "../lib/commands";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useKeymapStore } from "../stores/useKeymapStore";

/** 分类的显示顺序。 */
const CATEGORY_ORDER: readonly CommandCategory[] = ["file", "edit", "select", "transport", "timeline", "insert", "view", "output"];

/**
 * 快捷键速查表（帮助菜单）：按分类列出所有有快捷键的命令（含自定义后的组合键），可搜索；
 * 只读，“自定义快捷键…”打开设置对话框。
 */
export function ShortcutSheetDialog({ commands }: { commands: readonly Command[] }) {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.shortcutSheetOpen);
  const setOpen = useEditorUiStore((s) => s.setShortcutSheetOpen);
  const overrides = useKeymapStore((s) => s.overrides);
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const withKeys = commands.filter((c) => effectiveKeys(c, overrides).length > 0);
    const matched =
      query.trim() === ""
        ? withKeys
        : rankCommands(withKeys, query, (c) => t(c.titleKey), (c) => t(`editor.commands.category.${c.category}`)).map((r) => r.command);
    const set = new Set(matched.map((c) => c.id));
    return CATEGORY_ORDER.map((category) => ({ category, items: withKeys.filter((c) => c.category === category && set.has(c.id)) })).filter(
      (s) => s.items.length > 0,
    );
  }, [commands, overrides, query, t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-3 overflow-hidden p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard aria-hidden className="size-4" />
            {t("editor.shortcutSheet.title")}
          </DialogTitle>
          <DialogDescription>{t("editor.shortcutSheet.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label={t("editor.shortcutSheet.search")}
              placeholder={t("editor.shortcutSheet.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => {
              setOpen(false);
              useEditorUiStore.getState().setKeymapOpen(true);
            }}
          >
            {t("editor.shortcutSheet.customize")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {sections.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("editor.keymap.empty")}</p>
          ) : (
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {sections.map(({ category, items }) => {
                const name = t(`editor.commands.category.${category}`);
                return (
                  <section key={category} aria-label={name}>
                    <h3 className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">{name}</h3>
                    <dl className="grid">
                      {items.map((c) => (
                        <div key={c.id} className="flex items-center justify-between gap-3 border-b border-border/60 py-1 last:border-b-0">
                          <dt className="min-w-0 truncate text-sm">{t(c.titleKey)}</dt>
                          <dd className="flex shrink-0 flex-wrap justify-end gap-1">
                            {effectiveKeys(c, overrides).map((k) => (
                              <kbd key={k} className="num rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-foreground">
                                {formatChord(k)}
                              </kbd>
                            ))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
