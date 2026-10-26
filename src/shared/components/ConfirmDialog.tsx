import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题：说明要做什么，例如“删除目的地 A？”。 */
  title: string;
  /** 补充说明：写明后果与是否可撤销。 */
  description: string;
  /** 确认按钮文字，应是动作本身（如“删除”），而不是笼统的“确定”。 */
  confirmLabel: string;
  /** 破坏性操作使用红色确认按钮。 */
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * 通用确认对话框：标题 + 说明 + 取消 / 确认。确认后自动关闭。
 *
 * 取消按钮默认聚焦由 Radix 处理（焦点落在对话框内第一个可聚焦元素，即关闭按钮之后的取消键），
 * 避免用户连按回车误触破坏性操作。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}