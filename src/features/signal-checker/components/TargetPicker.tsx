import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getTargets } from "../lib/api";
import type { TargetGroups, TargetOption } from "../lib/types";

interface TargetPickerProps {
  /** 选中某个候选 IP 时调用 */
  onSelect: (ip: string) => void;
}

/** 受限广播地址。 */
const LIMITED_BROADCAST = "255.255.255.255";

interface Group {
  key: string;
  title: string;
  items: Array<TargetOption & { label: string }>;
}

/**
 * 目标 IP 选择器：按"本机 / 本机网卡 / 已发现设备 / 广播地址"分组列出候选项。
 *
 * 只在展开时才向后端取列表（设备和网卡会变化，每次展开都重新取）。选中后把 IP 交给父组件并收起，
 * 输入框本身仍可手输任意地址。
 */
export function TargetPicker({ onSelect }: TargetPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const targets = useQuery({
    queryKey: ["signal-checker", "targets"],
    queryFn: getTargets,
    enabled: open,
    staleTime: 0,
  });

  const groups = buildGroups(targets.data, t);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t("signalChecker.pickTarget")}>
          <ChevronDown aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-80 w-80 overflow-y-auto p-2">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t("signalChecker.targetEmpty")}</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.title} className="mb-1 last:mb-0">
              <h3 className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.ip}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      onClick={() => {
                        onSelect(item.ip);
                        setOpen(false);
                      }}
                    >
                      <span className="tabular shrink-0">{item.ip}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {item.label}
                      </span>
                      {item.online === false && (
                        <Badge variant="outline">{t("signalChecker.targetOffline")}</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 把后端返回的分组整理成要显示的分组（跳过空组，并给每项配好说明文字）。 */
function buildGroups(data: TargetGroups | undefined, t: (key: string) => string): Group[] {
  if (!data) return [];
  const groups: Group[] = [
    {
      key: "local",
      title: t("signalChecker.targetLocal"),
      items: data.local.map((o) => ({ ...o, label: t("signalChecker.targetLocalHint") })),
    },
    {
      key: "interfaces",
      title: t("signalChecker.targetInterfaces"),
      items: data.interfaces.map((o) => ({ ...o, label: o.name ?? "" })),
    },
    {
      key: "devices",
      title: t("signalChecker.targetDevices"),
      items: data.devices.map((o) => ({ ...o, label: o.name ?? "" })),
    },
    {
      key: "broadcasts",
      title: t("signalChecker.targetBroadcasts"),
      items: data.broadcasts.map((o) => ({
        ...o,
        label:
          o.ip === LIMITED_BROADCAST
            ? t("signalChecker.targetLimitedBroadcast")
            : t("signalChecker.targetDirectedBroadcast"),
      })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}
