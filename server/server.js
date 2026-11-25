// ============================================================================
// server/server.js —— 权威服务端（Node.js + Express + Socket.io）
//
// 启动：node server/server.js        （默认 3000，可用 PORT 覆盖）
//
// 职责：
//   1. 房间机制：A 创建 4 位房间号，B 输入房间号加入；支持断线重连。
//   2. 所有移动/攻击/陷阱/装置/召唤/回合规则都在这里校验，前端只发意图。
//   3. 迷雾在服务端按「每个玩家自己的单位视野」计算，下发专属 PlayerView，
//      隐藏的敌方单位/装置坐标根本不会出现在网络包里（防作弊）。
//   4. 非法操作只向请求方回传错误，成功则向两端广播各自视图。
// ============================================================================

import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import * as R from '../shared/rules.js';
import { EMOTE_IDS, EMOTE_CD_MS, findEmote } from '../shared/emotes.js';
import { isLocalRequest } from './shutdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 云部署关键：Zeabur / Render / Railway / Fly.io 等平台会动态注入 PORT，
// 必须监听它而不是写死 3000；本地双击「一键启动」时回落到 3000。
const PORT = Number(process.env.PORT || 3000);
const other = (s) => (s === 'A' ? 'B' : 'A');

// ---------------------------------------------------------------------------
// v6：云部署模式检测
//   * 平台通常自带 RENDER / ZEABUR / RAILWAY_* 等环境变量；也可用
//     CLOUD_DEPLOY=1 显式开启（推荐在平台的 Environment 里加一个）。
//   * 云端是多租户服务：某个玩家点「退出游戏」绝不能杀掉整个容器进程，
//     因此该模式下 /api/shutdown 只返回提示、不 process.exit。
//   * 本地「一键启动」不带这些变量 -> 仍是原来的局域网单机模式。
// ---------------------------------------------------------------------------
const IS_CLOUD = process.env.CLOUD_DEPLOY === '1' || !!(
  process.env.RENDER || process.env.RENDER_SERVICE_ID
  || process.env.ZEABUR || process.env.RAILWAY_ENVIRONMENT
  || process.env.FLY_APP_NAME || process.env.VERCEL
  || process.env.K_SERVICE || process.env.HEROKU_APP_NAME
  // 兜底：某些平台不注入专属变量，但会设 NODE_ENV=production 并动态分配 PORT
  || (process.env.NODE_ENV === 'production' && Number(process.env.PORT) !== 3000)
);
const DIST_DIR = path.join(ROOT, 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

/** 依据反向代理请求头还原玩家实际访问的公网地址（云端二维码 / 邀请链接用）。 */
function publicUrlOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  return host ? `${proto}://${host}` : null;
}

/**
 * 请求是否来自「本机 / 局域网」访问，而不是公网域名。
 * 云平台反向代理会把 Host 设为平台分配的域名（xxx.zeabur.app / xxx.onrender.com），
 * 因此不依赖任何平台环境变量也能可靠识别云端访问。
 */
function isLocalHostname(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.hostname || req.headers.host || '')
    .split(',')[0].trim().toLowerCase();
  const host = raw.replace(/^\[/, '').replace(/\]$/, '').replace(/:\d+$/, '');
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // 用电脑自己的局域网 IP 打开（本机一键启动的另一台窗口）也算局域网
  return LAN_ADDRESSES.some((a) => a.address.toLowerCase() === host);
}

/** 云端 / 公网访问：进程级标记 或 当前请求的 Host 不是本机地址。 */
function isCloudRequest(req) {
  return IS_CLOUD || !isLocalHostname(req);
}

// ---------------------------------------------------------------------------
// 局域网 IP 探测：给「一键启动」的终端提示和大厅二维码用
// 过滤掉回环、Docker/VMware/虚拟网卡、APIPA(169.254) 等不是真实局域网的地址，
// 并按常见家用网段优先级排序，尽量给出朋友手机能直接访问的那一个。
// ---------------------------------------------------------------------------
const VIRTUAL_IFACE = /^(docker|br-|veth|vEthernet|VMware|VirtualBox|vnic|utun|tun|tap|tailscale|wg|ham|lo|Loopback)/i;
function lanIPv4s() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const iface of list || []) {
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isIPv4 || iface.internal) continue;
      // 169.254 是链路本地地址（手机一般连不上），降为最低优先级并标记 usable=false
      const linkLocal = iface.address.startsWith('169.254.');
      out.push({ name, address: iface.address, usable: !linkLocal });
    }
  }
  const rank = (a) => !a.usable ? 9
    : a.address.startsWith('192.168.') ? 0
      : /^10\./.test(a.address) ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
  return out.sort((x, y) => rank(x) - rank(y));
}
const LAN_ADDRESSES = lanIPv4s();
const LAN_IP = LAN_ADDRESSES[0]?.address || null;
const LAN_URL = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
const LAN_USABLE = !!LAN_ADDRESSES[0]?.usable;
// 生产环境每局随机发牌；CARD_SEED 仅供自动化测试复现牌序
const CARD_SEED = process.env.CARD_SEED !== undefined
  ? (Number(process.env.CARD_SEED) >>> 0) : (Date.now() >>> 0);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  // v6：云部署允许任意来源（平台分配的预览域名、绑定的自定义域名、跨端调试）。
  // 前端默认与页面同源连接，这里放开 CORS 是为了自定义域名与反向代理场景。
  cors: { origin: '*' },
  // websocket 与 polling 都允许：云平台反代不支持 WS 时客户端可回退到 polling
  transports: ['websocket', 'polling'],
});

// 云平台 Health Check 可以直接打 /health；同时暴露部署模式与前端构建状态便于排障。
app.get('/health', (_req, res) => res.json({
  ok: true, rooms: rooms.size, uptime: process.uptime(), lanUrl: LAN_URL,
  mode: IS_CLOUD ? 'cloud' : 'lan', cloud: IS_CLOUD, dist: HAS_DIST, port: PORT,
}));

// 前端大厅/二维码读取地址信息。
// 局域网模式：返回服务端探测到的真实局域网 IP；
// 云端模式：返回玩家当前访问的公网域名（由平台反代头还原），大厅据此生成分享二维码。
// 必须放在 express.static 与 SPA 通配之前，否则会被 index.html 抢先匹配。
app.get('/api/network', (req, res) => {
  const publicUrl = publicUrlOf(req);
  const cloud = isCloudRequest(req);
  return res.json({
    ok: true,
    mode: cloud ? 'cloud' : 'lan',
    hostname: os.hostname(),
    port: PORT,
    publicUrl,
    localUrl: cloud ? (publicUrl || `http://localhost:${PORT}`) : `http://localhost:${PORT}`,
    lanUrl: LAN_URL,
    lanIp: LAN_IP,
    // 云端有平台分配的公网域名，一律视为「朋友可访问」
    lanUsable: cloud ? true : LAN_USABLE,
    lanAddresses: LAN_ADDRESSES,
  });
});

// ---------------------------------------------------------------------------
// v5：PC 大厅【退出游戏】—— 关闭游戏进程
//   * 只有运行服务端的这台电脑（loopback / 本机任一网卡 IP）可以触发；
//     手机等局域网远端一律 403，避免误触关掉房主的游戏。
//   * 先把响应发回浏览器，再广播 serverShutdown 让所有客户端停止重连，
//     最后优雅关闭 Socket.io / HTTP 并 process.exit(0)。
//   * 幂等：重复点击或 HTTP + Socket 双通道只会执行一次。
//   * 该接口放在 express.static 与 SPA 通配之前，避免被 index.html 抢先匹配。
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdownGame(source = 'api') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[exit] 收到 PC 大厅退出请求（${source}），正在关闭游戏进程…`);
  // 让所有已连接的客户端（含手机、观战者）知道是正常退出，而不是掉线重连
  try { io.emit('serverShutdown', { reason: '房主已关闭游戏' }); } catch { /* 忽略 */ }
  setTimeout(() => {
    try { io.close(); } catch { /* 忽略 */ }
    try { httpServer.close(() => process.exit(0)); } catch { process.exit(0); }
    // 兜底：若 httpServer.close 因长连接未回调，强制结束进程
    setTimeout(() => process.exit(0), 700).unref();
  }, 180);
}

app.post('/api/shutdown', (req, res) => {
  // v6：云端是多租户服务，绝不能让某个玩家的「退出游戏」结束整个容器，
  // 否则所有在线玩家会被平台重启打断。只回提示，前端负责退出本标签页。
  // 用「请求 Host 是否本机」判定，不依赖平台是否注入了专属环境变量。
  if (isCloudRequest(req)) {
    return res.json({ ok: true, cloud: true, message: '云端部署不会关闭服务器，关闭本标签页即可离开' });
  }
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, error: '仅运行游戏的电脑可以从大厅退出' });
  }
  res.json({ ok: true, message: '游戏进程即将关闭' });
  shutdownGame('http');
});

// ---------------------------------------------------------------------------
// v6：单端口统一托管 —— 一个 Node 进程同时提供「前端页面」与「Socket.io 联机」
//   * express.static 直接托管 dist（vite build 产物）；
//   * 其余路径回退到 index.html，交给前端路由；
//   * /health、/api/*、/socket.io 由上面的专用路由处理，不被 SPA 回退吞掉；
//   * dist 未构建时给出明确的诊断页（503），避免云部署出现莫名其妙的白屏。
// ---------------------------------------------------------------------------
app.use(express.static(DIST_DIR, { index: false }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/socket.io')) return res.status(404).end();
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return res.status(404).json({ ok: false, error: '接口不存在' });
  }
  // 浏览器默认会请求 favicon，回 204 避免云端日志里刷 404
  if (req.path === '/favicon.ico') return res.status(204).end();
  if (!HAS_DIST) {
    return res.status(503).type('html').send(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>立方战术 · 前端未构建</title>'
      + '<body style="font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf3;padding:40px;line-height:1.8">'
      + '<h1>前端尚未构建</h1><p>服务端已启动，但找不到 <code>dist/index.html</code>。</p>'
      + '<p>请在部署平台把 <b>Build Command</b> 设为 <code>npm install --include=dev &amp;&amp; npm run build</code>，'
      + '或在本机执行 <code>npm install &amp;&amp; npm run build</code> 后重启服务。</p>'
      + '<p>联机服务与健康检查不受影响：<a style="color:#38bdf8" href="/health">/health</a></p></body></html>',
    );
  }
  return res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// 房间存储
// ---------------------------------------------------------------------------
/** @type {Map<string, {code,status,state,slots:{A:object|null,B:object|null},createdAt:number}>} */
const rooms = new Map();

function newCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('房间号生成失败');
}

function sideOf(room, clientId) {
  if (room.slots.A?.clientId === clientId) return 'A';
  if (room.slots.B?.clientId === clientId) return 'B';
  return null;
}

function bind(room, side, clientId, socket) {
  if (socket.data.roomCode && socket.data.roomCode !== room.code) {
    socket.leave(socket.data.roomCode);
  }
  room.slots[side] = { clientId, socketId: socket.id, connected: true };
  socket.data.roomCode = room.code;
  socket.data.side = side;
  socket.data.clientId = clientId;
  socket.join(room.code);
}

function findByClient(clientId) {
  if (!clientId) return null;
  for (const room of rooms.values()) {
    const side = sideOf(room, clientId);
    if (side) return { room, side };
  }
  return null;
}

function emitRoom(room) {
  for (const side of ['A', 'B']) {
    const slot = room.slots[side];
    if (!slot?.socketId) continue;
    io.to(slot.socketId).emit('room', {
      code: room.code,
      side,
      status: room.status,
      opponentConnected: !!room.slots[other(side)]?.connected,
    });
  }
}

/**
 * 向两端分别下发「按各自视野过滤」的状态。
 * 只发送 R.viewFor() 的结果，绝不发送原始 room.state：
 * 因此对方手牌(hands)、隐藏单位坐标、隐藏事件坐标都不会出现在网络包里。
 */
function broadcast(room) {
  if (!room.state) return;
  for (const side of ['A', 'B']) {
    const slot = room.slots[side];
    if (!slot?.socketId) continue;
    const view = R.viewFor(room.state, side, {
      roomCode: room.code,
      status: room.status,
      opponentConnected: !!room.slots[other(side)]?.connected,
    });
    io.to(slot.socketId).emit('state', view);
  }
  // 最终版任务一：观战者「继承其所观战玩家」的迷雾视野。
  // 用该 side 生成专属 PlayerView（隐藏单位/装置同样不下发），并标记 spectating 只读。
  for (const [sid, spectatorSide] of (room.spectators || new Map())) {
    const view = R.viewFor(room.state, spectatorSide, {
      roomCode: room.code,
      status: room.status,
      opponentConnected: !!room.slots[other(spectatorSide)]?.connected,
      spectating: true,
      mySide: spectatorSide,
    });
    io.to(sid).emit('state', view);
  }
}

function sendError(socket, message) {
  socket.emit('error', String(message || '操作失败'));
}

function startIfReady(room) {
  if (room.status !== 'waiting') return;
  if (!room.slots.A?.connected || !room.slots.B?.connected) return;
  // 迭代 5：两人都进房后先进入「盲选」阶段，不直接开局
  room.status = 'picking';
  room.lineup = null;
  room.state = R.createPickingState();
  emitRoom(room);
  broadcast(room);
}

// ---------------------------------------------------------------------------
// 操作意图 -> 纯函数规则层（player 一律取服务端绑定的 side，忽略客户端自报身份）
// ---------------------------------------------------------------------------
const ACTIONS = {
  move: (s, p, side) => R.moveUnit(s, p.unitId, p.targetPos, side),
  attack: (s, p, side) => R.resolveAttack(s, p.attackerId, p.targetId, side),
  // 迭代 6：p.z 指定要开关的陷阱层（1 中层 / 2 顶层），缺省中层；
  // 中/顶层共用「每方每回合 1 次」次数，仍由规则层权威校验。
  toggleTrap: (s, p, side) => R.toggleCenterTrap(s, p.unitId, side, p.z ?? p.trapPos),
  place: (s, p, side) => R.placeDevice(s, side, p.type, p.pos),
  // 召唤入口只认「预备池名额 key」；旧字段 cls 仅作兼容，服务端仍会
  // 校验它必须属于本局预选名单且未使用，客户端无法借此召唤名单外单位。
  summon: (s, p, side) => R.summonUnit(s, side,
    p.reserveKey ?? p.cls ?? p.unitClass ?? p.class, p.pos),
  // 迭代 4：技能牌。cardId 属于哪一方、是否合法目标、AP/每回合限制全在服务端校验，
  // 客户端无法用别人的 cardId 打牌，也无法从广播里看到对方手牌。
  playCard: (s, p, side) => R.playCard(s, p.cardId, p.targetId, side, p.pos || p.targetPos || null),
  // 最终版任务三：点击牌库主动抽 1 张（1 AP）
  drawCard: (s, _p, side) => R.drawCard(s, side),
  endTurn: (s, _p, side) => R.endTurn(s, side),
  surrender: (s, _p, side) => R.surrender(s, side),
};

function handleAction(socket, type, payload) {
  const { roomCode, side } = socket.data;
  const room = rooms.get(roomCode);
  if (!room || !side) return sendError(socket, '尚未加入房间');
  if (room.status !== 'playing' || !room.state) return sendError(socket, '对局尚未开始');
  const fn = ACTIONS[type];
  if (!fn) return sendError(socket, `未知操作：${type}`);
  const p = payload && typeof payload === 'object' ? payload : {};
  let res;
  try {
    res = fn(room.state, p, side);
  } catch (err) {
    console.error(`[action:${type}]`, err);
    return sendError(socket, '服务端处理异常');
  }
  if (!res?.ok) return sendError(socket, res?.error || '非法操作');
  room.state = res.state;
  if (room.state.phase === 'gameover') room.status = 'gameover';
  broadcast(room);
  emitRoom(room);
}

// ---------------------------------------------------------------------------
// 迭代 5：开局盲选动作（与对局动作分开，因为此时 room.status === 'picking'）
// 所有阵容校验、确认状态、双确认切换都在 shared/rules.js 的纯函数里完成。
// ---------------------------------------------------------------------------
const PICK_ACTIONS = {
  setPicks: (s, p, side) => R.setPicks(s, side, p.classes),
  confirmPicks: (s, p, side) => R.confirmPicks(s, side, p.classes),
  unconfirmPicks: (s, _p, side) => R.unconfirmPicks(s, side),
};

function handlePick(socket, type, payload) {
  const { roomCode, side } = socket.data;
  const room = rooms.get(roomCode);
  if (!room || !side) return sendError(socket, '尚未加入房间');
  if (room.state?.phase !== 'picking') return sendError(socket, '当前不在选人阶段');
  const fn = PICK_ACTIONS[type];
  if (!fn) return sendError(socket, `未知选人操作：${type}`);
  const p = payload && typeof payload === 'object' ? payload : {};
  let res;
  try {
    res = fn(room.state, p, side);
  } catch (err) {
    console.error(`[pick:${type}]`, err);
    return sendError(socket, '服务端处理异常');
  }
  if (!res?.ok) return sendError(socket, res?.error || '非法选人操作');
  room.state = res.state;

  // 双方都确认 -> 按各自盲选阵容生成初始 3 个单位，切入 playing。
  // 注意：此处才第一次把双方 picks 用于生成单位；在此之前任何网络包都不含对方阵容。
  if (R.bothConfirmed(room.state)) {
    room.lineup = { A: [...room.state.picks.A], B: [...room.state.picks.B] };
    room.state = R.createInitialState(CARD_SEED, room.lineup);
    room.status = 'playing';
  }
  broadcast(room);
  emitRoom(room);
}

// ---------------------------------------------------------------------------
// Socket 事件
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

  // v5：PC 大厅【退出游戏】的 Socket 兜底通道（HTTP /api/shutdown 为主通道）。
  // 同样只接受来自本机（这台电脑）的请求，局域网远端一律拒绝。
  socket.on('quitGame', (_payload, cb) => {
    // v6：与 /api/shutdown 一致 —— 公网访问不结束进程，只回提示
    const handshake = socket.handshake;
    const pseudo = {
      headers: handshake.headers || {},
      hostname: String(handshake.headers?.host || '').split(':')[0],
      socket: { remoteAddress: handshake.address },
    };
    if (isCloudRequest(pseudo)) {
      reply(cb)({ ok: true, cloud: true, message: '云端部署不会关闭服务器，关闭本标签页即可离开' });
      return;
    }
    if (!isLocalRequest(pseudo)) {
      reply(cb)({ ok: false, error: '仅运行游戏的电脑可以从大厅退出' });
      return;
    }
    reply(cb)({ ok: true, message: '游戏进程即将关闭' });
    shutdownGame('socket');
  });

  // 创建房间（若该 clientId 已在某房间，则视为断线重连）
  socket.on('createRoom', (payload, cb) => {
    const clientId = payload?.clientId;
    const existing = findByClient(clientId);
    if (existing) {
      bind(existing.room, existing.side, clientId, socket);
      reply(cb)({ ok: true, code: existing.room.code, side: existing.side, resumed: true });
      emitRoom(existing.room);
      broadcast(existing.room);
      return;
    }
    const code = newCode();
    const room = {
      code, status: 'waiting', state: null,
      slots: { A: null, B: null }, createdAt: Date.now(),
      // 观战者：socketId -> 所观战的阵营（A / B）
      spectators: new Map(),
      // 迭代 9：局内表情的每阵营上次发送时间戳（服务端权威 CD，单位 ms）
      emoteLastAt: { A: 0, B: 0 },
    };
    rooms.set(code, room);
    bind(room, 'A', clientId, socket);
    reply(cb)({ ok: true, code, side: 'A' });
    emitRoom(room);
    console.log(`[room] ${code} 已创建，等待玩家 B`);
  });

  // 加入房间
  socket.on('joinRoom', (payload, cb) => {
    const code = String(payload?.code || '').trim();
    const clientId = payload?.clientId;
    const room = rooms.get(code);
    if (!room) return reply(cb)({ ok: false, error: '房间不存在，请检查 4 位房间号' });

    const known = sideOf(room, clientId);
    if (known) {
      bind(room, known, clientId, socket);
      reply(cb)({ ok: true, code, side: known, resumed: true });
      emitRoom(room);
      broadcast(room);
      return;
    }
    if (room.slots.B) return reply(cb)({ ok: false, error: '房间已满' });
    bind(room, 'B', clientId, socket);
    reply(cb)({ ok: true, code, side: 'B' });
    startIfReady(room); // 两端齐了 -> 初始化对局并广播
    console.log(`[room] ${code} 玩家 B 已加入，对局开始`);
  });

  // 刷新页面后凭 localStorage 里的 clientId 恢复身份
  socket.on('resume', (payload, cb) => {
    const code = String(payload?.code || '').trim();
    const clientId = payload?.clientId;
    const room = rooms.get(code);
    if (!room) return reply(cb)({ ok: false, error: '房间已失效' });
    const side = sideOf(room, clientId);
    if (!side) return reply(cb)({ ok: false, error: '身份不匹配' });
    bind(room, side, clientId, socket);
    reply(cb)({ ok: true, code, side, resumed: true });
    emitRoom(room);
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    if (socket.data.spectating) {
      rooms.get(socket.data.spectating)?.spectators?.delete(socket.id);
      socket.leave(socket.data.spectating);
      socket.data.spectating = undefined;
      socket.data.spectateSide = undefined;
    }
    const room = rooms.get(socket.data.roomCode);
    if (room && room.slots[socket.data.side]?.socketId === socket.id) {
      room.slots[socket.data.side] = null;
    }
    socket.leave(socket.data.roomCode || '');
    socket.data.roomCode = undefined;
    socket.data.side = undefined;
    if (room) emitRoom(room);
  });

  // 游戏结束后任意一方都可以请求重开
  socket.on('restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return sendError(socket, '尚未加入房间');
    if (room.state?.phase !== 'gameover') return sendError(socket, '对局尚未结束');
    // 沿用本局盲选阵容重开（不必重新选人）；发牌种子由 CARD_SEED 决定，便于测试复现
    room.state = R.createInitialState(CARD_SEED, room.lineup || undefined);
    room.status = 'playing';
    room.emoteLastAt = { A: 0, B: 0 };
    broadcast(room);
    emitRoom(room);
  });

  // ---------------------------------------------------------------------------
  // 迭代 9：局内表情（完全独立于 GameState 的旁路互动事件）
  //   * 不消耗 AP、不写规则层、不触发 broadcast(room)，因此不影响任何核心数值与联机同步；
  //   * side 一律取服务端绑定的身份，客户端无法伪造阵营；
  //   * 只认白名单 id，emoji/label 由服务端查表下发，客户端不能注入任意文本；
  //   * 按阵营记录时间戳做 3 秒 CD，冷却中只回发送方 emoteCooldown，不广播；
  //   * 广播到房间频道 io.to(room.code)，A/B 与未来加入同一频道的观战者都能收到。
  // ---------------------------------------------------------------------------
  socket.on('emote', (payload) => {
    const { roomCode, side } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || !side) return;
    if (room.status !== 'playing' && room.status !== 'gameover') return;
    const id = typeof payload === 'object' && payload ? String(payload.id ?? '') : '';
    const def = findEmote(id);
    if (!def || !EMOTE_IDS.includes(id)) return;

    const now = Date.now();
    room.emoteLastAt ??= { A: 0, B: 0 };
    const last = room.emoteLastAt[side] || 0;
    const wait = EMOTE_CD_MS - (now - last);
    if (wait > 0) {
      socket.emit('emoteCooldown', { remainingMs: wait });
      return;
    }
    room.emoteLastAt[side] = now;
    // 广播到房间频道：A/B 与任何已 spectate 的观战者都在该频道里
    io.to(room.code).emit('emote', {
      side, id,
      emoji: def.emoji, label: def.label, color: def.color,
      serverTs: now,
    });
  });

  // 观战者：只读订阅房间频道，不占 A/B 席位、不改 room.status、不能发任何动作。
  // 最终版任务一：观战者必须指定观战哪一方（缺省 A），服务端按该 side 生成
  // 「带战争迷雾」的专属 PlayerView 并持续广播，绝不裸露全图信息。
  socket.on('spectate', (payload, cb) => {
    const reply = (r) => { if (typeof cb === 'function') cb(r); };
    const code = String(payload?.code || '').trim();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: '房间不存在' });
    const side = String(payload?.side || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    socket.join(code);
    socket.data.spectating = code;
    socket.data.spectateSide = side;
    room.spectators ??= new Map();
    room.spectators.set(socket.id, side);
    reply({ ok: true, code, side });
    if (room.state) {
      io.to(socket.id).emit('state', R.viewFor(room.state, side, {
        roomCode: room.code, status: room.status,
        opponentConnected: !!room.slots[other(side)]?.connected,
        spectating: true, mySide: side,
      }));
    }
  });

  for (const type of Object.keys(ACTIONS)) {
    socket.on(type, (payload) => handleAction(socket, type, payload));
  }
  for (const type of Object.keys(PICK_ACTIONS)) {
    socket.on(type, (payload) => handlePick(socket, type, payload));
  }

  socket.on('disconnect', () => {
    if (socket.data.spectating) {
      rooms.get(socket.data.spectating)?.spectators?.delete(socket.id);
    }
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const slot = room.slots[socket.data.side];
    if (slot && slot.socketId === socket.id) {
      slot.connected = false;
      slot.socketId = null;
    }
    emitRoom(room);
    broadcast(room);
    console.log(`[room] ${room.code} 玩家 ${socket.data.side} 断开`);
  });
});

// 空闲房间清理（2 小时无连接）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const dead = !room.slots.A?.connected && !room.slots.B?.connected;
    if (dead && now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[room] ${code} 已清理`);
    }
  }
}, 10 * 60 * 1000).unref();

// ANSI 颜色：绝大多数终端（含 Windows 10+ 的 cmd / PowerShell / Terminal）都支持 VT 序列
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`${C.bold}${C.green}🎮 游戏已启动！${C.reset} ${C.dim}监听 0.0.0.0:${PORT}${C.reset}`);
  if (IS_CLOUD) {
    // 云端：局域网 IP 探测没有意义，公网域名由平台分配并在 Domain 页面展示
    console.log(`   ${C.cyan}云部署模式${C.reset}：单端口同时托管前端页面 + Socket.io 联机`);
    console.log(`   ${C.cyan}公网网址${C.reset}：到 Zeabur / Render 的 Domain 页面复制平台分配的 HTTPS 域名`);
    console.log(`   ${C.dim}分享给朋友即可开玩，二维码与邀请链接会自动使用该公网域名${C.reset}`);
    console.log(`   ${C.dim}健康检查 /health  ·  网络信息 /api/network  ·  PORT 由平台自动注入${C.reset}`);
    if (!HAS_DIST) {
      console.log(`   ${C.yellow}[警告] 未找到 dist/index.html，请先执行 npm install --include=dev && npm run build${C.reset}`);
    }
  } else {
    console.log(`   ${C.cyan}本机访问：${C.reset}${C.bold}http://localhost:${PORT}${C.reset}`);
    if (LAN_URL) {
      console.log(`   ${C.yellow}局域网联机（请把这个地址发给朋友）：${C.reset}${C.bold}${LAN_URL}${C.reset}`);
      console.log(`   ${C.dim}手机扫码：创建房间后会自动弹出带房间号的二维码${C.reset}`);
      if (!LAN_USABLE) {
        console.log(`   ${C.yellow}注意：只检测到链路本地地址(169.254.*)，若朋友无法访问请检查 Wi-Fi / 网线${C.reset}`);
      }
      if (LAN_ADDRESSES.length > 1) {
        console.log(`   ${C.dim}其它网卡：${LAN_ADDRESSES.slice(1)
          .map((a) => `http://${a.address}:${PORT} (${a.name})`).join('   ')}${C.reset}`);
      }
    } else {
      console.log(`   ${C.yellow}未检测到局域网 IPv4，请连上 Wi-Fi / 网线后重启服务端${C.reset}`);
    }
    console.log(`   ${C.dim}健康检查 http://localhost:${PORT}/health  ·  网络信息 http://localhost:${PORT}/api/network${C.reset}`);
    console.log(`   ${C.dim}停止服务：在此窗口按 Ctrl + C，或在 PC 大厅右上角点【退出游戏】${C.reset}`);
  }
  console.log('');
});
