import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Upload,
  Download,
  Pencil,
  Copy,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/shared/components/PageHeader";
import { DestinationDialog } from "./DestinationDialog";
import { useForwardingDraft } from "../hooks/useForwarding";
import {
  newDestination,
  type ForwardDestination,
  type ForwardingTable,
} from "../lib/types";

interface ForwardingEditorProps {
  initial: ForwardingTable;
}

/**
 * 转发编辑器：目的地列表（启停/编辑/复制/删除）+ 新增 + 导入导出。
 */
export function ForwardingEditor({ initial }: ForwardingEditorProps) {
  const { t } = useTranslation();
  const { destinations, upsert, remove, toggle, duplicate, replaceAll } =
    useForwardingDraft(initial);
  const [editing, setEditing] = useState<ForwardDestination | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const json = JSON.stringify(destinations, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "art-net-studio-forwarding.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file: File) => {
    try {
      const list = JSON.parse(await file.text()) as ForwardDestination[];
      replaceAll(list);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("forwarding.title")}
        subtitle={t("forwarding.subtitle")}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
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

      {destinations.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          {t("forwarding.noDestinations")}
        </div>
      ) : (
        <div className="grid gap-3">
          {destinations.map((d) => (
            <Card key={d.id}>
              <CardContent className="flex items-center gap-4 p-5">
                <Switch checked={d.enabled} onCheckedChange={() => toggle(d.id)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.name || "—"}</span>
                    <Badge variant={d.protocol === "sacn" ? "secondary" : "default"}>
                      {d.protocol === "sacn" ? "sACN" : "Art-Net"}
                    </Badge>
                    <Badge variant="outline">
                      {d.mode === "all" ? t("forwarding.modeAll") : t("forwarding.modeSelected")}
                    </Badge>
                  </div>
                  <div className="tabular mt-0.5 text-xs text-muted-foreground">
                    {d.targetIp}:{d.port}
                    {d.universeOffset !== 0 && ` · offset ${d.universeOffset}`}
                    {d.defaultDelayMs > 0 && ` · ${d.defaultDelayMs}ms`}
                    {d.overrides.length > 0 && ` · ${d.overrides.length} overrides`}
                  </div>
                </div>
                <Button variant="ghost" size="icon" aria-label={t("common.edit")} onClick={() => setEditing(d)}>
                  <Pencil className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t("forwarding.duplicate")} onClick={() => duplicate(d.id)}>
                  <Copy className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t("common.delete")} onClick={() => remove(d.id)}>
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
    </div>
  );
}
