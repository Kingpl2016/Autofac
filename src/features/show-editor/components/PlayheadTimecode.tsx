import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { seekTo } from "../hooks/transportActions";
import { formatTimecode, parseJumpTime } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 播放头时间码。
 *
 * 播放期间播放头每秒更新约 30 次，单独成组件，保证只有这一小块文字随之重绘。
 * `editable` 时点它可以直接输入跳转（`1:23.10`、`83s`、`12f`、`+2s` / `-10f` 相对跳转），回车确认、Esc 放弃；
 * 播放中不进入编辑。
 *
 * @param props.label 无障碍名称。
 * @param props.className 样式。
 * @param props.editable 是否可以点击输入跳转。
 */
export function PlayheadTimecode({ label, className, editable = false }: { label: string; className?: string; editable?: boolean }) {
  const { t } = useTranslation();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const playing = usePlaybackStore((s) => s.state?.transport === "playing");
  const [draft, setDraft] = useState<string | null>(null);

  if (!editable) {
    return (
      <span className={className} aria-label={label}>
        {formatTimecode(playheadMs)}
      </span>
    );
  }

  if (draft !== null) {
    const commit = () => {
      const target = parseJumpTime(draft, playheadMs);
      setDraft(null);
      if (target === null) {
        announce(t("editor.jump.invalid"));
        return;
      }
      void seekTo(Math.min(target, useProjectStore.getState().project.durationMs));
    };
    return (
      <input
        // 打开时直接可以输入
        autoFocus
        aria-label={t("editor.jump.input")}
        title={t("editor.jump.hint")}
        className={cn(className, "num h-6 w-28 rounded-sm border border-input bg-background px-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(className, "rounded-sm px-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      aria-label={`${label} ${formatTimecode(playheadMs)}，${t("editor.jump.click")}`}
      title={t("editor.jump.hint")}
      disabled={playing}
      onClick={() => setDraft(formatTimecode(playheadMs))}
    >
      {formatTimecode(playheadMs)}
    </button>
  );
}
