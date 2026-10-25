import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection } from "./SettingsSection";
import { SettingRow } from "./SettingRow";
import { useNetworkInterfaces } from "../hooks/useNetworkInterfaces";
import type { AppSettings } from "../lib/types";

interface SettingsFormProps {
  settings: AppSettings;
  update: (updater: (prev: AppSettings) => AppSettings) => void;
}

/** sACN 标准监听端口。 */
const DEFAULT_SACN_PORT = 5568;

/** sACN 合法 Universe 范围（E1.31：1~63999），与后端 normalize 一致。 */
const SACN_UNIVERSE_MIN = 1;
const SACN_UNIVERSE_MAX = 63999;

/** 解析逗号分隔的 Universe 文本为去重升序的数字数组（只保留 sACN 合法范围）。 */
function parseUniverses(text: string): number[] {
  const set = new Set<number>();
  for (const part of text.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n >= SACN_UNIVERSE_MIN && n <= SACN_UNIVERSE_MAX) {
      set.add(n);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 设置表单：网络 / 协议 / 显示 / 合并 / 录制 / 更新 六大分区。
 */
export function SettingsForm({ settings, update }: SettingsFormProps) {
  const { t } = useTranslation();
  const { data: interfaces = [] } = useNetworkInterfaces();
  // 取草稿而非已保存值：开关一拨动，相关配置项就即时显示 / 隐藏
  const sacnOn = settings.protocol.sacnEnabled;

  return (
    <div className="grid gap-(--density-gutter) pb-10">
      {/* 网络 */}
      <SettingsSection title={t("settings.sectionNetwork")}>
        <SettingRow label={t("settings.networkMode")}>
          <Select
            value={settings.network.mode}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                network: { ...s.network, mode: v as AppSettings["network"]["mode"] },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{t("settings.singleInterface")}</SelectItem>
              <SelectItem value="multiNic">{t("settings.multiNic")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {settings.network.mode === "single" && (
          <SettingRow label={t("settings.interface")}>
            <Select
              value={settings.network.interface}
              onValueChange={(v) =>
                update((s) => ({
                  ...s,
                  network: { ...s.network, interface: v },
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {interfaces.map((i) => (
                  <SelectItem key={`${i.name}-${i.ip}`} value={i.ip}>
                    {i.ip === "0.0.0.0"
                      ? t("settings.allInterfaces")
                      : `${i.name} (${i.ip})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        )}

        {settings.network.mode === "multiNic" &&
          interfaces
            .filter((i) => i.ip !== "0.0.0.0")
            .map((i) => {
              const cfg =
                settings.network.multiNic.find((n) => n.name === i.name) ??
                { name: i.name, artnetEnabled: true, sacnEnabled: true };
              const setNic = (patch: Partial<typeof cfg>) =>
                update((s) => {
                  const rest = s.network.multiNic.filter((n) => n.name !== i.name);
                  return {
                    ...s,
                    network: {
                      ...s.network,
                      multiNic: [...rest, { ...cfg, ...patch }],
                    },
                  };
                });
              return (
                <SettingRow key={i.name} label={`${i.name} (${i.ip})`}>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs">
                      Art-Net
                      <Switch
                        checked={cfg.artnetEnabled}
                        onCheckedChange={(v) => setNic({ artnetEnabled: v })}
                      />
                    </label>
                    {sacnOn && (
                      <label className="flex items-center gap-1.5 text-xs">
                        sACN
                        <Switch
                          checked={cfg.sacnEnabled}
                          onCheckedChange={(v) => setNic({ sacnEnabled: v })}
                        />
                      </label>
                    )}
                  </div>
                </SettingRow>
              );
            })}
      </SettingsSection>

      {/* 协议 */}
      <SettingsSection title={t("settings.sectionProtocol")}>
        <SettingRow label={t("settings.artnetEnabled")}>
          <Switch
            checked={settings.protocol.artnetEnabled}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                protocol: { ...s.protocol, artnetEnabled: v },
              }))
            }
          />
        </SettingRow>
        <SettingRow label={t("settings.artnetPort")}>
          <Input
            type="number"
            className="tabular w-28"
            value={settings.protocol.artnetPort}
            onChange={(e) =>
              update((s) => ({
                ...s,
                protocol: {
                  ...s.protocol,
                  artnetPort: Number(e.target.value) || 0,
                },
              }))
            }
          />
        </SettingRow>
        <SettingRow label={t("settings.sacnEnabled")}>
          <Switch
            checked={settings.protocol.sacnEnabled}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                protocol: { ...s.protocol, sacnEnabled: v },
              }))
            }
          />
        </SettingRow>
        {sacnOn && (
          <>
            <SettingRow label={t("settings.sacnPort")}>
              <Input
                type="number"
                min={1}
                max={65535}
                className="tabular w-28"
                value={settings.protocol.sacnPort}
                onChange={(e) =>
                  update((s) => ({
                    ...s,
                    protocol: { ...s.protocol, sacnPort: Number(e.target.value) },
                  }))
                }
                // 输入中允许暂时为空；离开输入框时回落到合法值（端口 0 会让系统分配随机端口）
                onBlur={() => {
                  const p = settings.protocol.sacnPort;
                  if (Number.isInteger(p) && p >= 1 && p <= 65535) return;
                  update((s) => ({
                    ...s,
                    protocol: { ...s.protocol, sacnPort: DEFAULT_SACN_PORT },
                  }));
                }}
              />
            </SettingRow>
            <SettingRow label={t("settings.sacnUniverses")}>
              <Input
                className="tabular"
                defaultValue={settings.protocol.sacnUniverses.join(",")}
                onBlur={(e) =>
                  update((s) => ({
                    ...s,
                    protocol: {
                      ...s.protocol,
                      sacnUniverses: parseUniverses(e.target.value),
                    },
                  }))
                }
              />
            </SettingRow>
          </>
        )}
      </SettingsSection>

      {/* 显示 */}
      <SettingsSection title={t("settings.sectionDisplay")}>
        <SettingRow label={t("settings.uiUpdateRate")}>
          <Select
            value={String(settings.display.uiUpdateRate)}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                display: { ...s.display, uiUpdateRate: Number(v) },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">{t("settings.fpsLow")}</SelectItem>
              <SelectItem value="30">{t("settings.fpsMid")}</SelectItem>
              <SelectItem value="60">{t("settings.fpsHigh")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.universeFormat")}>
          <Select
            value={settings.display.universeFormat}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                display: {
                  ...s.display,
                  universeFormat: v as AppSettings["display"]["universeFormat"],
                },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="decimal1">{t("settings.formatDecimal1")}</SelectItem>
              <SelectItem value="decimal0">{t("settings.formatDecimal0")}</SelectItem>
              <SelectItem value="hex">{t("settings.formatHex")}</SelectItem>
              <SelectItem value="artnet">{t("settings.formatArtnet")}</SelectItem>
              <SelectItem value="ascii">{t("settings.formatAscii")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.channelFormat")}>
          <Select
            value={settings.display.channelFormat}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                display: {
                  ...s.display,
                  channelFormat: v as AppSettings["display"]["channelFormat"],
                },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="decimal1">{t("settings.formatDecimal1")}</SelectItem>
              <SelectItem value="decimal0">{t("settings.formatDecimal0")}</SelectItem>
              <SelectItem value="hex">{t("settings.formatHex")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.valueFormat")}>
          <Select
            value={settings.display.valueFormat}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                display: {
                  ...s.display,
                  valueFormat: v as AppSettings["display"]["valueFormat"],
                },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="decimal">{t("settings.valueDecimal")}</SelectItem>
              <SelectItem value="hex">{t("settings.valueHex")}</SelectItem>
              <SelectItem value="percent">{t("settings.valuePercent")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>

      {/* 合并 */}
      <SettingsSection title={t("settings.sectionMerge")}>
        <SettingRow label={t("settings.mergeMode")}>
          <Select
            value={settings.merge.mode}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                merge: { ...s.merge, mode: v as AppSettings["merge"]["mode"] },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="htp">{t("settings.mergeHtp")}</SelectItem>
              <SelectItem value="ltp">{t("settings.mergeLtp")}</SelectItem>
              <SelectItem value="priority">{t("settings.mergePriority")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.sourceTimeout")}>
          <Input
            type="number"
            className="tabular w-28"
            value={settings.merge.sourceTimeoutMs}
            onChange={(e) =>
              update((s) => ({
                ...s,
                merge: {
                  ...s.merge,
                  sourceTimeoutMs: Number(e.target.value) || 0,
                },
              }))
            }
          />
        </SettingRow>
      </SettingsSection>

      {/* 录制 */}
      <SettingsSection title={t("settings.sectionRecording")}>
        <SettingRow label={t("settings.recordingDir")}>
          <Input
            className="w-full"
            placeholder="~/Documents/ArtNet Studio Recordings"
            value={settings.recording.directory}
            onChange={(e) =>
              update((s) => ({
                ...s,
                recording: { ...s.recording, directory: e.target.value },
              }))
            }
          />
        </SettingRow>
        <SettingRow label={t("settings.recordingCompression")}>
          <Select
            value={settings.recording.compression}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                recording: {
                  ...s.recording,
                  compression: v as AppSettings["recording"]["compression"],
                },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zstd">{t("settings.compressionZstd")}</SelectItem>
              <SelectItem value="none">{t("settings.compressionNone")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t("settings.recordingZstdLevel")}>
          <Input
            type="number"
            min={1}
            max={9}
            className="tabular w-28"
            disabled={settings.recording.compression === "none"}
            value={settings.recording.zstdLevel}
            onChange={(e) =>
              update((s) => ({
                ...s,
                recording: {
                  ...s.recording,
                  zstdLevel: Math.min(9, Math.max(1, Number(e.target.value) || 1)),
                },
              }))
            }
          />
        </SettingRow>
        <SettingRow label={t("settings.recordingSplitMinutes")}>
          <Input
            type="number"
            min={0}
            className="tabular w-28"
            value={settings.recording.splitMinutes}
            onChange={(e) =>
              update((s) => ({
                ...s,
                recording: {
                  ...s.recording,
                  splitMinutes: Math.max(0, Number(e.target.value) || 0),
                },
              }))
            }
          />
        </SettingRow>
      </SettingsSection>

      {/* 更新 */}
      <SettingsSection title={t("settings.sectionUpdate")}>
        <SettingRow label={t("settings.updateChannel")}>
          <Select
            value={settings.update.channel}
            onValueChange={(v) =>
              update((s) => ({
                ...s,
                update: { channel: v as AppSettings["update"]["channel"] },
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">{t("settings.channelStable")}</SelectItem>
              <SelectItem value="beta">{t("settings.channelBeta")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
