import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Command as Cmdk } from "cmdk";
import { Check, ChevronsUpDown, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { aiListModels } from "../lib/api";
import { aiErrorText } from "../lib/errors";
import type { AiModelInfo, AiModelListInput } from "../lib/types";

interface ModelComboboxProps {
  id?: string;
  value: string;
  onChange: (model: string) => void;
  /** 查询模型列表用的参数（协议、地址、配置 id、表单里刚填的 Key）。 */
  query: AiModelListInput;
  /** 预设里建议的模型（拉取失败或还没拉取时也能选）。 */
  suggested: readonly string[];
}

/** 一次查询的结果：按查询参数记住，参数变了自动作废。 */
interface Fetched {
  key: string;
  models: AiModelInfo[];
}

/**
 * 可搜索的模型选择框：从模型服务实时拉取模型列表，并列出预设里的建议模型；输入的文字不在列表里时
 * 可以直接使用（自部署的服务、刚发布的模型）。
 *
 * 弹出时自动拉取一次（同一组参数只拉一次），也可以点“刷新”。拉取失败时说明原因，仍可手动输入。
 */
export function ModelCombobox({ id, value, onChange, query, suggested }: ModelComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 不把 Key 放进可见的状态，只用来判断参数是否变化
  const queryKey = `${query.kind}|${query.baseUrl}|${query.profileId ?? ""}|${query.key ? "k" : ""}`;
  const remote = fetched?.key === queryKey ? fetched.models : null;

  const load = () => {
    setLoading(true);
    setError(null);
    aiListModels(query)
      .then((models) => setFetched({ key: queryKey, models }))
      .catch((e: unknown) => setError(aiErrorText(t, e)))
      .finally(() => setLoading(false));
  };

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; source: "remote" | "preset" }[] = [];
    for (const m of remote ?? []) if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push({ ...m, source: "remote" });
    }
    for (const m of suggested) if (!seen.has(m)) {
      seen.add(m);
      out.push({ id: m, name: m, source: "preset" });
    }
    return out;
  }, [remote, suggested]);

  const q = search.trim().toLowerCase();
  const shown = q === "" ? options : options.filter((o) => o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
  const custom = search.trim() !== "" && !options.some((o) => o.id === search.trim()) ? search.trim() : null;
  const pick = (model: string) => {
    onChange(model);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && remote === null && !loading) load();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between px-4 font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value || t("ai.settings.modelPick")}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Cmdk shouldFilter={false} label={t("ai.settings.model")} className="flex flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2">
            <Cmdk.Input
              value={search}
              onValueChange={setSearch}
              placeholder={t("ai.settings.modelSearch")}
              className="h-10 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("ai.settings.modelRefresh")}
              title={t("ai.settings.modelRefresh")}
              disabled={loading}
              onClick={load}
            >
              {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
            </Button>
          </div>
          {error && (
            <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">
              {t("ai.settings.modelLoadFailed", { reason: error })}
            </p>
          )}
          <Cmdk.List className="max-h-64 overflow-auto p-1">
            {custom && (
              <Cmdk.Item
                value={`custom:${custom}`}
                onSelect={() => pick(custom)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent"
              >
                {t("ai.settings.modelUse", { model: custom })}
              </Cmdk.Item>
            )}
            {shown.map((o) => (
              <Cmdk.Item
                key={o.id}
                value={o.id}
                onSelect={() => pick(o.id)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent"
              >
                <Check className={cn("size-4 shrink-0", o.id === value ? "opacity-100" : "opacity-0")} aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {o.name}
                  {o.name !== o.id && <span className="ml-1.5 text-xs text-muted-foreground">{o.id}</span>}
                </span>
                {o.source === "preset" && <span className="shrink-0 text-[10px] text-muted-foreground">{t("ai.settings.modelSuggested")}</span>}
              </Cmdk.Item>
            ))}
            {shown.length === 0 && !custom && (
              <Cmdk.Empty className="px-3 py-4 text-center text-xs text-muted-foreground">
                {loading ? t("common.loading") : t("ai.settings.modelEmpty")}
              </Cmdk.Empty>
            )}
          </Cmdk.List>
        </Cmdk>
      </PopoverContent>
    </Popover>
  );
}
