import { useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import { useAuiState } from "@assistant-ui/react";
import { Boxes, ChevronDown, Loader2, Settings } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aiErrorText, openAiModelsDialog, useActiveAiProfile, useProfileModels, useSetProfileModel, type AiProfileView } from "@/features/ai";
import { useAiChatStore } from "../../../stores/useAiChatStore";

/** 按协议分组。 */
function groupByKind(profiles: readonly AiProfileView[]): [AiProfileView["kind"], AiProfileView[]][] {
  const map = new Map<AiProfileView["kind"], AiProfileView[]>();
  for (const p of profiles) map.set(p.kind, [...(map.get(p.kind) ?? []), p]);
  return [...map];
}

/**
 * 当前配置可换的模型（子菜单）：打开时从模型服务拉取列表，补上预设建议；选中后改这个配置的模型。
 *
 * @param props.profile 当前配置。
 */
const ModelSwitchSub: FC<{ profile: AiProfileView }> = ({ profile }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { models, loading, error } = useProfileModels(profile, open);
  const setModel = useSetProfileModel();
  const pick = (model: string) => {
    if (model === profile.model) return;
    setModel(profile, model)
      .then(() => toast.success(t("editor.ai.modelSwitched", { model })))
      .catch((e: unknown) => toast.error(aiErrorText(t, e)));
  };
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <Boxes aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("editor.ai.modelSwitch")}</span>
        <span className="ms-2 max-w-28 truncate text-xs text-muted-foreground">{profile.model}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{t("editor.ai.modelSwitchHint", { name: profile.name })}</span>
          {loading && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-label={t("common.loading")} />}
        </DropdownMenuLabel>
        {error && <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">{t("editor.ai.modelListFailed")}</p>}
        <DropdownMenuRadioGroup value={profile.model} onValueChange={pick}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {m.name !== m.id && <span className="ms-2 truncate text-xs text-muted-foreground">{m.id}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/**
 * 输入框底部的模型菜单：切换本次对话使用的 AI 配置（按协议分组，显示模型名），或换当前配置的模型；
 * “模型配置…”在当前页面弹出配置对话框。对话内容保留，下一次请求发往新模型。生成过程中不能切换。
 */
export const ModelMenu: FC = () => {
  const { t } = useTranslation();
  const chosen = useAiChatStore((s) => s.profileId);
  const { profiles, profile } = useActiveAiProfile(chosen);
  const running = useAuiState((s) => s.thread.isRunning);
  if (!profile) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          aria-label={t("editor.ai.modelMenu", { name: profile.name })}
          className="h-7 min-w-0 max-w-[45%] gap-1 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="truncate">{profile.name}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup value={profile.id} onValueChange={(id) => useAiChatStore.setState({ profileId: id })}>
          {groupByKind(profiles).map(([kind, list], i) => (
            <div key={kind}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs text-muted-foreground">{t(`ai.kinds.${kind}`)}</DropdownMenuLabel>
              {list.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.name !== p.model && <span className="ms-2 truncate text-xs text-muted-foreground">{p.model}</span>}
                </DropdownMenuRadioItem>
              ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <ModelSwitchSub profile={profile} />
        <DropdownMenuItem onSelect={openAiModelsDialog}>
          <Settings aria-hidden />
          {t("editor.ai.manageModels")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
