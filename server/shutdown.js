// ============================================================================
// server/shutdown.js —— PC 大厅【退出游戏】的本机来源校验
//
// 项目是「浏览器前端 + Node 服务端」结构：真正的游戏进程就是
// `node server/server.js`（一键启动脚本拉起的就是它）。网页 JS 受浏览器
// 沙箱限制，无法直接结束操作系统进程，因此由前端请求 POST /api/shutdown，
// 服务端自行优雅退出，才算真正「关闭游戏进程」。
//
// 安全约束：只有从「运行服务端的这台电脑」发出的请求才允许退出。
// 手机 / 朋友通过局域网 IP 连进来时 remoteAddress 是对方的局域网地址，
// 会被拒绝，避免远端误触把房主的游戏关掉（也契合「仅电脑端大厅可见」）。
// ============================================================================
import os from 'node:os';

/** 归一化 IP：去掉 IPv4-mapped 前缀、方括号、IPv6 区域标识、统一小写。 */
export function normalizeIp(addr = '') {
  let a = String(addr || '').trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') === -1 ? undefined : a.indexOf(']'));
  if (a.includes('%')) a = a.split('%')[0];
  return a;
}

/** 本机所有网卡地址集合（含回环）。用本机 LAN IP 打开大厅也允许退出。 */
const LOCAL_IPS = (() => {
  const set = new Set(['127.0.0.1', '::1']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        const ip = normalizeIp(iface.address);
        if (ip) set.add(ip);
      }
    }
  } catch { /* 极端环境下只读回环即可 */ }
  return set;
})();

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/**
 * 判断 HTTP / Socket.io 请求是否来自本机（运行游戏服务端的 PC）。
 * @param {{socket?:{remoteAddress?:string}, connection?:{remoteAddress?:string},
 *          ip?:string, handshake?:{address?:string}}} req
 */
export function isLocalRequest(req) {
  const raw = req?.socket?.remoteAddress
    || req?.connection?.remoteAddress
    || req?.ip
    || req?.handshake?.address
    || '';
  const addr = normalizeIp(raw);
  if (!addr) return false;
  if (LOOPBACK.has(addr)) return true;
  return LOCAL_IPS.has(addr);
}

/** 供测试与日志使用：当前识别到的本机地址（不含回环）。 */
export function localAddresses() {
  return [...LOCAL_IPS].filter((ip) => !LOOPBACK.has(ip));
}
