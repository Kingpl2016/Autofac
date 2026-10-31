import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAiModelsDialogStore } from "../stores/useAiModelsDialogStore";
import { AiProfileList } from "./AiProfileList";

/**
 * “模型配置”对话框：在当前页面里管理 AI 配置（添加、编辑、测试连接、设为默认、删除），不用跳到设置页。
 * 内容与设置页“AI 助手”分区的配置列表相同。
 */
export function AiModelsDialog() {
  const { t } = useTranslation();
  const open = useAiModelsDialogStore((s) => s.open);
  const setOpen = useAiModelsDialogStore((s) => s.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl gap-4">
        <DialogHeader>
          <DialogTitle>{t("ai.models.title")}</DialogTitle>
          <DialogDescription>{t("ai.models.hint")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border">
          <AiProfileList />
        </div>
      </DialogContent>
    </Dialog>
  );
}
