import type {
  ConfigPatch,
  DeviceConfig,
  DeviceStatus,
  Diag,
  FirmwareInfo,
  NetFile,
  PlayerStatus,
  Progress,
} from "@/features/network/lib/types";
import type { NetdevMachineSeed } from "../types";
import { hashText } from "../lib/random";
import type { Library } from "./library";
import {
  num,
  sleep,
  str,
  type CommandArgs,
  type DemoModule,
  type World,
} from "./world";

/** 模拟的设备 OTA 分区上限。 */
const OTA_SLOT_BYTES = 0x40_0000;
/** 重启后固件自检并自动确认所需的时间。 */
const AUTO_CONFIRM_MS = 6000;

/** 抛出与真实后端一致的 `{ code, message }` 错误。 */
function netFail(code: string, message: string): never {
  throw { code, message };
}

/** 一台模拟设备的运行态。 */
interface Machine {
  seed: NetdevMachineSeed;
  files: NetFile[];
  durations: Map<string, number>;
  workMode: number;
  version: string;
  config: DeviceConfig;
  logs: string[];
  /** 设备上配置的 Token（可被 PUT /api/config 修改） */
  token: string | null;
  /** 重启中：到此时刻（world.elapsedMs）前不可达 */
  offlineUntil: number;
  pendingVerify: boolean;
  /** 到此时刻自动确认新固件 */
  confirmAt: number;
  player: PlayerStatus;
  sdFree: number;
}

/** 已保存设备（演示里的"注册表"）。 */
interface Saved {
  id: string;
  name: string;
  host: string;
  port: number;
}

/**
 * 按名称哈希出稳定的"文件体积"，让没有真实文件的演示传输有合理的大小。
 *
 * # Arguments
 *
 * * `key` - 路径或名称。
 *
 * # Returns
 *
 * 1.5 MiB ~ 3.5 MiB 之间的字节数。
 */
function pseudoSize(key: string): number {
  return 1_500_000 + (hashText(key) % 2_000_000);
}

/** 判断是否为合法可见 ASCII Token（8~64 位）。 */
function validToken(t: string): boolean {
  return t === "" || (t.length >= 8 && t.length <= 64 && /^[\x21-\x7e]+$/.test(t));
}

/** 判断文件名是否符合固件规则。 */
function checkFileName(name: string): void {
  const bad =
    name === "" ||
    name.length > 128 ||
    /[/\\]/.test(name) ||
    name.includes("..") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(name) ||
    !name.toLowerCase().endsWith(".artrec") ||
    name.length === ".artrec".length;
  if (bad) netFail("invalid", "文件名须以 .artrec 结尾，且不能含路径分隔符或控制字符");
}

/**
 * 创建网络设备演示模块：多台模拟核心板（鉴权 / 离线 / 重启 / 播放 / 文件 / OTA），
 * 语义对齐固件 `docs/protocol.md`，包括"没配 Token 时拒绝一切写操作"和"非节目模式拒绝播放"。
 *
 * 文件改动在内存里生效，刷新页面后还原。传输按 `netdev.json` 的 `transferMs` 模拟进度，支持取消。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 节目库，"上传节目到设备"要取它的文件名与体积。
 *
 * # Returns
 *
 * 网络设备演示模块。
 */
export function createNetdevModule(world: World, library: Library): DemoModule {
  const seed = world.data.netdev;
  const now = () => world.elapsedMs();

  const machines = new Map<string, Machine>();
  for (const m of seed.machines) {
    const files: NetFile[] = m.files.map((f) => ({
      name: f.name,
      size: f.size,
      isDir: false,
      program: f.program,
    }));
    const player: PlayerStatus = {
      state: 0,
      programNo: 0,
      repeat: 0,
      speedX100: 100,
      posMs: 0,
      durMs: 0,
      universes: 0,
      frames: 0,
      badFrames: 0,
    };
    machines.set(m.host, {
      seed: m,
      files,
      durations: new Map(m.files.map((f) => [f.name, f.durationMs])),
      workMode: m.workMode,
      version: m.version,
      config: { ...seed.config, hostname: m.hostname, dhcp: m.viaDhcp, tokenSet: m.token !== null },
      logs: [...seed.logs],
      token: m.token,
      offlineUntil: 0,
      pendingVerify: false,
      confirmAt: 0,
      player,
      sdFree: m.sdFree,
    });
  }
  // 主舞台设备预置一个正在循环播放的节目，页面一打开就有实时数据
  const main = machines.get(seed.saved[0]?.host ?? "");
  const first = main?.files.find((f) => f.program === 1);
  if (main && first) {
    main.player = {
      ...main.player,
      state: 2,
      programNo: 1,
      repeat: 1,
      durMs: main.durations.get(first.name) ?? 0,
      universes: 4,
    };
  }

  const saved: Saved[] = seed.saved.map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }));
  const localTokens = new Map<string, string>(
    seed.saved.flatMap((s) => (s.localToken ? [[s.id, s.localToken] as const] : [])),
  );
  const cancelled = new Set<string>();

  const log = (m: Machine, text: string) => {
    m.logs.push(`I (${Math.round(now())}) demo: ${text}`);
    if (m.logs.length > 200) m.logs.shift();
  };

  const reachable = (m: Machine) => m.seed.reachable && now() >= m.offlineUntil;

  /** 模拟一次到设备的请求：延迟 → 可达性 → 鉴权。 */
  const call = async (
    hostOrId: { id: string } | { host: string; token?: string | null },
    sensitive: boolean,
  ): Promise<Machine> => {
    let host: string;
    let token: string | null;
    if ("id" in hostOrId) {
      const s = saved.find((x) => x.id === hostOrId.id);
      if (!s) netFail("unknown_device", "设备不存在");
      host = s.host;
      token = localTokens.get(s.id) ?? null;
    } else {
      host = hostOrId.host;
      token = hostOrId.token ?? null;
    }
    await sleep(seed.latencyMs);
    const m = machines.get(host);
    if (!m || !reachable(m)) {
      await sleep(600);
      netFail("network", "连接设备失败（超时）");
    }
    if (m.token !== null) {
      if (token !== m.token) netFail("unauthorized", "设备要求鉴权：请设置或更正 Token");
    } else if (sensitive) {
      netFail("unauthorized", "设备要求鉴权：请设置或更正 Token");
    }
    return m;
  };

  const statusOf = (m: Machine): DeviceStatus => ({
    version: m.version,
    workMode: m.workMode,
    ip: m.seed.host,
    netmask: "255.255.255.0",
    gateway: "192.168.1.1",
    viaDhcp: m.seed.viaDhcp,
    linkUp: true,
    sdMounted: true,
    sdTotal: m.seed.sdTotal,
    sdFree: m.sdFree,
    player: {
      state: m.player.state,
      programNo: m.player.programNo,
      posMs: Math.round(m.player.posMs),
      durMs: m.player.durMs,
    },
  });

  const requirePlayable = (m: Machine) => {
    if (m.workMode !== 0 && m.workMode !== 4) netFail("wrong_mode", "当前工作模式不允许此操作");
  };

  const progressOf = (args: CommandArgs): ((p: Progress) => void) => {
    const ch = args.onProgress as { onmessage?: (p: Progress) => void } | undefined;
    return (p) => ch?.onmessage?.(p);
  };

  /** 模拟一次可取消的流式传输。 */
  const simulateTransfer = async (args: CommandArgs, total: number): Promise<void> => {
    const id = str(args, "transferId");
    const emit = progressOf(args);
    const steps = 18;
    for (let i = 1; i <= steps; i += 1) {
      await sleep(seed.transferMs / steps);
      if (cancelled.delete(id)) netFail("cancelled", "传输已取消");
      const done = Math.round((total * i) / steps);
      emit({ done, total, speedBps: Math.round((total / seed.transferMs) * 1000) });
    }
  };

  const assignProgram = (m: Machine): number | null => {
    const used = new Set(m.files.flatMap((f) => (f.program ? [f.program] : [])));
    for (let n = 1; n <= 255; n += 1) if (!used.has(n)) return n;
    return null;
  };

  const storeFile = (m: Machine, name: string, size: number) => {
    const existing = m.files.find((f) => f.name === name);
    const delta = size - (existing?.size ?? 0);
    if (delta > m.sdFree) netFail("no_space", "设备存储空间不足");
    m.sdFree -= delta;
    const program = existing?.program ?? assignProgram(m);
    m.files = [...m.files.filter((f) => f.name !== name), { name, size, isDir: false, program }];
    m.durations.set(name, m.durations.get(name) ?? 120_000 + (hashText(name) % 400_000));
    return program;
  };

  /** 触发设备重启：一段时间不可达，期间播放停止。 */
  const reboot = (m: Machine, extraMs = 0) => {
    m.offlineUntil = now() + seed.rebootMs + extraMs;
    m.player = { ...m.player, state: 0, programNo: 0, posMs: 0 };
  };

  const firmwareInfo = (path: string): FirmwareInfo => {
    const fileName = path.split(/[\\/]/).pop() ?? "firmware.bin";
    if (!fileName.toLowerCase().endsWith(".bin")) netFail("invalid", "请选择 .bin 固件文件");
    if (/bad|corrupt|损坏/i.test(fileName)) {
      netFail("invalid", "不是 ESP 应用固件（镜像头魔数不符），请选择 .bin 应用镜像而非整片 Flash 或分区表");
    }
    const size = pseudoSize(path);
    if (size > OTA_SLOT_BYTES) netFail("invalid", "固件超过设备 OTA 分区大小");
    const v = /(\d+\.\d+\.\d+)/.exec(fileName)?.[1] ?? "1.5.0";
    return {
      fileName,
      size,
      version: v,
      projectName: "artnet_p4",
      buildTime: "12:30:00",
      buildDate: "Oct 27 2026",
      idfVersion: "v5.5.1",
    };
  };

  const diagOf = (m: Machine): Diag => {
    const t = now() / 1000;
    const wob = (amp: number, period: number, phase = 0) => Math.sin(t / period + phase) * amp;
    const tasks = [
      ["player_main", 22, 0, 6144, 120],
      ["player_prefetch", 20, 1, 1536, 90],
      ["dmx_uart0", 21, 1, 2816, 60],
      ["lwip_tcpip", 18, 0, 3072, 30],
      ["httpd", 5, 0, 4096, 8],
      ["etronet_rx", 12, 1, 3584, 4],
      ["IDLE0", 0, 0, 1024, 500],
      ["IDLE1", 0, 1, 1024, 420],
    ] as const;
    return {
      heap: {
        free: Math.round(214_000 + wob(6000, 5)),
        minFree: 168_000,
        largestBlock: Math.round(110_000 + wob(3000, 9, 1)),
        psramFree: Math.round(30_600_000 + wob(40_000, 7, 2)),
      },
      tasks: tasks.map(([name, prio, core, stackMin, cpu], i) => ({
        name,
        prio,
        stackMin,
        core,
        runtime: Math.round(t * 1000 * (cpu + 1)),
        cpuPermille: Math.max(0, Math.round(cpu + wob(cpu * 0.15, 3 + i))),
      })),
      dmxUart: { ports: 3, txTimeouts: 0 },
      player: { state: m.player.state, badFrames: m.player.badFrames },
    };
  };

  /** 简化版的固件配置校验（对齐 `config_validate`）。 */
  const validatePatch = (p: ConfigPatch) => {
    const bad = (msg: string) => netFail("invalid_arg", msg);
    if (p.sacnPriority !== undefined && (p.sacnPriority < 0 || p.sacnPriority > 200)) bad("sacnPriority");
    if (p.keepaliveMs !== undefined && (p.keepaliveMs < 0 || p.keepaliveMs > 600_000)) bad("keepaliveMs");
    if (p.forwardUniStart !== undefined && (p.forwardUniStart < 0 || p.forwardUniStart > 32_767)) bad("forwardUniStart");
    if (p.forwardUniCount !== undefined && (p.forwardUniCount < 1 || p.forwardUniCount > 512)) bad("forwardUniCount");
    if (p.sourceName !== undefined && (p.sourceName.length < 1 || p.sourceName.length > 63)) bad("sourceName");
    if (p.httpToken !== undefined && !validToken(p.httpToken)) {
      netFail("invalid", "Token 须为 8~64 位可见 ASCII 字符");
    }
  };

  return {
    commands: {
      // ---------- 设备管理 ----------
      netdev_list: () => saved.map((s) => ({ ...s, hasToken: localTokens.has(s.id) })),

      netdev_save: (args: CommandArgs) => {
        const input = (args.input ?? {}) as { id?: string; name?: string; host?: string; port?: number };
        const host = (input.host ?? "").trim();
        const port = input.port ?? 0;
        if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.includes("..")) {
          netFail("invalid", "主机只能是 IP 或主机名，不要包含 http://、端口或路径");
        }
        if (port < 1 || port > 65_535) netFail("invalid", "端口必须在 1~65535 之间");
        const name = (input.name ?? "").trim() || host;
        if ([...name].length > 40) netFail("invalid", "名称最多 40 个字符");
        if (saved.some((s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port && s.id !== input.id)) {
          netFail("invalid", "该主机和端口已添加过");
        }
        if (input.id) {
          const s = saved.find((x) => x.id === input.id);
          if (!s) netFail("unknown_device", "设备不存在");
          Object.assign(s, { name, host, port });
          return { ...s };
        }
        const s: Saved = { id: `demo-${Math.random().toString(36).slice(2, 10)}`, name, host, port };
        saved.push(s);
        return { ...s };
      },

      netdev_remove: (args: CommandArgs) => {
        const id = str(args, "id");
        const i = saved.findIndex((s) => s.id === id);
        if (i < 0) netFail("unknown_device", "设备不存在");
        saved.splice(i, 1);
        localTokens.delete(id);
      },

      netdev_set_token: (args: CommandArgs) => {
        const id = str(args, "id");
        const token = str(args, "token");
        if (!saved.some((s) => s.id === id)) netFail("unknown_device", "设备不存在");
        if (!validToken(token)) netFail("invalid", "Token 须为 8~64 位可见 ASCII 字符");
        if (token === "") localTokens.delete(id);
        else localTokens.set(id, token);
      },

      netdev_probe: async (args: CommandArgs) => {
        const token = typeof args.token === "string" ? args.token : null;
        const m = await call({ host: str(args, "host"), token }, false);
        return statusOf(m);
      },

      // ---------- 状态与控制 ----------
      netdev_status: async (args: CommandArgs) => statusOf(await call({ id: str(args, "id") }, false)),

      netdev_set_workmode: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const mode = num(args, "mode");
        if (!Number.isInteger(mode) || mode < 0 || mode > 5) netFail("invalid", "工作模式必须在 0~5 之间");
        m.workMode = mode;
        // 切到非 0/4 模式会停止播放
        if (mode !== 0 && mode !== 4 && m.player.state !== 0) {
          m.player = { ...m.player, state: 1, posMs: 0 };
        }
        log(m, `工作模式 -> ${mode}`);
      },

      netdev_board_op: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const op = num(args, "op");
        if (!Number.isInteger(op) || op < 0 || op > 2) netFail("invalid", "设备操作码必须在 0~2 之间");
        if (op === 0) reboot(m);
        if (op === 1) {
          m.config = { ...seed.config, hostname: m.seed.hostname, tokenSet: m.token !== null };
          reboot(m, 2000);
        }
        log(m, `设备操作 ${["复位", "恢复出厂", "自检"][op]}`);
      },

      netdev_program_op: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const no = num(args, "no");
        const action = num(args, "action");
        if (!Number.isInteger(no) || no < 1 || no > 255) netFail("invalid", "节目号必须在 1~255 之间");
        if (action === 5) netFail("not_supported", "设备不支持该操作");
        if (!Number.isInteger(action) || action < 0 || action > 4) netFail("invalid", "节目操作码必须在 0~4 之间");
        const file = m.files.find((f) => f.program === no);
        if (action === 4) {
          if (!file) netFail("not_found", "设备上未找到目标");
          if (m.player.programNo === no) m.player = { ...m.player, state: 0, programNo: 0, posMs: 0, durMs: 0 };
          m.files = m.files.filter((f) => f !== file);
          m.sdFree += file.size;
          return;
        }
        requirePlayable(m);
        if (action === 0) {
          if (m.player.state !== 0) m.player = { ...m.player, state: 1, posMs: 0 };
        } else if (action === 1) {
          if (m.player.state === 2) m.player = { ...m.player, state: 3 };
          else if (m.player.state === 3) m.player = { ...m.player, state: 2 };
        } else {
          if (!file) netFail("not_found", "设备上未找到目标");
          m.player = {
            ...m.player,
            state: 2,
            programNo: no,
            repeat: action === 3 ? 1 : 0,
            posMs: 0,
            durMs: m.durations.get(file.name) ?? 120_000,
            universes: 4,
          };
          log(m, `播放节目 ${no}（${file.name}）`);
        }
      },

      netdev_player: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        return { ...m.player, posMs: Math.round(m.player.posMs), frames: Math.round(m.player.frames) };
      },

      netdev_seek: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        m.player = { ...m.player, posMs: Math.max(0, Math.min(num(args, "posMs"), m.player.durMs)) };
      },

      netdev_speed: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const v = num(args, "speedX100");
        if (!Number.isInteger(v) || v < 25 || v > 200) netFail("invalid", "倍速必须在 25~200 之间（×100）");
        m.player = { ...m.player, speedX100: v };
      },

      // ---------- 配置 / 诊断 / 日志 ----------
      netdev_get_config: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        return { ...m.config, tokenSet: m.token !== null };
      },

      netdev_put_config: async (args: CommandArgs) => {
        const id = str(args, "id");
        const m = await call({ id }, true);
        const patch = (args.patch ?? {}) as ConfigPatch;
        validatePatch(patch);
        const { httpToken, ...rest } = patch;
        const touchesNet = ["dhcp", "ip", "netmask", "gateway", "hostname"].some((k) => k in rest);
        if (!m.config.dhcp && (rest.dhcp ?? m.config.dhcp) === false && (rest.ip ?? m.config.ip) === "0.0.0.0") {
          netFail("invalid_arg", "静态 IP 不能为 0.0.0.0");
        }
        m.config = { ...m.config, ...rest };
        if (httpToken !== undefined) {
          m.token = httpToken === "" ? null : httpToken;
          // 与真实后端一致：设备接受后再更新本地凭据
          if (httpToken === "") localTokens.delete(id);
          else localTokens.set(id, httpToken);
        }
        log(m, "配置已更新");
        return { ok: true, netRebootRequired: touchesNet };
      },

      netdev_diag: async (args: CommandArgs) => diagOf(await call({ id: str(args, "id") }, false)),

      netdev_logs: async (args: CommandArgs) => (await call({ id: str(args, "id") }, false)).logs.join("\n"),

      // ---------- 文件 ----------
      netdev_list_files: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        return m.files.map((f) => ({ ...f }));
      },

      netdev_list_programs: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        return m.files.flatMap((f) => (f.program ? [{ no: f.program, file: f.name, size: f.size }] : []));
      },

      netdev_assign_programs: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const list = (args.assignments ?? []) as Array<{ no: number; file: string }>;
        if (list.length === 0) netFail("invalid", "没有要应用的节目号分配");
        for (const a of list) {
          if (!Number.isInteger(a.no) || a.no < 1 || a.no > 255) netFail("invalid", "节目号必须在 1~255 之间");
          checkFileName(a.file);
          if (!m.files.some((f) => f.name === a.file)) netFail("not_found", "设备上未找到目标");
        }
        if (new Set(list.map((a) => a.no)).size !== list.length || new Set(list.map((a) => a.file)).size !== list.length) {
          netFail("invalid", "节目号或文件名重复");
        }
        // 与固件一致：一个文件只对应一个编号；被占用的编号会被覆盖
        for (const a of list) {
          m.files = m.files.map((f) => {
            if (f.name === a.file) return { ...f, program: a.no };
            return f.program === a.no ? { ...f, program: null } : f;
          });
        }
        log(m, `调整节目号：${list.map((a) => `${a.no}→${a.file}`).join("，")}`);
      },

      netdev_delete_file: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const name = str(args, "name");
        checkFileName(name);
        const f = m.files.find((x) => x.name === name);
        if (!f) netFail("not_found", "设备上未找到目标");
        if (f.program !== null && f.program === m.player.programNo && m.player.state !== 0) {
          netFail("busy", "设备忙或该文件正在播放");
        }
        m.files = m.files.filter((x) => x !== f);
        m.sdFree += f.size;
        log(m, `删除文件 ${name}`);
      },

      netdev_rename_file: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const from = str(args, "from");
        const to = str(args, "to");
        checkFileName(from);
        checkFileName(to);
        const f = m.files.find((x) => x.name === from);
        if (!f) netFail("device_io", "设备内部错误");
        m.files = m.files.map((x) => (x === f ? { ...x, name: to } : x));
        const d = m.durations.get(from);
        if (d !== undefined) m.durations.set(to, d);
      },

      netdev_upload_file: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const name = str(args, "name");
        checkFileName(name);
        const size = pseudoSize(str(args, "path"));
        if (size > m.sdFree) netFail("no_space", "设备存储空间不足");
        await simulateTransfer(args, size);
        const program = storeFile(m, name, size);
        log(m, `上传文件 ${name}（${size} 字节）`);
        return { name, size, program };
      },

      netdev_download_file: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        const name = str(args, "name");
        checkFileName(name);
        const f = m.files.find((x) => x.name === name);
        if (!f) netFail("not_found", "设备上未找到目标");
        await simulateTransfer(args, f.size);
      },

      netdev_upload_recording: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const rec = library.find(str(args, "path"));
        if (!rec) netFail("invalid", "节目不在录制目录内");
        const name = rec.entry.fileName;
        await simulateTransfer(args, rec.entry.bytes);
        storeFile(m, name, rec.entry.bytes);
        world.log("info", `节目已上传到设备 ${m.seed.host}: ${name}`);
        return name;
      },

      netdev_cancel: (args: CommandArgs) => {
        cancelled.add(str(args, "transferId"));
        return true;
      },

      // ---------- 固件 ----------
      netdev_ota_status: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, false);
        return {
          running: seed.ota.running,
          version: m.version,
          compileTime: seed.ota.compileTime,
          pendingVerify: m.pendingVerify,
          rollbackEnabled: seed.ota.rollbackEnabled,
        };
      },

      netdev_ota_confirm: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        m.pendingVerify = false;
      },

      netdev_inspect_firmware: (args: CommandArgs) => firmwareInfo(str(args, "path")),

      netdev_ota_upload: async (args: CommandArgs) => {
        const m = await call({ id: str(args, "id") }, true);
        const info = firmwareInfo(str(args, "path"));
        await simulateTransfer(args, info.size);
        m.version = info.version;
        m.pendingVerify = true;
        reboot(m);
        m.confirmAt = m.offlineUntil + AUTO_CONFIRM_MS;
        log(m, `OTA 完成，新版本 ${info.version}，重启中`);
        return { newVersion: info.version, rebooting: true };
      },
    },

    tick: ({ dtMs }) => {
      for (const m of machines.values()) {
        // 新固件重启后自检通过，自动确认
        if (m.pendingVerify && m.confirmAt > 0 && now() >= m.confirmAt) {
          m.pendingVerify = false;
          m.confirmAt = 0;
        }
        const p = m.player;
        if (p.state !== 2) continue;
        const pos = p.posMs + (dtMs * p.speedX100) / 100;
        if (pos >= p.durMs) {
          m.player =
            p.repeat === 1
              ? { ...p, posMs: 0 }
              : { ...p, state: 1, posMs: 0 };
        } else {
          m.player = { ...p, posMs: pos, frames: p.frames + (dtMs * p.speedX100) / 100 / 22.7 };
        }
      }
    },
  };
}
