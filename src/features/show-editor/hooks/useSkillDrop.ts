import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { importSkillWithToast, isSkillPath } from "@/features/ai";
import { listenFileDrop } from "@/shared/tauri/dragDrop";

/**
 * 对话栏打开期间，把拖进窗口的技能包（`.zip`、`SKILL.md` 或文件夹）安装为用户技能。
 * 音视频文件交给 `useMediaDrop`，这里忽略。没有 Tauri 运行时时什么也不做。
 *
 * @returns 是否有文件正悬停在窗口上。
 */
export function useSkillDrop(): boolean {
  const { t } = useTranslation();
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    listenFileDrop({
      onHover: (on) => alive && setHovering(on),
      onDrop: (paths) => {
        void (async () => {
          for (const p of paths.filter(isSkillPath).slice(0, 5)) await importSkillWithToast(p, t);
        })();
      },
    })
      .then((unlisten) => {
        if (alive) off = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, [t]);
  return hovering;
}
