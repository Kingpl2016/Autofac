import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RgbColorPicker } from "react-colorful";

import { cssColor } from "../lib/cueTemplates";
import type { Rgb } from "../lib/project";
import { CommitInput } from "./CommitInput";
interface ColorSectionProps {
  rgb: Rgb;
  mixed: boolean;
  onCommit: (rgb: Rgb) => void;
}

/**
 * 颜色区：色板 + R / G / B 数字框。
 *
 * 拖动色板时只改本地草稿，松开指针才提交；`key` 随选中项变化，切换选择时草稿重置。
 */
export function ColorSection({ rgb, mixed, onCommit }: ColorSectionProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Rgb | null>(null);
  const shown = draft ?? rgb;

  useEffect(() => {
    if (draft === null) return;
    const finish = () => {
      onCommit(draft);
      setDraft(null);
    };
    window.addEventListener("pointerup", finish, { once: true });
    return () => window.removeEventListener("pointerup", finish);
  }, [draft, onCommit]);

  const channels: { key: "r" | "g" | "b"; index: 0 | 1 | 2; label: string }[] = [
    { key: "r", index: 0, label: t("editor.cue.red") },
    { key: "g", index: 1, label: t("editor.cue.green") },
    { key: "b", index: 2, label: t("editor.cue.blue") },
  ];

  // 外层的分区（“颜色”）提供标题；这里只放色板与数字框
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{mixed ? t("editor.cue.mixed") : null}</span>
        <span
          aria-hidden
          className="size-5 rounded-sm border border-border bg-(--cue-color)"
          style={{ "--cue-color": cssColor(shown) } as React.CSSProperties}
        />
      </div>
      <RgbColorPicker
        className="!w-full"
        color={{ r: shown[0], g: shown[1], b: shown[2] }}
        onChange={({ r, g, b }) => setDraft([r, g, b])}
      />
      <div className="grid grid-cols-3 gap-2">
        {channels.map((c) => (
          <label key={c.key} className="grid gap-1 text-xs text-muted-foreground">
            {c.label}
            <CommitInput
              className="num h-8 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.cue.numberOf", { field: c.label })}
              value={shown[c.index]}
              onCommit={(text) => {
                const n = Number(text);
                if (!Number.isFinite(n)) return;
                const next: Rgb = [...rgb];
                next[c.index] = Math.min(255, Math.max(0, Math.round(n)));
                onCommit(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
