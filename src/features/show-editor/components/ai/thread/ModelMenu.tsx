import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuiState } from "@assistant-ui/react";
import { ChevronDown, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActiveAiProfile, type AiProfileView } from "@/features/ai";
import { useAiChatStore } from "../../../stores/useAiChatStore";

/** 按协议分组。 */
function groupByKind(profiles: readonly AiProfileView[]): [AiProfileView["kind"], AiProfileView[]][] {
  const map = new Map<AiProfileView["kind"], AiProfileView[]>();
  for (const p of profiles) map.set(p.kind, [...(map.get(p.kind) ?? []), p]);
  return [...map];
}

/**
 * 输入框底部的模型菜单：切换本次对话使用的 AI 配置（按协议分组，显示模型名）。对话内容保留，
 * 下一次请求发往新模型。生成过程中不能切换。
 */
export const ModelMenu: FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
          className="h-7 max-w-[70%] gap-1 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="truncate">{profile.name}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
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
        <DropdownMenuItem onSelect={() => navigate("/settings#ai")}>
          <Settings aria-hidden />
          {t("editor.ai.manageModels")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
