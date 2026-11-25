// Socket.io-client 封装。
//
// v6 云部署关键：**不写死任何域名 / 端口 / localhost**。
//   * 生产（云部署 / 一键启动单端口）：SERVER_URL 为 undefined，socket.io-client
//     自动连接「当前页面同源」的 window.location.origin，页面是 https 时自动用 wss。
//     因此部署到 https://xxx.zeabur.app 或 https://xxx.onrender.com 后无需改一行代码。
//   * 本地开发：前端 5173 由 vite.config.ts 的 /socket.io 代理转发到 3000；
//     只有需要连另一台机器时才用 VITE_SERVER_URL 显式指定。
import { io } from 'socket.io-client';

const SERVER_URL: string | undefined = import.meta.env.VITE_SERVER_URL || undefined;

export const socket = io(SERVER_URL, {
  autoConnect: true,
  // polling 先建连、再 upgrade 到 websocket：兼容部分云平台反向代理不支持 WS 的情况；
  // 支持 WS 时仍会自动升级，联机延迟不受影响。
  transports: ['polling', 'websocket'],
  reconnection: true,
  reconnectionDelay: 800,
  reconnectionAttempts: 20,
});

/** 实际连接的地址（调试 / 验收用）：未显式配置时即当前页面域名，保证同源动态。 */
export function socketTarget(): string {
  if (SERVER_URL) return SERVER_URL;
  return typeof location !== 'undefined' ? location.origin : '';
}

/**
 * 稳定的本机身份，用于刷新页面后恢复房间与阵营。
 *
 * 用 sessionStorage 而不是 localStorage：同一浏览器里每个标签页都有独立身份，
 * 这样在一台机器上开两个窗口就能分别扮演 A / B 自己联机自测；同时在标签页内
 * 刷新仍然可以凭同一身份恢复房间（断线重连）。
 * 另外支持 ?pid=xxx 显式指定身份，便于确保双开隔离或自动化脚本。
 */
const STORE: Storage = (() => {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : localStorage; }
  catch { return localStorage; }
})();
const CID_KEY = 'cube-tactics-client-id';
const ROOM_KEY = 'cube-tactics-room';

export const clientId: string = (() => {
  const pid = new URLSearchParams(
    typeof location !== 'undefined' ? location.search : ''
  ).get('pid');
  if (pid) return `pid:${pid}`;
  let v = STORE.getItem(CID_KEY);
  if (!v) {
    v = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    STORE.setItem(CID_KEY, v);
  }
  return v;
})();

export interface AckResult {
  ok: boolean;
  code?: string;
  side?: 'A' | 'B';
  resumed?: boolean;
  error?: string;
}

export function emitAck<T = AckResult>(event: string, payload: unknown, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时，请检查服务端是否已启动')), timeoutMs);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export const savedRoom = () => {
  try { return JSON.parse(STORE.getItem(ROOM_KEY) || 'null') as { code: string; side: 'A' | 'B' } | null; }
  catch { return null; }
};
export const saveRoom = (r: { code: string; side: 'A' | 'B' } | null) => {
  if (r) STORE.setItem(ROOM_KEY, JSON.stringify(r));
  else STORE.removeItem(ROOM_KEY);
};

// ---------------------------------------------------------------------------
// 极简联机：服务端权威探测局域网 IP，前端只读结果、不自己猜网卡
// ---------------------------------------------------------------------------
export interface LanAddress { name: string; address: string; usable: boolean }
export interface NetworkInfo {
  ok: boolean;
  /** v6：'cloud' = 云平台部署（公网域名）；'lan' = 本机 / 局域网一键启动 */
  mode?: 'cloud' | 'lan';
  /** v6：玩家当前访问的公网地址（由反向代理请求头还原） */
  publicUrl?: string | null;
  hostname?: string;
  port?: number;
  localUrl?: string;
  lanUrl?: string | null;
  lanIp?: string | null;
  lanUsable?: boolean;
  lanAddresses?: LanAddress[];
}

/** 读取 /api/network（Vite 开发模式由 vite.config.ts 代理到 3000）。失败时返回 null，由调用方降级。 */
export async function fetchNetworkInfo(): Promise<NetworkInfo | null> {
  if (typeof fetch === 'undefined') return null;
  try {
    const res = await fetch('/api/network', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json() as NetworkInfo;
    return data?.ok ? data : null;
  } catch { return null; }
}

/**
 * v5 / v6：PC 大厅【退出游戏】—— 请求结束游戏进程。
 *   * 本机 / 局域网模式：服务端只接受来自这台电脑的请求，收到后 process.exit(0)。
 *   * 云部署模式：服务端返回 cloud:true 且**不会结束进程**（否则会打断所有在线玩家），
 *     前端据此把退出页文案改成「关闭本标签页即可离开」。
 */
export type ShutdownResult = 'closed' | 'cloud' | 'failed';

export async function requestShutdown(): Promise<ShutdownResult> {
  if (typeof fetch === 'undefined') return 'failed';
  try {
    const res = await fetch('/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!res.ok) return 'failed';
    const data = await res.json().catch(() => ({})) as { cloud?: boolean };
    return data.cloud ? 'cloud' : 'closed';
  } catch { return 'failed'; }
}

/**
 * v6：二维码 / 邀请链接的基准地址 —— 永远取「当前页面所在的域名」。
 *   * 云端（https://xxx.zeabur.app）→ 自动得到该公网 HTTPS 域名；
 *   * 局域网用 IP 打开（http://192.168.x.x:3000）→ 自动得到该 IP；
 *   * 只有本机用 localhost / 127.0.0.1 打开时，才改用服务端探测到的局域网 IP，
 *     方便手机扫码（此时 localhost 对手机没有意义）。
 * 这样前端不需要知道任何部署地址，也不写死 localhost:3000。
 */
export function joinBaseUrl(info: NetworkInfo | null): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  // 云端：永远用当前页面域名（服务端也会从反代头还原同一个地址），
  // 绝不能退回局域网 IP —— 那个地址对互联网上的朋友没有意义。
  if (info?.mode === 'cloud') return (origin || info.publicUrl || '').replace(/\/+$/, '');
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const isLoopback = !host || host === 'localhost' || host === '127.0.0.1'
    || host === '[::1]' || host === '::1';
  if (!isLoopback && !host.startsWith('169.254.')) return origin.replace(/\/+$/, '');
  if (info?.lanUrl) return info.lanUrl.replace(/\/+$/, '');
  return (info?.publicUrl || origin).replace(/\/+$/, '');
}

/** 扫码链接 ?room=XXXX（同时兼容 ?code=）里的 4 位房间号。 */
export function scanRoomCode(): string | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const v = (q.get('room') || q.get('code') || '').trim();
  return /^\d{4}$/.test(v) ? v : null;
}

/** 观战链接 ?spectate=XXXX&side=A：只读订阅某一方的迷雾视野 */
export function scanSpectate(): { code: string; side: 'A' | 'B' } | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const code = (q.get('spectate') || '').trim();
  if (!/^\d{4}$/.test(code)) return null;
  const side = (q.get('side') || 'A').toUpperCase() === 'B' ? 'B' : 'A';
  return { code, side };
}
