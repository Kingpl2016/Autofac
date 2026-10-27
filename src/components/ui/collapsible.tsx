import { Collapsible as CollapsiblePrimitive } from "radix-ui";

/** 可折叠区域（基于 Radix Collapsible）：触发器自动带 `aria-expanded` / `aria-controls`。 */
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsibleContent = CollapsiblePrimitive.Content;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
