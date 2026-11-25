// ============================================================================
// v6：一键云部署端到端测试
//   * PORT 环境变量 / 0.0.0.0 监听 / 单端口同时提供页面与 Socket.io
//   * /api/network 按请求 Host 自动识别公网域名（X-Forwarded-* 反代头）
//   * CORS origin '*' 预检与跨域 Socket.io 连接
//   * 云端 /api/shutdown 不结束进程（避免打断所有在线玩家）
//   * 未开启云端时保持原有局域网行为
// 运行：node --test tests/cloud.test.js
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

async function startServer(extraEnv = {}) {
  const PORT = 3500 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    // NODE_ENV=test 避免「production + 动态端口」的云端兜底误触发
    env: { ...process.env, PORT: String(PORT), CARD_SEED: '3', NODE_ENV: 'test', ...extraEnv },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) })).ok) break; } catch (_) {}
    await sleep(80);
  }
  assert.ok(Date.now() - start < 10000, '服务端应在平台注入的 PORT 上正常启动');
  return { child, BASE, PORT };
}

test('v6：PORT 环境变量 + 单端口托管前端 + 云模式信息 + CORS', async (t) => {
  const { child, BASE, PORT } = await startServer({ CLOUD_DEPLOY: '1' });
  t.after(() => { try { child.kill('SIGTERM'); } catch (_) {} });

  // 1) 平台动态分配端口确实生效，健康检查暴露部署模式
  const h = await (await fetch(`${BASE}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.port, PORT, 'health 返回的端口应等于注入的 PORT');
  assert.equal(h.mode, 'cloud');
  assert.equal(h.cloud, true);
  assert.equal(typeof h.dist, 'boolean');

  // 2) 反向代理头还原公网域名（云端二维码 / 邀请链接依据）
  const net = await (await fetch(`${BASE}/api/network`, {
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cube-tactics.zeabur.app' },
  })).json();
  assert.equal(net.mode, 'cloud');
  assert.equal(net.publicUrl, 'https://cube-tactics.zeabur.app');
  assert.equal(net.localUrl, 'https://cube-tactics.zeabur.app');
  assert.equal(net.lanUsable, true, '云端公网域名一律可分享');

  // 3) 同一个 Node 进程同时托管前端页面与静态资源
  const hasDist = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
  const home = await fetch(`${BASE}/`);
  if (hasDist) {
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /id="root"/, '首页应返回打包后的 index.html');
    const js = html.match(/src="([^"]+\.js)"/)?.[1];
    const css = html.match(/href="([^"]+\.css)"/)?.[1];
    assert.ok(js && css, 'index.html 应引用构建后的 JS/CSS');
    for (const asset of [js, css]) {
      const r = await fetch(`${BASE}${asset}`);
      assert.equal(r.status, 200, `静态资源 ${asset} 应由同一进程提供`);
    }
    // SPA 回退：任意前端路径都返回 index.html
    const spa = await fetch(`${BASE}/room/1234`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /id="root"/);
  } else {
    assert.equal(home.status, 503, '未构建时应给出明确诊断页而不是白屏');
    assert.match(await home.text(), /前端尚未构建/);
  }

  // 4) API / Socket.io 路径不被 SPA 回退吞掉
  const api404 = await fetch(`${BASE}/api/does-not-exist`);
  assert.equal(api404.status, 404);
  assert.equal((await api404.json()).ok, false);
  const sio = await fetch(`${BASE}/socket.io/`);
  assert.notEqual(sio.status, 200, '/socket.io 不应返回 index.html');

  // 5) CORS：预检放行任意来源
  const preflight = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://another-site.example', 'Access-Control-Request-Method': 'GET' },
  });
  assert.ok(preflight.status < 400, 'CORS 预检应成功');
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  // 6) 带外部 Origin 的 Socket.io 客户端也能连上（同源前端 + 跨域兼容）
  const client = io(BASE, {
    transports: ['websocket'], forceNew: true, reconnection: false,
    extraHeaders: { Origin: 'https://another-site.example' },
  });
  t.after(() => client.close());
  await waitFor(() => client.connected, '跨域 Socket.io 客户端连接');
  assert.equal(client.connected, true);
});

test('v6：云端退出只退页面、不结束进程', async (t) => {
  const { child, BASE } = await startServer({ CLOUD_DEPLOY: '1' });
  t.after(() => { try { child.kill('SIGTERM'); } catch (_) {} });

  const res = await fetch(`${BASE}/api/shutdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.cloud, true, '云端返回 cloud:true，前端据此只关闭本标签页');

  await sleep(1200);
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
  assert.equal(health.status, 200, '服务必须继续运行，不能杀掉容器进程');
  assert.equal(child.exitCode, null, '进程不能退出（否则平台会重启并打断所有玩家）');
});

test('v6：未开启云端时保持局域网行为，公网 Host 自动识别为云端', async (t) => {
  const { child, BASE, PORT } = await startServer({ CLOUD_DEPLOY: '' });
  t.after(() => { try { child.kill('SIGTERM'); } catch (_) {} });

  const h = await (await fetch(`${BASE}/health`)).json();
  assert.equal(h.mode, 'lan');
  assert.equal(h.cloud, false);
  assert.equal(h.port, PORT);

  const lan = await (await fetch(`${BASE}/api/network`)).json();
  assert.equal(lan.mode, 'lan', '本机 Host 应仍是局域网模式');
  assert.equal(lan.localUrl, `http://localhost:${PORT}`);

  // 关键：即使忘记设置 CLOUD_DEPLOY，只要是通过公网域名访问，也自动按云端处理
  const viaDomain = await (await fetch(`${BASE}/api/network`, {
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cube-tactics.onrender.com' },
  })).json();
  assert.equal(viaDomain.mode, 'cloud');
  assert.equal(viaDomain.publicUrl, 'https://cube-tactics.onrender.com');

  const viaDomainShutdown = await (await fetch(`${BASE}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'cube-tactics.onrender.com',
    },
    body: '{}',
  })).json();
  assert.equal(viaDomainShutdown.cloud, true, '公网访问不会误杀进程');
  await sleep(500);
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
  assert.equal(child.exitCode, null);
});
