// ============================================================================
// 端到端联机冒烟测试：自动拉起服务端 + 两个 Socket.io 客户端，
// 验证房间、权威校验、按玩家视野下发、回合交替、召唤与防作弊。
// 运行：node --test tests/lan.test.js
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { io } from 'socket.io-client';
import { createInitialState } from '../shared/rules.js';
import { CARD_POOL, INITIAL_HAND_SIZE, HAND_LIMIT } from '../shared/constants.js';
import { EMOTE_IDS, EMOTE_CD_MS } from '../shared/emotes.js';

const PORT = 3100 + Math.floor(Math.random() * 300);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}
async function waitServer() {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(80);
  }
  throw new Error('服务端启动超时');
}
function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack 超时：${event}`)), 5000);
    socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}
function makeClient() {
  const socket = io(BASE_URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const states = [], errors = [], rooms = [], emotes = [], cooldowns = [];
  socket.on('state', (v) => states.push(v));
  socket.on('error', (m) => errors.push(String(m)));
  socket.on('room', (r) => rooms.push(r));
  socket.on('emote', (e) => emotes.push(e));       // 迭代 9：表情旁路广播
  socket.on('emoteCooldown', (c) => cooldowns.push(c));
  return { socket, states, errors, rooms, emotes, cooldowns };
}
const last = (arr) => arr[arr.length - 1];

test('联机：创建/加入房间、权威校验、服务端迷雾、回合交替、召唤', async (t) => {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // 固定发牌种子：让手牌断言可复现（生产默认随机）
    env: { ...process.env, PORT: String(PORT), CARD_SEED: '3' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGTERM'));
  await waitServer();

  const A = makeClient(), B = makeClient();
  t.after(() => { A.socket.close(); B.socket.close(); });
  await Promise.all([
    waitFor(() => A.socket.connected, 'A 连接'),
    waitFor(() => B.socket.connected, 'B 连接'),
  ]);

  // --- 房间机制 ---
  const ca = await ack(A.socket, 'createRoom', { clientId: 'test-client-A' });
  assert.equal(ca.ok, true);
  assert.equal(ca.side, 'A');
  assert.match(ca.code, /^\d{4}$/, '房间号为 4 位数字');
  const cb = await ack(B.socket, 'joinRoom', { code: ca.code, clientId: 'test-client-B' });
  assert.equal(cb.ok, true);
  assert.equal(cb.side, 'B');
  const C = makeClient();
  t.after(() => C.socket.close());
  await waitFor(() => C.socket.connected, 'C 连接');
  const cc = await ack(C.socket, 'joinRoom', { code: ca.code, clientId: 'intruder' });
  assert.equal(cc.ok, false, '房间满后第三人不可加入');

  await waitFor(() => A.states.length >= 1 && B.states.length >= 1, '双方收到选人状态');

  // --- 迭代 5：进房先进入盲选阶段，双方确认前棋盘为空、不泄露对方阵容 ---
  const pa = last(A.states), pb = last(B.states);
  assert.equal(pa.phase, 'picking', 'B 进房后进入选人阶段');
  assert.equal(pb.phase, 'picking');
  assert.equal(pa.status, 'picking');
  assert.equal(pa.units.length, 0, '选人完成前棋盘不含任何单位');
  assert.equal(pa.hand.length, 0, '选人阶段不发手牌');
  assert.equal(pa.hints, null);
  assert.equal(pa.pick.size, 3);
  assert.equal(pa.pick.pool.length, 6, '6 个职业卡由服务端下发');
  assert.equal(pa.pick.myConfirmed, false);
  assert.equal(pa.pick.opponentConfirmed, false);
  assert.ok(pa.pick.pool.every((c) => c.name && c.icon && c.color && c.hp > 0 && c.desc));

  // A 逐张点选 -> 服务端权威保存；B 只应看到「对手是否已确认」
  const lineupA = ['warrior', 'archer', 'mage'];
  A.socket.emit('setPicks', { classes: lineupA.slice(0, 2) });
  await waitFor(() => last(A.states).pick?.myPicks.length === 2, 'A 的部分选人被保存');
  const midA = last(A.states), midB = last(B.states);
  assert.deepEqual(midA.pick.myPicks, ['warrior', 'archer']);
  assert.equal(midB.pick.myPicks.length, 0, 'B 看不到 A 选了什么');
  assert.equal('picks' in midB, false, '服务端私有 picks 从不进入网络包');
  assert.equal(midB.pick.opponentConfirmed, false, '未确认前对手状态为未确认');

  A.socket.emit('setPicks', { classes: lineupA });
  await waitFor(() => last(A.states).pick?.myPicks.length === 3, 'A 选满 3 个');
  A.socket.emit('confirmPicks', { classes: lineupA });
  await waitFor(() => last(A.states).pick?.myConfirmed === true, 'A 确认阵容');
  const confA = last(A.states), confB = last(B.states);
  assert.equal(confA.phase, 'picking', '仅一方确认不能开局');
  assert.equal(confB.pick.opponentConfirmed, true, 'B 只看到「对手已确认」');
  assert.equal(confB.pick.myPicks.length, 0, 'B 依然看不到 A 的阵容');
  assert.equal(confB.units.length, 0, '未双确认前棋盘仍为空');
  assert.equal('picks' in confB, false);
  assert.ok(!JSON.stringify(confB).includes('"lineup"'), 'B 的网络包不含任何阵容数据');

  // B 确认 -> 双方确认，服务端按各自阵容只生成 1 个首发，其余 2 个进预备池
  B.socket.emit('confirmPicks', { classes: ['warrior', 'archer', 'mage'] });
  await waitFor(() => last(A.states).phase === 'playing' && last(B.states).phase === 'playing', '双方确认后开局');
  const startA = last(A.states);
  assert.equal(startA.units.length, 1, 'A 开局只生成 1 个首发单位');
  assert.deepEqual(startA.units.map((u) => u.class), ['warrior'], '首发为阵容第 0 个职业');
  assert.deepEqual(startA.units[0].pos, { x: 0, y: 1, z: 0 }, 'A 首发固定 (0,1,0)');
  assert.equal(startA.reserve, 2, '另外 2 个预选单位在预备召唤池');
  assert.equal(startA.reservePool.length, 2, '下发预备池条目供前端点选召唤');
  assert.equal(startA.pick, undefined, '进入对局后不再下发选人数据');

  const va = last(A.states), vb = last(B.states);
  // 后续断言按「对局阶段的广播次数」计数：只保留开局那一条 state，清掉选人阶段的累计
  A.states.splice(0, A.states.length - 1);
  B.states.splice(0, B.states.length - 1);
  A.errors.length = 0; B.errors.length = 0;
  assert.equal(va.mySide, 'A');
  assert.equal(vb.mySide, 'B');
  assert.equal(va.currentPlayer, 'A', '玩家 A 固定先手');
  assert.equal(va.ap, 5, 'AP 面板 5/5');
  assert.equal(va.apMax, 5);
  assert.equal(va.units.length, 1, '初始只看到自己的 1 个首发单位');
  assert.equal(vb.units.length, 1);
  assert.equal(va.units.filter((u) => u.owner === 'B').length, 0, '敌方单位被迷雾隐藏');
  assert.equal(vb.units.filter((u) => u.owner === 'A').length, 0);
  assert.ok(va.hints.summonPoints.length > 0,
    '最终版：己方初始层任意合法空格都能召唤，开局即有多个高亮格');
  assert.ok(va.hints.summonPoints.every((p) => p.z === 0), 'A 的召唤点全在底层 z=0');
  assert.equal(va.stairs.length, 6, '服务端下发 6 个严格坐标配对的楼梯');
  assert.equal(va.topTrapOpen, false, '顶层陷阱默认关闭');
  // 最终版 PlayerView 新字段：黑雾 / 牌库 / 弃牌堆 / 观战标记
  assert.ok(Array.isArray(va.smokeCells) && va.smokeCells.length === 0);
  assert.equal(typeof va.deckCount, 'number');
  assert.equal(va.discardCount, 0);
  assert.equal(va.homeLayer, 0);
  assert.equal(vb.homeLayer, 2);
  assert.equal(va.spectating, false);
  assert.ok(va.hints.cardCells instanceof Object, 'hints 下发黄格合法目标');

  // --- 迭代 8：通用手牌隔离（A/B 各自只看到自己的 5 张通用牌） ---
  assert.equal(INITIAL_HAND_SIZE, 5, '迭代 8：开局发 5 张通用牌');
  assert.equal(va.hand.length, INITIAL_HAND_SIZE, 'A 收到 5 张手牌');
  assert.equal(vb.hand.length, INITIAL_HAND_SIZE, 'B 收到 5 张手牌');
  assert.ok(va.hand.every((c) => CARD_POOL.includes(c.type)), 'A 手牌全是通用牌（无专属卡）');
  assert.ok(vb.hand.every((c) => CARD_POOL.includes(c.type)), 'B 手牌全是通用牌（无专属卡）');
  assert.equal('hands' in va, false, '网络包不含服务端私有 hands');
  assert.equal('hands' in vb, false);
  // 带引号精确匹配：5 张时卡号会到 c10，裸 includes('c1') 会误命中 c10
  const aCardIds0 = va.hand.map((c) => c.id), bCardIds0 = vb.hand.map((c) => c.id);
  assert.ok(bCardIds0.every((id) => !JSON.stringify(va).includes(`"${id}"`)), 'A 的网络包不含 B 的任何手牌 id');
  assert.ok(aCardIds0.every((id) => !JSON.stringify(vb).includes(`"${id}"`)), 'B 的网络包不含 A 的任何手牌 id');
  assert.ok(va.hand.every((c) => c.name && c.desc && c.cost === 1), '手牌含名称/说明/消耗');
  assert.equal(vb.hints, null, '非行动方不下发 hints（也就没有对方 cardTargets）');

  // --- A 移动：服务端校验并广播；B 侧事件坐标被抹除 ---
  A.socket.emit('move', { unitId: 'A-warrior', targetPos: { x: 0, y: 0, z: 0 } });
  await waitFor(() => A.states.length >= 2 && B.states.length >= 2, '移动后广播');
  const a2 = last(A.states), b2 = last(B.states);
  assert.equal(a2.ap, 4);
  assert.deepEqual(a2.units.find((u) => u.id === 'A-warrior').pos, { x: 0, y: 0, z: 0 });
  assert.equal(b2.units.filter((u) => u.owner === 'A').length, 0, 'A 的单位对 B 仍隐藏');
  assert.ok(b2.events.length >= 1);
  assert.equal(b2.events[0].hidden, true, '隐藏事件被标记');
  assert.equal(b2.events[0].pos, null, '隐藏事件坐标不下发');

  // --- 非法操作：服务端拒绝并回传原因 ---
  A.socket.emit('move', { unitId: 'A-warrior', targetPos: { x: 2, y: 2, z: 0 } });
  await waitFor(() => A.errors.length >= 1, '非法移动回传错误');
  assert.match(last(A.errors), /正交|楼梯/);

  A.socket.emit('move', { unitId: 'B-warrior', targetPos: { x: 0, y: 0, z: 2 } });
  await waitFor(() => A.errors.length >= 2, '伪造对方单位被拒绝');
  assert.match(last(A.errors), /不能操作对方单位/);

  A.socket.emit('attack', { attackerId: 'A-warrior', targetId: 'B-warrior' });
  await waitFor(() => A.errors.length >= 3, '隐藏目标不可攻击');
  assert.match(last(A.errors), /目标不可见/);

  // --- 回合交替 + 非行动方操作屏蔽 ---
  A.socket.emit('endTurn', {});
  await waitFor(() => last(A.states).currentPlayer === 'B', '切换到 B');
  assert.equal(last(A.states).ap, 5, '新回合 AP 重置为 5');
  assert.equal(last(A.states).hints, null, '非行动方不收到操作提示');
  A.socket.emit('move', { unitId: 'A-warrior', targetPos: { x: 1, y: 0, z: 0 } });
  await waitFor(() => A.errors.length >= 4, '非行动方操作被拒绝');
  assert.match(last(A.errors), /不是你的回合/);
  assert.equal(last(B.states).hints !== null, true, '行动方收到 hints');

  // --- B 行动 -> 回到 A -> 从预备池点选名额召唤（2 AP） ---
  B.socket.emit('endTurn', {});
  await waitFor(() => last(A.states).currentPlayer === 'A', '切回 A');
  assert.equal(last(A.states).ap, 5, '换回 A 时 AP 立刻重置为 5');
  assert.ok(last(A.states).hints.summonPoints.some((p) => p.x === 1 && p.y === 0 && p.z === 0),
    '(1,0,0) 是合法召唤点之一');
  assert.ok(last(A.states).hints.summonPoints.length > 1,
    '最终版：己方初始层任意合法空格都能召唤（不再是唯一单点）');
  // 召唤入口仅限预备池：取一个未使用名额的 key 提交
  const mageSlot = last(A.states).reservePool.find((e) => e.cls === 'mage');
  assert.ok(mageSlot && !mageSlot.used, 'mage 在预备池中且尚未召唤');
  A.socket.emit('summon', { reserveKey: mageSlot.key, pos: { x: 1, y: 0, z: 0 } });
  await waitFor(() => last(A.states).units.length === 2, '召唤出第 2 个单位');
  const a5 = last(A.states);
  assert.equal(a5.reserve, 1, '消耗 1 个名额，还剩 1 个');
  assert.equal(a5.ap, 3, '5 AP - 召唤 2 AP = 3 AP');
  assert.equal(a5.reservePool.find((e) => e.key === mageSlot.key).used, true, '名额标记【已召唤】并锁死');
  assert.equal(a5.units.find((u) => u.class === 'mage' && u.pos.x === 1 && u.pos.y === 0).hasAttacked, false,
    '召唤单位本回合可直接行动');
  // 已召唤名额重复召唤 / 名单外职业，服务端一律拒绝
  A.socket.emit('summon', { reserveKey: mageSlot.key, pos: { x: 0, y: 0, z: 0 } });
  await waitFor(() => A.errors.length >= 5, '重复召唤被拒绝');
  assert.match(last(A.errors), /预选|尚未出场|每回合|预备池/);
  const errBaseSummon = A.errors.length;
  A.socket.emit('summon', { cls: 'guardian', pos: { x: 0, y: 0, z: 0 } });
  await waitFor(() => A.errors.length > errBaseSummon, '名单外单位被拒绝');
  assert.match(last(A.errors), /预选|尚未出场/);

  // --- 迭代 6：攀升器仅 A 可布置；进入后额外 1 AP 传送到中层中心 ---
  // 召唤改为 2 AP 后本回合余额不足，先走完一轮让 AP 重置再单独验证攀升器
  A.socket.emit('endTurn', {});
  await waitFor(() => last(A.states).currentPlayer === 'B', '切到 B');
  B.socket.emit('endTurn', {});
  await waitFor(() => last(A.states).currentPlayer === 'A' && last(A.states).ap === 5,
    '回到 A 且 AP 重置为 5');
  assert.equal(last(A.states).inventory.climber, 1, 'A 持有 1 个攀升器');
  assert.equal(last(B.states).inventory.climber, 0, 'B 没有攀升器库存（服务端权威）');
  A.socket.emit('place', { type: 'climber', pos: { x: 1, y: 1, z: 0 } });
  await waitFor(() => last(A.states).devices.some((d) => d.type === 'climber'), 'A 放置攀升器');
  A.socket.emit('move', { unitId: 'A-mage', targetPos: { x: 1, y: 1, z: 0 } });
  await waitFor(() => last(A.states).units.find((u) => u.id === 'A-mage')?.pos.z === 1,
    '攀升器把 A-mage 传送到中层');
  assert.deepEqual(last(A.states).units.find((u) => u.id === 'A-mage').pos,
    { x: 1, y: 1, z: 1 }, '传送到中层中心 (1,1,1)');
  assert.equal(last(A.states).ap, 2, '5 - 布置 1 - 移动 1 - 攀升 1 = 2 AP');

  // --- 投降 ---
  A.socket.emit('surrender', {});
  await waitFor(() => last(A.states).phase === 'gameover', '投降后结束');
  assert.equal(last(A.states).winner, 'B');
  assert.equal(last(B.states).winner, 'B');

  // --- 重新开始 ---
  B.socket.emit('restart', {});
  await waitFor(() => last(A.states).phase === 'playing' && last(A.states).ap === 5, '重开成功');
  assert.equal(last(A.states).currentPlayer, 'A');

  // --- 迭代 4：技能牌联机同步 + 手牌隔离（重开后是全新一局） ---
  const rA = last(A.states), rB = last(B.states);
  const predict = createInitialState(3);
  assert.deepEqual(rA.hand.map((c) => c.type), predict.hands.A.map((c) => c.type),
    '重开后发牌与规则层一致（固定种子可复现）');
  assert.deepEqual(rB.hand.map((c) => c.type), predict.hands.B.map((c) => c.type));
  const myIds = rA.hand.map((c) => c.id), oppIds = rB.hand.map((c) => c.id);
  assert.ok(oppIds.every((id) => !JSON.stringify(rA).includes(`"${id}"`)), '重开后 A 包仍不含 B 手牌');
  assert.ok(myIds.every((id) => !JSON.stringify(rB).includes(`"${id}"`)), '重开后 B 包仍不含 A 手牌');

  // 1) 伪造：A 拿 B 的 cardId 打牌 -> 服务端按绑定身份拒绝
  let errBase = A.errors.length;
  A.socket.emit('playCard', { cardId: oppIds[0] });
  await waitFor(() => A.errors.length > errBase, '伪造对方手牌被拒');
  assert.match(last(A.errors), /手牌中不存在/);

  // 2) 合法：A 打出自己的【战术洞察】（无需目标）
  const insight = rA.hand.find((c) => c.type === 'insight');
  assert.ok(insight, '固定种子下 A 含洞察牌');
  A.socket.emit('playCard', { cardId: insight.id });
  await waitFor(() => last(A.states).hand.length === INITIAL_HAND_SIZE - 1 && last(A.states).ap === 6,
    '打牌成功后广播');
  const acA = last(A.states), acB = last(B.states);
  assert.equal(acA.ap, 6, '5 - 1 + 2 = 6');
  assert.equal(acA.hand.length, INITIAL_HAND_SIZE - 1, 'A 手牌 -1（5 -> 4）');
  assert.equal(acB.hand.length, INITIAL_HAND_SIZE, 'B 手牌不变（仍 5 张）');
  assert.ok(!JSON.stringify(acB).includes(`"${insight.id}"`), 'B 包不含 A 打出的卡 id');
  assert.equal(acA.perTurnFlags.skillCardUsed, true, 'A 本回合已打技能牌');
  assert.equal(acB.perTurnFlags.skillCardUsed, false, 'B 的每回合标志只反映 B 自己（仍为 false）');
  // 技能牌限额用尽，但装置牌不受影响（canPlay 只看 AP 与手牌）
  assert.equal(acA.hints.canPlaySkill, false, '技能牌限额已用完');
  assert.equal(acA.hints.canPlay, true, '装置牌仍可继续打出');

  // 3) 技能牌每回合最多 1 张（第二张技能牌被拒）
  errBase = A.errors.length;
  A.socket.emit('playCard', { cardId: myIds.find((id) => id !== insight.id) });
  await waitFor(() => A.errors.length > errBase, '第二张技能牌被拒');
  assert.match(last(A.errors), /技能牌/);

  // 4) 回合切换：迭代 8 开局即满 5 张，新回合玩家满手不再抽；非行动方手牌不变、标志重置
  A.socket.emit('endTurn', {});
  await waitFor(() => last(A.states).currentPlayer === 'B', '回合切换到 B');
  assert.equal(last(B.states).hand.length, HAND_LIMIT, 'B 满手 5 张，新回合不抽牌');
  assert.equal(last(A.states).hand.length, INITIAL_HAND_SIZE - 1, 'A 手牌仍为打出后的 4 张');
  assert.equal(last(A.states).perTurnFlags.skillCardUsed, false, '换回合时重置技能牌已使用标记');
  assert.ok(last(B.states).hand.every((c) => CARD_POOL.includes(c.type)), '后续仍只会出现通用牌');
  assert.ok(last(B.states).hand.every((c) => !JSON.stringify(last(A.states)).includes(`"${c.id}"`)),
    'A 依旧看不到 B 的任何一张手牌');

  // --- 迭代 6：顶层陷阱联机开关（B 在顶层，规则全部在服务端校验） ---
  const bv = last(B.states);
  const topUnit = bv.units.find((u) => u.owner === 'B' && u.pos.z === 2);
  assert.ok(topUnit, 'B 有顶层单位可开关顶层陷阱');
  assert.equal(bv.topTrapOpen, false, '顶层陷阱默认关闭');
  assert.equal(bv.stairs.length, 6, 'B 的视图同样下发严格坐标配对的楼梯集合');
  B.socket.emit('toggleTrap', { unitId: topUnit.id, z: 2 });
  await waitFor(() => last(B.states).topTrapOpen === true, '顶层陷阱被打开');
  assert.equal(last(A.states).topTrapOpen, true, 'A 端同步到顶层陷阱状态');
  assert.ok(last(B.states).logs.at(-1).text.includes('顶层'), '日志标注顶层陷阱');
  // 中 / 顶层共用「每方每回合 1 次」
  const errBeforeToggle = B.errors.length;
  B.socket.emit('toggleTrap', { unitId: topUnit.id, z: 1 });
  await waitFor(() => B.errors.length > errBeforeToggle, '同一回合第二次开关被拒');
  assert.match(last(B.errors), /每回合最多/);

  // --- 迭代 9：局内表情（独立旁路事件，不改 GameState / 不消耗 AP / 不触发 state 广播） ---
  // 前端展示常量与服务端白名单必须逐项对齐
  const uiSrc = fs.readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
  const feIds = [...uiSrc.matchAll(/\{ id: '([a-z]+)',\s*emoji:/g)].map((m) => m[1]);
  assert.deepEqual(feIds, EMOTE_IDS, '前端 EMOTES 与服务端 EMOTE_IDS 完全一致');
  assert.equal(EMOTE_IDS.length, 6, '共 6 个预设表情');
  assert.equal(EMOTE_CD_MS, 3000, '服务端 CD 为 3 秒');

  // 观战者：只读订阅房间频道，不占席位、不影响 state
  const W = makeClient();
  t.after(() => W.socket.close());
  await waitFor(() => W.socket.connected, '观战者连接');
  const specAck = await ack(W.socket, 'spectate', { code: ca.code, side: 'A' });
  assert.equal(specAck.ok, true, '观战者订阅成功');
  assert.equal(specAck.side, 'A', '服务端回传所观战的阵营');
  // 最终版任务一：观战者必须继承所观战玩家的迷雾视野
  await waitFor(() => W.states.length > 0, '观战者收到带迷雾的 state');
  const specView = last(W.states);
  assert.equal(specView.spectating, true, '观战视图标记为只读');
  assert.equal(specView.mySide, 'A', '观战者视图按 A 生成');
  assert.deepEqual(specView.visionCells, last(A.states).visionCells,
    '观战者继承玩家 A 的迷雾视野（下发同一批可见格）');
  assert.deepEqual(specView.units, last(A.states).units, '观战者看到与 A 相同的单位');
  await sleep(60);

  const eBase = { A: A.emotes.length, B: B.emotes.length, W: W.emotes.length };
  const stateLenBefore = A.states.length;
  const apBefore = last(A.states).ap;

  // 1) A 发合法表情 -> A / B / 观战者三方都收到，字段由服务端权威下发
  A.socket.emit('emote', { id: 'laugh' });
  await waitFor(() => A.emotes.length > eBase.A && B.emotes.length > eBase.B
    && W.emotes.length > eBase.W, '表情广播给对手与观战者');
  const em = last(A.emotes);
  assert.equal(em.side, 'A');
  assert.equal(em.id, 'laugh');
  assert.ok(em.emoji && em.label && em.color && em.serverTs, 'emoji/label/color/serverTs 齐全');
  assert.deepEqual(
    [last(B.emotes).id, last(W.emotes).id], ['laugh', 'laugh'], '对手与观战者收到同一表情',
  );

  // 2) 发表情是纯旁路：不产生任何 state 广播、不消耗 AP
  await sleep(120);
  assert.equal(A.states.length, stateLenBefore, '发表情不触发 GameState 广播');
  assert.equal(last(A.states).ap, apBefore, '发表情不消耗 AP');

  // 3) 3 秒内重复发送无效：不广播，且回发送方 emoteCooldown
  const cntAfterFirst = A.emotes.length;
  A.socket.emit('emote', { id: 'cry' });
  await waitFor(() => A.cooldowns.length >= 1, '收到 CD 拒绝回执');
  const cd = last(A.cooldowns);
  assert.ok(cd.remainingMs > 0 && cd.remainingMs <= EMOTE_CD_MS, 'remainingMs 在 (0, 3000]');
  assert.equal(A.emotes.length, cntAfterFirst, 'CD 内重复发送不广播');
  assert.equal(W.emotes.length, eBase.W + 1, '观战者也没收到被拦截的表情');

  // 4) 非法 id 被白名单拦截，不广播也不回 CD
  const cntBeforeEvil = A.emotes.length;
  const cdBeforeEvil = A.cooldowns.length;
  A.socket.emit('emote', { id: '__not_allowed__' });
  await sleep(120);
  assert.equal(A.emotes.length, cntBeforeEvil, '非法 id 不广播');
  assert.equal(A.cooldowns.length, cdBeforeEvil, '非法 id 不进入 CD 判定');

  // 5) CD 按阵营隔离：B 立刻发送应成功（A 仍在冷却）
  B.socket.emit('emote', { id: 'like' });
  await waitFor(() => B.emotes.length > eBase.B + 1, 'B 的 CD 与 A 相互独立');
  assert.equal(last(B.emotes).side, 'B');
  assert.equal(last(W.emotes).id, 'like', '观战者同样收到 B 的表情');

  // 6) 冷却到期后 A 可再次发送
  await sleep(cd.remainingMs + 80);
  const cntBeforeRecover = A.emotes.length;
  A.socket.emit('emote', { id: 'think' });
  await waitFor(() => A.emotes.length > cntBeforeRecover, '3 秒 CD 到期后可再次发送');
  assert.equal(last(A.emotes).id, 'think');
});
