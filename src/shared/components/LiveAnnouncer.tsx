import { useAnnouncerStore } from "@/shared/stores/announcerStore";

/**
 * 全应用唯一的状态播报区：视觉上隐藏，读屏软件会礼貌地朗读其内容变化。
 *
 * 在应用根挂载一次。内容整体原子更新（`aria-atomic`），奇偶序号追加零宽空格，
 * 保证连续播报同一句话时也会被重新朗读。
 */
export function LiveAnnouncer() {
  const message = useAnnouncerStore((s) => s.message);
  const seq = useAnnouncerStore((s) => s.seq);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
      {seq % 2 === 0 ? "\u200B" : ""}
    </div>
  );
}
