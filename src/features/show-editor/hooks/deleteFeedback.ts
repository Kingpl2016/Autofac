import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 删除后的反馈：右下角提示带“撤销”按钮（点了就撤销最近一步），同时读给屏幕阅读器。
 *
 * @param text 提示文字，例如“已删除标记 副歌”。
 */
export function notifyDeleted(text: string): void {
  announce(text);
  toast(text, {
    action: {
      label: i18n.t("editor.undoAction"),
      onClick: () => useProjectStore.temporal.getState().undo(),
    },
  });
}
