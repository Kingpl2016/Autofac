import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { formatChord } from "@/shared/lib/keyboard";
import { effectiveKeys, type Command } from "../lib/commands";
import { mergeLayers } from "../lib/layers";
import { colorValueRgb, paramHead } from "../lib/looks";
import type { Preset } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useKeymapStore } from "../stores/useKeymapStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 轮盘上默认的命令（最多 7 个，第 8 格留给“预设”）。 */
const RADIAL_COMMANDS = [
  "timeline.split",
  "edit.copy",
  "edit.paste",
  "edit.delete",
  "timeline.marker",
  "timeline.snap",
  "programmer.recordScene",
] as const;

/** 轮盘半径（像素）。 */
const RADIUS = 92;
/** 一格的尺寸（像素）。 */
const ITEM = 64;

/** 轮盘上的一格。 */
interface RadialItem {
  id: string;
  label: string;
  hint?: string;
  swatch?: string;
  disabled?: boolean;
  run: () => void;
}

/** 预设代表色。 */
function presetSwatch(p: Preset): string {
  const c = paramHead(p.look.color);
  if (!c) return "transparent";
  const [r, g, b] = colorValueRgb(c);
  return `rgb(${r} ${g} ${b})`;
}

/**
 * 径向轮盘（快捷操作）：按 `Shift+Q` 打开（右键改为上下文菜单），围成一圈的常用命令，数字键 1~8 直接执行；
 * “预设”格切到预设轮：选中外观片段时把预设应用到片段，否则应用到编程器里选中的灯。
 *
 * @param props.commands 全部命令（与快捷键、命令面板共用）。
 */
export function RadialMenu({ commands }: { commands: readonly Command[] }) {
  const { t } = useTranslation();
  const at = useEditorUiStore((s) => s.radial);
  const setRadial = useEditorUiStore((s) => s.setRadial);
  const presets = useProjectStore((s) => s.project.presets);
  const overrides = useKeymapStore((s) => s.overrides);
  const [mode, setMode] = useState<"commands" | "presets">("commands");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => {
    setRadial(null);
    setMode("commands");
  };

  const applyPreset = (preset: Preset) => {
    const ui = useEditorUiStore.getState();
    const { project } = useProjectStore.getState();
    const looks = project.cues.filter((c) => c.kind === "look" && ui.selectedCueIds.includes(c.id)).map((c) => c.id);
    if (looks.length > 0) {
      useProjectStore.getState().update((d) => {
        for (const c of d.cues) if (c.kind === "look" && looks.includes(c.id)) c.look.presetId = preset.id;
      });
      announce(t("editor.presets.applied", { name: preset.name, count: looks.length }));
    } else if (ui.selectedFixtureIds.length > 0) {
      const values = { ...useProgrammerStore.getState().values };
      for (const id of ui.selectedFixtureIds) {
        const look = { ...(values[id] ?? {}) };
        mergeLayers(look, preset.look);
        values[id] = look;
      }
      useProgrammerStore.getState().setValues(values);
      announce(t("editor.presets.appliedProgrammer", { name: preset.name, count: ui.selectedFixtureIds.length }));
    } else {
      announce(t("editor.radial.nothingSelected"));
    }
  };

  const items: RadialItem[] =
    mode === "commands"
      ? [
          ...RADIAL_COMMANDS.map((id) => commands.find((c) => c.id === id))
            .filter((c): c is Command => c !== undefined)
            .map((c) => ({
              id: c.id,
              label: t(c.titleKey),
              hint: effectiveKeys(c, overrides).map(formatChord)[0],
              disabled: c.enabled ? !c.enabled() : false,
              run: () => {
                close();
                c.run();
              },
            })),
          {
            id: "presets",
            label: t("editor.radial.presets"),
            disabled: presets.length === 0,
            run: () => setMode("presets"),
          },
        ]
      : [
          ...presets.slice(0, 7).map((p) => ({
            id: p.id,
            label: p.name,
            swatch: presetSwatch(p),
            run: () => {
              close();
              applyPreset(p);
            },
          })),
          { id: "back", label: t("editor.radial.back"), run: () => setMode("commands") },
        ];

  // 打开或切换轮盘时聚焦第一格
  useEffect(() => {
    if (at) refs.current.find((b) => b && !b.disabled)?.focus();
  }, [at, mode]);

  if (!at) return null;

  // 轮盘不超出窗口
  const margin = RADIUS + ITEM;
  const cx = Math.min(Math.max(at.x, margin), window.innerWidth - margin);
  const cy = Math.min(Math.max(at.y, margin), window.innerHeight - margin);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = refs.current.findIndex((b) => b === document.activeElement);
    const n = items.length;
    if (e.key === "Escape") close();
    else if (/^[1-8]$/.test(e.key)) {
      const item = items[Number(e.key) - 1];
      if (item && !item.disabled) item.run();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") refs.current[(index + 1 + n) % n]?.focus();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") refs.current[(index - 1 + n) % n]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div
        role="menu"
        aria-label={mode === "commands" ? t("editor.radial.title") : t("editor.radial.presetsTitle")}
        className="absolute"
        style={{ left: cx, top: cy }}
        onKeyDown={onKeyDown}
      >
        <div
          aria-hidden
          className="absolute size-56 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-popover/90 shadow-2xl backdrop-blur-sm"
        />
        <span aria-hidden className="absolute -translate-x-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
          {mode === "commands" ? t("editor.radial.hint") : t("editor.radial.presetsTitle")}
        </span>
        {items.map((item, i) => {
          const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
          return (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-keyshortcuts={String(i + 1)}
              onClick={item.run}
              className={cn(
                "absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-full border border-border bg-surface-2 p-1 text-center text-[10px] leading-tight shadow",
                "hover:border-primary hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
              style={{ left: Math.cos(angle) * RADIUS, top: Math.sin(angle) * RADIUS, width: ITEM, height: ITEM }}
            >
              <span className="num text-[9px] text-muted-foreground">{i + 1}</span>
              {item.id === "presets" && <Bookmark aria-hidden className="size-3.5" />}
              {item.id === "back" && <ChevronLeft aria-hidden className="size-3.5" />}
              {item.swatch && (
                <span
                  aria-hidden
                  className="size-3.5 rounded-sm border border-border bg-(--sw)"
                  style={{ "--sw": item.swatch } as CSSProperties}
                />
              )}
              <span className="line-clamp-2 max-w-full px-0.5">{item.label}</span>
              {item.hint && <span className="text-[9px] text-muted-foreground">{item.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
