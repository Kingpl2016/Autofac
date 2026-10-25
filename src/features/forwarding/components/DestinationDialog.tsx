import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  parseRange,
  type ForwardDestination,
  type OverrideAction,
} from "../lib/types";

interface DestinationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ForwardDestination;
  onSave: (dest: ForwardDestination) => void;
}

/**
 * 目的地新增/编辑对话框：全字段 + per-universe 覆盖编辑 + 范围批量添加。
 */
export function DestinationDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: DestinationDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ForwardDestination>(initial);
  const [rangeText, setRangeText] = useState("");

  const patch = (p: Partial<ForwardDestination>) =>
    setDraft((d) => ({ ...d, ...p }));

  const addOverride = () =>
    patch({
      overrides: [
        ...draft.overrides,
        { sourceUniverse: 0, action: "forward", targetUniverse: null, delayMs: null },
      ],
    });

  const applyRange = () => {
    const unis = parseRange(rangeText);
    const existing = new Set(draft.overrides.map((o) => o.sourceUniverse));
    const added = unis
      .filter((u) => !existing.has(u))
      .map((u) => ({
        sourceUniverse: u,
        action: "forward" as OverrideAction,
        targetUniverse: null,
        delayMs: null,
      }));
    patch({ overrides: [...draft.overrides, ...added] });
    setRangeText("");
  };

  const handleSave = () => {
    if (!draft.name.trim() || !draft.targetIp.trim()) {
      toast.error(t("forwarding.required"));
      return;
    }
    onSave(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initial.name ? t("forwarding.editDestination") : t("forwarding.addDestination")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 grid gap-1.5">
            <Label>{t("forwarding.name")}</Label>
            <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.targetIp")}</Label>
            <Input
              className="tabular"
              placeholder="10.0.0.5"
              value={draft.targetIp}
              onChange={(e) => patch({ targetIp: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.protocol")}</Label>
            <Select
              value={draft.protocol}
              onValueChange={(v) =>
                patch({
                  protocol: v as ForwardDestination["protocol"],
                  port: v === "sacn" ? 5568 : 6454,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="artNet">Art-Net</SelectItem>
                <SelectItem value="sacn">sACN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.port")}</Label>
            <Input
              type="number"
              className="tabular"
              value={draft.port}
              onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.mode")}</Label>
            <Select
              value={draft.mode}
              onValueChange={(v) => patch({ mode: v as ForwardDestination["mode"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("forwarding.modeAll")}</SelectItem>
                <SelectItem value="selected">{t("forwarding.modeSelected")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.universeOffset")}</Label>
            <Input
              type="number"
              className="tabular"
              value={draft.universeOffset}
              onChange={(e) => patch({ universeOffset: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.defaultDelay")}</Label>
            <Input
              type="number"
              className="tabular"
              value={draft.defaultDelayMs}
              onChange={(e) =>
                patch({ defaultDelayMs: Math.min(2000, Number(e.target.value) || 0) })
              }
            />
          </div>
          <div className="col-span-2 grid gap-1.5">
            <Label>{t("forwarding.description")}</Label>
            <Textarea
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>
        </div>

        {/* 覆盖规则 */}
        <div className="mt-1">
          <div className="mb-2 flex items-center justify-between">
            <Label>{t("forwarding.overrides")}</Label>
            <Button variant="outline" size="sm" onClick={addOverride}>
              <Plus />
              {t("forwarding.addOverride")}
            </Button>
          </div>

          <div className="mb-2 flex items-center gap-2">
            <Input
              className="tabular"
              placeholder={t("forwarding.rangeAdd")}
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
            />
            <Button variant="secondary" size="sm" onClick={applyRange}>
              {t("forwarding.rangeApply")}
            </Button>
          </div>

          <div className="space-y-1.5">
            {draft.overrides.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="number"
                  className="tabular w-20"
                  aria-label={t("forwarding.sourceUniverse")}
                  value={o.sourceUniverse}
                  onChange={(e) => {
                    const ov = [...draft.overrides];
                    ov[i] = { ...o, sourceUniverse: Number(e.target.value) || 0 };
                    patch({ overrides: ov });
                  }}
                />
                <Select
                  value={o.action}
                  onValueChange={(v) => {
                    const ov = [...draft.overrides];
                    ov[i] = { ...o, action: v as OverrideAction };
                    patch({ overrides: ov });
                  }}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forward">{t("forwarding.actionForward")}</SelectItem>
                    <SelectItem value="exclude">{t("forwarding.actionExclude")}</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  className="tabular w-24"
                  placeholder={t("forwarding.targetUniverse")}
                  value={o.targetUniverse ?? ""}
                  onChange={(e) => {
                    const ov = [...draft.overrides];
                    const val = e.target.value === "" ? null : Number(e.target.value);
                    ov[i] = { ...o, targetUniverse: val };
                    patch({ overrides: ov });
                  }}
                />
                <Input
                  type="number"
                  className="tabular w-20"
                  placeholder={t("forwarding.delay")}
                  value={o.delayMs ?? ""}
                  onChange={(e) => {
                    const ov = [...draft.overrides];
                    const val = e.target.value === "" ? null : Number(e.target.value);
                    ov[i] = { ...o, delayMs: val };
                    patch({ overrides: ov });
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    patch({ overrides: draft.overrides.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
