import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBox, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFixtureAssetStore } from "@/features/fixtures";
import { formatBytesIec } from "@/shared/lib/format";
import { pickImageFile } from "@/shared/tauri/pickers";
import { setStageVenue } from "../lib/stageOps";
import { useProjectStore } from "../stores/useProjectStore";
import { disposeLoaded, loadModelFile, MAX_VENUE_TRIANGLES, MODEL_EXTENSIONS, normalizeVenue, VENUE_UNITS, type VenueUnit } from "./importModel";
import { importErrorText } from "./importErrors";

/**
 * 导入场馆模型：选 GLB / glTF / OBJ，转到 Y 向上、换算成米、合并并简化到 30 万面以内后存进资源库（种类“场馆”），
 * 设为当前工程的场馆（一步撤销）。位置、角度与缩放在场景设置里调。
 *
 * @param props.onClose 关闭。
 */
export function VenueImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const put = useFixtureAssetStore((s) => s.put);
  const [path, setPath] = useState<string | null>(null);
  const [unit, setUnit] = useState<VenueUnit>("auto");
  const [zUp, setZUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tris: number; sourceTris: number; bytes: number; size: string; unit: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : "";

  const pick = async () => {
    const p = await pickImageFile(t("editor.stage3d.modelFileType"), MODEL_EXTENSIONS);
    if (p) {
      setPath(p);
      setDone(null);
      setError(null);
    }
  };

  const run = async () => {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const source = await loadModelFile(path);
      let result;
      try {
        result = await normalizeVenue(source, { unit, zUp });
      } finally {
        disposeLoaded(source);
      }
      const [w, h, d] = result.sizeM;
      const asset = await put(result.glb, {
        format: "glb",
        kind: "venue",
        name: fileName,
        stats: { tris: result.tris, bboxMm: [Math.round(w * 1000), Math.round(h * 1000), Math.round(d * 1000)] },
      });
      update((dr) => setStageVenue(dr, { hash: asset.hash, name: fileName }));
      setDone({
        tris: result.tris,
        sourceTris: result.sourceTris,
        bytes: result.glb.byteLength,
        size: `${w.toFixed(1)} × ${h.toFixed(1)} × ${d.toFixed(1)}`,
        unit: t(`editor.stage3d.venue.units.${result.unit}`),
      });
      toast.success(t("editor.stage3d.venue.imported", { name: fileName }));
    } catch (e) {
      setError(e instanceof Error && e.message === "too_large" ? t("editor.stage3d.venue.tooLarge") : importErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editor.stage3d.venue.importTitle")}</DialogTitle>
          <DialogDescription>{t("editor.stage3d.venue.importDescription", { tris: MAX_VENUE_TRIANGLES.toLocaleString() })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void pick()}>
              <FileBox aria-hidden />
              {t("editor.stage3d.pickFile")}
            </Button>
            <span className="min-w-0 truncate text-sm text-muted-foreground">{fileName || t("editor.stage3d.noFile")}</span>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="venue-unit">{t("editor.stage3d.venue.unit")}</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as VenueUnit)}>
              <SelectTrigger id="venue-unit" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENUE_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {t(`editor.stage3d.venue.units.${u}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={zUp} onCheckedChange={setZUp} />
            {t("editor.stage3d.venue.zUp")}
          </label>
          {done && (
            <p role="status" className="text-sm">
              {t("editor.stage3d.venue.done", { tris: done.tris.toLocaleString(), size: formatBytesIec(done.bytes), dims: done.size, unit: done.unit })}
              {done.sourceTris > done.tris && ` ${t("editor.stage3d.simplified", { from: done.sourceTris.toLocaleString() })}`}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {done ? t("common.close") : t("common.cancel")}
          </Button>
          <Button type="button" disabled={!path || busy} onClick={() => void run()}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            {t("editor.stage3d.importRun")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
