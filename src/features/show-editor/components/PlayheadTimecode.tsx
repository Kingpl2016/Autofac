import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";

/**
 * 播放头时间码。
 *
 * 播放期间播放头每秒更新约 30 次，单独成组件，保证只有这一小块文字随之重绘。
 */
export function PlayheadTimecode({ label, className }: { label: string; className?: string }) {
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  return (
    <span className={className} aria-label={label}>
      {formatTimecode(playheadMs)}
    </span>
  );
}
