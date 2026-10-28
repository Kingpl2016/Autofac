import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Cable, ChevronRight, Lock, Network, Plus, TriangleAlert, Unplug, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useProtocolFlags } from "@/features/settings";
import { Segmented } from "@/shared/components/Segmented";
import { isUnspecifiedIpv4, isValidIpv4 } from "@/shared/lib/ip";
import { setOutputEnabled } from "../hooks/transportActions";
import { MAX_GAMMA, MAX_LATENCY_COMP_MS, MIN_GAMMA, MIN_GAMMA_ON, setOutput } from "../lib/ops";
import { DEFAULT_GAMMA, RECOMMENDED_GAMMA, type OutputTarget } from "../lib/project";
import { MAX_PARK, removePark, setPark, setSync } from "../lib/universeOps";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { SliderField } from "./SliderField";
import { UniverseDialog } from "./UniverseDialog";

type TargetKind = OutputTarget["kind"];
type DirectTarget = Extract<OutputTarget, { kind: "direct" }>;

/** 各协议的默认端口。 */
const DEFAULT_PORT = { artNet: 6454, sacn: 5568 } as const;

/** 输出的三种状态：正在发送 / 开着但没在发送 / 关闭（只在本机预览）。 */
type OutputPhase = "sending" | "idle" | "off";

/**
 * 工具条上的输出设置。
 *
 * - 头部：“输出到网络”总开关（默认开启，不存进工程）与当前状态；关闭时编辑器照常播放、只在本机预览，
 *   不向网络发包，也不占用输出（实时转发、录制、回放可用）；
 * - 发送到：转发表 / 指定设备（IP、协议、端口改完回车生效）/ 按 Universe 路由表，以及路由表入口；
 * - 高级（默认收起，展开状态会记住）：Gamma 校正（默认关闭，即 1.0 线性输出；打开后取推荐值 2.2 并可调）、
 *   灯光延迟补偿、同步（ArtSync / sACN 同步 Universe）、通道锁定（Park）。
 *   收起时标题旁列出改过默认值的项，避免“看不见的设置”。
 *
 * 目标与高级设置的改动立即写入工程（可撤销），并随工程同步给后端；输出会话运行中也会实时生效。
 */
export function OutputPopover() {
  const { t } = useTranslation();
  const output = useProjectStore((s) => s.project.output);
  const update = useProjectStore((s) => s.update);
  const warnings = usePlaybackStore((s) => s.state?.warnings.length ?? 0);
  const destinations = usePlaybackStore((s) => s.state?.destinations ?? null);
  const enabled = usePlaybackStore((s) => s.state?.outputEnabled ?? true);
  const sending = usePlaybackStore((s) => s.state?.sending ?? false);
  const advancedOpen = useEditorPrefsStore((s) => s.outputAdvancedOpen);
  const setAdvancedOpen = useEditorPrefsStore((s) => s.setOutputAdvancedOpen);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  // 选了“指定设备”但还没填好 IP：先只在界面上切过去，填好后才写进工程
  const [pendingDirect, setPendingDirect] = useState(false);
  const switchId = useId();
  const statusId = useId();

  const phase: OutputPhase = !enabled ? "off" : sending ? "sending" : "idle";
  const kind: TargetKind = pendingDirect ? "direct" : output.target.kind;
  const direct = output.target.kind === "direct" ? output.target : null;

  // Gamma 1.0 即线性输出，视为“关闭”
  const gammaOn = output.gamma > MIN_GAMMA;

  // 收起时提示哪些高级设置不是默认值
  const changed = [
    output.gamma !== DEFAULT_GAMMA && t("editor.output.gammaShort", { value: output.gamma.toFixed(1) }),
    output.latencyCompMs !== 0 && t("editor.output.latencyShort", { value: output.latencyCompMs }),
    (output.sync.artSync || output.sync.sacnSyncUniverse !== null) && t("editor.output.syncShort"),
    output.park.length > 0 && t("editor.output.parkShort", { count: output.park.length }),
  ].filter((x): x is string => typeof x === "string");

  // 状态行里的目标摘要
  const summary =
    output.target.kind === "routed"
      ? t("editor.output.summaryRouted", { count: output.universes.length })
      : direct
        ? t("editor.output.summaryDirect", { protocol: direct.protocol === "sacn" ? "sACN" : "Art-Net", ip: direct.ip, port: direct.port })
        : t("editor.output.summaryForwarding", { count: destinations ?? 0 });
  const statusText = {
    sending: `${t("editor.output.statusSending")} · ${summary}`,
    idle: `${t("editor.output.statusIdle")} · ${summary}`,
    off: t("editor.output.statusOff"),
  }[phase];

  const chooseKind = (next: TargetKind) => {
    if (next === "direct") {
      // 已经是指定设备时什么也不做；否则等填好 IP 再写进工程
      setPendingDirect(output.target.kind !== "direct");
      return;
    }
    setPendingDirect(false);
    if (next !== output.target.kind) update((d) => setOutput(d, { target: { kind: next } }));
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("editor.output.title")}
            title={statusText}
            className={cn(
              "h-8 gap-1.5 px-2",
              phase === "off" && "bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning",
            )}
          >
            {phase === "off" ? <Unplug aria-hidden /> : <Cable aria-hidden />}
            <span className="text-xs">{t(phase === "off" ? "editor.output.previewOnly" : "editor.output.button")}</span>
            {phase === "sending" && (
              <>
                <span className="size-1.5 rounded-full bg-success" role="img" aria-label={t("editor.playback.outputting")} />
                {destinations !== null && <span className="num text-[11px] text-muted-foreground">{destinations}</span>}
              </>
            )}
            {phase === "idle" && (
              <span className="size-1.5 rounded-full border border-muted-foreground/70" role="img" aria-label={t("editor.output.statusIdleShort")} />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex max-h-[80vh] w-96 flex-col gap-0 overflow-hidden p-0" aria-label={t("editor.output.title")}>
          {/* 头部：总开关 + 状态 */}
          <div className="grid gap-3 px-4 pt-4 pb-3">
            <div className="flex items-start gap-3">
              <div className="grid min-w-0 flex-1 gap-1">
                <label htmlFor={switchId} className="text-sm font-semibold">
                  {t("editor.output.enabled")}
                </label>
                <p id={statusId} className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                  <span className="flex h-[1lh] shrink-0 items-center">
                    <PhaseDot phase={phase} />
                  </span>
                  <span className="num min-w-0 break-words">{statusText}</span>
                </p>
              </div>
              <Switch
                id={switchId}
                checked={enabled}
                aria-describedby={statusId}
                onCheckedChange={(on) => void setOutputEnabled(on)}
              />
            </div>
            {phase === "off" && (
              <div role="status" className="grid gap-0.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <p className="font-medium">{t("editor.output.offTitle")}</p>
                <p className="opacity-90">{t("editor.output.offBody")}</p>
              </div>
            )}
          </div>

          <div className="grid min-h-0 gap-0 overflow-y-auto border-t border-border">
            {/* 发送到 */}
            <section aria-labelledby={`${statusId}-target`} className="grid gap-2.5 px-4 py-3">
              <h4 id={`${statusId}-target`} className="text-xs font-medium text-muted-foreground">
                {t("editor.output.target")}
              </h4>
              <Segmented
                ariaLabel={t("editor.output.target")}
                value={kind}
                activation="manual"
                className="grid w-full grid-cols-3"
                options={[
                  { value: "forwarding", label: t("editor.output.targetForwarding") },
                  { value: "direct", label: t("editor.output.targetDirect") },
                  { value: "routed", label: t("editor.output.targetRouted") },
                ]}
                onChange={chooseKind}
              />
              {kind === "forwarding" &&
                (destinations === 0 ? (
                  <Note tone="warning">{t("editor.output.descForwardingNone")}</Note>
                ) : (
                  <Note>{t("editor.output.descForwarding", { count: destinations ?? 0 })}</Note>
                ))}
              {kind === "direct" && (
                <DirectTargetFields
                  key={JSON.stringify(direct)}
                  target={direct}
                  onCommit={(target) => {
                    setPendingDirect(false);
                    update((d) => setOutput(d, { target }));
                  }}
                />
              )}
              {kind === "routed" && <Note>{t("editor.output.routedHint")}</Note>}
              <button
                type="button"
                onClick={() => {
                  setPopoverOpen(false);
                  setRoutingOpen(true);
                }}
                className="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Network aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t("editor.output.openRouting")}</span>
                {output.target.kind === "routed" && (
                  <Badge variant="default">{t("editor.output.routedBadge", { count: output.universes.length })}</Badge>
                )}
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
              {warnings > 0 && <Note tone="warning">{t("editor.output.skipped", { count: warnings })}</Note>}
            </section>

            {/* 高级 */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="grid border-t border-border">
              <CollapsibleTrigger className="flex min-w-0 items-center gap-1.5 px-4 py-2.5 text-left text-xs font-medium transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", advancedOpen && "rotate-90")} />
                {t("editor.output.advanced")}
                {!advancedOpen && changed.length > 0 && (
                  <span className="min-w-0 truncate font-normal text-muted-foreground">· {changed.join(t("editor.output.listSep"))}</span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-3.5 px-4 pt-1 pb-4">
                <SettingRow
                  label={t("editor.output.gammaEnable")}
                  htmlFor={`${switchId}-gamma`}
                  hint={t(gammaOn ? "editor.output.gammaHint" : "editor.output.gammaOffHint")}
                  control={
                    <Switch
                      id={`${switchId}-gamma`}
                      checked={gammaOn}
                      onCheckedChange={(on) => update((d) => setOutput(d, { gamma: on ? RECOMMENDED_GAMMA : DEFAULT_GAMMA }))}
                    />
                  }
                >
                  {gammaOn && (
                    <SliderField
                      label={t("editor.output.gamma")}
                      numberLabel={t("editor.output.gammaValue")}
                      value={output.gamma}
                      min={MIN_GAMMA_ON}
                      max={MAX_GAMMA}
                      step={0.1}
                      decimals={1}
                      onCommit={(gamma) => update((d) => setOutput(d, { gamma }))}
                    />
                  )}
                </SettingRow>
                <SettingRow
                  label={t("editor.output.latency")}
                  hint={t("editor.output.latencyHint", { max: MAX_LATENCY_COMP_MS })}
                  control={
                    <>
                      <CommitInput
                        className="num h-7 w-20 px-2 text-right text-xs"
                        inputMode="numeric"
                        label={t("editor.output.latency")}
                        value={output.latencyCompMs}
                        onCommit={(text) => {
                          const n = Number(text);
                          if (Number.isFinite(n)) update((d) => setOutput(d, { latencyCompMs: n }));
                        }}
                      />
                      <span className="w-5 text-xs text-muted-foreground">ms</span>
                    </>
                  }
                />
                <SettingRow
                  label="ArtSync"
                  htmlFor={`${switchId}-artsync`}
                  hint={t("editor.output.artSyncHint")}
                  control={
                    <Switch
                      id={`${switchId}-artsync`}
                      checked={output.sync.artSync}
                      onCheckedChange={(artSync) => update((d) => setSync(d, { artSync }))}
                    />
                  }
                />
                <SettingRow
                  label={t("editor.routing.sacnSync")}
                  hint={t("editor.routing.sacnSyncHint")}
                  control={
                    <CommitInput
                      className="num h-7 w-[6.25rem] px-2 text-right text-xs"
                      inputMode="numeric"
                      label={t("editor.routing.sacnSync")}
                      placeholder={t("editor.output.sacnSyncNone")}
                      value={output.sync.sacnSyncUniverse ?? ""}
                      onCommit={(text) => {
                        const n = Math.floor(Number(text));
                        update((d) => setSync(d, { sacnSyncUniverse: text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n }));
                      }}
                    />
                  }
                />
                <ParkEditor />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </PopoverContent>
      </Popover>
      <UniverseDialog open={routingOpen} onOpenChange={setRoutingOpen} />
    </>
  );
}

/** 状态点：发送中实心绿点，待机空心点，关闭为告警色。 */
function PhaseDot({ phase }: { phase: OutputPhase }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        phase === "sending" && "bg-success",
        phase === "idle" && "border border-muted-foreground/70",
        phase === "off" && "bg-warning",
      )}
    />
  );
}

/** 小字说明；`warning` 时带告警图标。 */
function Note({ tone = "muted", children }: { tone?: "muted" | "warning"; children: ReactNode }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", tone === "warning" ? "text-warning" : "text-muted-foreground")}>
      {tone === "warning" && <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      {children}
    </p>
  );
}

/**
 * 设置行：名称在左、控件在右，说明在下方，额外内容（如滑块）跟在说明前面。
 *
 * @param props.label 名称。
 * @param props.htmlFor 控件 id（控件是开关等可关联标签的元素时给出，名称即其无障碍名称）。
 * @param props.hint 说明。
 * @param props.control 右侧控件。
 * @param props.children 名称行下方的额外内容。
 */
function SettingRow({
  label,
  htmlFor,
  hint,
  control,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm">
            {label}
          </label>
        ) : (
          <span className="text-sm">{label}</span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">{control}</div>
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * 指定设备的 IP / 协议 / 端口：改完按回车或离开输入框即生效（不合法时不写入并提示原因），
 * 按 Esc 放弃。外部目标变化（撤销）时由调用方用 `key` 重置。
 *
 * @param props.target 当前生效的直发目标；还没设置时为 `null`。
 * @param props.onCommit 写入新的直发目标。
 */
function DirectTargetFields({ target, onCommit }: { target: DirectTarget | null; onCommit: (target: DirectTarget) => void }) {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const id = useId();
  const [ip, setIp] = useState(target?.ip ?? "");
  // sACN 关闭时，已有的 sACN 目标按 Art-Net 显示与提交
  const [protocol, setProtocol] = useState<DirectTarget["protocol"]>(sacnEnabled && target ? target.protocol : "artNet");
  const [port, setPort] = useState(String(target?.port ?? DEFAULT_PORT.artNet));
  const [touched, setTouched] = useState(false);

  const ipUnspecified = isUnspecifiedIpv4(ip);
  const ipOk = isValidIpv4(ip) && !ipUnspecified;
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const ipError = touched && ip.trim() !== "" && !ipOk ? t(ipUnspecified ? "editor.output.ipUnspecified" : "editor.output.ipInvalid") : null;

  /** 合法且与当前目标不同就写入。 */
  const commit = (next: { ip?: string; protocol?: DirectTarget["protocol"]; port?: string }) => {
    const nIp = (next.ip ?? ip).trim();
    const nProtocol = next.protocol ?? protocol;
    const nPort = Number(next.port ?? port);
    const ok = isValidIpv4(nIp) && !isUnspecifiedIpv4(nIp) && Number.isInteger(nPort) && nPort >= 1 && nPort <= 65535;
    if (!ok) return;
    if (target && target.ip === nIp && target.protocol === nProtocol && target.port === nPort) return;
    onCommit({ kind: "direct", ip: nIp, protocol: nProtocol, port: nPort });
  };

  /** 回车提交，Esc 放弃改动。 */
  const keys = (reset: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") {
      reset();
      setTouched(false);
    }
  };

  return (
    <div className="grid gap-2">
      <div className={cn("grid items-end gap-2", sacnEnabled ? "grid-cols-[1fr_auto_4.5rem]" : "grid-cols-[1fr_4.5rem]")}>
        <div className="grid gap-1">
          <label htmlFor={`${id}-ip`} className="text-[11px] text-muted-foreground">
            {t("editor.output.ip")}
          </label>
          <Input
            id={`${id}-ip`}
            className="num h-8 px-2 text-xs"
            placeholder="192.168.1.50"
            autoComplete="off"
            spellCheck={false}
            value={ip}
            aria-invalid={ipError !== null}
            aria-describedby={ipError ? `${id}-ip-error` : undefined}
            onChange={(e) => setIp(e.target.value)}
            onBlur={() => {
              setTouched(true);
              commit({});
            }}
            onKeyDown={keys(() => setIp(target?.ip ?? ""))}
          />
        </div>
        {sacnEnabled && (
          <div className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">{t("editor.output.protocol")}</span>
            <Segmented
              ariaLabel={t("editor.output.protocol")}
              value={protocol}
              size="xs"
              className="h-8 items-center"
              options={[
                { value: "artNet", label: "Art-Net" },
                { value: "sacn", label: "sACN" },
              ]}
              onChange={(p) => {
                const nextPort = String(DEFAULT_PORT[p]);
                setProtocol(p);
                setPort(nextPort);
                commit({ protocol: p, port: nextPort });
              }}
            />
          </div>
        )}
        <div className="grid gap-1">
          <label htmlFor={`${id}-port`} className="text-[11px] text-muted-foreground">
            {t("editor.output.port")}
          </label>
          <Input
            id={`${id}-port`}
            className="num h-8 px-2 text-xs"
            inputMode="numeric"
            value={port}
            aria-invalid={!portOk}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => commit({})}
            onKeyDown={keys(() => setPort(String(target?.port ?? DEFAULT_PORT[protocol])))}
          />
        </div>
      </div>
      {ipError ? (
        <p id={`${id}-ip-error`} role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {ipError}
        </p>
      ) : !portOk ? (
        <Note tone="warning">{t("editor.output.portInvalid")}</Note>
      ) : (
        <Note>{t(target ? "editor.output.descDirect" : "editor.output.directPending")}</Note>
      )}
    </div>
  );
}

/** 通道锁定（Park）：已锁定的通道列成可解除的小标签；按 Universe / 通道 / 值添加。 */
function ParkEditor() {
  const { t } = useTranslation();
  const park = useProjectStore((s) => s.project.output.park);
  const update = useProjectStore((s) => s.update);
  const [universe, setUniverse] = useState("0");
  const [channel, setChannel] = useState("1");
  const [value, setValue] = useState("255");

  const add = () => {
    const [u, c, v] = [Number(universe), Number(channel), Number(value)];
    if (![u, c, v].every(Number.isFinite)) return;
    update((d) => void setPark(d, { universe: u, channel: c, value: v }));
  };

  return (
    <fieldset className="grid gap-2">
      <legend className="flex w-full items-center gap-1.5 text-sm">
        <Lock aria-hidden className="size-3.5 text-muted-foreground" />
        {t("editor.output.park")}
        {park.length > 0 && <span className="num ml-auto text-xs text-muted-foreground">{t("editor.output.parkCount", { count: park.length })}</span>}
      </legend>
      <p className="text-xs text-muted-foreground">{t("editor.output.parkHint")}</p>
      {park.length > 0 && (
        <ul aria-label={t("editor.output.parkList")} className="flex flex-wrap gap-1">
          {park.map((p) => (
            <li key={`${p.universe}.${p.channel}`} className="num flex items-center gap-0.5 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-2.5 text-xs">
              U{p.universe}.{p.channel} = {p.value}
              <button
                type="button"
                aria-label={t("editor.output.unpark", { universe: p.universe, channel: p.channel })}
                title={t("editor.output.unpark", { universe: p.universe, channel: p.channel })}
                onClick={() => update((d) => removePark(d, p.universe, p.channel))}
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 rounded-md bg-surface-1 p-1">
        <span className="pl-1 text-xs text-muted-foreground">U</span>
        <Input aria-label={t("editor.output.parkUniverse")} className="num h-7 w-12 px-1.5 text-xs" inputMode="numeric" value={universe} onChange={(e) => setUniverse(e.target.value)} />
        <span className="text-xs text-muted-foreground">.</span>
        <Input aria-label={t("editor.output.parkChannel")} className="num h-7 w-14 px-1.5 text-xs" inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
        <span className="text-xs text-muted-foreground">=</span>
        <Input aria-label={t("editor.output.parkValue")} className="num h-7 w-14 px-1.5 text-xs" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-2 text-xs" disabled={park.length >= MAX_PARK} onClick={add}>
          <Plus aria-hidden />
          {t("editor.output.parkAdd")}
        </Button>
      </div>
    </fieldset>
  );
}
