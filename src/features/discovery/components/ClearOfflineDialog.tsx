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

interface ClearOfflineDialogProps {
  open: boolean;
  /** 将被清理的离线设备数量 */
  count: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/** 清理离线设备前的确认框：写明数量，并说明自定义名称会保留。 */
export function ClearOfflineDialog({
  open,
  count,
  onOpenChange,
  onConfirm,
}: ClearOfflineDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("discovery.clearConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("discovery.clearConfirmDesc", { n: count })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("discovery.clearConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
