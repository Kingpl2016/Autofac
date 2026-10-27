import * as React from "react";

import { cn } from "@/lib/utils";

/** 骨架屏占位块。个性化里开启“骨架屏流光”后，带 `data-slot="skeleton"` 的块会有光带扫过。 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-accent", className)} {...props} />;
}

export { Skeleton };