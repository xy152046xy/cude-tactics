// ============================================================================
// 规则层单元测试：node --test tests/rules.test.js
// 覆盖：数值、楼梯、射程/溅射、击退碰撞、木箱、中心陷阱、召唤、视野、胜负
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../shared/rules.js';
import {
  CLASSES, AP_PER_TURN, MAX_HALF_TURNS, CARD_POOL, CARDS,
  ARROW_TRAP_DAMAGE, INITIAL_HAND_SIZE, DRAW_PER_TURN, HAND_LIMIT,
  CLASS_POOL, PICK_SIZE, INITIAL_POSITIONS, TRAP_DAMAGE, COLLISION_DAMAGE,
  STAIRS, SUMMON_POINTS, TOP_TRAP, CLIMB_TARGET, CLIMB_AP_COST,
  GUARDIAN_FLAT_REDUCTION, GUARDIAN_MIN_DAMAGE,
  FIRST_SPAWN, SUMMON_COST, DRAW_CARD_COST, SMOKE_DURATION,
  DEVICE_CARDS, A_ONLY_CARDS, HOME_LAYER,
  SKILL_CARDS, isDeviceCardType, isSkillCardType,
} from '../shared/constants.js';

const U = (id, owner, cls, pos, hp) => ({
  id, owner, class: cls,
  hp: hp ?? CLASSES[cls].hp, maxHp: CLASSES[cls].hp,
  pos: { ...pos }, hasAttacked: false, alive: true, inGrass: false,
});
const D = (id, owner, type, pos) => ({ id, owner, type, hp: 1, pos: { ...pos } });
// 构造「双方都还有存活单位」的真实对局态，避免 checkWin 在单方场景下立即结束游戏
const S = (...units) => {
  const s = R.createInitialState();
  const list = [...units];
  if (!list.some((u) => u.owner === 'A' && u.alive)) {
    list.push(U('dummy-A', 'A', 'mage', { x: 2, y: 2, z: 0 }));
  }
  if (!list.some((u) => u.owner === 'B' && u.alive)) {
    list.push(U('dummy-B', 'B', 'mage', { x: 2, y: 2, z: 2 }));
  }
  s.units = list;
  s.devices = [];
  return s;
};
const at = (s, id) => s.units.find((u) => u.id === id);
const dev = (s, id) => s.devices.find((d) => d.id === id);
const ids = (list) => list.map((x) => `${x.x},${x.y},${x.z}`);

// ---------------------------------------------------------------------------
test('1. 初始状态：A 先手、AP=5、只 1 首发/方、预备池 2', () => {
  const s = R.createInitialState();
  assert.equal(s.currentPlayer, 'A');
  assert.equal(s.ap, AP_PER_TURN, '开局 AP 立刻重置为 5（绝不出现 AP=0）');
  assert.equal(AP_PER_TURN, 5);
  assert.equal(s.turn, 1);
  assert.equal(s.units.length, 2, '开局只生成 2 个首发单位（每方 1 个）');
  assert.deepEqual(s.units.find((u) => u.owner === 'A').pos, { ...FIRST_SPAWN.A });
  assert.deepEqual(s.units.find((u) => u.owner === 'B').pos, { ...FIRST_SPAWN.B });
  assert.equal(s.reserve.A, 2, '其余 2 个预选单位进入预备召唤池');
  assert.equal(s.reservePool.A.length, 2);
  assert.equal(s.reservePool.B.length, 2);
  assert.ok(s.reservePool.A.every((e) => !e.used));
  assert.equal(s.inventory.A.crate, 3);
  assert.equal(s.inventory.A.portal, 1);
  assert.equal(s.centerTrapOpen, false);
  assert.equal(s.phase, 'playing');
});

test('2. 移动：每格 1 AP、楼梯上下 1 AP、不可斜移/越界（迭代 6 新楼梯集合）', () => {
  // 迭代 6：底层 y=0 一侧两角已取消楼梯，改用仍为楼梯的 (0,2,0)
  let s = S(U('a', 'A', 'warrior', { x: 0, y: 2, z: 0 }));
  assert.equal(R.canMove(s, 'a', { x: 1, y: 1, z: 0 }, 'A').ok, false, '斜移被拒绝');
  assert.equal(R.canMove(s, 'a', { x: 0, y: 2, z: 2 }, 'A').ok, false, '跨两层被拒绝');
  const flat = S(U('f', 'A', 'warrior', { x: 0, y: 0, z: 0 }));
  assert.equal(R.canMove(flat, 'f', { x: 0, y: 0, z: 1 }, 'A').ok, false,
    '底层 (0,0,0) 不再是楼梯，无法上楼');

  let r = R.moveUnit(s, 'a', { x: 0, y: 2, z: 1 }, 'A');
  assert.equal(r.ok, true, '楼梯上楼合法');
  assert.equal(r.state.ap, 4);
  assert.deepEqual(r.state.units[0].pos, { x: 0, y: 2, z: 1 });

  r = R.moveUnit(r.state, 'a', { x: 1, y: 2, z: 1 }, 'A');
  assert.equal(r.ok, true, '同层正交合法');
  assert.equal(r.state.ap, 3);

  // 不是自己的回合
  assert.equal(R.moveUnit(r.state, 'a', { x: 2, y: 2, z: 1 }, 'B').ok, false);
});

test('3. 攻击：战士/弓手射程、法师终极削弱（攻1不击退 + 无差别溅射）、每单位每回合最多 1 次', () => {
  let s = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 0 }),
  );
  assert.equal(R.canAttack(s, 'aw', 'bt', 'A').ok, true, '战士同层相邻可攻击');
  assert.equal(R.canAttack(s, 'aw', 'bt', 'B').ok, false);

  // 弓手直线 2 格
  const s2 = S(
    U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }),
    U('bt2', 'B', 'warrior', { x: 2, y: 1, z: 0 }),
  );
  assert.equal(R.canAttack(s2, 'aa', 'bt2', 'A').ok, true, '弓手同层直线 2 格');
  const far = S(U('aa2', 'A', 'archer', { x: 0, y: 0, z: 0 }), U('bb', 'B', 'mage', { x: 2, y: 2, z: 0 }));
  assert.equal(R.canAttack(far, 'aa2', 'bb', 'A').ok, false, '非正交直线不可攻击');

  // 迭代 8 法师：攻击 1、主目标不击退；相邻敌 / 友全部 1 伤且全不后退；施法者不自伤
  const s3 = S(
    U('am', 'A', 'mage',    { x: 0, y: 1, z: 0 }),
    U('bt3', 'B', 'warrior', { x: 1, y: 1, z: 0 }),  // 主目标 hp 5 -> 4
    U('bs', 'B', 'warrior',  { x: 1, y: 0, z: 0 }),  // 相邻敌方 hp 5 -> 4
    U('af', 'A', 'warrior',  { x: 2, y: 1, z: 0 }),  // 相邻友军 hp 5 -> 4（无差别溅射）
  );
  const r3 = R.resolveAttack(s3, 'am', 'bt3', 'A');
  assert.equal(r3.ok, true);
  assert.equal(at(r3.state, 'bt3').hp, 4, '主目标只扣 1 血（攻击由 2 降为 1）');
  assert.deepEqual(at(r3.state, 'bt3').pos, { x: 1, y: 1, z: 0 }, '主目标不后退');
  assert.equal(at(r3.state, 'bs').hp, 4, '相邻敌方单位受 1 点溅射');
  assert.deepEqual(at(r3.state, 'bs').pos, { x: 1, y: 0, z: 0 }, '相邻敌方不后退');
  assert.equal(at(r3.state, 'af').hp, 4, '相邻友军也受 1 点溅射（不分敌我）');
  assert.deepEqual(at(r3.state, 'af').pos, { x: 2, y: 1, z: 0 }, '相邻友军不后退');
  assert.equal(at(r3.state, 'am').hp, 3, '施法者本人不受自伤');
  assert.ok(!r3.events.some((e) => e.kind === 'knockback' || e.kind === 'knockbackMove'),
    '法师攻击全场没有任何击退事件');
  assert.equal(r3.events.filter((e) => e.kind === 'damage' && e.source === 'splash').length, 2,
    '溅射恰好命中敌 + 友 2 个单位');
  assert.equal(at(r3.state, 'am').hasAttacked, true);
  assert.equal(R.canAttack(r3.state, 'am', 'bt3', 'A').ok, false, '本回合不能再攻击');
  assert.equal(r3.state.ap, 4, '攻击消耗 1 AP');
});

test('4. 上下方向攻击不产生击退（改用保留的楼梯坐标）', () => {
  const s = S(
    U('aw', 'A', 'warrior', { x: 0, y: 2, z: 0 }),
    U('bt', 'B', 'warrior', { x: 0, y: 2, z: 1 }),
  );
  assert.equal(R.canAttack(s, 'aw', 'bt', 'A').ok, true, '楼梯上下相邻可攻击');
  const r = R.resolveAttack(s, 'aw', 'bt', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'bt').hp, 3);
  assert.deepEqual(at(r.state, 'bt').pos, { x: 0, y: 2, z: 1 }, '垂直攻击不击退');
  assert.ok(r.events.some((e) => e.kind === 'noKnockback'));
  assert.ok(!r.events.some((e) => e.kind === 'knockback'));
});

test('5. 击退碰撞：撞墙 1 点、撞单位仅被击退者受伤、撞木箱碎裂且免伤', () => {
  // 撞墙（越界）
  const wall = S(U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }), U('bt', 'B', 'warrior', { x: 2, y: 1, z: 0 }));
  const rw = R.resolveAttack(wall, 'aw', 'bt', 'A');
  assert.equal(at(rw.state, 'bt').hp, 2, '2 攻击 + 1 碰撞');
  assert.deepEqual(at(rw.state, 'bt').pos, { x: 2, y: 1, z: 0 }, '碰撞后仍在原格');
  assert.ok(rw.events.some((e) => e.kind === 'collision' && e.reason === 'wall'));

  // 撞单位：仅被击退目标受伤
  const unitHit = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 0 }),
    U('block', 'B', 'warrior', { x: 2, y: 1, z: 0 }),
  );
  const ru = R.resolveAttack(unitHit, 'aw', 'bt', 'A');
  assert.equal(at(ru.state, 'bt').hp, 2);
  assert.equal(at(ru.state, 'block').hp, 5, '阻挡单位不受伤');
  assert.deepEqual(at(ru.state, 'bt').pos, { x: 1, y: 1, z: 0 });

  // 撞木箱：木箱碎裂、目标不受碰撞伤害
  const crateHit = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 0 }),
  );
  crateHit.devices = [D('c1', 'B', 'crate', { x: 2, y: 1, z: 0 })];
  const rc = R.resolveAttack(crateHit, 'aw', 'bt', 'A');
  assert.equal(at(rc.state, 'bt').hp, 3, '只有 2 点攻击伤害');
  assert.equal(dev(rc.state, 'c1'), undefined, '木箱被撞碎');
  assert.ok(rc.events.some((e) => e.kind === 'crateBreak'));
  assert.deepEqual(at(rc.state, 'bt').pos, { x: 1, y: 1, z: 0 });
});

test('6. 木箱阻挡移动；布置装置需 8 邻域有己方单位、每回合 1 次、扣库存', () => {
  const s = S(U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }));
  s.devices = [D('c1', 'B', 'crate', { x: 1, y: 1, z: 0 })];
  assert.equal(R.canMove(s, 'aw', { x: 1, y: 1, z: 0 }, 'A').ok, false, '木箱阻挡移动');
  s.devices = [];

  assert.equal(R.canPlaceDevice(s, 'A', 'crate', { x: 2, y: 2, z: 0 }).ok, false, '周围无己方单位');
  assert.equal(R.canPlaceDevice(s, 'A', 'crate', { x: 0, y: 2, z: 0 }).ok, false, '楼梯格不可布置');
  assert.equal(R.canPlaceDevice(s, 'A', 'crate', { x: 0, y: 0, z: 0 }).ok, true,
    '底层 (0,0,0) 取消楼梯后可布置');

  const r = R.placeDevice(s, 'A', 'crate', { x: 1, y: 1, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.state.inventory.A.crate, 2);
  assert.equal(r.state.ap, 4);
  assert.equal(r.state.devices.length, 1);
  assert.equal(R.canPlaceDevice(r.state, 'A', 'crate', { x: 1, y: 0, z: 0 }).ok, false, '每回合最多 1 个');

  // 攻击装置消耗正常攻击行动
  const s2 = S(U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }));
  s2.devices = [D('c2', 'B', 'crate', { x: 2, y: 1, z: 0 })];
  const ra = R.resolveAttack(s2, 'aa', 'c2', 'A');
  assert.equal(ra.ok, true);
  assert.equal(ra.state.devices.length, 0);
  assert.equal(at(ra.state, 'aa').hasAttacked, true);
});

test('7. 中层中心陷阱：开关、落到 z=0 受 1 伤、下层被顶住卡层不重叠', () => {
  const s = S(
    U('aa', 'A', 'warrior', { x: 1, y: 0, z: 1 }), // 可开关陷阱的己方单位
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 1 }), // 站在陷阱上
  );
  assert.equal(R.canToggleTrap(s, 'aa', 'A').ok, true);
  const r1 = R.toggleCenterTrap(s, 'aa', 'A');
  assert.equal(r1.state.centerTrapOpen, true);
  assert.deepEqual(at(r1.state, 'bt').pos, { x: 1, y: 1, z: 0 }, '掉落到下层中心');
  assert.equal(at(r1.state, 'bt').hp, 4, '最终落到 z=0 受 1 点坠落伤害');
  assert.equal(r1.state.ap, 4);
  assert.equal(R.canToggleTrap(r1.state, 'aa', 'A').ok, false, '每回合最多开关 1 次');
  assert.equal(R.standable(r1.state, { x: 1, y: 1, z: 1 }), true,
    '打开的洞口允许进入（进入后由 handleFall 结算）');

  // 迭代 6 方案 B：下层中心被占 -> 无法继续下落，卡在当前层陷阱格，不扣坠落伤害
  const s2 = S(
    U('aa', 'A', 'warrior', { x: 1, y: 0, z: 1 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 1 }),
    U('occ', 'A', 'mage', { x: 1, y: 1, z: 0 }),
  );
  const r2 = R.toggleCenterTrap(s2, 'aa', 'A');
  assert.deepEqual(at(r2.state, 'bt').pos, { x: 1, y: 1, z: 1 }, '卡在中间层陷阱格');
  assert.equal(at(r2.state, 'bt').hp, 5, '卡中间层不扣坠落伤害');
  assert.ok(r2.events.some((e) => e.kind === 'fallBlocked'), '产生 fallBlocked 事件');
  assert.ok(r2.state.logs.at(-1).text.A.includes('被下层单位顶住'), '日志文案符合验收要求');
  assert.ok(r2.state.logs.at(-1).text.B.includes('被下层单位顶住'), '双方日志都可见');
  const cells = r2.state.units.filter((u) => u.alive).map((u) => `${u.pos.x},${u.pos.y},${u.pos.z}`);
  assert.equal(new Set(cells).size, cells.length, '严格防止 Z 轴坐标重叠');

  // 关闭后恢复可站立
  const s3 = S(U('aa', 'A', 'warrior', { x: 1, y: 0, z: 1 }));
  const open = R.toggleCenterTrap(s3, 'aa', 'A').state;
  open.perTurnFlags.trapToggled.A = false; // 模拟下一回合
  const closed = R.toggleCenterTrap(open, 'aa', 'A').state;
  assert.equal(closed.centerTrapOpen, false);
  assert.equal(R.canMove(closed, 'aa', { x: 1, y: 1, z: 1 }, 'A').ok, true);
});

test('8. 最终版召唤：只 1 首发 / 只能召唤预选名额 / 每个整局 1 次 / 2 AP / 己方初始层任意空格 / 本回合可行动', () => {
  const s = R.createInitialState();
  assert.equal(s.units.length, 2, '开局只有 2 个首发单位');
  assert.deepEqual(s.units.find((u) => u.owner === 'A').pos, { ...FIRST_SPAWN.A }, 'A 首发 (0,1,0)');
  assert.deepEqual(s.units.find((u) => u.owner === 'B').pos, { ...FIRST_SPAWN.B }, 'B 首发 (2,1,2)');
  assert.deepEqual(INITIAL_POSITIONS.B[0], { x: 2, y: 1, z: 2 });

  assert.equal(SUMMON_POINTS.A.length, 9, 'A 底层 9 格都是候选召唤点');
  assert.equal(SUMMON_POINTS.B.length, 9, 'B 顶层 9 格都是候选召唤点');
  assert.ok(SUMMON_POINTS.A.every((p) => p.z === HOME_LAYER.A));
  assert.ok(SUMMON_POINTS.B.every((p) => p.z === HOME_LAYER.B));
  assert.equal(SUMMON_COST, 2, '召唤消耗 2 AP');

  // 预备池只含本局预选名单里除首发外的 2 个单位
  assert.deepEqual(R.reserveEntries(s, 'A').map((e) => e.cls), ['archer', 'mage']);
  assert.equal(R.canSummon(s, 'A', 'guardian', { x: 1, y: 0, z: 0 }).ok, false, '不能召唤预选列表外单位');
  assert.equal(R.canSummon(s, 'A', 'warrior', { x: 1, y: 0, z: 0 }).ok, false, '首发已出场，不能重复召唤');
  assert.equal(R.summonUnit(s, 'A', 'guardian', { x: 1, y: 0, z: 0 }).ok, false, '服务端同样拒绝名单外单位');

  assert.equal(R.canSummon(s, 'A', 'mage', { x: 0, y: 1, z: 0 }).ok, false, '被占据的格不可召唤');
  assert.equal(R.canSummon(s, 'A', 'mage', { x: 1, y: 1, z: 2 }).ok, false, 'A 不能在顶层召唤');
  assert.equal(R.canSummon(s, 'A', 'mage', { x: 1, y: 1, z: 0 }).ok, true, '底层任意合法空格可召唤');
  const forB = R.createInitialState(); forB.currentPlayer = 'B';
  assert.equal(R.canSummon(forB, 'B', 'mage', { x: 0, y: 0, z: 2 }).ok, true, 'B 可在顶层任意合法空格召唤');
  assert.equal(R.canSummon(forB, 'B', 'mage', { x: 0, y: 0, z: 0 }).ok, false, 'B 不能在底层召唤');

  const r = R.summonUnit(s, 'A', 'A-r1', { x: 1, y: 1, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.state.ap, 3, '5 AP - 2 AP = 3');
  assert.equal(r.state.reserve.A, 1, '消耗 1 个名额，还剩 1 个');
  const fresh = r.state.units[r.state.units.length - 1];
  assert.equal(fresh.class, 'mage');
  assert.deepEqual(fresh.pos, { x: 1, y: 1, z: 0 });
  assert.equal(fresh.hasAttacked, false);
  assert.equal(R.canMove(r.state, fresh.id, { x: 1, y: 2, z: 0 }, 'A').ok, true, '召唤后本回合可直接行动');

  // 已召唤名额锁死：同一 key / 同一职业都不能再召唤
  assert.equal(R.canSummon(r.state, 'A', 'A-r1', { x: 0, y: 0, z: 0 }).ok, false, '已召唤名额整局锁死');
  assert.equal(R.canSummon(r.state, 'A', 'mage', { x: 0, y: 0, z: 0 }).ok, false, '同一职业不能重复召唤');
  assert.equal(R.reserveEntries(r.state, 'A').find((e) => e.cls === 'mage').used, true, '标记为【已召唤】');
  assert.equal(R.canSummon(r.state, 'A', 'A-r0', { x: 0, y: 0, z: 0 }).ok, false, '同一回合最多召唤 1 次');

  // 换手后 AP 重置为 5，可召唤另一个名额；两个名额都用过之后预备池锁死
  const t1 = R.endTurn(r.state, 'A').state;
  const t2 = R.endTurn(t1, 'B').state;
  assert.equal(t2.ap, 5, '换回 A 时 AP 立刻重置为 5');
  const r2 = R.summonUnit(t2, 'A', 'A-r0', { x: 0, y: 0, z: 0 });
  assert.equal(r2.ok, true, '第二个名额可以召唤');
  assert.equal(r2.state.reserve.A, 0, '预备池已空');
  assert.equal(r2.state.units.filter((u) => u.owner === 'A' && u.alive).length, 3, '场上最多 1 首发 + 2 召唤');
  assert.equal(R.summonUnit(r2.state, 'A', null, { x: 2, y: 2, z: 0 }).ok, false, '预备池空后不能再召唤');
});

test('9. 视野：弓手全层、战士/法师十字、楼梯扩展、并集合并、迷雾过滤', () => {
  const s = S(
    U('aa', 'A', 'archer', { x: 1, y: 1, z: 0 }),
    U('aw', 'A', 'warrior', { x: 1, y: 1, z: 1 }),
  );
  // 迭代 6：楼梯只剩显式集合，弓手全层 9 格 + 仅 2 个真实楼梯对应上层角格 = 11
  assert.equal(R.unitVision(s, at(s, 'aa')).length, 11, '弓手：本层 9 格 + 2 个真实楼梯上层角格');
  assert.equal(R.unitVision(s, at(s, 'aw')).length, 5, '战士：十字 5 格');

  const vis = R.computeVisibility(s, 'A');
  assert.ok(vis.has('2,2,0'), '并集包含弓手全层视野');
  assert.ok(vis.has('0,2,1'), '楼梯 (0,2,0) 扩展出上层对应角格');
  assert.equal(vis.has('0,0,1'), false, '已取消楼梯的角格不再扩展视野');

  const hidden = S(
    U('aa', 'A', 'archer', { x: 1, y: 1, z: 0 }),
    U('bh', 'B', 'warrior', { x: 2, y: 2, z: 2 }), // A 看不到
  );
  const vA = R.viewFor(hidden, 'A');
  assert.equal(vA.units.some((u) => u.id === 'bh'), false, '隐藏敌方单位不出现在视图');
  assert.equal(R.canAttack(hidden, 'aa', 'bh', 'A').ok, false, '隐藏目标不可攻击');
  const vB = R.viewFor(hidden, 'B');
  assert.equal(vB.units.some((u) => u.id === 'aa'), false, 'A 的单位对 B 也隐藏');

  // 移动后进入视野后重新可见，离开后重新隐藏
  let s2 = S(U('aa', 'A', 'archer', { x: 1, y: 1, z: 0 }), U('bh', 'B', 'warrior', { x: 1, y: 1, z: 0 }));
  assert.ok(R.viewFor(s2, 'A').units.some((u) => u.id === 'bh'));
  s2.units[1].pos = { x: 1, y: 1, z: 2 };
  assert.equal(R.viewFor(s2, 'A').units.some((u) => u.id === 'bh'), false);
});

test('10. 回合切换：AP/hasAttacked/每回合标志重置；投降与回合上限平局', () => {
  const s = R.createInitialState();
  s.units[0].hasAttacked = true;
  s.perTurnFlags.placed.A = true;
  s.ap = 1;
  const r = R.endTurn(s, 'A');
  assert.equal(r.state.currentPlayer, 'B');
  assert.equal(r.state.ap, 5);
  assert.equal(r.state.units.every((u) => !u.hasAttacked), true);
  assert.equal(r.state.perTurnFlags.placed.A, false);

  const sur = R.surrender(R.createInitialState(), 'A');
  assert.equal(sur.state.phase, 'gameover');
  assert.equal(sur.state.winner, 'B');

  // 到达上限：存活数相同，按总生命值判定
  const lim = R.createInitialState();
  lim.turn = MAX_HALF_TURNS;
  lim.units.find((u) => u.owner === 'B').hp = 1;
  const lr = R.endTurn(lim, 'A');
  assert.equal(lr.state.phase, 'gameover');
  assert.equal(lr.state.winner, 'A');

  const lim2 = R.createInitialState();
  lim2.turn = MAX_HALF_TURNS;
  assert.equal(R.endTurn(lim2, 'A').state.winner, 'draw', '完全相同则平局');

  // 最终版任务四：新回合 AP 立刻重置为 5，绝不出现开局 AP=0
  assert.equal(R.createInitialState().ap, AP_PER_TURN, '开局 AP=5');
  const apBug = R.createInitialState();
  apBug.ap = 0;                       // 人为模拟「回合刚开始却 AP=0」的异常状态
  assert.equal(R.viewFor(apBug, 'A').ap, AP_PER_TURN, '回合刚开始异常 AP=0 时仍按 5 下发');
});

test('11. 胜负：击败对方全部单位立即获胜；日志不泄露隐藏坐标', () => {
  const s = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'archer', { x: 1, y: 1, z: 0 }, 2),
  );
  const r = R.resolveAttack(s, 'aw', 'bt', 'A');
  assert.equal(r.state.phase, 'gameover');
  assert.equal(r.state.winner, 'A');

  // A 的隐藏移动不得把坐标泄露给 B
  const hid = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bw', 'B', 'archer', { x: 1, y: 1, z: 2 }),
  );
  const moved = R.moveUnit(hid, 'aw', { x: 0, y: 0, z: 0 }, 'A').state;
  const vB = R.viewFor(moved, 'B');
  for (const e of vB.events) {
    assert.ok(e.hidden || !e.pos, '隐藏事件应被标记且不带坐标');
    assert.equal(e.pos || null, null, '隐藏事件坐标应被清除');
  }
  assert.ok(!vB.logs.some((l) => l.text.includes('(0,0,0)')), 'B 的日志不含 A 隐藏单位坐标');
  const vA = R.viewFor(moved, 'A');
  assert.ok(vA.logs.some((l) => l.text.includes('(0,0,0)')), 'A 本人日志含自己的坐标');
});

test('12. 攻击预览由服务端计算（前端零规则计算）', () => {
  const s = S(
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 0 }),
  );
  s.devices = [
    D('c1', 'B', 'crate', { x: 2, y: 1, z: 0 }), // 击退后方：木箱碎裂
    D('c2', 'B', 'crate', { x: 0, y: 0, z: 0 }), // 相邻：可作为攻击目标
  ];
  const hints = R.buildHints(s, 'A');
  assert.ok(hints.attacks['aw'].includes('bt'));
  assert.ok(hints.attacks['aw'].includes('c2'), '相邻敌方装置可作为攻击目标');
  assert.equal(hints.attacks['aw'].includes('c1'), false, '战士射程 1 格，2 格外的装置不可攻击');
  const pv = hints.previews['aw']['bt'];
  assert.equal(pv.damage, 2);
  assert.equal(pv.collision.reason, 'device');
  assert.equal(pv.crateBreak, true);
  assert.equal(pv.collision.damage, 0);
});

// ===========================================================================
// 迭代 4：弩箭机关 / 草丛 / 技能牌
// ===========================================================================

test('13. 通用手牌：开局各 5 张通用牌、满手不抽、上限 5、只下发己方手牌（无专属卡）', () => {
  const s = R.createInitialState();
  assert.equal(INITIAL_HAND_SIZE, 5, '迭代 8：开局发 5 张通用牌');
  assert.equal(s.hands.A.length, INITIAL_HAND_SIZE);
  assert.equal(s.hands.B.length, INITIAL_HAND_SIZE);
  assert.equal(CARD_POOL.length, 10, '最终版公共牌库：3 通用 + 致盲烟雾 + 6 装置卡');
  assert.deepEqual(Object.keys(CARDS).sort(), [...CARD_POOL].sort(),
    'CARDS 与 CARD_POOL 完全一致，不存在任何职业专属卡 / 主动技能牌');
  assert.ok(!Object.keys(CARDS).some((t) => /nova|bulwark|arcane|steel/i.test(t)),
    '牌库不含奥术新星 / 钢铁壁垒等专属卡');
  assert.ok([...s.hands.A, ...s.hands.B].every((c) => CARD_POOL.includes(c.type)), '开局全是通用牌');

  const vA = R.viewFor(s, 'A'), vB = R.viewFor(s, 'B');
  assert.equal(vA.hand.length, INITIAL_HAND_SIZE);
  assert.equal(vB.hand.length, INITIAL_HAND_SIZE);
  assert.equal('hands' in vA, false, 'PlayerView 不含服务端私有 hands 字段');
  // 用带引号的完整 id 精确匹配：开局 5 张后卡号会到 c10，裸 includes('c1') 会误命中 c10
  const aPack = JSON.stringify(vA), bPack = JSON.stringify(vB);
  for (const c of s.hands.B) assert.ok(!aPack.includes(`"${c.id}"`), `A 的网络包不含 B 的卡 ${c.id}`);
  for (const c of s.hands.A) assert.ok(!bPack.includes(`"${c.id}"`), `B 的网络包不含 A 的卡 ${c.id}`);
  assert.ok(vA.hand.every((c) => s.hands.A.some((x) => x.id === c.id)), 'A 只看到自己的手牌');
  assert.equal(vB.hints, null, '非行动方无 hints（更不会含对方 cardTargets）');

  // 迭代 8：开局即达上限 5，新回合玩家满手不再抽；非当前回合玩家手牌不变
  const e = R.endTurn(s, 'A');
  assert.equal(e.state.hands.B.length, HAND_LIMIT, '满手 5 张时新回合不抽牌');
  assert.equal(e.state.hands.A.length, INITIAL_HAND_SIZE, '非当前回合玩家不抽');
  assert.equal(e.state.currentPlayer, 'B');
  assert.ok(e.state.hands.B.every((c) => CARD_POOL.includes(c.type)), '后续仍只会出现通用牌');

  // 打出 1 张后，下一次轮到自己时补抽 1 张（仍只会是通用牌）
  const s2 = R.createInitialState();
  s2.hands.A.pop(); // 模拟打出 1 张 -> 4 张
  const t1 = R.endTurn(s2, 'A').state;
  const t2 = R.endTurn(t1, 'B').state;
  assert.equal(t2.hands.A.length, HAND_LIMIT, '打出后下一回合补抽 1 张');
  assert.ok(t2.hands.A.every((c) => CARD_POOL.includes(c.type)), '补抽到的仍是通用牌');

  // 手牌上限 5：满了不再抽
  const full = R.createInitialState();
  full.hands.A = Array.from({ length: HAND_LIMIT }, (_, i) => ({ id: `fa${i}`, type: 'insight' }));
  const f1 = R.endTurn(full, 'A').state;
  const f2 = R.endTurn(f1, 'B').state;
  assert.equal(f2.hands.A.length, HAND_LIMIT, '达到上限后不再抽牌');

  // 每回合标志重置 + viewFor 正确展平 perTurnFlags（修复旧实现恒为空对象的问题）
  const f = R.createInitialState();
  f.perTurnFlags.placed.A = true;
  f.perTurnFlags.skillCardUsed.A = true;
  assert.equal(R.viewFor(f, 'A').perTurnFlags.placed, true);
  assert.equal(R.viewFor(f, 'A').perTurnFlags.skillCardUsed, true, '技能牌标记正确展平');
  assert.equal(R.endTurn(f, 'A').state.perTurnFlags.skillCardUsed.A, false,
    '切换新回合时重置【本回合技能牌已使用】标记');
});

test('14. 弩箭机关：库存 2、敌方进入 1 伤无击退、持续触发、己方不触发、明牌、可破坏', () => {
  const init = R.createInitialState();
  assert.equal(init.inventory.A.arrowTrap, 2);
  assert.equal(init.inventory.A.grass, 2);

  // 布置合法性（8 邻域有己方单位）
  const b = S(U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }));
  const pl = R.placeDevice(b, 'A', 'arrowTrap', { x: 1, y: 1, z: 0 });
  assert.equal(pl.ok, true);
  assert.equal(pl.state.inventory.A.arrowTrap, 1, '扣库存');

  // 敌方进入
  let a = R.createInitialState();
  a.currentPlayer = 'B';
  a.units = [U('aw', 'A', 'warrior', { x: 0, y: 0, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 })];
  a.devices = [D('at', 'A', 'arrowTrap', { x: 1, y: 1, z: 0 })];
  const m1 = R.moveUnit(a, 'bw', { x: 1, y: 1, z: 0 }, 'B');
  assert.equal(m1.ok, true);
  assert.equal(at(m1.state, 'bw').hp, 5 - ARROW_TRAP_DAMAGE, '敌方进入受 1 伤');
  assert.equal(m1.state.devices.length, 1, '装置不消耗，可持续触发');
  assert.ok(m1.events.some((e) => e.kind === 'arrowTrapTrigger'));
  assert.ok(m1.events.some((e) => e.kind === 'damage' && e.source === 'arrowTrap' && e.amount === 1));
  assert.ok(!m1.events.some((e) => e.kind === 'knockback'), '无击退');

  // 后续再次进入同格，再次触发
  const m2 = R.moveUnit(m1.state, 'bw', { x: 2, y: 1, z: 0 }, 'B');
  const m3 = R.moveUnit(m2.state, 'bw', { x: 1, y: 1, z: 0 }, 'B');
  assert.equal(at(m3.state, 'bw').hp, 5 - 2 * ARROW_TRAP_DAMAGE, '每次进入都触发');

  // 己方进入不触发
  let a2 = R.createInitialState();
  a2.units = [U('aw', 'A', 'warrior', { x: 2, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 0, y: 0, z: 0 })];
  a2.devices = [D('at', 'A', 'arrowTrap', { x: 1, y: 1, z: 0 })];
  const mo = R.moveUnit(a2, 'aw', { x: 1, y: 1, z: 0 }, 'A');
  assert.equal(at(mo.state, 'aw').hp, 5, '己方进入不触发');

  // 最终版任务一：迷雾内的敌方单位 / 装置「绝对不可见」，坐标不进入网络包
  const vis = R.createInitialState();
  vis.units = [U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 2, z: 2 })];
  vis.devices = [D('at', 'A', 'arrowTrap', { x: 1, y: 1, z: 0 })];
  assert.equal(R.viewFor(vis, 'B').devices.some((d) => d.id === 'at'), false,
    '视野外的敌方装置不下发（迷雾绝对遮蔽）');
  assert.ok(R.viewFor(vis, 'A').devices.some((d) => d.id === 'at'), '己方装置恒可见');
  const inSight = R.createInitialState();
  inSight.units = [U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }), U('ba', 'B', 'archer', { x: 2, y: 2, z: 0 })];
  inSight.devices = [D('at2', 'A', 'arrowTrap', { x: 1, y: 1, z: 0 })];
  assert.ok(R.viewFor(inSight, 'B').devices.some((d) => d.id === 'at2'), '视野内敌方装置可见');

  // 可被攻击破坏
  const kill = R.createInitialState();
  kill.units = [U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 2, z: 2 })];
  kill.devices = [D('at2', 'B', 'arrowTrap', { x: 1, y: 1, z: 0 })];
  const ka = R.resolveAttack(kill, 'aa', 'at2', 'A');
  assert.equal(ka.ok, true);
  assert.equal(ka.state.devices.length, 0, '弩箭机关可被攻击破坏');
});

test('15. 草丛：进入隐身、对敌绝对不可见、己方可见、不可攻击、离开/攻击破隐、同格反隐、不可破坏', () => {
  // B 放一个底层弓手，确保 (1,1,0) 在 B 视野内 —— 用来证明隐藏来自「隐身」而非迷雾
  let s = R.createInitialState();
  s.units = [
    U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('ba', 'B', 'archer', { x: 2, y: 2, z: 0 }),
  ];
  s.devices = [D('g', 'B', 'grass', { x: 1, y: 1, z: 0 })];
  assert.ok(R.viewFor(s, 'B').units.some((u) => u.id === 'aw'), '隐身前 B 能看到 A 战士');

  const m = R.moveUnit(s, 'aw', { x: 1, y: 1, z: 0 }, 'A');
  assert.equal(at(m.state, 'aw').inGrass, true, '进入草丛后隐身');
  assert.equal(R.viewFor(m.state, 'B').units.some((u) => u.id === 'aw'), false, '草丛内单位对敌方绝对不可见');
  assert.equal(R.viewFor(m.state, 'A').units.some((u) => u.id === 'aw'), true, '己方看得到草丛内己方单位');
  assert.ok(R.viewFor(m.state, 'B').devices.some((d) => d.id === 'g'), '草丛明牌可见');

  const stB = structuredClone(m.state); stB.currentPlayer = 'B';
  assert.equal(R.canAttack(stB, 'ba', 'aw', 'B').ok, false, '隐身目标不可被选为攻击目标');
  assert.equal(R.canAttack(stB, 'ba', 'g', 'B').ok, false, '草丛不可被攻击破坏');

  // 离开草丛破隐
  const out = R.moveUnit(m.state, 'aw', { x: 2, y: 1, z: 0 }, 'A');
  assert.equal(at(out.state, 'aw').inGrass, false, '离开草丛破隐');
  assert.ok(R.viewFor(out.state, 'B').units.some((u) => u.id === 'aw'), '破隐后重新可见');

  // 攻击破隐
  let g2 = R.createInitialState();
  g2.units = [U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 })];
  g2.devices = [D('g', 'B', 'grass', { x: 1, y: 1, z: 0 })];
  at(g2, 'aw').inGrass = true;
  const atk = R.resolveAttack(g2, 'aw', 'bw', 'A');
  assert.equal(atk.ok, true);
  assert.equal(at(atk.state, 'aw').inGrass, false, '发起攻击立即破隐');
  assert.ok(atk.events.some((e) => e.kind === 'reveal'));

  // 同格反隐（构造贴身同格态）
  const same = R.createInitialState();
  same.units = [U('ba', 'B', 'archer', { x: 1, y: 1, z: 0 }), U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 })];
  same.devices = [D('g', 'B', 'grass', { x: 1, y: 1, z: 0 })];
  at(same, 'aw').inGrass = true;
  assert.ok(R.viewFor(same, 'B').units.some((u) => u.id === 'aw'), '敌方单位同格时反隐可见');
});

test('16. 【紧急包扎】：回 2 血不超上限、满血拒绝、消耗 1 AP、技能牌每回合 1 张', () => {
  let s = R.createInitialState();
  at(s, 'A-warrior').hp = 2;
  s.hands.A = [{ id: 'h1', type: 'bandage' }, { id: 'h2', type: 'bandage' }];
  assert.equal(R.canPlayCard(s, 'h1', 'A-warrior', 'A').ok, true);
  const r = R.playCard(s, 'h1', 'A-warrior', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'A-warrior').hp, 4, '2 -> 4');
  assert.equal(r.state.ap, AP_PER_TURN - 1, '消耗 1 AP');
  assert.equal(r.state.hands.A.length, 1, '手牌 -1');
  assert.ok(r.events.some((e) => e.kind === 'heal' && e.amount === 2));
  assert.equal(R.canPlayCard(r.state, 'h2', 'A-warrior', 'A').ok, false,
    '技能牌每回合最多 1 张（bandage 属技能牌）');
  assert.equal(r.state.perTurnFlags.skillCardUsed.A, true, '打出技能牌后设置本回合标记');

  let s2 = R.createInitialState();
  at(s2, 'A-warrior').hp = 4;
  s2.hands.A = [{ id: 'h3', type: 'bandage' }];
  assert.equal(at(R.playCard(s2, 'h3', 'A-warrior', 'A').state, 'A-warrior').hp, 5, '不超过 maxHp');

  let s3 = R.createInitialState();
  s3.hands.A = [{ id: 'h4', type: 'bandage' }];
  assert.equal(R.canPlayCard(s3, 'h4', 'A-warrior', 'A').ok, false, '满血不可包扎');
  assert.equal(R.canPlayCard(s, 'h1', 'B-warrior', 'A').ok, false, '不能选敌方单位');
  assert.equal(R.canPlayCard(s, 'not-mine', 'A-warrior', 'A').ok, false, '不能打不存在的手牌');
});

test('17. 【战术洞察】：本回合 +2 AP（净 +1）、无需目标、对方日志不含牌名', () => {
  let s = R.createInitialState();
  s.hands.A = [{ id: 'i1', type: 'insight' }];
  const r = R.playCard(s, 'i1', undefined, 'A');
  assert.equal(r.ok, true);
  assert.equal(r.state.ap, AP_PER_TURN - 1 + 2, '5 - 1 + 2 = 6');
  assert.ok(r.events.some((e) => e.kind === 'apGain' && e.amount === 2));
  assert.equal(r.state.hands.A.length, 0);
  const vA = R.viewFor(r.state, 'A'), vB = R.viewFor(r.state, 'B');
  const la = vA.logs.at(-1).text, lb = vB.logs.at(-1).text;
  assert.ok(la.includes('打出【战术洞察】'), '本人日志含「打出【牌名】」');
  assert.ok(!lb.includes('打出【'), '对方日志不含牌名前缀（不泄露打出了哪张牌）');
  assert.equal(JSON.stringify(vB).includes('i1'), false, 'B 的网络包不含 A 打出的卡 id');
  assert.ok(!vB.events.some((e) => e.kind === 'cardPlay' && ('type' in e || 'cardType' in e)),
    '出牌事件不含牌型字段');
});

test('18. 【强力击退】：1 伤 + 最多推 2 格、撞墙额外伤、撞木箱碎裂免伤、目标可见校验', () => {
  // 推进 1 格后撞墙：基础 1 + 碰撞 1 + 每张牌额外 1 = 3
  let s = R.createInitialState();
  s.units = [U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 1, y: 1, z: 0 })];
  s.devices = [];
  s.hands.A = [{ id: 'k1', type: 'powerKnock' }];
  const r = R.playCard(s, 'k1', 'bw', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'bw').hp, 2, '1 基础 + 2 碰撞（含额外 1）= 3 伤');
  assert.deepEqual(at(r.state, 'bw').pos, { x: 2, y: 1, z: 0 }, '推进 1 格后撞墙停下');
  const kb = r.events.find((e) => e.kind === 'knockback');
  assert.equal(kb.to.x, 3, '理论击退终点为 2 格外（证明 distance=2）');
  const col = r.events.find((e) => e.kind === 'collision');
  assert.equal(col.reason, 'wall');
  assert.equal(col.damage, 2, '正常碰撞 1 + 卡牌额外 1');

  // 撞木箱：碎裂、免碰撞伤害
  let s2 = R.createInitialState();
  s2.units = [U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 1, y: 1, z: 0 })];
  s2.devices = [D('c1', 'B', 'crate', { x: 2, y: 1, z: 0 })];
  s2.hands.A = [{ id: 'k2', type: 'powerKnock' }];
  const r2 = R.playCard(s2, 'k2', 'bw', 'A');
  assert.equal(at(r2.state, 'bw').hp, 4, '只有 1 点基础伤害');
  assert.equal(r2.state.devices.length, 0, '木箱碎裂');
  assert.ok(r2.events.some((e) => e.kind === 'crateBreak'));

  // 卡牌只要「视野内」即可，不受普通攻击射程限制
  let f = R.createInitialState();
  f.units = [U('aa', 'A', 'archer', { x: 0, y: 0, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 2, z: 0 })];
  f.devices = [];
  f.hands.A = [{ id: 'k3', type: 'powerKnock' }];
  assert.equal(R.canAttack(f, 'aa', 'bw', 'A').ok, false, '普通攻击打不到非正交直线目标');
  assert.equal(R.canPlayCard(f, 'k3', 'bw', 'A').ok, true, '卡牌只要求视野内');

  // 草丛隐身敌人不能成为卡牌目标，hints 也不给出
  let g = R.createInitialState();
  g.units = [U('aa', 'A', 'archer', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 1, y: 1, z: 0 })];
  g.devices = [D('gr', 'B', 'grass', { x: 1, y: 1, z: 0 })];
  at(g, 'bw').inGrass = true;
  g.hands.A = [{ id: 'k4', type: 'powerKnock' }];
  assert.equal(R.canPlayCard(g, 'k4', 'bw', 'A').ok, false, '隐身敌人不可选');
  assert.equal(R.buildHints(g, 'A').cardTargets['k4'].length, 0, 'hints 不列出隐身目标');
});


// ===========================================================================
// 迭代 5：6 职业池 / 开局盲选 / 新职业特性
// ===========================================================================

test('19. 开局盲选：picking 状态、校验、双确认、viewFor 信息隔离', () => {
  const s = R.createPickingState();
  assert.equal(s.phase, 'picking');
  assert.deepEqual(s.picks, { A: [], B: [] });
  assert.deepEqual(s.confirmed, { A: false, B: false });

  // 服务端校验：重复 / 未知职业 / 超量 都拒绝
  assert.equal(R.setPicks(s, 'A', ['warrior', 'warrior']).ok, false, '不能重复选同一职业');
  assert.equal(R.setPicks(s, 'A', ['warrior', 'notAClass']).ok, false, '未知职业被拒');
  assert.equal(R.setPicks(s, 'A', CLASS_POOL.slice(0, 4)).ok, false, '超过 PICK_SIZE 被拒');

  const s1 = R.setPicks(s, 'A', ['warrior', 'archer']).state;
  assert.deepEqual(s1.picks.A, ['warrior', 'archer']);
  assert.deepEqual(s1.picks.B, [], '不影响对方');
  assert.equal(R.confirmPicks(s1, 'A').ok, false, '未选满不能确认');

  const s2 = R.confirmPicks(s1, 'A', ['warrior', 'archer', 'assassin']).state;
  assert.equal(s2.confirmed.A, true);
  assert.equal(R.bothConfirmed(s2), false, '单方确认不开局');
  assert.equal(R.confirmPicks(s2, 'A', CLASS_POOL.slice(0, 3)).ok, false, '不能重复确认');
  assert.equal(R.setPicks(s2, 'A', ['mage']).ok, false, '确认后不能改选');
  const s3 = R.unconfirmPicks(s2, 'A').state;
  assert.equal(s3.confirmed.A, false);
  assert.equal(R.setPicks(s3, 'A', ['mage']).ok, true, '取消确认后可重选');

  // viewFor：只下发本人 picks + 对手「是否已确认」
  const t = R.confirmPicks(s1, 'A', ['warrior', 'archer', 'assassin']).state;
  const vA = R.viewFor(t, 'A'), vB = R.viewFor(t, 'B');
  assert.equal(vA.phase, 'picking');
  assert.equal(vA.units.length, 0, '选人完成前棋盘为空');
  assert.equal(vA.hand.length, 0, '选人阶段不发手牌');
  assert.equal(vA.hints, null);
  assert.equal(vA.pick.pool.length, 6);
  assert.equal(vA.pick.size, PICK_SIZE);
  assert.ok(vA.pick.pool.every((c) => c.name && c.icon && c.color && c.hp > 0 && c.desc));
  assert.deepEqual(vA.pick.myPicks, ['warrior', 'archer', 'assassin']);
  assert.equal(vA.pick.myConfirmed, true);
  assert.equal(vA.pick.opponentConfirmed, false);
  assert.deepEqual(vB.pick.myPicks, [], 'B 看不到 A 选了哪 3 个');
  assert.equal(vB.pick.opponentConfirmed, true, 'B 只看到「对手已确认」');
  assert.equal('picks' in vB, false, '服务端私有 picks 不下发');
  assert.equal('hands' in vB, false);

  const t2 = R.confirmPicks(t, 'B', ['mage', 'priest', 'guardian']).state;
  assert.equal(R.bothConfirmed(t2), true, '双方确认后服务端才切 playing');
});

test('20. 按双方盲选阵容生成初始单位（只 1 首发 + 预备池）', () => {
  const lineup = { A: ['assassin', 'priest', 'guardian'], B: ['mage', 'guardian', 'warrior'] };
  const s = R.createInitialState(7, lineup);
  assert.equal(s.units.length, 2, '开局每方只生成 1 个首发单位');
  const a = s.units.filter((u) => u.owner === 'A');
  const b = s.units.filter((u) => u.owner === 'B');
  assert.deepEqual(a.map((u) => u.class), [lineup.A[0]], 'A 首发 = 阵容第 0 个');
  assert.deepEqual(b.map((u) => u.class), [lineup.B[0]], 'B 首发 = 阵容第 0 个');
  assert.deepEqual(a.map((u) => u.hp), [3], '刺客 3 HP（迭代 8 数值）');
  assert.deepEqual(a.map((u) => u.pos), [{ ...FIRST_SPAWN.A }], '固定首发坐标');
  assert.deepEqual(b.map((u) => u.pos), [{ ...FIRST_SPAWN.B }]);
  assert.ok(a.every((u) => u.inGrass === false && u.hasAttacked === false && u.alive));
  assert.deepEqual(s.lineup, lineup, '阵容保存在 state 供重开沿用');
  // 另外 2 个自选单位只进预备池，不在战场上
  assert.deepEqual(R.reserveEntries(s, 'A').map((e) => e.cls), lineup.A.slice(1));
  assert.deepEqual(R.reserveEntries(s, 'B').map((e) => e.cls), lineup.B.slice(1));
  assert.ok(s.units.every((u) => !lineup.A.slice(1).includes(u.class)), '预备单位开局不生成在战场');
  // 未传阵容时退回默认 3 职业
  const d = R.createInitialState();
  assert.deepEqual(d.units.filter((u) => u.owner === 'A').map((u) => u.class), ['warrior']);
  assert.deepEqual(R.reserveEntries(d, 'A').map((e) => e.cls), ['archer', 'mage']);
});

test('21. 刺客：暗杀无击退（目标原地不动）、收割击杀刷新攻击', () => {
  // 未击杀：法师 3 HP - 2 = 1，且完全不位移、无击退事件
  const s = S(U('ak', 'A', 'assassin', { x: 0, y: 1, z: 0 }), U('bm', 'B', 'mage', { x: 1, y: 1, z: 0 }));
  const r = R.resolveAttack(s, 'ak', 'bm', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'bm').hp, 1);
  assert.deepEqual(at(r.state, 'bm').pos, { x: 1, y: 1, z: 0 }, '目标原地不动');
  assert.ok(!r.events.some((e) => e.kind === 'knockback'), '没有任何击退事件');
  assert.equal(at(r.state, 'ak').hasAttacked, true);

  // 击杀：目标 2 HP 被 2 攻击打死 -> 刷新攻击状态，可立刻再打另一个相邻敌人
  const s2 = S(
    U('ak', 'A', 'assassin', { x: 0, y: 1, z: 0 }),
    U('bm', 'B', 'mage', { x: 1, y: 1, z: 0 }, 2),
    U('bm2', 'B', 'warrior', { x: 0, y: 2, z: 0 }),
  );
  const r2 = R.resolveAttack(s2, 'ak', 'bm', 'A');
  assert.equal(r2.ok, true);
  assert.equal(at(r2.state, 'bm').alive, false);
  assert.equal(r2.state.phase, 'playing', 'B 仍有存活单位，游戏未结束');
  assert.equal(at(r2.state, 'ak').hasAttacked, false, '收割：刷新本回合攻击状态');
  assert.ok(r2.events.some((e) => e.kind === 'refresh'));
  assert.equal(R.canAttack(r2.state, 'ak', 'bm2', 'A').ok, true, '可以立刻再次攻击');
  const r3 = R.resolveAttack(r2.state, 'ak', 'bm2', 'A');
  assert.equal(r3.ok, true);
  assert.equal(at(r3.state, 'ak').hasAttacked, true, '第二次攻击后正常上锁');
});

test('22. 牧师：不能攻击敌方/装置/满血，只治疗射程内己方受伤单位且无击退', () => {
  const s = S(
    U('ap', 'A', 'priest', { x: 0, y: 1, z: 0 }),
    U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }, 2),
    U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 }),
  );
  assert.equal(R.canAttack(s, 'ap', 'bw', 'A').ok, false, '牧师不能攻击敌方');
  assert.equal(R.canAttack(s, 'ap', 'aw', 'A').ok, true, '可以治疗己方受伤单位');
  const r = R.resolveAttack(s, 'ap', 'aw', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'aw').hp, 4, '2 -> 4，回复 2 点');
  assert.deepEqual(at(r.state, 'aw').pos, { x: 1, y: 1, z: 0 }, '治疗无击退');
  assert.ok(!r.events.some((e) => e.kind === 'knockback'));
  assert.ok(!r.events.some((e) => e.kind === 'damage'));
  assert.ok(r.events.some((e) => e.kind === 'heal' && e.amount === 2));

  // 不超过上限
  const m = S(
    U('ap', 'A', 'priest', { x: 0, y: 1, z: 0 }),
    U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }, 4),
    U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 }),
  );
  assert.equal(at(R.resolveAttack(m, 'ap', 'aw', 'A').state, 'aw').hp, 5, '4 -> 5，不超过 maxHp');

  // 满血 / 装置 / 敌方 都被拒绝
  const f = S(
    U('ap', 'A', 'priest', { x: 0, y: 1, z: 0 }),
    U('af', 'A', 'mage', { x: 1, y: 1, z: 0 }),
    U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 }),
  );
  f.devices = [D('c1', 'B', 'crate', { x: 0, y: 2, z: 0 })];
  assert.equal(R.canAttack(f, 'ap', 'af', 'A').ok, false, '满血无需治疗');
  assert.equal(R.canAttack(f, 'ap', 'c1', 'A').ok, false, '牧师不能攻击装置');
  assert.equal(R.canAttack(f, 'ap', 'bw', 'A').ok, false, '牧师不能攻击敌方');

  // hints：牧师的合法目标只有己方受伤单位，敌方绝不高亮；预览给出 heal
  const hints = R.buildHints(s, 'A');
  assert.ok(hints.attacks['ap'].includes('aw'));
  assert.ok(!hints.attacks['ap'].includes('bw'), '敌方不在牧师 attacks 中');
  assert.equal(hints.previews['ap']['aw'].damage, 0);
  assert.equal(hints.previews['ap']['aw'].heal, 2, '预览给出治疗量而非伤害 0');
});

test('23. 盾卫：HP 7 + 吨位碰撞加伤 + 坚韧（所有伤害 -1 保底 1，绝不扣 0）', () => {
  assert.equal(CLASSES.guardian.hp, 7, '迭代 8：盾卫 HP 由 8 下调为 7');
  assert.equal(GUARDIAN_FLAT_REDUCTION, 1);
  assert.equal(GUARDIAN_MIN_DAMAGE, 1);

  // 吨位：盾卫发起击退撞墙，碰撞 1 + 额外 1 = 2（目标不是盾卫，不减伤）
  const s = S(U('ag', 'A', 'guardian', { x: 1, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 }));
  const r = R.resolveAttack(s, 'ag', 'bw', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'bw').hp, 2, '5 - 1 攻击 - 2 碰撞 = 2');
  assert.equal(r.events.find((e) => e.kind === 'collision').damage, COLLISION_DAMAGE + 1);
  const ctrl = S(U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 2, y: 1, z: 0 }));
  assert.equal(R.resolveAttack(ctrl, 'aw', 'bw', 'A').events.find((e) => e.kind === 'collision').damage,
    COLLISION_DAMAGE, '普通职业只有 1 点碰撞伤害');

  // 撞木箱：依旧碎裂免伤，吨位不生效
  const b = S(U('ag', 'A', 'guardian', { x: 0, y: 1, z: 0 }), U('bw', 'B', 'warrior', { x: 1, y: 1, z: 0 }));
  b.devices = [D('c1', 'B', 'crate', { x: 2, y: 1, z: 0 })];
  const rb = R.resolveAttack(b, 'ag', 'bw', 'A');
  assert.equal(at(rb.state, 'bw').hp, 4, '只受 1 点攻击伤害');
  assert.equal(rb.events.find((e) => e.kind === 'collision').damage, 0);
  assert.ok(rb.events.some((e) => e.kind === 'crateBreak'));

  // 坚韧：普攻 2 伤 -> 1，被击退撞墙碰撞 1 伤 -> 保底 1，共扣 2（7 -> 5）
  const d = S(U('aw', 'A', 'warrior', { x: 1, y: 1, z: 0 }), U('bg', 'B', 'guardian', { x: 2, y: 1, z: 0 }));
  const rd = R.resolveAttack(d, 'aw', 'bg', 'A');
  assert.equal(at(rd.state, 'bg').hp, 5, '7 - 1 攻击 - 1 碰撞 = 5');
  assert.equal(rd.events.find((e) => e.kind === 'damage' && e.source === 'attack').amount, 1,
    '普攻 2 伤减为 1（普攻也纳入坚韧）');
  assert.equal(rd.events.find((e) => e.kind === 'collision').damage, 1,
    '碰撞 1 伤保底 1（不再减为 0）');

  // 固定陷阱 1 伤 -> 保底 1，装置仍被消耗
  const t = S(U('aw', 'A', 'warrior', { x: 2, y: 2, z: 2 }), U('bg', 'B', 'guardian', { x: 0, y: 1, z: 0 }));
  t.currentPlayer = 'B';
  t.devices = [D('t1', 'A', 'trap', { x: 0, y: 0, z: 0 })];
  const rt = R.moveUnit(t, 'bg', { x: 0, y: 0, z: 0 }, 'B');
  assert.equal(rt.ok, true);
  assert.equal(at(rt.state, 'bg').hp, 6, `固定陷阱 ${TRAP_DAMAGE} 点保底扣 1（7 -> 6）`);
  assert.equal(rt.state.devices.length, 0, '固定陷阱仍被消耗');

  // 弩箭机关 1 伤 -> 保底 1（验收：被射中必定扣 1 血，不再是无伤）
  const ar = S(U('aw', 'A', 'warrior', { x: 2, y: 2, z: 2 }), U('bg', 'B', 'guardian', { x: 0, y: 1, z: 0 }));
  ar.currentPlayer = 'B';
  ar.devices = [D('ar1', 'A', 'arrowTrap', { x: 0, y: 0, z: 0 })];
  const ra = R.moveUnit(ar, 'bg', { x: 0, y: 0, z: 0 }, 'B');
  assert.equal(at(ra.state, 'bg').hp, 6, `弩箭机关 ${ARROW_TRAP_DAMAGE} 点保底扣 1（7 -> 6）`);
  assert.equal(ra.state.devices.length, 1, '弩箭机关持续存在');

  // 迭代 6 方案 B：下层中心被占 -> 卡在中层陷阱格，不扣坠落伤害、不重叠
  const f = S(
    U('aw', 'A', 'warrior', { x: 2, y: 2, z: 2 }),
    U('bg', 'B', 'guardian', { x: 1, y: 1, z: 1 }),
    U('block', 'A', 'warrior', { x: 1, y: 1, z: 0 }),
  );
  f.currentPlayer = 'B';
  const rf = R.toggleCenterTrap(f, 'bg', 'B');
  assert.equal(rf.ok, true);
  assert.deepEqual(at(rf.state, 'bg').pos, { x: 1, y: 1, z: 1 }, '被下层顶住，卡在中间层');
  assert.equal(at(rf.state, 'bg').hp, 7, '卡层不扣坠落伤害');
  assert.ok(rf.state.logs.at(-1).text.B.includes('被下层单位顶住'));

  // 真正落到 z=0：坠落 1 伤保底扣 1（7 -> 6），绝不减为 0
  const f2 = S(
    U('aw', 'A', 'warrior', { x: 2, y: 2, z: 2 }),
    U('bg', 'B', 'guardian', { x: 1, y: 1, z: 1 }),
  );
  f2.currentPlayer = 'B';
  const rf2 = R.toggleCenterTrap(f2, 'bg', 'B');
  assert.deepEqual(at(rf2.state, 'bg').pos, { x: 1, y: 1, z: 0 }, '下层为空则落到 z=0');
  assert.equal(at(rf2.state, 'bg').hp, 6, '坠落 1 点保底扣 1（不再减半为 0）');
  assert.equal(rf2.events.find((e) => e.kind === 'damage' && e.source === 'fall').amount, 1,
    '坠落伤害事件保底 1');

  // 通用牌直伤 1 -> 保底 1；所有伤害事件 amount 恒 >= 1，绝不出现 0 / 负数
  const cp = S(U('aar', 'A', 'archer', { x: 2, y: 2, z: 0 }), U('bg', 'B', 'guardian', { x: 1, y: 1, z: 0 }));
  cp.hands.A = [{ id: 'k1', type: 'powerKnock' }];
  const rp = R.playCard(cp, 'k1', 'bg', 'A');
  assert.equal(rp.ok, true);
  assert.equal(rp.events.find((e) => e.kind === 'damage' && e.source === 'card').amount, 1,
    '通用牌 1 伤保底 1');
  const allDmg = [r, rd, rt, ra, rf, rf2, rp].flatMap((x) => x.events.filter((e) => e.kind === 'damage'));
  assert.ok(allDmg.every((e) => e.amount >= 1), '所有伤害事件 amount >= 1（保底不出现 0 / 负）');
});

// ===========================================================================
// 迭代 6：多层陷阱 / 攀升器 / 防重叠 / 楼梯与召唤点
// ===========================================================================

test('24. 顶层陷阱：可开关；中/顶层同时打开时连续掉到 z=0 并受 1 伤', () => {
  const s = S(
    U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }),
    U('b0', 'B', 'warrior', { x: 0, y: 1, z: 2 }),  // B 可开关顶层陷阱
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 2 }),  // 站在顶层陷阱上
  );
  s.currentPlayer = 'B';
  s.centerTrapOpen = true;                           // 中层已打开
  assert.equal(R.canToggleTrap(s, 'b0', 'B', 2).ok, true, '顶层陷阱可开关');
  const r = R.toggleCenterTrap(s, 'b0', 'B', 2);
  assert.equal(r.ok, true);
  assert.equal(r.state.topTrapOpen, true);
  assert.deepEqual(at(r.state, 'bt').pos, { x: 1, y: 1, z: 0 }, '连续掉到最底层');
  assert.equal(at(r.state, 'bt').hp, 4, '最终落到 z=0 受 1 点坠落伤害');
  assert.equal(r.events.filter((e) => e.kind === 'fall').length, 2, '产生 2 段连续下落事件');
  assert.ok(r.events.some((e) => e.kind === 'toggle' && e.z === 2), 'toggle 事件标注顶层');
  assert.ok(r.state.logs.at(-1).text.B.includes('顶层'), '日志标注顶层陷阱');
  // 中 / 顶层共用「每方每回合 1 次」
  assert.equal(R.canToggleTrap(r.state, 'b0', 'B', 1).ok, false, '双陷阱共用同一次数');
});

test('25. 防重叠方案 B：下层被单位 / 不可破坏装置顶住时卡层、不掉血、不重叠', () => {
  const s = S(
    U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }),
    U('b0', 'B', 'warrior', { x: 0, y: 1, z: 2 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 2 }),
    U('occ', 'A', 'mage', { x: 1, y: 1, z: 0 }),    // 下层中心有人
  );
  s.currentPlayer = 'B';
  s.centerTrapOpen = true;
  const r = R.toggleCenterTrap(s, 'b0', 'B', 2);
  assert.deepEqual(at(r.state, 'bt').pos, { x: 1, y: 1, z: 1 }, '卡在中层陷阱格（悬空）');
  assert.equal(at(r.state, 'bt').hp, 5, '卡中间层不扣坠落伤害');
  assert.ok(r.events.some((e) => e.kind === 'fallBlocked' && e.reason === 'unit'));
  assert.ok(r.state.logs.at(-1).text.A.includes('被下层单位顶住'), '日志文案符合验收要求');
  assert.ok(r.state.logs.at(-1).text.B.includes('被下层单位顶住'), '双方日志都可见');
  const cells = r.state.units.filter((u) => u.alive).map((u) => `${u.pos.x},${u.pos.y},${u.pos.z}`);
  assert.equal(new Set(cells).size, cells.length, '严格防止 Z 轴坐标重叠');
  // 前端能正常渲染「处于中层陷阱格的悬空单位」
  const vB = R.viewFor(r.state, 'B');
  assert.ok(vB.units.some((u) => u.id === 'bt'), '卡在洞口的悬空单位仍下发');

  // 不可破坏装置（草丛）同样顶住上方单位
  const s2 = S(
    U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }),
    U('b0', 'B', 'warrior', { x: 0, y: 1, z: 2 }),
    U('bt', 'B', 'warrior', { x: 1, y: 1, z: 2 }),
  );
  s2.currentPlayer = 'B';
  s2.centerTrapOpen = true;
  s2.devices = [D('grass', 'A', 'grass', { x: 1, y: 1, z: 0 })];
  const r2 = R.toggleCenterTrap(s2, 'b0', 'B', 2);
  assert.deepEqual(at(r2.state, 'bt').pos, { x: 1, y: 1, z: 1 }, '不可破坏装置也能顶住');
  assert.equal(at(r2.state, 'bt').hp, 5);
  assert.ok(r2.events.some((e) => e.kind === 'fallBlocked' && e.reason === 'device'));
});

test('26. 木箱盖住洞口：踩上安全；击退撞碎盖板后顺惯性掉进洞', () => {
  const s = S(
    U('aw', 'A', 'warrior', { x: 1, y: 0, z: 1 }),
    U('b0', 'B', 'warrior', { x: 0, y: 0, z: 2 }),
  );
  s.currentPlayer = 'A';
  const opened = R.toggleCenterTrap(s, 'aw', 'A', 1).state;
  opened.perTurnFlags.placed.A = false;
  const covered = R.placeDevice(opened, 'A', 'crate', { x: 1, y: 1, z: 1 });
  assert.equal(covered.ok, true, '打开的洞口上仍可放置木箱盖板');
  const m = R.moveUnit(covered.state, 'aw', { x: 1, y: 1, z: 1 }, 'A');
  assert.equal(m.ok, true);
  assert.deepEqual(at(m.state, 'aw').pos, { x: 1, y: 1, z: 1 }, '踩在木箱上不掉落');
  assert.equal(at(m.state, 'aw').hp, 5);
  assert.ok(!m.events.some((e) => e.kind === 'fall'), '未触发坠落');

  // 击退撞向盖洞木箱：木箱碎裂、目标受碰撞伤害并顺惯性掉进洞
  const s2 = S(
    U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }),
    U('t', 'B', 'warrior', { x: 0, y: 1, z: 1 }),
  );
  s2.currentPlayer = 'A';
  s2.centerTrapOpen = true;
  s2.devices = [D('cover', 'B', 'crate', { x: 1, y: 1, z: 1 })];
  // 用导出的纯函数模拟「从格子外侧把目标击退向中心洞口」
  const r = R.resolveKnockback(s2, { x: -1, y: 1, z: 1 }, 't', 'A');
  assert.equal(r.ok, true);
  assert.ok(r.events.some((e) => e.kind === 'crateBreak'), '盖板木箱被撞碎');
  assert.ok(r.events.some((e) => e.kind === 'collision' && e.damage === 1), '目标受碰撞伤害');
  assert.deepEqual(at(r.state, 't').pos, { x: 1, y: 1, z: 0 }, '顺惯性掉到底层中心');
  assert.equal(at(r.state, 't').hp, 3, '碰撞 1 + 坠落 1 = 2 伤');
  assert.equal(r.state.devices.length, 0, '木箱已消失');
});

test('27. 攀升器：仅 A 持有、仅底层、进入后额外 1 AP 传送到中层中心', () => {
  const s = R.createInitialState();
  assert.equal(s.inventory.A.climber, 1);
  assert.equal(s.inventory.B.climber, 0, 'B 库存为 0（服务端权威）');
  assert.equal(R.canPlaceDevice(s, 'B', 'climber', { x: 1, y: 1, z: 0 }).ok, false, 'B 不可布置');
  assert.equal(R.canPlaceDevice(s, 'A', 'climber', { x: 1, y: 1, z: 1 }).ok, false, '仅可放底层');
  const pl = R.placeDevice(s, 'A', 'climber', { x: 1, y: 1, z: 0 });
  assert.equal(pl.ok, true);
  assert.equal(pl.state.inventory.A.climber, 0);
  // 开局只有 1 个首发（A-warrior），用它走进攀升器
  const firstId = s.units.find((u) => u.owner === 'A').id;
  const m = R.moveUnit(pl.state, firstId, { x: 1, y: 1, z: 0 }, 'A');
  assert.equal(m.ok, true);
  assert.deepEqual(at(m.state, firstId).pos, CLIMB_TARGET, '传送到中层中心');
  assert.equal(m.state.ap, AP_PER_TURN - 1 - 1 - CLIMB_AP_COST, '布置 + 移动 + 攀升共 3 AP');
  assert.ok(m.events.some((e) => e.kind === 'climb'));
  assert.ok(m.state.logs.at(-1).text.A.includes('攀升器'));

  // 中层陷阱开着时，攀升后立刻按掉落逻辑继续结算
  const s2 = R.createInitialState();
  const pl2 = R.placeDevice(s2, 'A', 'climber', { x: 1, y: 1, z: 0 }).state;
  pl2.centerTrapOpen = true;
  const m2 = R.moveUnit(pl2, firstId, { x: 1, y: 1, z: 0 }, 'A');
  assert.deepEqual(at(m2.state, firstId).pos, { x: 1, y: 1, z: 0 }, '攀升到中层后立即掉回底层');
  assert.equal(at(m2.state, firstId).hp, 4, 'warrior 5 HP，受 1 点坠落伤害');
});

test('28. 楼梯严格坐标配对 + 单点召唤点 + viewFor 下发地形字段', () => {
  // 底层 z=0 与顶层 z=2 各 2 个点位，中层 z=1 只保留同坐标的垂直中转点
  assert.equal(STAIRS.length, 6);
  for (const p of [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, { x: 2, y: 0, z: 2 },
    { x: 0, y: 0, z: 1 }, { x: 2, y: 0, z: 1 }]) {
    assert.equal(R.isStair(p), false, `(${p.x},${p.y},${p.z}) 不再是楼梯`);
  }
  for (const p of [{ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 },
    { x: 0, y: 2, z: 1 }, { x: 2, y: 2, z: 1 },
    { x: 0, y: 2, z: 2 }, { x: 2, y: 2, z: 2 }]) {
    assert.equal(R.isStair(p), true, `(${p.x},${p.y},${p.z}) 保留楼梯`);
  }
  // 只允许同 (x,y) 的配对边，禁止任何错误跨层连通
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 1 }), true, '(0,2,0)<->(0,2,1) 合法');
  assert.equal(R.isStairLink({ x: 2, y: 2, z: 1 }, { x: 2, y: 2, z: 2 }), true, '(2,2,1)<->(2,2,2) 合法');
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 1 }), false, '不同 x 错误跨层被拒');
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 2 }), false, '跨 2 层被拒');
  assert.equal(R.isStairLink({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }), false, '非楼梯点被拒');

  const s = S(U('a', 'A', 'warrior', { x: 0, y: 0, z: 1 }), U('b', 'B', 'warrior', { x: 0, y: 2, z: 2 }));
  s.currentPlayer = 'A';
  assert.equal(R.canMove(s, 'a', { x: 0, y: 0, z: 0 }, 'A').ok, false, '下不到非楼梯的 (0,0,0)');
  assert.equal(R.canMove(s, 'a', { x: 0, y: 0, z: 2 }, 'A').ok, false, '上不到非楼梯的 (0,0,2)');
  const s2 = S(U('a', 'A', 'warrior', { x: 0, y: 2, z: 1 }), U('b', 'B', 'warrior', { x: 0, y: 2, z: 2 }));
  s2.currentPlayer = 'A';
  assert.equal(R.canMove(s2, 'a', { x: 0, y: 2, z: 0 }, 'A').ok, true, '按坐标配对可下楼');
  assert.equal(R.canMove(s2, 'a', { x: 0, y: 2, z: 2 }, 'A').ok, false, '目标格被单位占据时不可上楼');

  const init = R.createInitialState();
  const v = R.viewFor(init, 'A');
  assert.equal(v.topTrapOpen, false);
  assert.equal(v.stairs.length, 6, 'viewFor 下发 6 个严格楼梯坐标');
  assert.equal(v.trapCells.length, 2, 'viewFor 下发中 / 顶层两个陷阱格');
  assert.deepEqual(v.trapCells[1], { ...TOP_TRAP });
  assert.equal(R.viewFor(init, 'B').stairs.length, 6, '地形是公开信息，B 视角同样下发');
  assert.equal(R.canSummon(init, 'A', 'mage', { x: 1, y: 1, z: 1 }).ok, false, '不能在非己方初始层召唤');
  const forB = R.createInitialState(); forB.currentPlayer = 'B';
  assert.equal(R.canSummon(forB, 'B', 'mage', { x: 0, y: 0, z: 2 }).ok, true,
    '最终版：B 顶层任意合法空格都能召唤（不再是单点）');
});

test('29. handleFall(unitId, startZ)：卡中间层不受伤、落地 z=0 受 1 伤、有盖板不触发', () => {
  // 被下层单位顶住 -> 停在中层、不掉血
  const s = S(
    U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }),
    U('t', 'B', 'warrior', { x: 1, y: 1, z: 2 }),
    U('occ', 'A', 'mage', { x: 1, y: 1, z: 0 }),
  );
  s.topTrapOpen = true; s.centerTrapOpen = true;
  const events = [];
  R.handleFall(s, 't', 2, events);
  assert.deepEqual(at(s, 't').pos, { x: 1, y: 1, z: 1 }, '被下层单位顶住，停在中层');
  assert.equal(at(s, 't').hp, 5, '卡中间层不掉血');
  assert.ok(events.some((e) => e.kind === 'fallBlocked'));

  // 无阻挡 -> 连续下落 2 层，落地受 1 伤
  const s2 = S(U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }), U('t', 'B', 'warrior', { x: 1, y: 1, z: 2 }));
  s2.topTrapOpen = true; s2.centerTrapOpen = true;
  const ev2 = [];
  R.handleFall(s2, 't', 2, ev2);
  assert.deepEqual(at(s2, 't').pos, { x: 1, y: 1, z: 0 });
  assert.equal(at(s2, 't').hp, 4, '落地受 1 点坠落伤害');
  assert.equal(ev2.filter((e) => e.kind === 'fall').length, 2, '连续下落 2 层');

  // 有木箱支撑（盖板）时根本不触发下落
  const s3 = S(U('a0', 'A', 'warrior', { x: 0, y: 0, z: 0 }), U('t', 'B', 'warrior', { x: 1, y: 1, z: 2 }));
  s3.topTrapOpen = true;
  s3.devices = [D('c', 'A', 'crate', { x: 1, y: 1, z: 2 })];
  const ev3 = [];
  R.handleFall(s3, 't', 2, ev3);
  assert.deepEqual(at(s3, 't').pos, { x: 1, y: 1, z: 2 }, '木箱支撑时不触发下落');
  assert.equal(ev3.length, 0);
});

// ===========================================================================
// 迭代 8：纯战棋平A流 —— 剥离所有主动技能 / 专属卡，法师终极削弱 + 全局平衡
// ===========================================================================

test('30. 六职业纯被动最终设定 + 无任何专属卡 / 主动技能 + 开局 5 张通用牌', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CLASSES).map(([k, c]) => [k, {
      hp: c.hp, atk: c.atk, range: c.range, knock: c.knock, splash: c.splash,
    }])),
    {
      warrior:  { hp: 5, atk: 2, range: 1, knock: true,  splash: 0 },
      archer:   { hp: 3, atk: 2, range: 2, knock: true,  splash: 0 },
      mage:     { hp: 3, atk: 1, range: 2, knock: false, splash: 1 },
      assassin: { hp: 3, atk: 2, range: 1, knock: false, splash: 0 },
      priest:   { hp: 4, atk: 0, range: 2, knock: false, splash: 0 },
      guardian: { hp: 7, atk: 1, range: 1, knock: true,  splash: 0 },
    },
    '六职业 HP / 攻击 / 射程 / 击退 / 溅射 与最终设定完全一致',
  );
  // 天生被动特性（没有一个是「主动技能」）
  assert.equal(CLASSES.archer.vision, 'fullLayer', '弓手：同层全图视野');
  assert.equal(CLASSES.assassin.noKnockback, true, '刺客：无击退');
  assert.equal(CLASSES.assassin.refreshOnKill, true, '刺客：击杀刷新攻击');
  assert.equal(CLASSES.priest.healOnly, true, '牧师：纯治疗');
  assert.equal(CLASSES.priest.heal, 2, '牧师：回 2 HP');
  assert.equal(CLASSES.guardian.collisionBonus, 1, '盾卫吨位：碰撞 +1');
  assert.equal(CLASSES.guardian.damageReduction, true, '盾卫坚韧');

  // 最终版：无任何职业专属卡 / 主动技能；牌库 = 3 通用 + 致盲烟雾 + 6 装置卡
  assert.equal(CARD_POOL.length, 10);
  assert.deepEqual(Object.keys(CARDS).sort(), [...CARD_POOL].sort());
  assert.ok(['smoke', 'crate', 'grass', 'trap', 'portal', 'arrowTrap', 'climber']
    .every((t) => CARD_POOL.includes(t)), '致盲烟雾与 6 张装置卡都已入公共牌库');
  assert.ok(Object.values(CLASSES).every((c) =>
    !('skill' in c) && !('activeSkill' in c) && !('signatureCard' in c) && !('castCost' in c)),
    '职业配置里不存在任何主动技能 / 专属卡字段');
  assert.equal(INITIAL_HAND_SIZE, 5, '开局发 5 张通用牌');
  const s = R.createInitialState();
  assert.equal(s.hands.A.length, 5);
  assert.equal(s.hands.B.length, 5);
  assert.ok([...s.hands.A, ...s.hands.B].every((c) => CARD_POOL.includes(c.type)),
    '开局手牌全部是通用牌');
});

test('31. 法师无差别溅射：只打同层正交相邻、含友军、含盾卫减伤、自伤排除、全场不后退', () => {
  const s = S(
    U('am', 'A', 'mage',     { x: 0, y: 1, z: 0 }),
    U('bt', 'B', 'warrior',  { x: 1, y: 1, z: 0 }),  // 主目标
    U('be', 'B', 'guardian', { x: 1, y: 0, z: 0 }),  // 相邻敌方盾卫（坚韧 1 伤保底 1）
    U('af', 'A', 'warrior',  { x: 2, y: 1, z: 0 }),  // 相邻友军
    U('ad', 'A', 'warrior',  { x: 1, y: 1, z: 1 }),  // 同 x/y 但跨层 -> 不入列
    U('ax', 'A', 'warrior',  { x: 2, y: 2, z: 0 }),  // 对角 -> 不入列
  );
  const r = R.resolveAttack(s, 'am', 'bt', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'bt').hp, 4, '主目标 -1');
  assert.equal(at(r.state, 'be').hp, 6, '相邻敌方盾卫 7 - 1 = 6（坚韧保底 1）');
  assert.equal(at(r.state, 'af').hp, 4, '相邻友军 -1（无差别溅射伤及友军）');
  assert.equal(at(r.state, 'ad').hp, 5, '跨层单位不受溅射');
  assert.equal(at(r.state, 'ax').hp, 5, '对角单位不受溅射');
  assert.equal(at(r.state, 'am').hp, 3, '施法者本人不受自伤');
  assert.equal(r.events.filter((e) => e.kind === 'damage' && e.source === 'splash').length, 2,
    '溅射恰好命中 2 个同层正交相邻单位');
  assert.ok(!r.events.some((e) => e.kind === 'knockback' || e.kind === 'knockbackMove'),
    '主目标与所有溅射目标全不后退');
  assert.deepEqual(at(r.state, 'bt').pos, { x: 1, y: 1, z: 0 });
  assert.deepEqual(at(r.state, 'be').pos, { x: 1, y: 0, z: 0 });
  assert.deepEqual(at(r.state, 'af').pos, { x: 2, y: 1, z: 0 });
});

test('32. 盾卫坚韧公式：1 伤->1、2 伤->1、3 伤->2，绝不扣 0 / 负数', () => {
  // 1 伤：弩箭机关（验收「被射中必定扣 1 血」）
  const s1 = S(U('aw', 'A', 'warrior', { x: 2, y: 2, z: 0 }), U('bg', 'B', 'guardian', { x: 0, y: 1, z: 0 }));
  s1.currentPlayer = 'B';
  s1.devices = [D('ar1', 'A', 'arrowTrap', { x: 0, y: 0, z: 0 })];
  const r1 = R.moveUnit(s1, 'bg', { x: 0, y: 0, z: 0 }, 'B');
  assert.equal(at(r1.state, 'bg').hp, 6, '1 伤 -> 1（7 -> 6）');

  // 2 伤：战士普攻 2（击退到空格，避免额外碰撞干扰）
  const s2 = S(U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }), U('bg', 'B', 'guardian', { x: 1, y: 1, z: 0 }));
  const r2 = R.resolveAttack(s2, 'aw', 'bg', 'A');
  assert.equal(r2.events.find((e) => e.kind === 'damage' && e.source === 'attack').amount, 1,
    '2 伤 -> 1（验收「被 2 点伤害攻击必定扣 1 血」）');
  assert.equal(at(r2.state, 'bg').hp, 6, '7 -> 6');

  // 3 伤 -> 2：临时把战士攻击设为 3 以验证公式上界（finally 恢复，不污染其它用例）
  const saved = CLASSES.warrior.atk;
  CLASSES.warrior.atk = 3;
  try {
    const s3 = S(U('aw', 'A', 'warrior', { x: 0, y: 1, z: 0 }), U('bg', 'B', 'guardian', { x: 1, y: 1, z: 0 }));
    const r3 = R.resolveAttack(s3, 'aw', 'bg', 'A');
    assert.equal(r3.events.find((e) => e.kind === 'damage' && e.source === 'attack').amount, 2,
      '3 伤 -> 2');
    assert.equal(at(r3.state, 'bg').hp, 5, '7 - 2 = 5');
  } finally {
    CLASSES.warrior.atk = saved;
  }

  // 所有真实伤害事件恒 >= 1，绝不出现 0 / 负数
  const allDmg = [r1, r2].flatMap((x) => x.events.filter((e) => e.kind === 'damage'));
  assert.ok(allDmg.every((e) => e.amount >= 1), '保底扣血：伤害事件 amount 恒 >= 1');
  assert.equal(GUARDIAN_FLAT_REDUCTION, 1);
  assert.equal(GUARDIAN_MIN_DAMAGE, 1);
  for (const n of [1, 2, 3, 5, 10]) {
    assert.ok(Math.max(GUARDIAN_MIN_DAMAGE, n - GUARDIAN_FLAT_REDUCTION) >= 1,
      `${n} 伤的保底结果 >= 1（不会算出 0 或负）`);
  }
});

test('33. 其余职业保持现状：刺客击杀刷新后可再攻击/移动、牧师点敌人不可攻击、弓手全图视野', () => {
  // 保留另一个存活敌人，避免击杀后 B 全灭触发 checkWin 结束游戏
  const s = S(
    U('ak', 'A', 'assassin', { x: 0, y: 1, z: 0 }),
    U('bm', 'B', 'mage', { x: 1, y: 1, z: 0 }, 2),
    U('bz', 'B', 'warrior', { x: 0, y: 0, z: 0 }),
  );
  const r = R.resolveAttack(s, 'ak', 'bm', 'A');
  assert.equal(r.ok, true);
  assert.equal(at(r.state, 'ak').hasAttacked, false, '击杀后立刻刷新攻击状态');
  assert.equal(R.canAttack(r.state, 'ak', 'bz', 'A').ok, true, '可立即再攻击另一个敌人');
  assert.equal(R.canMove(r.state, 'ak', { x: 1, y: 1, z: 0 }, 'A').ok, true, '也可继续移动');

  const p = S(U('ap', 'A', 'priest', { x: 0, y: 1, z: 0 }),
    U('bw', 'B', 'warrior', { x: 1, y: 1, z: 0 }),
    U('aw', 'A', 'warrior', { x: 0, y: 0, z: 0 }, 2));
  assert.equal(R.canAttack(p, 'ap', 'bw', 'A').ok, false, '牧师点击敌人无法攻击');
  const rp = R.resolveAttack(p, 'ap', 'aw', 'A');
  assert.equal(rp.ok, true, '牧师点击友军可以治疗');
  assert.equal(at(rp.state, 'aw').hp, 4, '回复 2 HP（2 -> 4）');

  const v = S(U('aar', 'A', 'archer', { x: 1, y: 1, z: 0 }), U('bw2', 'B', 'warrior', { x: 0, y: 0, z: 0 }));
  assert.ok(R.unitVision(v, at(v, 'aar')).length >= 9, '弓手同层全图视野');
});

// ===========================================================================
// 最终版（v2）：战争迷雾 / 致盲烟雾 / 装置卡牌 / 主动抽牌 / 观战
// ===========================================================================

test('34. 战争迷雾：视野外敌方单位/装置不下发，观战者继承被观战方迷雾视野', () => {
  const s = S(
    U('aa', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('bh', 'B', 'warrior', { x: 2, y: 0, z: 2 }),   // A 视野外
    U('ba', 'B', 'archer',  { x: 1, y: 1, z: 0 }),   // A 战士十字视野内
  );
  s.devices = [D('dt', 'B', 'trap', { x: 2, y: 2, z: 2 })];
  const vA = R.viewFor(s, 'A');
  assert.equal(vA.units.some((u) => u.id === 'bh'), false, '视野外敌方单位绝对不可见');
  assert.equal(vA.devices.some((d) => d.id === 'dt'), false, '视野外敌方装置绝对不可见');
  assert.ok(vA.units.some((u) => u.id === 'ba'), '视野内敌方单位可见');
  assert.ok(vA.visionCells.length > 0 && vA.visionCells.length < 27, '视野是可见子集而非全图');

  // 观战者：viewFor(state, side) 与玩家视图完全一致（隐藏信息同样不下发）
  const specA = R.viewFor(s, 'A', { spectating: true, mySide: 'A' });
  assert.deepEqual(specA.units, vA.units, '观战 A 看到与 A 相同的单位');
  assert.deepEqual(specA.devices, vA.devices, '观战 A 看到与 A 相同的装置');
  assert.deepEqual(specA.visionCells, vA.visionCells, '观战者继承所观战玩家的迷雾视野');
  assert.equal(specA.spectating, true);
  assert.equal(specA.mySide, 'A');
  const specB = R.viewFor(s, 'B', { spectating: true, mySide: 'B' });
  assert.ok(specB.units.some((u) => u.id === 'bh'), '观战 B 能看到 B 的顶层单位');
  assert.notDeepEqual(specB.visionCells, vA.visionCells, '观战 A / B 的视野互不相同');
});

test('35. 致盲烟雾：1 费、选任意可见格、同层 3x3、2 回合、雾中敌方视野降为 1 格', () => {
  const s = S(
    U('aa', 'A', 'warrior', { x: 0, y: 1, z: 0 }),
    U('ba', 'B', 'archer',  { x: 0, y: 0, z: 0 }),   // 雾中 B 单位，原本全层视野
  );
  const before = R.unitVision(s, at(s, 'ba')).length;
  assert.ok(before > 9, '弓手原本有全层 + 楼梯扩展视野');

  s.hands.A = [{ id: 'sm1', type: 'smoke' }];
  const center = { x: 0, y: 1, z: 0 };
  assert.equal(R.canPlayCard(s, 'sm1', null, 'A', center).ok, true, '可见格可释放烟雾');
  assert.equal(R.canPlayCard(s, 'sm1', null, 'A', { x: 1, y: 1, z: 2 }).ok, false,
    '视野外的格子不可选');
  const r = R.playCard(s, 'sm1', null, 'A', center);
  assert.equal(r.ok, true);
  assert.equal(r.state.ap, AP_PER_TURN - 1, '消耗 1 AP');
  assert.equal(r.state.smokes[0].turnsLeft, SMOKE_DURATION);
  assert.equal(r.state.smokes[0].cells.length, 6, '边缘中心 3x3 裁掉越界后 6 格');
  assert.equal(r.state.discards.A.length, 1, '卡牌飞入弃牌堆');
  assert.equal(R.viewFor(r.state, 'A').smokeCells.length, 6);

  // 雾中 B 单位：视野从全层收缩为「自身周围 1 格」
  const after = R.unitVision(r.state, at(r.state, 'ba')).length;
  assert.equal(after, 4, '雾中敌方单位视野降为周围 1 格（角落 2x2=4）');
  assert.ok(after < before);
  assert.ok(R.viewFor(r.state, 'B').visionCells.length <= 4, '黑雾同时遮蔽受制方远处格');

  const t1 = R.endTurn(r.state, 'A').state;
  assert.equal(t1.smokes[0].turnsLeft, 1, '经过 1 回合剩 1');
  const t2 = R.endTurn(t1, 'B').state;
  assert.equal(t2.smokes.length, 0, '持续 2 回合后消散');
  assert.equal(R.viewFor(t2, 'A').smokeCells.length, 0);
});

test('36. 装置卡牌化：扣 1 AP、黄格合法目标、点击落装置、卡牌进弃牌堆、攀升器仅 A', () => {
  assert.equal(Object.keys(DEVICE_CARDS).length, 6, '6 种装置都已卡牌化');
  const fresh = R.createInitialState();
  assert.equal(fresh.hands.A.some((c) => c.type === 'climber'), true, '攀升器只加入 A 的初始牌库');
  assert.equal(fresh.hands.B.some((c) => c.type === 'climber'), false, 'B 初始牌库无攀升器');

  // 用弓手扩大同层视野，保证有足够「可见合法放置格」以验证同回合连续多张
  const s = R.createInitialState();
  for (const u of s.units) if (u.owner === 'A') u.class = 'archer';
  s.hands.A = [
    { id: 'dc1', type: 'crate' }, { id: 'dc2', type: 'crate' }, { id: 'dc3', type: 'grass' },
  ];
  const pos = { x: 0, y: 0, z: 0 };
  const hints = R.buildHints(s, 'A');
  assert.ok(hints.cardCells['dc1'].some((p) => p.x === 0 && p.y === 0 && p.z === 0),
    '服务端下发黄色合法放置格');
  const r = R.playCard(s, 'dc1', null, 'A', pos);
  assert.equal(r.ok, true);
  assert.ok(r.state.devices.some((d) => d.type === 'crate' &&
    d.pos.x === 0 && d.pos.y === 0 && d.pos.z === 0), '点击黄格后装置落地');
  assert.equal(r.state.ap, AP_PER_TURN - 1);
  assert.equal(r.state.discards.A.length, 1, '卡牌飞入弃牌堆');
  assert.equal(R.viewFor(r.state, 'A').discardTop, '木箱');
  assert.equal(r.state.perTurnFlags.skillCardUsed.A, false, '打出装置牌不占用技能牌限额');

  // 最终版 v4：装置牌无单回合数量上限 —— 只要 AP 够，同一回合可连续打出并正常放置
  let multi = r.state;
  for (const [id, type] of [['dc2', 'crate'], ['dc3', 'grass']]) {
    const cell = (R.buildHints(multi, 'A').cardCells[id] || [])
      .find((p) => R.canPlayCard(multi, id, null, 'A', p).ok);
    assert.ok(cell, `${type} 仍有可见合法放置格`);
    const step = R.playCard(multi, id, null, 'A', cell);
    assert.equal(step.ok, true, `装置牌 ${type} 不受「每回合 1 张」限制，可连续打出`);
    multi = step.state;
    assert.equal(multi.perTurnFlags.skillCardUsed.A, false, '装置牌从不设置技能牌标记');
  }
  assert.equal(multi.devices.length, 3, '3 张装置牌全部正常落地');
  assert.equal(multi.discards.A.length, 3, '3 张卡全部飞入弃牌堆');
  assert.equal(multi.ap, AP_PER_TURN - 3, '每张装置牌独立扣 1 AP');

  // B 即便伪造持有攀升器卡，服务端也拒绝（仅 A 可用）
  const sb = R.createInitialState();
  sb.currentPlayer = 'B';
  sb.hands.B = [{ id: 'cl2', type: 'climber' }];
  assert.equal(R.canPlayCard(sb, 'cl2', null, 'B', { x: 0, y: 0, z: 2 }).ok, false,
    '攀升器卡对 B 不可用');
});

test('37. 主动抽牌：自动抽 2 张、点牌库 1 AP 抽 1 张、手牌上限严格 5 张', () => {
  assert.equal(DRAW_PER_TURN, 2, '每回合自动抽 2 张');
  assert.equal(DRAW_CARD_COST, 1, '主动抽牌消耗 1 AP');
  assert.equal(HAND_LIMIT, 5);
  const s = R.createInitialState();
  assert.equal(s.hands.A.length, 5, '开局 5 张');
  assert.equal(R.drawCard(s, 'A').ok, false, '满手 5 张不能主动抽');

  s.hands.A.pop(); s.hands.A.pop();   // 模拟打出 2 张 -> 3 张
  const d = R.drawCard(s, 'A');
  assert.equal(d.ok, true);
  assert.equal(d.state.hands.A.length, 4);
  assert.equal(d.state.ap, AP_PER_TURN - 1);
  assert.equal(d.state.decks.A, s.decks.A - 1, '牌库计数 -1');
  assert.equal(R.viewFor(d.state, 'A').deckCount, d.state.decks.A);

  const t1 = R.endTurn(d.state, 'A').state;  // B 满手，不抽
  const t2 = R.endTurn(t1, 'B').state;       // A 4 张 -> 自动抽 2 张但上限 5
  assert.equal(t2.hands.A.length, 5, '自动抽 2 张受严格上限 5 约束');
  assert.ok(t2.hands.A.every((c) => CARD_POOL.includes(c.type)), '抽到的仍是牌库内的卡');
});

test('38. PlayerView 最终版字段：黑雾 / 牌库 / 弃牌堆 / canDraw / homeLayer / spectating', () => {
  const s = R.createInitialState();
  const v = R.viewFor(s, 'A');
  assert.ok(Array.isArray(v.smokes) && Array.isArray(v.smokeCells));
  assert.equal(v.smokeCells.length, 0);
  assert.equal(typeof v.deckCount, 'number');
  assert.equal(v.discardCount, 0);
  assert.equal(v.discardTop, null);
  assert.equal(v.homeLayer, 0, 'A 初始层 z=0');
  assert.equal(R.viewFor(s, 'B').homeLayer, 2, 'B 初始层 z=2');
  assert.equal(v.spectating, false);
  assert.equal(typeof v.canDraw, 'boolean');
  assert.ok(v.hand.every((c) => 'device' in c), '手牌带 device 字段（装置卡）');
  assert.equal(typeof v.hints.canDraw, 'boolean', 'hints 下发 canDraw');
  assert.ok(v.hints.cardCells instanceof Object, 'hints 下发 cardCells（黄格）');

  // picking 阶段同样带齐字段，避免前端读到 undefined
  const p = R.viewFor(R.createPickingState(), 'A');
  assert.ok(Array.isArray(p.smokeCells));
  assert.equal(typeof p.deckCount, 'number');
  assert.equal(p.spectating, false);
});

test('39. 最终版 v3 修复总验收：1 首发 / 预备池锁死 / 换手 AP=5 / 楼梯严格配对 / 卡牌落地不变', () => {
  const lineup = { A: ['assassin', 'priest', 'guardian'], B: ['mage', 'archer', 'warrior'] };
  const s = R.createInitialState(11, lineup);

  // 任务二：开局只生成 1 个首发 + 固定坐标
  assert.equal(s.units.length, 2);
  assert.deepEqual(s.units.find((u) => u.owner === 'A').pos, { x: 0, y: 1, z: 0 });
  assert.deepEqual(s.units.find((u) => u.owner === 'B').pos, { x: 2, y: 1, z: 2 });
  assert.equal(s.units.find((u) => u.owner === 'A').class, 'assassin', '首发 = 预选第 0 个');
  assert.equal(s.units.some((u) => u.class === 'priest' || u.class === 'guardian'), false,
    '其余预选单位开局不生成在战场');

  // 任务三：预备池只有预选的另外 2 个，名单外 / 首发都不可召唤
  const pool = R.reserveEntries(s, 'A');
  assert.deepEqual(pool.map((e) => e.cls), ['priest', 'guardian']);
  assert.equal(R.canSummon(s, 'A', 'warrior', { x: 1, y: 1, z: 0 }).ok, false, '名单外单位被拒');
  assert.equal(R.canSummon(s, 'A', 'assassin', { x: 1, y: 1, z: 0 }).ok, false, '首发不可重复召唤');
  assert.equal(R.summonUnit(s, 'A', 'warrior', { x: 1, y: 1, z: 0 }).ok, false);

  // 任务四：开局 AP=5，绝不出现 0
  assert.equal(s.ap, AP_PER_TURN);
  assert.equal(R.viewFor(s, 'A').ap, AP_PER_TURN);

  const r1 = R.summonUnit(s, 'A', pool[0].key, { x: 1, y: 1, z: 0 });
  assert.equal(r1.ok, true);
  assert.equal(r1.state.reserve.A, 1);
  assert.equal(R.reserveEntries(r1.state, 'A')[0].used, true, '标记【已召唤】');
  assert.equal(R.summonUnit(r1.state, 'A', pool[0].key, { x: 0, y: 0, z: 0 }).ok, false, '该名额整局锁死');
  assert.equal(R.summonUnit(r1.state, 'A', 'priest', { x: 0, y: 0, z: 0 }).ok, false, '同职业不能重复召唤');

  const t1 = R.endTurn(r1.state, 'A').state;
  assert.equal(t1.currentPlayer, 'B');
  assert.equal(t1.ap, AP_PER_TURN, 'B 新回合 AP 立刻重置为 5');
  const t2 = R.endTurn(t1, 'B').state;
  assert.equal(t2.currentPlayer, 'A');
  assert.equal(t2.ap, AP_PER_TURN, 'A 新回合 AP 立刻重置为 5');
  const r2 = R.summonUnit(t2, 'A', pool[1].key, { x: 0, y: 0, z: 0 });
  assert.equal(r2.ok, true, '第二个名额可以召唤');
  assert.equal(r2.state.reserve.A, 0);
  assert.equal(r2.state.units.filter((u) => u.owner === 'A' && u.alive).length, 3, '场上最多 3 个');
  assert.equal(R.summonUnit(r2.state, 'A', null, { x: 2, y: 2, z: 0 }).ok, false, '预备池空后不能再召唤');

  // 任务五：楼梯点位严格限制 + 只按坐标配对连通
  assert.equal(STAIRS.length, 6);
  assert.equal(R.isStair({ x: 0, y: 0, z: 1 }), false, '移除多余的中层错误点');
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 1 }), true);
  assert.equal(R.isStairLink({ x: 2, y: 2, z: 1 }, { x: 2, y: 2, z: 2 }), true);
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 1 }), false, '禁止错误跨层连通');
  assert.equal(R.isStairLink({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 2 }), false, '禁止跨 2 层');

  // 前置前提：卡牌打出 / 放置落地逻辑完全不变
  const cs = R.createInitialState();
  cs.hands.A = [{ id: 'v3c1', type: 'crate' }];
  const pc = R.playCard(cs, 'v3c1', null, 'A', { x: 0, y: 0, z: 0 });
  assert.equal(pc.ok, true, '装置卡仍可打出并落地');
  assert.ok(pc.state.devices.some((d) => d.type === 'crate' &&
    d.pos.x === 0 && d.pos.y === 0 && d.pos.z === 0), '装置落在选中的黄格');
  assert.equal(pc.state.discards.A.length, 1, '卡牌仍飞入弃牌堆');
});

test('41. 最终版 v4：分类出牌限额 —— 装置牌无限量 / 技能牌每回合 1 张 / 新回合刷新 / AP 独立校验', () => {
  // ---- 分类常量（服务端唯一权威） ----
  assert.equal(Object.keys(DEVICE_CARDS).length, 6, '6 张装置牌');
  assert.equal(SKILL_CARDS.length, 4, '4 张技能牌');
  assert.ok(SKILL_CARDS.every((t) => isSkillCardType(t)));
  assert.ok(Object.keys(DEVICE_CARDS).every((t) => isDeviceCardType(t) && !isSkillCardType(t)));
  assert.equal(isSkillCardType('smoke'), true, '致盲烟雾是技能牌（非放置装置）');

  // 取「服务端真实可打出」的可见合法格；弓手扩大同层视野保证格数充足
  const okCell = (s, id) => (R.buildHints(s, 'A').cardCells[id] || [])
    .find((p) => R.canPlayCard(s, id, null, 'A', p).ok);
  const wide = () => {
    const s = R.createInitialState();
    for (const u of s.units) if (u.owner === 'A') u.class = 'archer';
    return s;
  };

  // ---- 1) 装置牌：同回合连续 3 张全部成功、每张独立扣 AP、不置技能牌标记 ----
  let dev = wide();
  dev.hands.A = [
    { id: 'v4d1', type: 'crate' }, { id: 'v4d2', type: 'crate' }, { id: 'v4d3', type: 'grass' },
  ];
  assert.equal(dev.perTurnFlags.skillCardUsed.A, false, '开局技能牌标记为空');
  for (const [id, type] of [['v4d1', 'crate'], ['v4d2', 'crate'], ['v4d3', 'grass']]) {
    const cell = okCell(dev, id);
    assert.ok(cell, `${type} 有可见合法放置格`);
    const r = R.playCard(dev, id, null, 'A', cell);
    assert.equal(r.ok, true, `装置牌 ${type} 同回合可连续打出`);
    dev = r.state;
    assert.equal(dev.perTurnFlags.skillCardUsed.A, false, '装置牌从不设置技能牌标记');
  }
  assert.equal(dev.devices.length, 3, '3 张装置牌全部正常落地（放置逻辑未变）');
  assert.equal(dev.discards.A.length, 3, '3 张卡全部飞入弃牌堆');
  assert.equal(dev.ap, AP_PER_TURN - 3, '每张独立扣 1 AP');

  // ---- 2) 技能牌：每回合最多 1 张，成功打出后置标记并阻止后续技能牌 ----
  const sk = R.createInitialState();
  sk.hands.A = [
    { id: 'v4k1', type: 'insight' }, { id: 'v4k2', type: 'insight' },
    { id: 'v4dd', type: 'crate' },
  ];
  const p1 = R.playCard(sk, 'v4k1', undefined, 'A');
  assert.equal(p1.ok, true, '打出第 1 张技能牌');
  assert.equal(p1.state.perTurnFlags.skillCardUsed.A, true, '设置本回合技能牌已使用标记');
  const p2 = R.canPlayCard(p1.state, 'v4k2', undefined, 'A');
  assert.equal(p2.ok, false, '同回合第 2 张技能牌被阻止');
  assert.match(p2.error, /技能牌/);
  // 两类限额互不干扰：技能牌用掉后，装置牌仍可正常打出并放置
  const dcell = okCell(p1.state, 'v4dd');
  assert.ok(dcell, '装置牌仍有可见合法格');
  const p3 = R.playCard(p1.state, 'v4dd', null, 'A', dcell);
  assert.equal(p3.ok, true, '技能牌限额不影响装置牌');
  assert.equal(p3.state.devices.length, 1, '装置牌仍正常落地');
  assert.equal(p3.state.perTurnFlags.skillCardUsed.A, true, '装置牌不清除技能牌标记');

  // ---- 3) 新回合刷新：重置标记，玩家重新获得 1 次技能牌机会 ----
  const n1 = R.endTurn(p3.state, 'A').state;
  const n2 = R.endTurn(n1, 'B').state;
  assert.equal(n2.currentPlayer, 'A');
  assert.equal(n2.ap, AP_PER_TURN);
  assert.equal(n2.perTurnFlags.skillCardUsed.A, false, '切新回合重置技能牌已使用标记');
  n2.hands.A = [{ id: 'v4k3', type: 'insight' }];
  assert.equal(R.canPlayCard(n2, 'v4k3', undefined, 'A').ok, true,
    '新回合重新获得一次技能牌机会');
  assert.equal(R.viewFor(n2, 'A').perTurnFlags.skillCardUsed, false);
  assert.equal(R.buildHints(n2, 'A').canPlaySkill, true);
  assert.equal(R.buildHints(n2, 'A').canPlay, true);

  // ---- 4) AP 校验每张独立：AP 不足时装置牌同样被拒（限额之外） ----
  const ap = wide();
  ap.ap = 1;
  ap.hands.A = [{ id: 'v4a1', type: 'crate' }, { id: 'v4a2', type: 'crate' }];
  const a1 = R.playCard(ap, 'v4a1', null, 'A', okCell(ap, 'v4a1'));
  assert.equal(a1.ok, true, 'AP=1 时第 1 张装置牌可打');
  const a2 = R.canPlayCard(a1.state, 'v4a2', null, 'A',
    okCell(a1.state, 'v4a2') || { x: 0, y: 0, z: 0 });
  assert.equal(a2.ok, false, 'AP 归零后第 2 张装置牌被拒');
  assert.match(a2.error, /AP 不足/);

  // ---- 5) viewFor / buildHints 正确下发新字段 ----
  const v = R.viewFor(p1.state, 'A');
  assert.equal(v.perTurnFlags.skillCardUsed, true);
  assert.equal(v.hints.canPlaySkill, false, '技能牌已用完');
  assert.equal(v.hints.canPlay, true, '但 AP 与手牌仍允许打装置牌');
  assert.ok((v.hints.cardCells['v4dd'] || []).length > 0,
    '技能牌用掉后装置牌仍有黄色合法格，两类限额互不干扰');
});
