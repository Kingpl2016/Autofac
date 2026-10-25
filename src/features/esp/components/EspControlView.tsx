import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/shared/components/PageHeader";
import { ConnectionBar } from "./ConnectionBar";
import { espApi } from "../lib/api";

/** 以 toast 包裹一次异步指令。 */
async function run(p: Promise<unknown>, okMsg: string) {
  try {
    await p;
    toast.success(okMsg);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

const WORK_MODES = [
  "esp.modeAuto",
  "esp.modeArtnetForward",
  "esp.modeLoopEnv",
  "esp.modeScene",
  "esp.modeProgram",
  "esp.modeEffect",
];

const PROGRAM_ACTIONS = [
  "esp.actStop",
  "esp.actPause",
  "esp.actPlayOnce",
  "esp.actLoop",
  "esp.actDelete",
  "esp.actRecord",
];

/**
 * 核心板控制页：连接 + 工作模式 + 核心板操作 + 节目操作 + 通道读写。
 */
export function EspControlView() {
  const { t } = useTranslation();
  const [mode, setMode] = useState("0");
  const [programNo, setProgramNo] = useState(1);
  const [start, setStart] = useState(1);
  const [unitCount, setUnitCount] = useState(1);
  const [unitRun, setUnitRun] = useState(1);
  const [values, setValues] = useState("255");
  const [readResult, setReadResult] = useState<number[] | null>(null);

  const sent = t("esp.sent");

  return (
    <div>
      <PageHeader title={t("esp.controlTitle")} subtitle={t("esp.controlSubtitle")} />
      <ConnectionBar />

      <div className="grid gap-(--density-gutter) lg:grid-cols-2">
        {/* 工作模式 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("esp.workMode")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_MODES.map((k, i) => (
                  <SelectItem key={k} value={String(i)}>
                    {t(k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => void run(espApi.setWorkMode(Number(mode)), sent)}>
              {t("esp.applyMode")}
            </Button>
          </CardContent>
        </Card>

        {/* 核心板操作 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("esp.boardOp")}</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" onClick={() => void run(espApi.boardOp(0), sent)}>
              {t("esp.reset")}
            </Button>
            <Button variant="outline" onClick={() => void run(espApi.boardOp(1), sent)}>
              {t("esp.factory")}
            </Button>
            <Button variant="outline" onClick={() => void run(espApi.boardOp(2), sent)}>
              {t("esp.test")}
            </Button>
          </CardContent>
        </Card>

        {/* 节目操作 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("esp.program")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs">{t("esp.programNo")}</Label>
              <Input
                type="number"
                className="tabular w-24"
                value={programNo}
                onChange={(e) => setProgramNo(Number(e.target.value) || 0)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {PROGRAM_ACTIONS.map((k, i) => (
                <Button
                  key={k}
                  variant="secondary"
                  size="sm"
                  onClick={() => void run(espApi.programOp(programNo, i), sent)}
                >
                  {t(k)}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 通道读写 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("esp.channels")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1">
                <Label className="text-xs">{t("esp.start")}</Label>
                <Input type="number" className="tabular w-20" value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">{t("esp.unitCount")}</Label>
                <Input type="number" className="tabular w-20" value={unitCount} onChange={(e) => setUnitCount(Number(e.target.value) || 0)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">{t("esp.unitRun")}</Label>
                <Input type="number" className="tabular w-20" value={unitRun} onChange={(e) => setUnitRun(Number(e.target.value) || 0)} />
              </div>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">{t("esp.values")}</Label>
              <Input className="tabular" value={values} onChange={(e) => setValues(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  void run(
                    espApi.writeChannels(
                      start,
                      unitCount,
                      unitRun,
                      values
                        .split(",")
                        .map((s) => Number(s.trim()))
                        .filter((n) => Number.isFinite(n)),
                    ),
                    sent,
                  )
                }
              >
                {t("esp.write")}
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const r = await espApi.readChannels(start, unitCount, unitRun);
                    setReadResult(r);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                {t("esp.read")}
              </Button>
            </div>
            {readResult && (
              <div className="tabular rounded-md bg-muted p-2 text-xs">
                {t("esp.result")}: [{readResult.join(", ")}]
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
