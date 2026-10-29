import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatChord } from "@/shared/lib/keyboard";
import { effectiveKeys, rankCommands, type Command, type RankedCommand } from "../lib/commands";
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
 * 列表交互（↑ / ↓ / Home / End 移动并循环、Enter 执行、指针悬停选中、combobox + listbox 语义）由 cmdk 提供；
 * 排序与命中高亮用编辑器自己的模糊匹配（`rankCommands`），所以关闭了 cmdk 的内置过滤。
 * 不可用的命令置灰，键盘选择会跳过它们。
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

  const results = useMemo<RankedCommand[]>(() => {
    const title = (c: Command) => t(c.titleKey);
    const category = (c: Command) => t(`editor.commands.category.${c.category}`);
    if (query.trim() === "") {
      // 空查询保持命令表的自然顺序（按分类排列）
      return commands.map((command) => ({ command, title: title(command), match: { score: 0, indices: [] } }));
    }
    return rankCommands(commands, query, title, category);
  }, [commands, query, t]);

  const run = (command: Command) => {
    if (command.enabled && !command.enabled()) return;
    onClose();
    command.run();
  };

  return (
    <>
      <DialogTitle className="sr-only">{t("editor.commands.paletteTitle")}</DialogTitle>
      <DialogDescription className="sr-only">{t("editor.commands.paletteHint")}</DialogDescription>
      <Cmdk label={t("editor.commands.paletteSearch")} shouldFilter={false} loop vimBindings={false}>
        <div className="flex items-center gap-3 border-b border-border px-4 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Cmdk.Input
            placeholder={t("editor.commands.paletteSearch")}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onValueChange={setQuery}
          />
        </div>
        <Cmdk.List label={t("editor.commands.paletteTitle")} className="max-h-[50vh] overflow-y-auto p-1.5">
          <Cmdk.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{t("editor.commands.paletteEmpty")}</Cmdk.Empty>
          {results.map((item) => {
            const { command } = item;
            const disabled = command.enabled ? !command.enabled() : false;
            const keys = effectiveKeys(command, overrides);
            return (
              <Cmdk.Item
                key={command.id}
                value={command.id}
                disabled={disabled}
                title={disabled ? t("editor.commands.disabled") : undefined}
                onSelect={() => run(command)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
                  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                  "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
                )}
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
              </Cmdk.Item>
            );
          })}
        </Cmdk.List>
      </Cmdk>
      <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground" aria-hidden>
        {t("editor.commands.paletteHint")}
      </div>
    </>
  );
}
