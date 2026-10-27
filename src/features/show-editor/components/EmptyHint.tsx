import type { ReactNode } from "react";

/** 面板里的空状态提示：居中的一行说明。 */
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-4 text-center text-sm text-muted-foreground">
      <p className="max-w-64">{children}</p>
    </div>
  );
}
