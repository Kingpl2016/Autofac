import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RECORDINGS_QUERY_KEY } from "@/features/recording";
import { useTauriEvent } from "@/shared/events/useObservable";
import { SHOW_BAKE_EVENT, useBakeStore, type BakeEvent } from "../stores/useBakeStore";

/** 不值得弹错误的跳过原因：工程里还没有灯具，本来就没有东西可生成。 */
const REASON_NOTHING = "nothing_to_bake";

/**
 * 监听后台烘焙（保存时生成 `.artrec`）的事件：
 *
 * - 进行中记录进度，供工具条显示；
 * - 完成 / 失败 / 跳过时用 toast 说明，并刷新节目库列表（“未导出”标记随之变化）。
 *
 * 烘焙失败不影响保存：工程已在节目库里，可以继续编辑再保存重试。
 */
export function useBakeEvents(): void {
  const { t } = useTranslation();
  const client = useQueryClient();

  useTauriEvent<BakeEvent>(SHOW_BAKE_EVENT, (event) => {
    useBakeStore.getState().apply(event);
    if (event.status === "running") return;
    void client.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
    if (event.status === "done") {
      toast.success(t("editor.bake.done", { frames: event.frames ?? 0 }));
    } else if (event.status === "failed") {
      toast.error(t("editor.bake.failed", { reason: event.reason ?? "" }));
    } else if (event.reason === "in_use") {
      toast.warning(t("editor.bake.inUse"));
    } else if (event.reason === REASON_NOTHING) {
      toast.info(t("editor.bake.nothing"));
    }
  });

  // 离开编辑器时清掉进行中的进度
  useEffect(() => () => useBakeStore.getState().reset(), []);
}
