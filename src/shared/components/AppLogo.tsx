import { useId } from "react";

/**
 * 应用标志：深蓝圆角底板上，中间的控台节点向三个灯具节点发出信号线（蓝 / 青 / 琥珀，对应 DMX 电平的冷 → 暖）。
 *
 * 几何参数与 `scripts/generate_icons.py` 生成的应用图标一致（512 设计空间），改动时两处一起改。
 * 纯装饰，默认对读屏隐藏；需要朗读时传 `title`。
 */
export function AppLogo({ className, title }: { className?: string; title?: string }) {
  const uid = useId().replace(/:/g, "");
  const bg = `${uid}-bg`;
  const glow = `${uid}-glow`;
  const blur = `${uid}-blur`;

  const hub = { x: 256, y: 272 };
  const nodes = [
    { x: 128, y: 152, color: "#5B8CFF" },
    { x: 384, y: 152, color: "#2DD4E0" },
    { x: 256, y: 432, color: "#FFB547" },
  ];

  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#222D6B" />
          <stop offset="1" stopColor="#090C1F" />
        </linearGradient>
        <radialGradient id={glow} cx={hub.x / 512} cy={hub.y / 512} r="0.4">
          <stop offset="0" stopColor="#4A6DFF" stopOpacity="0.5" />
          <stop offset="1" stopColor="#4A6DFF" stopOpacity="0" />
        </radialGradient>
        <filter id={blur} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
        {nodes.map((n, i) => (
          <linearGradient
            key={i}
            id={`${uid}-spoke${i}`}
            gradientUnits="userSpaceOnUse"
            x1={hub.x}
            y1={hub.y}
            x2={n.x}
            y2={n.y}
          >
            <stop offset="0" stopColor="#EAF0FF" />
            <stop offset="1" stopColor={n.color} />
          </linearGradient>
        ))}
      </defs>

      <rect width="512" height="512" rx="112" fill={`url(#${bg})`} />
      <rect width="512" height="512" rx="112" fill={`url(#${glow})`} />
      <circle cx={hub.x} cy={hub.y} r="200" fill="none" stroke="#fff" strokeOpacity="0.09" strokeWidth="6" />

      {/* 节点发光 */}
      <g filter={`url(#${blur})`} opacity="0.7">
        {nodes.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r="54" fill={n.color} />
        ))}
      </g>

      {/* 信号线 */}
      {nodes.map((n, i) => (
        <line
          key={i}
          x1={hub.x}
          y1={hub.y}
          x2={n.x}
          y2={n.y}
          stroke={`url(#${uid}-spoke${i})`}
          strokeWidth="20"
          strokeLinecap="round"
        />
      ))}

      {/* 节点 */}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r="58" fill="none" stroke={n.color} strokeOpacity="0.35" strokeWidth="8" />
          <circle cx={n.x} cy={n.y} r="40" fill={n.color} />
        </g>
      ))}

      {/* 枢纽 */}
      <circle cx={hub.x} cy={hub.y} r="62" fill="#0E1330" stroke="#EAF0FF" strokeWidth="16" />
      <circle cx={hub.x} cy={hub.y} r="24" fill="#EAF0FF" />
    </svg>
  );
}
