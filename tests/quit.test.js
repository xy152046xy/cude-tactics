// ============================================================================
// v5：PC 大厅【退出游戏】测试
//   1) 本机来源校验（loopback / IPv4-mapped / 本机网卡允许，远端拒绝）
//   2) 端到端：POST /api/shutdown -> 广播 serverShutdown -> 游戏进程退出
// 运行：node --test tests/quit.test.js
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { normalizeIp, isLocalRequest, localAddresses } from '../server/shutdown.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

test('v5：normalizeIp 归一化常见地址格式', () => {
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(normalizeIp('FE80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp('[::1]'), '::1');
  assert.equal(normalizeIp(''), '');
});

test('v5：isLocalRequest 只允许运行游戏的这台电脑退出', () => {
  assert.equal(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLocalRequest({ connection: { remoteAddress: '127.0.0.1' } }), true);
  // 本机任一网卡 IP（用本机 LAN IP 打开大厅）也允许
  for (const ip of localAddresses()) {
    assert.equal(isLocalRequest({ socket: { remoteAddress: ip } }), true, `本机网卡 ${ip} 应允许`);
  }
  // 203.0.113.0/24 是文档保留网段，不可能是本机地址
  assert.equal(isLocalRequest({ socket: { remoteAddress: '203.0.113.7' } }), false, '局域网/公网远端必须拒绝');
  assert.equal(isLocalRequest({ socket: { remoteAddress: '198.51.100.23' } }), false);
  assert.equal(isLocalRequest({}), false, '拿不到来源地址时拒绝');
  assert.equal(isLocalRequest(null), false);
});

test('v5：POST /api/shutdown 广播退出事件并真正结束游戏进程', async (t) => {
  const PORT = 3400 + Math.floor(Math.random() * 300);
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), CARD_SEED: '3' },
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } });

  // 等待服务端就绪
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { if ((await fetch(`${BASE_URL}/health`)).ok) break; } catch { /* 还没起来 */ }
    await sleep(80);
  }
  assert.ok(Date.now() - start < 10000, '服务端应能正常启动（原有功能未受影响）');

  // 模拟一个已连接的客户端（可以是手机/观战者），验证退出前会收到广播
  const client = io(BASE_URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const shutdowns = [];
  client.on('serverShutdown', (p) => shutdowns.push(p));
  t.after(() => client.close());
  await waitFor(() => client.connected, '客户端连接');

  const res = await fetch(`${BASE_URL}/api/shutdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.message, /游戏进程/);

  await waitFor(() => shutdowns.length >= 1, '收到 serverShutdown 广播');
  assert.equal(shutdowns.length, 1, '幂等：一次退出只广播一次');
  assert.match(String(shutdowns[0]?.reason || ''), /关闭游戏|退出/);

  // 进程必须真的结束，而不是只返回了一个 200
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, '游戏进程退出', 6000);
  assert.equal(child.exitCode, 0, '正常退出码应为 0');

  // 退出后 /health 不再响应
  let healthGone = false;
  try { await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(800) }); }
  catch { healthGone = true; }
  assert.equal(healthGone, true, '游戏进程关闭后健康检查应不可达');
});
