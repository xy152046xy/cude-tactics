// ============================================================================
// 真机验收：CDP 驱动无头 Chromium（A 端 UI）+ Node socket.io-client（B 端）
// 覆盖：盲选 BP、6 职业棋子、手牌 3:4 实体卡、攀升器、顶层陷阱、
//       显式楼梯集合、防重叠数据、1920/1366 响应式、运行时错误，
//       迭代 8 纯被动验收（开局 5 张通用牌、无任何专属卡 / 主动技能按钮），
//       迭代 9 表情包（6 宫格 / 气泡 / 3 秒 CD / 观战者广播）、音效解锁与静音、
//       战斗打击感（事件映射 / 顿帧时钟 / 震动 / 白闪 / 棋子纯白闪烁），
//       迭代 10 移动端横屏（竖屏遮罩 / 70% 棋盘 / 侧栏 / 横向手牌 / 44px 热区 / :active）。
// 前置：node server/server.js（3000，托管 dist） + Chromium --remote-debugging-port=9333
// 运行：node tools/visual-check.mjs
// ============================================================================
import { WebSocket } from 'ws';
import { io } from 'socket.io-client';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/workspace/shots';
const BASE = 'http://127.0.0.1:3000';
fs.mkdirSync(OUT, { recursive: true });

// ---------- CDP ----------
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 0;
const pend = new Map();
const runtimeErrors = [];
ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') runtimeErrors.push('EXC ' + String(m.params.exceptionDetails?.text || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    runtimeErrors.push('CONSOLE ' + m.params.args?.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) console.log('EVAL-EXC', String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 220));
  return r?.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const waitEl = async (sel, ms = 15000) => {
  for (let i = 0; i < ms / 150; i++) { if (await ev(`!!document.querySelector('${sel}')`)) return true; await sleep(150); }
  return false;
};
const btn = (text, sel = 'button') => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);
const clickCell = async (x, y, z) => ev(`window.__clickCell(${x},${y},${z})`);
const last = (arr) => arr[arr.length - 1];
const waitFor = async (fn, label, ms = 8000) => {
  for (let i = 0; i < ms / 120; i++) { if (fn()) return true; await sleep(120); }
  console.log('等待超时:', label);
  return false;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });

// ---------- A 打开页面并建房（3000 单端口：页面 + Socket.io 同源） ----------
// 同一标签页会用 sessionStorage 里的房间信息直接续连上一轮对局，
// 因此先清会话再带唯一 pid 重新进入，保证每次都是干净的大厅。
const PID = `verify-A-${Date.now()}`;
await send('Page.navigate', { url: `${BASE}/?pid=${PID}` });
await sleep(1000);
await ev(`sessionStorage.clear(); location.replace('/?pid=${PID}')`);
console.log('大厅:', await waitEl('.lobby-card .primary.big', 20000));
await sleep(400);

// ========== 阶段 0：极简联机（服务端网络信息 / 大厅局域网面板 / 主页二维码） ==========
const netInfo = await (await fetch(`${BASE}/api/network`)).json();
console.log('服务端网络信息:', JSON.stringify({
  lanUrl: netInfo.lanUrl, lanUsable: netInfo.lanUsable,
  port: netInfo.port, addresses: netInfo.lanAddresses?.length,
}));
await sleep(500);
const lobbyNet = await ev(`(()=>{
  const qr=document.querySelector('.lan-qr svg');
  return {
    panel: !!document.querySelector('.lan-panel'),
    url: document.querySelector('.lan-url')?.textContent?.trim(),
    hasQr: !!qr, qrPaths: qr?.querySelectorAll('path').length || 0,
    tag: document.querySelector('.lan-tag')?.textContent?.trim(),
    tipsMentionsScripts: !!document.querySelector('.tips')?.textContent?.includes('一键启动'),
  };
})()`);
console.log('大厅局域网面板:', JSON.stringify(lobbyNet));
await shot('00-lobby-lan');

await ev(`document.querySelector('.lobby-card .primary.big').click()`);
let code = null;
for (let i = 0; i < 60; i++) { code = await ev(`(document.querySelector('.room-code')||{}).textContent||null`); if (code) break; await sleep(150); }
console.log('房间', code);

// 创建成功后应自动弹出「带房间号」的二维码
await waitEl('.qr-modal', 8000);
const invite = await ev(`(()=>{
  const m=document.querySelector('.qr-modal');
  return {
    overlay: !!document.querySelector('.qr-overlay'),
    room: m?.querySelector('.qr-room-code')?.textContent?.trim(),
    hasQr: !!m?.querySelector('.qr-box svg'),
    url: m?.querySelector('.qr-url')?.textContent?.trim(),
    hasCopy: [...(m?.querySelectorAll('button')||[])].some(b=>b.textContent.includes('复制邀请链接')),
  };
})()`);
console.log('邀请二维码:', JSON.stringify({
  ...invite, urlHasRoom: !!invite.url?.includes(`?room=${code}`),
}));
await shot('00b-invite-qr');
// 关掉弹窗，否则遮罩会拦截后续 A 端点击
await btn('关闭', '.qr-actions button');

// ---------- B 加入（Node 客户端） ----------
const B = io(BASE, { transports: ['websocket'], forceNew: true });
await new Promise((res, rej) => { B.on('connect', res); B.on('connect_error', rej); });
const bst = [], berr = [];
B.on('state', (v) => bst.push(v));
B.on('error', (m) => berr.push(String(m)));
console.log('B 加入:', JSON.stringify(await new Promise((res) => B.emit('joinRoom', { code, clientId: 'verify-B' }, res))));

// ========== 阶段 1：盲选 BP ==========
console.log('选人界面:', await waitEl('.pick-grid .class-card'));
await sleep(450);
const pickInfo = await ev(`(()=>{
  const cards=[...document.querySelectorAll('.class-card')];
  const g=document.querySelector('.pick-grid');
  return {
    count: cards.length,
    names: cards.map(c=>c.querySelector('.cc-name')?.textContent),
    themes: cards.map(c=>getComputedStyle(c).getPropertyValue('--theme').trim()),
    ratio: cards[0] ? +(cards[0].getBoundingClientRect().width/cards[0].getBoundingClientRect().height).toFixed(2) : null,
    cols: g?getComputedStyle(g).gridTemplateColumns.split(' ').length:0,
    status: document.querySelector('.pf-status')?.textContent?.trim(),
  };
})()`);
console.log('职业卡信息:', JSON.stringify(pickInfo));
await shot('01-pick');

// A 盲选 3 个新职业：刺客 / 牧师 / 盾卫（索引 3/4/5）
for (const i of [3, 4, 5]) { await ev(`document.querySelectorAll('.class-card')[${i}].click()`); await sleep(130); }
console.log('选中 3 个后:', JSON.stringify(await ev(`(()=>{
  const cards=[...document.querySelectorAll('.class-card')];
  return {picked:cards.filter(c=>c.classList.contains('picked')).length,
    slots:document.querySelectorAll('.pf-slot.on').length,
    confirmDisabled:document.querySelector('.pick-btn')?.disabled};
})()`)));
await shot('02-pick-selected');

console.log('确认阵容:', await btn('确认阵容', '.pick-btn'));
await sleep(300);
await shot('03-pick-confirmed');
const bPick = bst.filter((v) => v.phase === 'picking').at(-1);
console.log('B 端盲选隔离:', JSON.stringify({
  myPicks: bPick?.pick?.myPicks,
  opponentConfirmed: bPick?.pick?.opponentConfirmed,
  units: bPick?.units?.length,
  hasLineup: JSON.stringify(bPick || {}).includes('"lineup"'),
}));

// B 确认 -> 开局
B.emit('confirmPicks', { classes: ['warrior', 'archer', 'mage'] });
console.log('进入棋盘:', await waitEl('.board-canvas'));
await sleep(700);
await ev(`window.__clickCell=(x,y,z)=>{const c=document.querySelector('.board-canvas');const r=c.getBoundingClientRect();const sx=r.width/972,sy=r.height/378;c.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+(24+z*318+(x+0.5)*96)*sx,clientY:r.top+(66+(y+0.5)*96)*sy}));return true;};true`);

// ========== 阶段 2：对局 UI 与迭代 6 视觉重构 ==========
const uiInfo = await ev(`(()=>{
  const pieces=[...document.querySelectorAll('.piece')];
  const cards=[...document.querySelectorAll('.hand-card')];
  const c0=cards[0], disc=document.querySelector('.piece-disc'), ab=document.querySelector('.action-btn');
  const cs=(e,p)=>e?getComputedStyle(e)[p]:null;
  return {
    pieces: pieces.length,
    classes: pieces.map(p=>p.querySelector('.piece-cls')?.textContent),
    pieceBorderWidth: cs(disc,'borderTopWidth'),
    pieceRing: cs(disc,'borderTopColor'),
    pieceGradient: cs(disc,'backgroundImage')?.slice(0,60),
    hpGradient: cs(document.querySelector('.piece-hpbar i'),'backgroundImage')?.slice(0,50),
    cardCount: cards.length,
    cardNames: cards.map(c=>c.querySelector('.hc-name')?.textContent?.trim()),
    allGeneric: cards.every(c=>['强力击退','紧急包扎','战术洞察'].includes(c.querySelector('.hc-name')?.textContent?.trim())),
    hasExclusiveCard: cards.some(c=>/奥术新星|钢铁壁垒|坚不可摧/.test(c.textContent||'')),
    noSkillButton: ![...document.querySelectorAll('button')].some(b=>/奥术新星|钢铁壁垒|坚不可摧|释放技能|施放技能/.test(b.textContent||'')),
    cardRatio: c0?+(c0.getBoundingClientRect().width/c0.getBoundingClientRect().height).toFixed(2):null,
    costRadius: cs(c0?.querySelector('.hc-cost'),'borderRadius'),
    costText: c0?.querySelector('.hc-cost')?.textContent,
    btnBorder: cs(ab,'borderTopColor'),
    tabs: [...document.querySelectorAll('.action-btn .ab-label')].map(x=>x.textContent),
    climberInv: [...document.querySelectorAll('.inv-item')].find(x=>x.textContent.includes('攀升器'))?.textContent?.trim(),
    legend: [...document.querySelectorAll('.legend-item')].map(x=>x.textContent.trim()),
  };
})()`);
console.log('迭代 6 视觉/结构:', JSON.stringify(uiInfo));
console.log('迭代 8 纯被动验收:', JSON.stringify({
  cardCount: uiInfo.cardCount, expected: 5,
  allGeneric: uiInfo.allGeneric, cardNames: uiInfo.cardNames,
  hasExclusiveCard: uiInfo.hasExclusiveCard, noSkillButton: uiInfo.noSkillButton,
  ok: uiInfo.cardCount === 5 && uiInfo.allGeneric && !uiInfo.hasExclusiveCard && uiInfo.noSkillButton,
}));
const liveB = last(bst);
console.log('服务端地形字段(B):', JSON.stringify({
  stairs: liveB?.stairs?.length,
  topTrapOpen: liveB?.topTrapOpen,
  trapCells: liveB?.trapCells?.length,
  climberStockB: liveB?.inventory?.climber,
  summonPoints: liveB?.hints ? undefined : 'B 非行动方无 hints',
}));
await shot('04-board');

// 打出一张通用牌 -> 卡牌飞出缩小动画。
// 牌序无关：5 张手牌由服务端发牌种子决定，本局不一定包含「战术洞察」（唯一无目标牌）。
// 没有洞察牌时跳过打牌动画验收并显式说明，绝不作为失败条件；牌库只含通用牌由 uiInfo.allGeneric 断言。
const hasInsight = await ev(`[...document.querySelectorAll('.hand-card')].some(c=>c.textContent.includes('战术洞察'))`);
if (hasInsight) {
  console.log('点【战术洞察】:', await btn('战术洞察', '.hand-card'));
  await sleep(110);
  console.log('飞出动画元素:', await ev(`!!document.querySelector('.card-ghost')`));
  await sleep(650);
  console.log('打牌后 AP:', await ev(`document.querySelector('.ap-value')?.textContent`));
} else {
  console.log('点【战术洞察】: 跳过（本局 5 张通用牌无此牌，发牌顺序不固定；非功能问题）');
}
await shot('05-card-fly');

// 选中牧师 -> 攻击按钮变「治疗」
console.log('选牧师:', await btn('牧师', '.roster-item'));
await sleep(260);
console.log('牧师上下文:', await ev(`JSON.stringify({
  labels:[...document.querySelectorAll('.action-btn .ab-label')].map(x=>x.textContent),
  healTargets:document.querySelectorAll('.piece.targetable.heal').length,
})`));
await shot('06-priest-context');

// 放置草丛（明牌、半透明绿色纹理）
console.log('点放置:', await btn('放置', '.action-btn'));
await sleep(200);
console.log('展开工具:', await ev(`[...document.querySelectorAll('.tool-btn .tb-label')].map(x=>x.textContent).join(',')`));
console.log('选草丛:', await btn('布置草丛', '.tool-btn'));
await sleep(160);
await clickCell(1, 2, 0);
await sleep(420);
console.log('草丛库存:', await ev(`[...document.querySelectorAll('.inv-item')].find(x=>x.textContent.includes('草丛'))?.textContent?.trim()`));
await shot('07-device-placed');

// ========== 阶段 3：攀升器（仅 A）放置并传送到中层 ==========
// 先结束回合再切回来？不需要：本回合 placed 已用（草丛），需换回合重置。
// 用 B 结束回合 -> 回到 A，placed 标志重置，再放攀升器。
await btn('结束回合', '.hud-actions button');
await sleep(350);
console.log('切到 B 回合:', await ev(`document.querySelector('.hud-sub')?.textContent`));
B.emit('endTurn', {});
await waitFor(() => last(bst)?.currentPlayer === 'A', '回到 A 回合');
await sleep(350);
console.log('回到 A 回合, AP:', await ev(`document.querySelector('.ap-value')?.textContent`));

console.log('点放置:', await btn('放置', '.action-btn'));
await sleep(180);
console.log('选攀升器:', await btn('布置攀升器', '.tool-btn'));
await sleep(160);
await clickCell(1, 1, 0);   // 底层中心放攀升器
await sleep(420);
console.log('攀升器已放置:', await ev(`[...document.querySelectorAll('.inv-item')].find(x=>x.textContent.includes('攀升器'))?.textContent?.trim()`));
await shot('08-climber-placed');

// 切回移动，选 A 刺客 (0,1,0) 后走进攀升器 -> 传送到 (1,1,1)
console.log('点移动:', await btn('移动', '.action-btn'));
await sleep(160);
await clickCell(0, 1, 0);   // 选中己方单位
await sleep(160);
await clickCell(1, 1, 0);   // 进入攀升器格
await sleep(600);
const climbed = await ev(`(()=>{
  const p=[...document.querySelectorAll('.piece')].find(x=>x.querySelector('.piece-cls')?.textContent==='刺');
  if(!p) return null;
  return {top:p.style.top,left:p.style.left,cls:p.className};
})()`);
console.log('攀升后棋子:', JSON.stringify(climbed));
console.log('攀升日志:', await ev(`[...document.querySelectorAll('.log-line')].map(x=>x.textContent).find(t=>t.includes('攀升'))||'（无）'`));
await shot('09-climber-teleport');

// ========== 阶段 4：顶层陷阱（B 开关，服务端权威） ==========
await btn('结束回合', '.hud-actions button');   // 切到 B
await waitFor(() => last(bst)?.currentPlayer === 'B', 'B 回合');
await sleep(300);
B.emit('toggleTrap', { unitId: 'B-warrior', z: 2 });
await waitFor(() => last(bst)?.topTrapOpen === true, '顶层陷阱打开');
await sleep(400);
console.log('顶层陷阱状态(B):', JSON.stringify({
  topTrapOpen: last(bst)?.topTrapOpen,
  centerTrapOpen: last(bst)?.centerTrapOpen,
  log: last(bst)?.logs?.at(-1)?.text,
}));
// A 端是「非行动方」，但地形事件是公开的：它应收到对手开关顶层陷阱的日志
const syncA = await ev(`(()=>{
  const logs=[...document.querySelectorAll('.log-line')].map(x=>x.textContent.trim());
  return { hasCanvas: !!document.querySelector('.board-canvas'),
           log: logs.find(t=>t.includes('顶层陷阱')) || null };
})()`);
console.log('A 端同步顶层陷阱:', JSON.stringify(syncA));
await shot('10-top-trap-open');

// ========== 阶段 5：1920×1080 响应式 ==========
async function layoutAt(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
  return ev(`(()=>{
    const r=(s)=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)];};
    const a=document.querySelector('.board-wrap')?.getBoundingClientRect(),h=document.querySelector('.hand-zone')?.getBoundingClientRect();
    const s=document.querySelector('.side')?.getBoundingClientRect();
    const ce=document.querySelector('.hand-card'),c=ce?.getBoundingClientRect();
    return {board:r('.board-wrap'),hand:r('.hand-zone'),side:r('.side'),
      boardHandOverlap:a&&h?a.bottom>h.top+1:null,
      boardSideOverlap:a&&s?a.right>s.left+1:null,
      handBottom:Math.round(h?.bottom||0), handOverflow:!!h&&h.bottom>window.innerHeight+1,
      docW:document.documentElement.scrollWidth,winW:window.innerWidth,
      docH:document.documentElement.scrollHeight,winH:window.innerHeight,
      // 手牌是扇形（带 rotate），getBoundingClientRect 会被旋转外扩；比例用 offsetWidth/Height 量
    cardW:ce?.offsetWidth||0,cardH:ce?.offsetHeight||0,
      cardRatio:ce?+(ce.offsetWidth/ce.offsetHeight).toFixed(2):null,
      // 手牌是扇形旋转（5 张时最外 ±9°，包围盒底角外扩约 12px），超出 18px 才算真被裁掉
      cardClipped:!!(c&&h)&&c.bottom>h.bottom+18};
  })()`);
}
const layout1920 = await layoutAt(1920, 1080);
console.log('1920x1080 布局:', JSON.stringify(layout1920));
await shot('13-responsive-1920');

// ========== 阶段 6：1366×768 响应式 ==========
const layout1366 = await layoutAt(1366, 768);
console.log('1366x768 布局:', JSON.stringify(layout1366));
await shot('14-responsive-1366');

// 恢复大视口截最终图
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await shot('15-final');

// ========== 阶段 7：扫码链接 ?room= 自动填入 / 自动加入 ==========
// 用 Node 客户端另开一个独立房间，避免干扰上面的主对局；再用第二个浏览器标签模拟朋友的手机。
const SCAN_HOST = io(BASE, { transports: ['websocket'], forceNew: true });
await new Promise((res) => SCAN_HOST.on('connect', res));
const SCAN_TAG = Date.now().toString(36);
const scanAck = await new Promise((res) => SCAN_HOST.emit('createRoom', { clientId: `scan-host-${SCAN_TAG}` }, res));
const scanCode = scanAck?.code;
console.log('扫码测试房间:', scanCode);

async function openGuest(url) {
  const created = await send('Target.createTarget', { url });
  const targetId = created?.result?.targetId;
  if (!targetId) throw new Error('Target.createTarget 失败');
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list2 = await (await fetch('http://127.0.0.1:9333/json/list')).json();
    const t = list2.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
    if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    await sleep(150);
  }
  if (!wsUrl) throw new Error('无法获取新标签页调试地址');
  const w = new WebSocket(wsUrl);
  await new Promise((r) => w.once('open', r));
  let n = 0; const p = new Map();
  w.on('message', (b) => {
    const m = JSON.parse(b.toString());
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  });
  const s2 = (method, params = {}) => new Promise((res) => {
    const i = ++n; p.set(i, res); w.send(JSON.stringify({ id: i, method, params }));
  });
  const e2 = async (expr) => (await s2('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  }))?.result?.result?.value;
  await s2('Runtime.enable');
  return { targetId, w, s2, e2 };
}
const guestState = (g) => g.e2(`(()=>({
  pick: !!document.querySelector('.pick-screen'),
  wait: !!document.querySelector('.waiting-card'),
  lobby: !!document.querySelector('.lobby-card'),
  hint: document.querySelector('.scan-hint')?.textContent?.trim() || null,
  inputValue: document.querySelector('#room-code')?.value || null,
  error: document.querySelector('.err-text')?.textContent?.trim() || null,
}))()`);

// 7a. 无效房间号 0000：验证「自动填入」并给出明确错误，不静默失败
const gFill = await openGuest(`${BASE}/?room=0000&pid=scan-fill`);
let fill = null;
for (let i = 0; i < 50; i++) {
  fill = await guestState(gFill);
  if (fill?.inputValue === '0000' && fill?.error) break;
  await sleep(200);
}
console.log('扫码自动填入(0000):', JSON.stringify(fill));
await send('Target.closeTarget', { targetId: gFill.targetId });
gFill.w.close();

// 7b. 真实房间号：验证「自动加入」并直接进入选人界面
const gJoin = await openGuest(`${BASE}/?room=${scanCode}&pid=scan-guest-${SCAN_TAG}`);
let joined = null;
for (let i = 0; i < 60; i++) {
  joined = await guestState(gJoin);
  if (joined?.pick || joined?.wait) break;
  await sleep(200);
}
console.log('扫码自动加入:', JSON.stringify(joined));
await send('Target.closeTarget', { targetId: gJoin.targetId });
gJoin.w.close();
SCAN_HOST.close();

// ========== 阶段 8：迭代 9 表情系统 / 音效 / 战斗打击感 ==========
const emoteSeen = [], cdSeen = [];
B.on('emote', (e) => emoteSeen.push(e));
B.on('emoteCooldown', (c) => cdSeen.push(c));

// 观战者只读订阅，验证「广播给观战者」
const SPEC = io(BASE, { transports: ['websocket'], forceNew: true });
await new Promise((res) => SPEC.on('connect', res));
const specEmotes = [];
SPEC.on('emote', (e) => specEmotes.push(e));
await new Promise((res) => SPEC.emit('spectate', { code }, res));

// 8a. 右上角控件就位 + 音频/打击感调试句柄
const gfReady = await ev(`(()=>({
  emoteBtn: !!document.querySelector('.emote-btn'),
  soundBtn: !!document.querySelector('.sound-btn'),
  flashOverlay: !!document.querySelector('.fx-flash-overlay'),
  audioHandle: !!window.__cubeAudio,
  feelHandle: !!window.__cubeFeel,
  audioState: window.__cubeAudio?.state,
}))()`);
console.log('迭代 9 控件/句柄:', JSON.stringify(gfReady));

// 8b. 用真实鼠标事件点击「表情」按钮：验证浏览器自动播放解锁 + 弹出 6 宫格面板
const ebRect = await ev(`(()=>{const b=document.querySelector('.emote-btn');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
if (ebRect) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ebRect.x, y: ebRect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ebRect.x, y: ebRect.y, button: 'left', clickCount: 1 });
}
await sleep(250);
const panelInfo = await ev(`(()=>{
  const items=[...document.querySelectorAll('.ep-item')];
  return {
    open: !!document.querySelector('.emote-panel'),
    count: items.length,
    labels: items.map(x=>x.querySelector('.ep-label')?.textContent),
    audioUnlocked: window.__cubeAudio?.unlocked,
    audioState: window.__cubeAudio?.state,
  };
})()`);
console.log('表情面板:', JSON.stringify(panelInfo));
await shot('16-emote-panel');

// 8c. 点「大笑」发送 -> A 端弹气泡、B 端与观战者收到广播；随后立即检查 3 秒 CD
console.log('点大笑发表情:', await btn('大笑', '.ep-item'));
await waitFor(() => emoteSeen.length >= 1, 'B 收到表情广播', 4000);
await waitFor(() => specEmotes.length >= 1, '观战者收到表情广播', 4000);
let bubbleReady = false;
for (let i = 0; i < 30; i++) {
  if (await ev(`!!document.querySelector('.emote-bubble')`)) { bubbleReady = true; break; }
  await sleep(120);
}
if (!bubbleReady) console.log('等待超时: A 端气泡');
const bubble = await ev(`(()=>{const b=document.querySelector('.emote-bubble');if(!b)return null;const s=getComputedStyle(b);return {
  sideLeft: b.classList.contains('side-a'), sideRight: b.classList.contains('side-b'),
  label: b.querySelector('.eb-label')?.textContent, who: b.querySelector('.eb-who')?.textContent,
  animation: s.animationName, duration: s.animationDuration,
}})()`);
console.log('表情气泡(A 端):', JSON.stringify(bubble));
console.log('广播一致性:', JSON.stringify({
  B: emoteSeen[0] && { side: emoteSeen[0].side, id: emoteSeen[0].id },
  spectator: specEmotes[0] && { side: specEmotes[0].side, id: specEmotes[0].id },
}));
// CD：3 秒内表情按钮应带冷却徽标；重开面板后 6 项禁用。
// React 的 setState 是异步的：不能在同一同步 evaluate 里 click 后立刻读 .ep-item，
// 否则读到的是重渲染前的旧 DOM（面板刚关闭时 items 为空 -> 误报 false）。
// 因此单独触发点击、等待一帧重渲染，再断言；且截图放到断言之后，缩短 3 秒窗口内的耗时。
const badgeInfo = await ev(`(()=>{const badge=document.querySelector('.emote-btn .ib-cd');return {badge:!!badge,badgeText:badge?.textContent}})()`);
await ev(`document.querySelector('.emote-btn')?.click()`);   // 打开面板（异步 setState）
await sleep(180);                                           // 等 React 重渲染出 6 个 .ep-item
const cdUi = await ev(`(()=>{const items=[...document.querySelectorAll('.ep-item')];return {
  count: items.length,
  panelDisabled: items.length === 6 && items.every(x => x.disabled),
}})()`);
console.log('3 秒 CD(本地):', JSON.stringify({
  ...badgeInfo, ...cdUi, ok: !!badgeInfo?.badge && !!cdUi?.panelDisabled,
}));
await shot('17-emote-bubble');   // 同时拍下气泡 + 冷却中面板
// 服务端权威 CD：让 B 连续发两次，第二次应被拒并回 emoteCooldown
const bEmoteBase = emoteSeen.length, bCdBase = cdSeen.length;
B.emit('emote', { id: 'cry' });
await sleep(180);
B.emit('emote', { id: 'angry' });
await sleep(220);
console.log('3 秒 CD(服务端):', JSON.stringify({
  broadcasts: emoteSeen.length - bEmoteBase, cooldowns: cdSeen.length - bCdBase,
  // B 首发表情广播 1 次；3 秒内第二次不广播，改回 1 次 emoteCooldown 给发送方
  ok: emoteSeen.length - bEmoteBase === 1 && cdSeen.length - bCdBase === 1,
}));
await ev(`document.querySelector('.emote-btn')?.click()`);   // 收起面板

// 8d. 静音开关：全局关闭 / 开启音效
const mute0 = await ev(`window.__cubeAudio?.muted`);
await btn('音效', '.sound-btn');
await sleep(120);
const mute1 = await ev(`({muted: window.__cubeAudio?.muted, pressed: document.querySelector('.sound-btn')?.getAttribute('aria-pressed')})`);
await btn('已静音', '.sound-btn');
await sleep(120);
const mute2 = await ev(`window.__cubeAudio?.muted`);
console.log('静音开关:', JSON.stringify({ before: mute0, on: mute1, off: mute2,
  ok: mute0 === false && mute1.muted === true && mute1.pressed === 'true' && mute2 === false }));

// 8e. 打击感：事件 -> 反馈映射（纯函数，覆盖验收标准 4 类场景）
// 真实服务端一次命中会同时下发 attack + damage，故补上 damage 让 hitStop / shake 生效。
const feelMap = await ev(`(()=>{const a=window.__cubeFeel.analyze;return {
  warrior: a([{kind:'attack', class:'warrior'}, {kind:'damage', source:'attack', unitId:'t1'}]),
  archer: a([{kind:'attack', class:'archer'}, {kind:'damage', source:'attack', unitId:'t1'}]),
  mage: a([{kind:'attack', class:'mage'}, {kind:'damage', source:'splash', unitId:'t1'}]),
  heavy: a([{kind:'collision'}, {kind:'crateBreak'}, {kind:'damage', source:'fall', unitId:'t2'}]),
  hidden: a([{kind:'attack', class:'warrior', hidden:true}]),
  hitStopMs: window.__cubeFeel.hitStopMs,
  clock: window.__cubeFeel.testClock?.(),
}})()`);
console.log('打击感映射:', JSON.stringify(feelMap));
console.log('顿帧时钟自检:', JSON.stringify({
  ...feelMap.clock,
  ok: !!feelMap.clock?.frozen && !!feelMap.clock?.heldSteady && !!feelMap.clock?.noRewind,
}));

// 8f. 打击感 DOM 接线：simulate 一次重击+白闪+顿帧，检查 class / 动画已挂上
const feelDom = await ev(`(()=>{
  const hit=document.querySelector('.piece.flashing .piece-disc');
  window.__cubeFeel.simulate({shake:'heavy', fullFlash:true, hitStop:true, sounds:[]});
  const stage=document.querySelector('.stage');
  const ov=document.querySelector('.fx-flash-overlay');
  const sh=stage?getComputedStyle(stage):null;
  return {
    shakeClass: stage?.className.includes('fx-shake-heavy'),
    shakeAnim: sh?.animationName,
    flashClass: ov?.classList.contains('fx-flash-on'),
    hitstopClass: document.querySelector('.game')?.classList.contains('fx-hitstop'),
    audioPlayCount: window.__cubeAudio?.playCount,
  };
})()`);
console.log('打击感 DOM 接线:', JSON.stringify(feelDom));
// 受击白闪：手动给一个棋子加 flashing，读伪元素动画名
const whiteFlash = await ev(`(()=>{const p=document.querySelector('.piece');if(!p)return null;p.classList.add('flashing');
  const d=p.querySelector('.piece-disc'); if(!d)return null;
  const a=getComputedStyle(d,'::after');const r={anim:a.animationName,dur:a.animationDuration,bg:a.backgroundColor};
  p.classList.remove('flashing');return r;})()`);
console.log('受击纯白闪烁:', JSON.stringify(whiteFlash));
await shot('18-gamefeel');

// ========== 阶段 9：迭代 10 移动端横屏引导与触控布局 ==========
// 复用上面已建立的对局（A 在 CDP 页面，B 是 socket 客户端），只切换 CDP 视口。
// 9a. 手机竖屏：半透明遮罩全屏覆盖 + 提示文案 + 棋盘被暂时隐藏
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(450);
const portrait = await ev(`(()=>{
  const g=document.querySelector('.portrait-gate');
  const s=g?getComputedStyle(g):null;
  const stage=document.querySelector('.stage');
  const st=stage?getComputedStyle(stage):null;
  return {
    gateShown: !!g && s.display!=='none',
    gatePosition: s?.position, gateZ: s?.zIndex,
    text: !!g?.textContent?.includes('请旋转手机至横屏以获得最佳战棋体验'),
    heading: g?.querySelector('h2')?.textContent,
    cta: !!g?.querySelector('.landscape-cta'),
    ctaText: g?.querySelector('.lc-text')?.textContent,
    skip: !!g?.querySelector('.pg-skip'),
    boardHidden: st?.visibility==='hidden',
    bodyBlocked: document.body.classList.contains('portrait-blocked'),
    bodyOverflow: getComputedStyle(document.body).overflow,
    capability: typeof window.__cubeOrientation==='function' ? window.__cubeOrientation() : null,
    vw: innerWidth, vh: innerHeight,
  };
})()`);
console.log('竖屏遮罩:', JSON.stringify(portrait));
console.log('竖屏验收:', JSON.stringify({ ok: portrait.gateShown && portrait.text && portrait.cta &&
  portrait.boardHidden && portrait.bodyBlocked && portrait.bodyOverflow === 'hidden' &&
  portrait.capability?.portrait === true && portrait.capability?.requestFullscreen === true }));
await shot('19-mobile-portrait');

// 9b. 点遮罩里的 CTA：验证全屏/方向能力调用不抛错，并给出降级提示
const ctaRect = await ev(`(()=>{const b=document.querySelector('.portrait-gate .landscape-cta');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
if (ctaRect) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ctaRect.x, y: ctaRect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ctaRect.x, y: ctaRect.y, button: 'left', clickCount: 1 });
}
await sleep(320);
const ctaResult = await ev(`(()=>({
  hint: document.querySelector('.portrait-gate .lc-hint')?.textContent || null,
  fullscreenElement: !!document.fullscreenElement,
  orientation: screen.orientation?.type || 'unknown',
  audioUnlocked: window.__cubeAudio?.unlocked,
}))()`);
console.log('全屏横屏按钮:', JSON.stringify(ctaResult));
await ev(`document.fullscreenElement ? document.exitFullscreen().catch(()=>{}) : null`);
await sleep(160);

// 9c. 手机横屏：极简状态栏 / 70% 棋盘 / 右侧栏 / 底部可横滑手牌 / 44px 热区
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await sleep(480);
const land = await ev(`(()=>{
  const q=(s)=>document.querySelector(s);
  const cs=(e,p)=>e?getComputedStyle(e)[p]:null;
  const r=(e)=>e?e.getBoundingClientRect():null;
  const gate=q('.portrait-gate'), game=q('.game'), stage=q('.stage');
  const board=q('.board-wrap'), side=q('.side'), hand=q('.hand-zone'), list=q('.hand-list');
  const hud=q('.hud'), hudLeft=q('.hud-left'), strip=q('.strip');
  const mActions=q('.mobile-actions'), mEnd=q('.mobile-endturn');
  const canvas=q('.board-canvas'), firstCard=q('.hand-card');
  const ab=q('.action-btn'), tb=q('.tool-btn'), ib=q('.icon-btn'), ri=q('.roster-item');
  const bR=r(board), sR=r(side), hR=r(hand), cR=r(canvas);
  const box=(e)=>e?{w:+r(e).width.toFixed(1),h:+r(e).height.toFixed(1)}:null;
  return {
    vw: innerWidth, vh: innerHeight, docH: document.documentElement.scrollHeight,
    gateHidden: !gate || cs(gate,'display')==='none',
    gameDisplay: cs(game,'display'), gameOverflow: cs(game,'overflow'),
    gameUserSelect: cs(game,'userSelect'),
    bodyTouchAction: cs(document.body,'touchAction'),
    hudLeftHidden: !hudLeft || cs(hudLeft,'display')==='none',
    stripHidden: !strip || cs(strip,'display')==='none',
    hudH: +(r(hud)?.height||0).toFixed(1),
    stageCols: cs(stage,'gridTemplateColumns'),
    boardWidthPct: bR?+(bR.width/innerWidth*100).toFixed(1):null,
    sideWidthPct: sR?+(sR.width/innerWidth*100).toFixed(1):null,
    sideOnRight: !!(bR&&sR&&sR.left>=bR.right-2),
    sideDisplay: cs(side,'display'),
    handBelowBoard: !!(bR&&hR&&hR.top>=bR.bottom-2),
    handOverflowX: cs(list,'overflowX'),
    handScrollable: !!list && list.scrollWidth > list.clientWidth + 4,
    handSnap: cs(list,'scrollSnapType'),
    handTouchAction: cs(list,'touchAction'),
    cardCount: document.querySelectorAll('.hand-card').length,
    cardBox: box(firstCard),
    canvasFits: !!(bR&&cR&&cR.bottom<=bR.bottom+2),
    docNoScroll: document.documentElement.scrollHeight <= innerHeight+2,
    mobileActionsShown: !!mActions && cs(mActions,'display')!=='none',
    endBtn: box(mEnd),
    hot: { actionBtn:box(ab), toolBtn:box(tb), iconBtn:box(ib), roster:box(ri), card:box(firstCard) },
    pieceDiscW: +(r(q('.piece-disc'))?.width||0).toFixed(1),
    legendHidden: !q('.legend') || cs(q('.legend'),'display')==='none',
  };
})()`);
console.log('横屏布局:', JSON.stringify(land));
const hotOk = Object.values(land.hot).every((v) => v && v.h >= 44 && v.w >= 44);
console.log('横屏验收:', JSON.stringify({ ok:
  land.gateHidden && land.gameDisplay === 'flex' && land.gameOverflow === 'hidden' &&
  land.hudLeftHidden && land.stripHidden && land.boardWidthPct >= 62 && land.sideOnRight &&
  land.handBelowBoard && land.handOverflowX === 'auto' && land.handScrollable &&
  land.canvasFits && land.mobileActionsShown && land.docNoScroll && hotOk &&
  land.bodyTouchAction === 'manipulation' && land.gameUserSelect === 'none' }));
await shot('20-mobile-landscape');

// 9d. :active 按压反馈：用 CDP 强制 :active 伪类（比鼠标事件更可靠），读缩放 / 提亮 / 高亮描边
await send('DOM.enable');
await send('CSS.enable');
const domRoot = await send('DOM.getDocument', { depth: 1 });
const btnNode = await send('DOM.querySelector', { nodeId: domRoot.result.root.nodeId, selector: '.action-btn' });
let press = null;
if (btnNode?.result?.nodeId) {
  await send('CSS.forcePseudoState', { nodeId: btnNode.result.nodeId, forcedPseudoClasses: ['active'] });
  await sleep(140);
  press = await ev(`(()=>{const b=document.querySelector('.action-btn');if(!b)return null;const s=getComputedStyle(b);return {transform:s.transform,filter:s.filter,border:s.borderTopColor}})()`);
  await send('CSS.forcePseudoState', { nodeId: btnNode.result.nodeId, forcedPseudoClasses: [] });
}
console.log('触控按压(:active):', JSON.stringify(press));
console.log('触控按压验收:', JSON.stringify({ ok: !!press && press.transform !== 'none' && press.filter !== 'none' }));

// 9e. 恢复桌面视口，确认遮罩消失且棋盘恢复可见
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
await sleep(320);
const restored = await ev(`(()=>({
  gateHidden: getComputedStyle(document.querySelector('.portrait-gate')).display==='none',
  boardVisible: getComputedStyle(document.querySelector('.stage')).visibility!=='hidden',
}))()`);
console.log('恢复桌面:', JSON.stringify(restored));

SPEC.close();
console.log('B 端错误:', berr.length ? berr.slice(-3) : '无');
console.log('=== 运行时错误 ===', runtimeErrors.length ? runtimeErrors.slice(0, 8) : '无');
ws.close(); B.close(); process.exit(0);
