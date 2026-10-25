import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Upload, Download, Pencil, Trash2, Check, X } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/shared/components/PageHeader";
import { ConnectionBar } from "./ConnectionBar";
import { useControllerStatus } from "../hooks/useControllerStatus";
import {
  controllerDeleteFile,
  controllerDownloadFile,
  controllerListFiles,
  controllerRenameFile,
  controllerUploadFile,
} from "../lib/api";

/**
 * 核心板文件页：列目录 + 上传 / 下载 / 删除 / 重命名。
 */
export function ControllerFilesView() {
  const { t } = useTranslation();
  const { status } = useControllerStatus();
  const fileInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const list = useQuery({
    queryKey: ["controller-files"],
    queryFn: controllerListFiles,
    enabled: status.connected,
  });

  const refetch = () => void list.refetch();

  const handleUpload = async (file: File) => {
    try {
      await controllerUploadFile(file.name, await file.arrayBuffer());
      toast.success(t("controller.sent"));
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDownload = async (name: string) => {
    try {
      const data = await controllerDownloadFile(name);
      const blob = new Blob([new Uint8Array(data)], {
        type: "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await controllerDeleteFile(name);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const commitRename = async (from: string) => {
    const to = renameDraft.trim();
    setRenaming(null);
    if (!to || to === from) return;
    try {
      await controllerRenameFile(from, to);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("controller.filesTitle")}
        subtitle={t("controller.filesSubtitle")}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
              disabled={!status.connected}
            >
              <Upload />
              {t("controller.upload")}
            </Button>
            <Button variant="outline" size="sm" onClick={refetch} disabled={!status.connected}>
              <RefreshCw />
              {t("controller.refresh")}
            </Button>
          </>
        }
      />
      <ConnectionBar />

      {!status.connected ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          {t("controller.notConnected")}
        </div>
      ) : (
        <Card>
          <CardContent className="pt-8">
            <div className="grid grid-cols-[1fr_8rem_12rem] gap-x-3 border-b border-border pb-2 text-xs font-medium text-muted-foreground">
              <span>{t("controller.fileName")}</span>
              <span className="text-right">{t("controller.fileSize")}</span>
              <span className="text-right" />
            </div>
            {(list.data ?? []).length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {t("controller.emptyFiles")}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {(list.data ?? []).map((f) => (
                  <div
                    key={f.name}
                    className="grid grid-cols-[1fr_8rem_12rem] items-center gap-x-5 py-5 text-sm"
                  >
                    {renaming === f.name ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          className="h-7"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(f.name);
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => void commitRename(f.name)}>
                          <Check />
                        </Button>
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => setRenaming(null)}>
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <span className="truncate">{f.name}</span>
                    )}
                    <span className="tabular text-right text-muted-foreground">
                      {f.isDir ? "—" : `${f.size}`}
                    </span>
                    <span className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={t("controller.download")} onClick={() => void handleDownload(f.name)}>
                        <Download className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("controller.rename")}
                        onClick={() => {
                          setRenameDraft(f.name);
                          setRenaming(f.name);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t("common.delete")} onClick={() => void handleDelete(f.name)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
