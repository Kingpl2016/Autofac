import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Upload,
  Download,
  Pencil,
  Copy,
  Trash2,
  TriangleAlert,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/shared/components/PageHeader";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { useProtocolFlags } from "@/features/settings";
import { openTextFile, saveTextFile } from "@/shared/tauri/files";
import { useNow } from "@/shared/hooks/useNow";
import { useOutputStore } from "@/shared/stores/outputStore";
import { DestinationDialog } from "./DestinationDialog";
import { DestinationStats } from "./DestinationStats";
import { ImportChoiceDialog } from "./ImportChoiceDialog";
import { useForwardingDraft } from "../hooks/useForwarding";
import { describeImportError } from "../lib/importMessage";
import { canMove } from "../lib/order";
import type { ForwardingPrefill } from "../lib/prefill";
import { mergeImported, parseImport } from "../lib/transfer";
import {
  newDestination,
  type ForwardDestination,
  type ForwardingTable,
} from "../lib/types";

interface ForwardingEditorProps {
  initial: ForwardingTable;
  /** 来自其它页面的预填信息：该 IP 已有目的地则直接编辑它，否则预填一个新目的地 */
  prefill?: ForwardingPrefill | null;
  /** 一次自动保存成功后的回调，用于同步查询缓存 */
  onSaved?: (list: ForwardDestination[]) => void;
}

/**
 * 转发编辑器：目的地列表（启停/编辑/复制/删除）+ 新增 + 导入导出。
 *
 * 删除前需确认；导入会先校验文件，已有目的地时让用户选择“替换”还是“合并”；
 * 自动保存失败时在页面顶部给出可重试的提示。
 */
export function ForwardingEditor({ initial, prefill = null, onSaved }: ForwardingEditorProps) {
  const { t } = useTranslation();
  const { destinations, status, upsert, remove, toggle, duplicate, replaceAll, move, retry } =
    useForwardingDraft(initial, { onSaved });
  const output = useOutputStore((s) => s.output);
  const receivedAt = useOutputStore((s) => s.receivedAt);
  const now = useNow(1000);
  // 预填只在挂载时消费一次：命中已有目的地就编辑它，避免对同一设备建出重复目的地
  const [editing, setEditing] = useState<ForwardDestination | null>(() => {
    if (!prefill) return null;
    const existing = initial.destinations.find((d) => d.targetIp === prefill.targetIp);
    return existing ?? { ...newDestination(), name: prefill.name, targetIp: prefill.targetIp };
  });
  const [pendingDelete, setPendingDelete] = useState<ForwardDestination | null>(null);
  const [pendingImport, setPendingImport] = useState<ForwardDestination[] | null>(null);
  const prefillToasted = useRef(false);
  useEffect(() => {
    if (!prefill || prefillToasted.current) return;
    prefillToasted.current = true;
    const exists = initial.destinations.some((d) => d.targetIp === prefill.targetIp);
    toast.info(
      t(exists ? "forwarding.prefillExisting" : "forwarding.prefillFromDiscovery", {
        ip: prefill.targetIp,
      }),
    );
  }, [prefill, initial.destinations, t]);
  const { sacnEnabled } = useProtocolFlags();
  // 只在渲染时过滤：sACN 目的地的数据仍保留在转发表里（保存 / 导出不受影响），重新开启后恢复显示
  const isVisible = (d: ForwardDestination) => sacnEnabled || d.protocol !== "sacn";
  const visible = destinations.filter(isVisible);

  const handleExport = () => {
    void saveTextFile(
      "art-net-studio-forwarding.json",
      JSON.stringify(destinations, null, 2),
    );
  };

  const applyImport = (list: ForwardDestination[], how: "replace" | "merge") => {
    replaceAll(how === "replace" ? list : mergeImported(destinations, list));
    toast.success(t("forwarding.import.done", { count: list.length }));
  };

  const handleImport = async () => {
    try {
      const text = await openTextFile();
      if (text === null) return;
      const result = parseImport(text);
      if (!result.ok) {
        toast.error(describeImportError(result.error, t));
        return;
      }
      // 当前没有目的地时没有可丢失的内容，不必再确认
      if (destinations.length === 0) applyImport(result.destinations, "replace");
      else setPendingImport(result.destinations);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const summary = (d: ForwardDestination) =>
    [
      `${d.targetIp}:${d.port}`,
      d.universeOffset !== 0 && t("forwarding.summary.offset", { n: d.universeOffset }),
      d.defaultDelayMs > 0 && t("forwarding.summary.delay", { ms: d.defaultDelayMs }),
      d.overrides.length > 0 && t("forwarding.summary.overrides", { count: d.overrides.length }),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div>
      <PageHeader
        title={t("forwarding.title")}
        subtitle={t("forwarding.subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void handleImport()}>
              <Upload />
              {t("common.import")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download />
              {t("common.export")}
            </Button>
            <Button size="sm" onClick={() => setEditing(newDestination())}>
              <Plus />
              {t("forwarding.addDestination")}
            </Button>
          </>
        }
      />

      {status === "error" && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div>
              <div className="text-sm font-medium text-destructive">
                {t("forwarding.saveFailed")}
              </div>
              <div className="text-xs text-muted-foreground">{t("forwarding.saveFailedHint")}</div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={retry}>
            {t("forwarding.retry")}
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          {t("forwarding.noDestinations")}
        </div>
      ) : (
        <div className="grid gap-3">
          {visible.map((d) => (
            <Card key={d.id}>
              <CardContent className="flex items-center gap-4 p-5">
                <Switch
                  checked={d.enabled}
                  onCheckedChange={() => toggle(d.id)}
                  aria-label={`${t("forwarding.enabled")} ${d.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.name || "—"}</span>
                    {sacnEnabled && (
                      <Badge variant={d.protocol === "sacn" ? "secondary" : "default"}>
                        {d.protocol === "sacn" ? "sACN" : "Art-Net"}
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {d.mode === "all" ? t("forwarding.modeAll") : t("forwarding.modeSelected")}
                    </Badge>
                  </div>
                  <div className="tabular mt-0.5 text-xs text-muted-foreground">{summary(d)}</div>
                  <DestinationStats dest={d} output={output} receivedAt={receivedAt} now={now} />
                </div>
                <div className="flex flex-col">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`${t("forwarding.moveUp")} ${d.name}`}
                    disabled={!canMove(destinations, d.id, -1, isVisible)}
                    onClick={() => move(d.id, -1, isVisible)}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`${t("forwarding.moveDown")} ${d.name}`}
                    disabled={!canMove(destinations, d.id, 1, isVisible)}
                    onClick={() => move(d.id, 1, isVisible)}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("common.edit")} ${d.name}`}
                  onClick={() => setEditing(d)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("forwarding.duplicate")} ${d.name}`}
                  onClick={() => duplicate(d.id)}
                >
                  <Copy className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("common.delete")} ${d.name}`}
                  onClick={() => setPendingDelete(d)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <DestinationDialog
          key={editing.id}
          open={true}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          initial={editing}
          onSave={upsert}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title={t("forwarding.delete.title", { name: pendingDelete?.name ?? "" })}
        description={t("forwarding.delete.desc", { ip: pendingDelete?.targetIp ?? "" })}
        confirmLabel={t("forwarding.delete.confirm")}
        destructive
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete.id);
        }}
      />

      <ImportChoiceDialog
        open={pendingImport !== null}
        onOpenChange={(o) => {
          if (!o) setPendingImport(null);
        }}
        count={pendingImport?.length ?? 0}
        current={destinations.length}
        onReplace={() => pendingImport && applyImport(pendingImport, "replace")}
        onMerge={() => pendingImport && applyImport(pendingImport, "merge")}
      />
    </div>
  );
}