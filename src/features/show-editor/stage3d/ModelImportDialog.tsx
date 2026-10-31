import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBox, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { modelShape, useFixtureAssetStore, useFixtureStore, type Appearance } from "@/features/fixtures";
import { formatBytesIec } from "@/shared/lib/format";
import { pickImageFile } from "@/shared/tauri/pickers";
import { useProjectStore } from "../stores/useProjectStore";
import { importErrorText } from "./importErrors";
import { disposeLoaded, loadModelFile, MODEL_EXTENSIONS, normalizeModel, type BeamAxis } from "./importModel";
import { localDims } from "./shapes";
import { renderThumbnail } from "./thumbnail";

/** 光轴方向的选项。 */
const BEAM_AXES: readonly BeamAxis[] = ["up", "front", "back", "down"];

/** 导入结果（显示给用户）。 */
interface Done {
  name: string;
  tris: number;
  sourceTris: number;
  bytes: number;
  jointed: boolean;
}

/**
 * 给一个灯具型号导入 3D 模型：选 GLB / glTF / OBJ，规整（转向、缩放、合并、简化）后存进资源库，
 * 同时写进工程里的模型快照（一步撤销）与灯具库里的同一模型（内置模型只读，只改工程）。
 *
 * @param props.modelId 模型编号。
 * @param props.onClose 关闭。
 */
export function ModelImportDialog({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const model = useProjectStore((s) => s.project.fixtureModels.find((m) => m.id === modelId));
  const update = useProjectStore((s) => s.update);
  const library = useFixtureStore((s) => s.models);
  const saveModel = useFixtureStore((s) => s.save);
  const put = useFixtureAssetStore((s) => s.put);
  const putThumb = useFixtureAssetStore((s) => s.putThumb);
  const [path, setPath] = useState<string | null>(null);
  const [axis, setAxis] = useState<BeamAxis>("up");
  const [useDims, setUseDims] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!model) return null;
  const dims = model.physical?.dimensionsMm;
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
        result = await normalizeModel(source, { beamAxis: axis, targetDims: useDims && dims ? localDims(modelShape(model), dims) : undefined });
      } finally {
        disposeLoaded(source);
      }
      const asset = await put(result.glb, {
        format: "glb",
        name: fileName,
        stats: { tris: result.tris, bboxMm: result.bboxMm, ...(result.jointed ? { jointed: true } : {}) },
      });
      const thumb = await renderThumbnail(result.glb);
      if (thumb) await putThumb(asset.hash, thumb).catch(() => undefined);
      const appearance: Appearance = {
        ...(model.appearance ?? { shape: modelShape(model) }),
        origin: model.appearance?.origin ?? "user",
        model3d: { hash: asset.hash, format: "glb", name: fileName },
      };
      update((d) => {
        const m = d.fixtureModels.find((x) => x.id === modelId);
        if (m) m.appearance = appearance;
      });
      const inLibrary = library.find((m) => m.id === modelId);
      if (inLibrary && !inLibrary.builtin) await saveModel({ ...inLibrary, appearance: { ...(inLibrary.appearance ?? appearance), model3d: appearance.model3d } });
      setDone({ name: fileName, tris: result.tris, sourceTris: result.sourceTris, bytes: result.glb.byteLength, jointed: result.jointed });
      toast.success(t("editor.stage3d.imported", { name: model.name }));
    } catch (e) {
      setError(importErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editor.stage3d.importTitle", { name: model.name })}</DialogTitle>
          <DialogDescription>{t("editor.stage3d.importDescription")}</DialogDescription>
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
            <Label htmlFor="m3d-axis">{t("editor.stage3d.beamAxis")}</Label>
            <Select value={axis} onValueChange={(v) => setAxis(v as BeamAxis)}>
              <SelectTrigger id="m3d-axis" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEAM_AXES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`editor.stage3d.axes.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("editor.stage3d.beamAxisHint")}</p>
          </div>
          {dims && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={useDims} onCheckedChange={setUseDims} />
              {t("editor.stage3d.useDims", { dims: dims.map((v) => Math.round(v)).join("×") })}
            </label>
          )}
          {done && (
            <p role="status" className="text-sm">
              {t("editor.stage3d.importDone", {
                tris: done.tris.toLocaleString(),
                size: formatBytesIec(done.bytes),
              })}
              {done.sourceTris > done.tris && ` ${t("editor.stage3d.simplified", { from: done.sourceTris.toLocaleString() })}`}
              {` ${done.jointed ? t("editor.stage3d.jointed") : t("editor.stage3d.notJointed")}`}
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
