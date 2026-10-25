import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Play, RefreshCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/shared/components/Segmented";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { cn } from "@/lib/utils";
import { useConfigValidation } from "../hooks/useConfigValidation";
import { useStartGuard } from "../hooks/useStartGuard";
import { configure, getStatus, startSending, stopSending } from "../lib/api";
import { draftToConfig, sameConfig, type Draft } from "../lib/draft";
import { isInteractiveTarget } from "../lib/dom";
import { describeConfigError, describeError, protocolLabel } from "../lib/errors";
import type { StartReason } from "../lib/guard";
import {
  DEFAULT_PORT,
  MAX_UNIVERSES,
  type ConfigError,
  type SignalConfig,
  type SignalProtocol,
} from "../lib/types";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { useGuardStore } from "../stores/useGuardStore";
import { useSenderStore } from "../stores/useSenderStore";
import { GuardDialog } from "./GuardDialog";
import { TargetPicker } from "./TargetPicker";

type Busy = "start" | "stop" | "apply" | null;
type Field = "ip" | "port" | "universes";

/** 校验错误出在哪个输入框上。 */
function fieldOf(error: ConfigError): Field {
  if (error.code === "invalidIp") return "ip";
  if (error.code === "invalidPort") return "port";
  return "universes";
}

const PROTOCOLS: SignalProtocol[] = ["artNet", "sacn"];

/**
 * 连接区：目标 IP / 端口 / 协议 / Universe 范围，以及开始 / 停止与应用。
 *
 * - 输入边写边校验（规则只在后端有一份），错误就地显示在对应输入框下；
 * - “开始发送”先做安全检查（目标不是本机 / 会经转发表发出 / 频闪），有风险就弹确认，通过后应用当前草稿再启动；
 *   发送中改了连接设置，需点“应用”才生效（避免输入到一半就把信号发到错误的地方）；
 * - 切换协议时端口自动换成该协议的默认端口。
 */
export function ConnectionCard() {
  const { t } = useTranslation();
  const ids = { ip: useId(), port: useId(), universes: useId(), hint: useId() };
  const draft = useCheckerFormStore((s) => s.draft);
  const setDraft = useCheckerFormStore((s) => s.setDraft);
  const status = useSenderStore((s) => s.status);
  const setStatus = useSenderStore((s) => s.setStatus);
  const validation = useConfigValidation(draft);
  const guard = useStartGuard();
  const acknowledgeStrobe = useGuardStore((s) => s.acknowledgeStrobe);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ config: SignalConfig; reasons: StartReason[] } | null>(
    null,
  );

  const running = status?.running ?? false;
  const config = draftToConfig(draft);
  const dirty = config !== null && (!status || !sameConfig(config, status.config));
  const invalid = validation.state === "error";
  const fieldError =
    validation.state === "error"
      ? { field: fieldOf(validation.error), text: describeConfigError(validation.error, t, draft.protocol) }
      : null;

  const edit = (patch: Partial<Draft>) => {
    setActionError(null);
    setDraft(patch);
  };

  /** 动作做完立刻刷新状态，不必等下一次 200ms 推送。 */
  const refreshStatus = () => getStatus().then(setStatus).catch(() => undefined);

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await action();
      await refreshStatus();
    } catch (e: unknown) {
      setActionError(describeError(e, t, draft.protocol));
    } finally {
      setBusy(null);
    }
  };

  const begin = (cfg: SignalConfig) =>
    run("start", async () => {
      await configure(cfg);
      await startSending();
    });

  /** 开始前先做安全检查：没有风险直接开始，否则弹确认。检查期间按钮显示忙碌，避免重复点击。 */
  const startWithGuard = async (cfg: SignalConfig) => {
    setBusy("start");
    const reasons = await guard.evaluate(cfg);
    setBusy(null);
    if (reasons.length === 0) await begin(cfg);
    else setConfirming({ config: cfg, reasons });
  };

  const confirmStart = () => {
    if (!confirming) return;
    if (confirming.reasons.some((r) => r.kind === "strobe")) acknowledgeStrobe();
    const cfg = confirming.config;
    setConfirming(null);
    void begin(cfg);
  };

  const toggle = () => {
    if (busy !== null || confirming !== null) return;
    if (running) {
      void run("stop", stopSending);
    } else if (config && !invalid) {
      void startWithGuard(config);
    }
  };

  // 空格键开始 / 停止。监听器只在挂载时注册一次，通过 ref 读取最新的 toggle，避免每次渲染重新绑定。
  // 焦点在输入框、按钮、单选、对话框等自己处理按键的元素上时不抢。
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isInteractiveTarget(e.target)) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const apply = () => {
    if (config) void run("apply", () => configure(config));
  };

  const errorFor = (field: Field) => (fieldError?.field === field ? fieldError.text : null);
  const describedBy = (field: Field) => (errorFor(field) ? `${ids[field]}-error` : undefined);

  return (
    <SurfacePanel title={t("signalChecker.connection")}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <div className="grid gap-1.5">
          <Label htmlFor={ids.ip}>{t("signalChecker.targetIp")}</Label>
          <div className="flex gap-2">
            <Input
              id={ids.ip}
              className="tabular"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("signalChecker.targetIpPlaceholder")}
              value={draft.targetIp}
              aria-invalid={errorFor("ip") ? true : undefined}
              aria-describedby={describedBy("ip")}
              onChange={(e) => edit({ targetIp: e.target.value })}
            />
            <TargetPicker onSelect={(ip) => edit({ targetIp: ip })} />
          </div>
          <FieldError id={`${ids.ip}-error`} text={errorFor("ip")} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={ids.port}>{t("signalChecker.port")}</Label>
          <Input
            id={ids.port}
            className="tabular"
            inputMode="numeric"
            autoComplete="off"
            value={draft.port}
            aria-invalid={errorFor("port") ? true : undefined}
            aria-describedby={describedBy("port")}
            onChange={(e) => edit({ port: e.target.value })}
          />
          <FieldError id={`${ids.port}-error`} text={errorFor("port")} />
        </div>

        <div className="grid content-start gap-1.5">
          <span className="text-sm font-medium leading-none">{t("signalChecker.protocol")}</span>
          <Segmented<SignalProtocol>
            ariaLabel={t("signalChecker.protocol")}
            value={draft.protocol}
            options={PROTOCOLS.map((p) => ({ value: p, label: protocolLabel(p) }))}
            onChange={(protocol) => edit({ protocol, port: String(DEFAULT_PORT[protocol]) })}
            size="md"
            className="w-fit"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={ids.universes}>{t("signalChecker.universes")}</Label>
          <Input
            id={ids.universes}
            className="tabular"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("signalChecker.universesPlaceholder")}
            value={draft.universes}
            aria-invalid={errorFor("universes") ? true : undefined}
            aria-describedby={errorFor("universes") ? `${ids.universes}-error` : ids.hint}
            onChange={(e) => edit({ universes: e.target.value })}
          />
          <FieldError id={`${ids.universes}-error`} text={errorFor("universes")} />
          {!errorFor("universes") && (
            <p id={ids.hint} className="text-xs text-muted-foreground">
              {validation.state === "ok"
                ? t("signalChecker.universeCount", { n: validation.universeCount })
                : t("signalChecker.universesHint", { max: MAX_UNIVERSES })}
            </p>
          )}
        </div>
      </div>

      {actionError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          className={cn(
            "min-w-36",
            !running && "bg-success text-success-foreground hover:bg-success/90 active:bg-success/80",
          )}
          variant={running ? "destructive" : "default"}
          disabled={busy !== null || (!running && invalid)}
          aria-busy={busy === "start" || busy === "stop" || undefined}
          aria-keyshortcuts="Space"
          onClick={toggle}
        >
          {busy === "start" || busy === "stop" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : running ? (
            <Square className="fill-current" aria-hidden />
          ) : (
            <Play className="fill-current" aria-hidden />
          )}
          {busy === "start"
            ? t("signalChecker.starting")
            : busy === "stop"
              ? t("signalChecker.stopping")
              : running
                ? t("signalChecker.stop")
                : t("signalChecker.start")}
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null || !dirty || invalid}
          aria-busy={busy === "apply" || undefined}
          onClick={apply}
        >
          <RefreshCw className={cn(busy === "apply" && "animate-spin")} aria-hidden />
          {t("signalChecker.apply")}
        </Button>
        {running && dirty && !invalid && (
          <span className="text-xs text-muted-foreground">{t("signalChecker.applyHint")}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{t("signalChecker.hotkeyHint")}</span>
      </div>
      <GuardDialog
        reasons={confirming?.reasons ?? null}
        variant="start"
        onConfirm={confirmStart}
        onCancel={() => setConfirming(null)}
      />
    </SurfacePanel>
  );
}

/** 输入框下的错误提示；没有错误时不渲染。 */
function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {text}
    </p>
  );
}
