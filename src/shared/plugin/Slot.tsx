import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";

import type { SlotName, SlotPropsMap } from "./slotRegistry";
import { useSlotContributions } from "./useSlotContributions";

/** 隔离单个贡献的渲染错误，避免某个插件的故障拖垮整个宿主区域。 */
class ContributionBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[plugin] 扩展点贡献 "${this.props.id}" 渲染失败`, error, info.componentStack);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface SlotProps<N extends SlotName> {
  /** 扩展点名称。 */
  name: N;
  /** 传给每个贡献组件的 props。 */
  slotProps?: SlotPropsMap[N];
}

/**
 * 渲染某个扩展点下的所有贡献（按 `order` 排列）。
 * 宿主只依赖本组件和扩展点名称，不依赖任何提供贡献的插件：插件被移除或禁用时，这里自然渲染为空。
 */
export function Slot<N extends SlotName>({ name, slotProps }: SlotProps<N>): ReactNode {
  const contributions = useSlotContributions(name);
  return contributions.map(({ id, component }) => {
    const Contribution = component as ComponentType<object>;
    return (
      <ContributionBoundary key={id} id={id}>
        <Contribution {...slotProps} />
      </ContributionBoundary>
    );
  });
}
