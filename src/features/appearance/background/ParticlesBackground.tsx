/** @file 粒子背景：基于 tsParticles（slim 包），连线、星空、雪花、流星；按设备限制粒子数与帧率 */
import { tsParticles, type Container, type ISourceOptions } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";
import { useEffect, useRef } from "react";

import { toMeshGradient, type BackgroundSettings } from "@/shared/appearance/background";

import { useBackgroundMotion } from "./capabilities";

/** 桌面端与小屏设备的粒子数量上限 */
const MAX_PARTICLES = { desktop: 80, mobile: 40 } as const;
/** 帧率上限 */
const FPS_LIMIT = { desktop: 60, mobile: 30 } as const;

/** 速度档位对应的粒子移动速度 */
const SPEEDS: Record<BackgroundSettings["speed"], number> = { slow: 0.6, normal: 1.2, fast: 2.4 };

/** ParticlesBackground 的属性 */
interface ParticlesBackgroundProps {
  /** 背景设置 */
  background: BackgroundSettings;
}

/**
 * 判断是否为小屏设备（用于降低粒子数量与帧率）。
 *
 * @returns 是否为小屏
 */
function isSmallScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches;
}

/**
 * 生成粒子配置。
 *
 * @param background - 背景设置
 * @returns tsParticles 配置
 */
function buildParticlesOptions(background: BackgroundSettings): ISourceOptions {
  const small = isSmallScreen();
  const count = small ? MAX_PARTICLES.mobile : MAX_PARTICLES.desktop;
  const speed = SPEEDS[background.speed];
  const colors = background.mesh;
  const base = {
    fullScreen: { enable: false },
    fpsLimit: small ? FPS_LIMIT.mobile : FPS_LIMIT.desktop,
    background: { color: "transparent" },
    detectRetina: false,
  } as const;

  if (background.particles === "stars") {
    return {
      ...base,
      particles: {
        number: { value: count },
        color: { value: colors },
        opacity: {
          value: { min: 0.2, max: 0.9 },
          animation: { enable: true, speed: 0.6, sync: false },
        },
        size: { value: { min: 0.6, max: 2 } },
        move: {
          enable: true,
          speed: speed * 0.15,
          direction: "none",
          outModes: { default: "out" },
        },
      },
    };
  }
  if (background.particles === "snow") {
    return {
      ...base,
      particles: {
        number: { value: count },
        color: { value: colors },
        opacity: { value: { min: 0.4, max: 0.9 } },
        size: { value: { min: 1, max: 4 } },
        move: {
          enable: true,
          speed: speed * 0.8,
          direction: "bottom",
          outModes: { default: "out" },
        },
      },
    };
  }
  if (background.particles === "meteors") {
    return {
      ...base,
      particles: {
        number: { value: Math.round(count / 4) },
        color: { value: colors },
        shape: { type: "line" },
        opacity: { value: { min: 0.3, max: 0.8 } },
        size: { value: { min: 8, max: 18 } },
        rotate: { value: 135, path: false },
        move: {
          enable: true,
          speed: speed * 6,
          direction: "bottomLeft",
          straight: true,
          outModes: { default: "out" },
        },
      },
    };
  }
  return {
    ...base,
    particles: {
      number: { value: count },
      color: { value: colors },
      opacity: { value: 0.6 },
      size: { value: { min: 1, max: 3 } },
      links: {
        enable: true,
        distance: small ? 110 : 150,
        color: colors[0] ?? "#6366f1",
        opacity: 0.35,
        width: 1,
      },
      move: { enable: true, speed, direction: "none", outModes: { default: "bounce" } },
    },
  };
}

/**
 * 粒子背景。
 *
 * @remarks
 * - 引擎与 slim 包在这个懒加载块里加载；组件卸载或配置变化时销毁旧实例，不泄漏画布与定时器
 * - 页面不可见时暂停，回到页面继续；减少动画或低配设备上不渲染粒子，只显示底下的主题底色
 * - 没有开启指针交互，因此背景层可以保持 `pointer-events: none`
 *
 * @param props - 组件属性
 * @returns 粒子容器节点
 */
export default function ParticlesBackground({ background }: ParticlesBackgroundProps) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<Container | undefined>(undefined);
  const { animate, visible } = useBackgroundMotion();
  const key = JSON.stringify([background.particles, background.speed, background.mesh]);

  useEffect(() => {
    const element = host.current;
    if (!animate || !element) return;
    let cancelled = false;
    void (async () => {
      await loadSlim(tsParticles);
      const loaded = await tsParticles.load({ element, options: buildParticlesOptions(background) });
      if (cancelled) loaded?.destroy();
      else container.current = loaded;
    })();
    return () => {
      cancelled = true;
      container.current?.destroy();
      container.current = undefined;
    };
    // key 概括了会改变粒子配置的字段；background 对象本身每次设置变化都会换引用，不用作依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, key]);

  // 页面不可见时暂停，回来继续（animate 已包含可见性，这里处理的是“已经创建好”的实例）
  useEffect(() => {
    if (visible) container.current?.play();
    else container.current?.pause();
  }, [visible]);

  return animate ? (
    <div ref={host} className="absolute inset-0" />
  ) : (
    // 静态降级：保留一层很淡的调色板，让背景不至于完全消失
    <div
      className="absolute inset-0 opacity-40"
      style={{
        backgroundColor: "var(--background)",
        backgroundImage: toMeshGradient(background.mesh),
      }}
    />
  );
}
