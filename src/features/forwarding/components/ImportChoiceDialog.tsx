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

interface ImportChoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 文件里的目的地数量。 */
  count: number;
  /** 当前已有的目的地数量。 */
  current: number;
  onReplace: () => void;
  onMerge: () => void;
}

/**
 * 导入前的选择框：当前已有目的地时，让用户决定“替换”还是“合并”。
 * 替换会丢弃现有目的地，用破坏性样式提示。
 */
export function ImportChoiceDialog({
  open,
  onOpenChange,
  count,
  current,
  onReplace,
  onMerge,
}: ImportChoiceDialogProps) {
  const { t } = useTranslation();
  const choose = (action: () => void) => () => {
    action();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("forwarding.import.title", { count })}</DialogTitle>
          <DialogDescription>{t("forwarding.import.desc", { current })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={choose(onReplace)}>
            {t("forwarding.import.replace")}
          </Button>
          <Button onClick={choose(onMerge)}>{t("forwarding.import.merge")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}