// ============================================================================
// shared/rules.js —— 纯函数规则层（服务端唯一权威）
//
// 约定：
//   * 所有 action 函数签名 (state, ...args, player) -> { ok, state?, events?, error? }
//   * 函数内部先 structuredClone(state)，绝不修改入参；返回的新 state 可直接赋值。
//   * canXxx 只做校验，返回 { ok, error }。
//   * 前端不 import 本文件；前端只渲染 viewFor() 产出的 PlayerView 并发送操作意图。
// ============================================================================

import {
  GRID, LAYERS, ALL_CELLS,
  AP_PER_TURN, MOVE_COST, ATTACK_COST, TOGGLE_COST, PLACE_COST, SUMMON_COST,
  MAX_HALF_TURNS, MAX_UNITS_ON_FIELD, RESERVE_PER_PLAYER,
  CLASSES, DEVICES, CENTER_TRAP, TOP_TRAP, FALL_TARGET, CLIMB_TARGET,
  CLIMB_AP_COST, TRAP_LAYERS, STAIRS, STAIR_LINKS, FIRST_SPAWN,
  COLLISION_DAMAGE, FALL_DAMAGE, TRAP_DAMAGE, SPLASH_DAMAGE, ARROW_TRAP_DAMAGE,
  CRATE_ADVANCE_ON_BREAK, ALLOW_PLACE_ON_CLOSED_CENTER,
  INITIAL_POSITIONS, INITIAL_CLASSES, SUMMON_POINTS,
  CLASS_POOL, PICK_SIZE, GUARDIAN_FLAT_REDUCTION, GUARDIAN_MIN_DAMAGE,
  CARD_COST, HAND_LIMIT, INITIAL_HAND_SIZE, DRAW_PER_TURN, DRAW_CARD_COST,
  DECK_SIZE, SMOKE_DURATION, SMOKE_RADIUS, DEVICE_CARDS, A_ONLY_CARDS, HOME_LAYER,
  isDeviceCardType,
  HEAL_AMOUNT, INSIGHT_AP, POWER_KNOCK_DAMAGE, POWER_KNOCK_DISTANCE,
  POWER_KNOCK_EXTRA_COLLISION, CARDS, CARD_POOL,
  CLASS_NAMES, DEVICE_NAMES, CARD_NAMES, PLAYER_NAMES,
  CLASS_COLORS, CLASS_ICONS, CLASS_TRAITS,
} from './constants.js';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export const key = (p) => `${p.x},${p.y},${p.z}`;
export const parseKey = (k) => {
  const [x, y, z] = k.split(',').map(Number);
  return { x, y, z };
};
export const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
export const inBounds = (p) =>
  !!p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z) &&
  p.x >= 0 && p.x < GRID && p.y >= 0 && p.y < GRID && p.z >= 0 && p.z < LAYERS;
/** 几何上的角格（仅用于展示，楼梯集合已不再等于全部角格） */
export const isCorner = (p) => p.x !== 1 && p.y !== 1; // (0,0)(0,2)(2,0)(2,2)
// 迭代 6：楼梯改为服务端权威的显式坐标集合（STAIRS）。
// canMove / canAttack / 视野扩展都通过 isStair 取「目标层对应坐标是否真是楼梯」。
const STAIR_KEYS = new Set(STAIRS.map(key));
export const isStair = (p) => !!p && STAIR_KEYS.has(key(p));

/**
 * 严格楼梯连通：只有 STAIR_LINKS 白名单里列出的「同 (x,y)、相邻层」两端才允许上下。
 * 任意其它跨层组合（含斜角、非配对点、跨 2 层）一律 false，杜绝错误跨层连通。
 */
export const isStairLink = (a, b) => {
  if (!isStair(a) || !isStair(b)) return false;
  if (Math.abs(a.z - b.z) !== 1 || a.x !== b.x || a.y !== b.y) return false;
  return STAIR_LINKS.some(([p, q]) =>
    (same(p, a) && same(q, b)) || (same(p, b) && same(q, a)));
};
export const isCenterTrap = (p) => same(p, CENTER_TRAP);   // 中层陷阱 (1,1,1)
export const isTopTrap = (p) => same(p, TOP_TRAP);         // 顶层陷阱 (1,1,2)
/** 是否为陷阱格（中层 / 顶层中心） */
export const isTrapCellCoord = (p) => isCenterTrap(p) || isTopTrap(p);
/** 该陷阱当前是否「打开」。中层读 centerTrapOpen，顶层读 topTrapOpen */
export const trapOpenAt = (s, p) =>
  isCenterTrap(p) ? !!s.centerTrapOpen : isTopTrap(p) ? !!s.topTrapOpen : false;
/** 该格是否存在木箱（可盖住洞口作为地板） */
export const crateAt = (s, p) => s.devices.find((d) => same(d.pos, p) && d.type === 'crate');
/**
 * 是否为「打开的洞口」：是陷阱格 + 该陷阱打开 + 没有木箱盖板。
 * 单位站在打开的洞口上会触发 handleFall；有木箱盖板则安全（踩在木箱上）。
 */
export const isOpenHoleAt = (s, p) =>
  isTrapCellCoord(p) && trapOpenAt(s, p) && !crateAt(s, p);
export const manhattanXY = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const chebXY = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const manhattan3 = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
export const isOrthogonalLine = (a, b) =>
  a.z === b.z && ((a.x === b.x && a.y !== b.y) || (a.y === b.y && a.x !== b.x));
export const lineDistance = (a, b) => (a.x === b.x ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x));
export const other = (p) => (p === 'A' ? 'B' : 'A');
const clone = (s) => structuredClone(s);
const ok = (state, events) => ({ ok: true, state, events });
const fail = (error) => ({ ok: false, error });

const getUnit = (s, id) => s.units.find((u) => u.id === id && u.alive);
const getDevice = (s, id) => s.devices.find((d) => d.id === id);
const getUnitAt = (s, p) => s.units.find((u) => u.alive && same(u.pos, p));
const getDeviceAt = (s, p) => s.devices.find((d) => same(d.pos, p));
const anyAt = (s, p) => getUnitAt(s, p) || getDeviceAt(s, p);
const blockingDeviceAt = (s, p) => s.devices.find((d) => same(d.pos, p) && DEVICES[d.type].blocks);

/**
 * 该格是否可作为落脚点（不含楼梯合法性，楼梯由 canMove 单独校验）。
 * 迭代 6：
 *  - 打开的洞口允许进入（进入后由 onEnter -> handleFall 结算连续下落 / 卡住）；
 *  - 盖在陷阱格上的木箱是「盖板/地板」，不阻挡单位，踩上去也不会掉落；
 *  - 普通木箱（blocks）依旧阻挡。
 */
export const standable = (s, p) => {
  if (!inBounds(p)) return false;
  if (getUnitAt(s, p)) return false;
  const b = blockingDeviceAt(s, p);
  if (b) {
    const coverCrate = isTrapCellCoord(p) && b.type === 'crate';
    if (!coverCrate) return false;
  }
  return true;
};

/** 事件辅助：把单位归属/职业带进事件，供日志与特效使用 */
const U = (unit, extra) => ({
  owner: unit.owner, class: unit.class, unitId: unit.id, ...extra,
});
const P = (p) => (p ? `(${p.x},${p.y},${p.z})` : '（未知）');

/**
 * 迭代 8：按目标职业被动修正「受到的伤害」。
 * 坚韧（盾卫）：受到的「所有类型」伤害（普攻 / 通用牌 / 溅射 / 陷阱 / 弩箭 /
 * 碰撞 / 坠落）固定减少 GUARDIAN_FLAT_REDUCTION 点，但最低仍受 GUARDIAN_MIN_DAMAGE 点：
 *   1 伤 -> 1 伤、2 伤 -> 1 伤、3 伤 -> 2 伤；绝不出现扣 0 血或负数。
 * source 参数保留仅为让各调用点标注伤害来源（日志 / 特效），不再参与减免判定。
 */
function incomingDamage(unit, amount, source) {
  void source;
  if (amount <= 0) return amount;
  if (!CLASSES[unit.class]?.damageReduction) return amount;
  return Math.max(GUARDIAN_MIN_DAMAGE, amount - GUARDIAN_FLAT_REDUCTION);
}

function zeroFlags() {
  return {
    summoned: { A: false, B: false },
    placed: { A: false, B: false },
    trapToggled: { A: false, B: false },
    // 本回合「技能牌已使用」标记：装置牌不受此限制。
    // beginPlayerTurn() 开局 / 换手都会重置，玩家在新回合重新获得一次技能牌机会。
    skillCardUsed: { A: false, B: false },
  };
}

/**
 * 统一开启某玩家的新回合：立刻把 AP 重置为 5，清空每回合标志。
 * 开局（A 先手）与 endTurn 换手都必须走这里，杜绝「轮到玩家却 AP=0」。
 * turnStartSeq 供 viewFor 做防御：本回合尚未产生任何 action 时若 ap 异常为 0，
 * 仍按新回合应有的 5 点下发（不影响玩家正常花光 AP 变成 0 的情况）。
 */
function beginPlayerTurn(s, player) {
  s.currentPlayer = player;
  s.ap = AP_PER_TURN;
  s.perTurnFlags = zeroFlags();
  s.fallResolved = [];
  s.turnStartSeq = s.actionSeq || 0;
}

// ---------------------------------------------------------------------------
// 抽牌（线性同余伪随机，种子存在 state 里：可复现、且两端共用同一份权威 state）
// 最终版：牌库 decks / 弃牌堆 discards 均为服务端权威计数，抽空自动洗回弃牌堆。
// ---------------------------------------------------------------------------
function nextRandom(s) {
  s.rng = (Math.imul(s.rng || 1, 1664525) + 1013904223) >>> 0;
  return s.rng / 4294967296;
}
function ensureDeck(s, player) {
  s.decks ??= { A: DECK_SIZE, B: DECK_SIZE };
  s.discards ??= { A: [], B: [] };
  s.hands ??= { A: [], B: [] };
  // 牌库抽空 -> 把弃牌堆洗回牌库（循环牌库，绝不出现无牌可抽）
  if (s.decks[player] <= 0 && s.discards[player].length > 0) {
    s.decks[player] = s.discards[player].length;
    s.discards[player] = [];
  }
  return s.decks[player] > 0;
}
/** 抽 1 张；手牌已达上限 / 牌库枯竭则不抽。返回抽到的卡或 null（内部用，不产生广播事件） */
function drawOne(s, player) {
  if ((s.hands?.[player] || []).length >= HAND_LIMIT) return null;
  if (!ensureDeck(s, player)) return null;
  // 特例：攀升器只加入玩家 A 的牌库，B 的抽取池里永不出现该卡
  const pool = player === 'A' ? CARD_POOL : CARD_POOL.filter((t) => !A_ONLY_CARDS.includes(t));
  const type = pool[Math.floor(nextRandom(s) * pool.length)];
  const card = { id: `c${s.nextCardId++}`, type };
  s.hands[player].push(card);
  s.decks[player] -= 1;
  return card;
}
/** 定向发一张指定牌（仅用于开局起手配方，不消耗 rng，保证两端完全可复现） */
function drawSpecific(s, player, type) {
  if ((s.hands?.[player] || []).length >= HAND_LIMIT) return null;
  s.decks ??= { A: DECK_SIZE, B: DECK_SIZE };
  s.hands ??= { A: [], B: [] };
  if (s.decks[player] <= 0) return null;
  const card = { id: `c${s.nextCardId++}`, type };
  s.hands[player].push(card);
  s.decks[player] -= 1;
  return card;
}
function drawCards(s, player, n) {
  for (let i = 0; i < n; i++) drawOne(s, player);
}
/**
 * 开局起手 5 张：3 张通用牌 + 【致盲烟雾】+ 1 张装置卡。
 * 特例：A 的第 5 张固定是【攀升器】（只加入 A 的初始牌库）；B 抽一张公共牌。
 */
function dealInitialHand(s, player) {
  for (const t of ['insight', 'bandage', 'powerKnock', 'smoke']) drawSpecific(s, player, t);
  if (player === 'A') drawSpecific(s, player, 'climber');
  else drawOne(s, player);
}
/** 打出的牌飞入弃牌堆（服务端权威，前端只读取数量与堆顶牌名） */
function discardCard(s, player, type) {
  s.discards ??= { A: [], B: [] };
  s.discards[player].push({ type, name: CARD_NAMES[type] || CARDS[type]?.name || '卡牌' });
  if (s.discards[player].length > 120) s.discards[player].shift();
}
/** 最终版任务三：花 1 AP 主动抽 1 张（手牌上限严格 5 张） */
export function drawCard(s, player) {
  const g = guard(s, player); if (g) return fail(g);
  if (s.ap < DRAW_CARD_COST) return fail('AP 不足（主动抽牌需 1 AP）');
  if ((s.hands?.[player] || []).length >= HAND_LIMIT) return fail('手牌已达上限 5 张');
  if (!ensureDeck(clone(s), player)) return fail('牌库与弃牌堆均已空');
  const ns = clone(s);
  ns.ap -= DRAW_CARD_COST;
  const card = drawOne(ns, player);
  const events = [{ kind: 'draw', actor: player, amount: card ? 1 : 0, pos: null }];
  afterAction(ns, events, player);
  const log = ns.logs[ns.logs.length - 1];
  if (log) log.text[player] = card
    ? `花 1 AP 主动抽 1 张【${CARD_NAMES[card.type]}】`
    : '牌库已空，抽牌失败';
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 迭代 5：开局盲选（picking 阶段）
// ---------------------------------------------------------------------------
/** 部分选人：允许 0..PICK_SIZE 个，用于逐张点选时实时保存、断线刷新后可恢复 */
function validPartial(classes) {
  if (!Array.isArray(classes) || classes.length > PICK_SIZE) return fail(`最多选择 ${PICK_SIZE} 个职业`);
  if (new Set(classes).size !== classes.length) return fail('不能重复选择同一职业');
  if (!classes.every((c) => CLASS_POOL.includes(c))) return fail('包含未知职业');
  return { ok: true };
}
function validFull(classes) {
  const c = validPartial(classes);
  if (!c.ok) return c;
  if (classes.length !== PICK_SIZE) return fail(`需选满 ${PICK_SIZE} 个职业才能确认`);
  return { ok: true };
}

/**
 * picking 阶段的权威状态。刻意不放任何单位 / 手牌 / 对方阵容：
 * 选人完成前棋盘上什么都没有，也就无从泄露对方选了谁。
 */
export function createPickingState() {
  return {
    phase: 'picking',
    picks: { A: [], B: [] },
    confirmed: { A: false, B: false },
    units: [], devices: [], logs: [], lastEvents: [],
    hands: { A: [], B: [] },
    inventory: { A: {}, B: {} },
    reserve: { A: 0, B: 0 },
    perTurnFlags: zeroFlags(),
    centerTrapOpen: false, topTrapOpen: false, winner: undefined,
    ap: 0, turn: 1, currentPlayer: 'A',
    actionSeq: 0, nextId: 1, nextLogId: 1, nextCardId: 1, rng: 1,
    fallResolved: [],
    // 最终版：致盲烟雾 / 牌库 / 弃牌堆（picking 阶段为空壳，避免 viewFor 读到 undefined）
    smokes: [], decks: { A: DECK_SIZE, B: DECK_SIZE }, discards: { A: [], B: [] },
  };
}

/** 逐张点选：只存本人 picks，绝不广播给对方 */
export function setPicks(s, player, classes) {
  if (s.phase !== 'picking') return fail('当前不在选人阶段');
  if (s.confirmed[player]) return fail('已确认阵容，请先点击「重新选择」');
  const chk = validPartial(classes); if (!chk.ok) return chk;
  const ns = clone(s);
  ns.picks[player] = [...classes];
  ns.actionSeq = (ns.actionSeq || 0) + 1;
  return ok(ns, []);
}

/** 确认阵容：classes 可选，传入时以它为准（校验玩家实际看到的那 3 个） */
export function confirmPicks(s, player, classes) {
  if (s.phase !== 'picking') return fail('当前不在选人阶段');
  if (s.confirmed[player]) return fail('已确认阵容');
  const ns = clone(s);
  if (Array.isArray(classes)) {
    const chk = validFull(classes); if (!chk.ok) return chk;
    ns.picks[player] = [...classes];
  } else {
    const chk = validFull(ns.picks[player]); if (!chk.ok) return chk;
  }
  ns.confirmed[player] = true;
  ns.actionSeq = (ns.actionSeq || 0) + 1;
  return ok(ns, []);
}

export function unconfirmPicks(s, player) {
  if (s.phase !== 'picking') return fail('当前不在选人阶段');
  if (!s.confirmed[player]) return fail('尚未确认阵容');
  const ns = clone(s);
  ns.confirmed[player] = false;
  ns.actionSeq = (ns.actionSeq || 0) + 1;
  return ok(ns, []);
}

export const bothConfirmed = (s) => !!(s.confirmed?.A && s.confirmed?.B);

/** 阵容兜底：未传 / 非法时退回默认 3 职业（保证旧单测与旧行为兼容） */
function normalizeLineup(list) {
  return validFull(list).ok ? [...list] : [...INITIAL_CLASSES];
}

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------
/**
 * @param {number} [seed] 发牌随机种子。
 * @param {{A?:string[],B?:string[]}} [lineup] 双方盲选阵容；不传则用默认 3 职业。
 */
export function createInitialState(seed, lineup) {
  const roster = { A: normalizeLineup(lineup?.A), B: normalizeLineup(lineup?.B) };
  const units = [];
  const reservePool = { A: [], B: [] };
  for (const owner of ['A', 'B']) {
    // 开局只生成【1 个首发】：阵容第 0 个职业，固定出生在 FIRST_SPAWN。
    const first = roster[owner][0];
    const hp = CLASSES[first].hp;
    units.push({
      id: `${owner}-${first}`, owner, class: first,
      hp, maxHp: hp, pos: { ...FIRST_SPAWN[owner] },
      hasAttacked: false, alive: true, inGrass: false,
    });
    // 另外 2 个自选单位只进入预备召唤池，不直接生成在战场上。
    // 每个名额整局只能用一次（used 一旦置 true 即锁死）。
    reservePool[owner] = roster[owner].slice(1).map((cls, i) => ({
      key: `${owner}-r${i}`, cls, used: false,
    }));
  }
  const inventory = { A: {}, B: {} };
  for (const owner of ['A', 'B']) {
    for (const [type, cfg] of Object.entries(DEVICES)) {
      // 迭代 6：攀升器仅玩家 A 发放库存，B 恒为 0（ownerOnly，服务端权威）
      inventory[owner][type] = (cfg.ownerOnly && cfg.ownerOnly !== owner) ? 0 : cfg.stock;
    }
  }
  const s = {
    turn: 1,
    currentPlayer: 'A',          // 玩家 A（下层）固定先手
    ap: AP_PER_TURN,
    units,
    devices: [],
    centerTrapOpen: false,
    topTrapOpen: false,          // 迭代 6：顶层中心陷阱 (1,1,2)
    phase: 'playing',            // 'picking' 用于开局盲选；'handoff' 保留给本地双人模式
    lineup: roster,              // 保存本局阵容，供「重新开始」沿用（不必重新选人）
    winner: undefined,
    inventory,
    reserve: { A: RESERVE_PER_PLAYER, B: RESERVE_PER_PLAYER },
    reservePool,                // 预备召唤池：仅本局预选的 2 个单位，每个整局限 1 次
    perTurnFlags: zeroFlags(),
    fallResolved: [],            // 每单位每回合最多一次掉落结算
    logs: [],
    lastEvents: [],
    actionSeq: 0,
    nextId: 1,
    nextLogId: 1,
    // ---- 迭代 4：服务端私有手牌（绝不整体下发，viewFor 只挑己方） ----
    hands: { A: [], B: [] },
    rng: (Number.isFinite(seed) ? seed >>> 0 : 20240607) || 1,
    nextCardId: 1,
    // 最终版：致盲烟雾列表 / 牌库剩余 / 弃牌堆
    smokes: [],
    decks: { A: DECK_SIZE, B: DECK_SIZE },
    discards: { A: [], B: [] },
  };
  // 统一开启 A 的新回合：AP 立刻重置为 5（开局绝不出现 AP=0）
  beginPlayerTurn(s, 'A');
  dealInitialHand(s, 'A');
  dealInitialHand(s, 'B');
  return s;
}

// ---------------------------------------------------------------------------
// 视野（弓手全层；战士/法师十字；楼梯角格提供上下层对应角格）
// 最终版任务一：【致盲烟雾】让雾中的「敌方单位」视野降为自身周围 1 格，
// 并对受制方遮蔽烟雾区域内没有己方单位贴身的格子。
// ---------------------------------------------------------------------------

/** 以某格为中心、同层 3x3 的黑雾区域（越界自动裁掉） */
export function smokeArea(center) {
  const cells = [];
  for (let dx = -SMOKE_RADIUS; dx <= SMOKE_RADIUS; dx++) {
    for (let dy = -SMOKE_RADIUS; dy <= SMOKE_RADIUS; dy++) {
      const p = { x: center.x + dx, y: center.y + dy, z: center.z };
      if (inBounds(p)) cells.push(p);
    }
  }
  return cells;
}

/** 单位是否处在「对方打出的」黑雾中（自己人放的烟不会致盲自己） */
function unitIsBlinded(s, unit) {
  return (s.smokes || []).some((sm) => sm.owner !== unit.owner &&
    (sm.cells || smokeArea(sm.center)).some((c) => same(c, unit.pos)));
}

export function unitVision(s, unit) {
  const cells = [];
  const push = (p) => { if (inBounds(p) && !cells.some((c) => same(c, p))) cells.push({ ...p }); };
  const z = unit.pos.z;
  // 致盲烟雾：视野收缩为「自身周围 1 格」的同层 3x3，且不再做楼梯扩展
  if (unitIsBlinded(s, unit)) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      push({ x: unit.pos.x + dx, y: unit.pos.y + dy, z });
    }
    return cells;
  }
  if (CLASSES[unit.class].vision === 'fullLayer') {
    for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) push({ x, y, z });
  } else {
    push({ ...unit.pos });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      push({ x: unit.pos.x + dx, y: unit.pos.y + dy, z });
    }
  }
  // 可见的楼梯格只沿「严格坐标配对的楼梯边」扩展相邻层对应格（只扩展一跳）
  for (const c of [...cells]) {
    if (!isStair(c)) continue;
    for (const dz of [-1, 1]) {
      const adj = { x: c.x, y: c.y, z: c.z + dz };
      if (isStairLink(c, adj)) push(adj);
    }
  }
  return cells;
}

/** 合并视野：己方所有存活单位视野取并集，再被敌方黑雾遮蔽 */
export function computeVisibility(s, player) {
  const set = new Set();
  for (const u of s.units) {
    if (u.alive && u.owner === player) {
      for (const c of unitVision(s, u)) set.add(key(c));
    }
  }
  // 黑雾对「受制方」（非放烟者）的遮蔽：
  // 烟雾 3x3 内的格子若没有该方单位贴身（周围 1 格内），一律从可见集合剔除。
  // 贴身格保留，保证「雾中单位视野降为自身周围 1 格」仍然有效、不会自相矛盾。
  for (const sm of (s.smokes || [])) {
    if (sm.owner === player) continue;
    for (const c of (sm.cells || smokeArea(sm.center))) {
      const near = s.units.some((u) => u.alive && u.owner === player &&
        u.pos.z === c.z && chebXY(u.pos, c) <= 1);
      if (!near) set.delete(key(c));
    }
  }
  return set;
}

export function isVisible(s, player, p) {
  return computeVisibility(s, player).has(key(p));
}

// ---------------------------------------------------------------------------
// 迭代 4：草丛隐身判定
// ---------------------------------------------------------------------------
/** 该格是否是草丛（草丛装置与单位可同格共存，因为 blocks=false） */
export const isGrassCell = (s, p) =>
  s.devices.some((d) => d.type === 'grass' && same(d.pos, p));

/** 观察者 player 是否有存活单位与隐身单位贴身同格（同格反隐） */
const enemyUnitAt = (s, player, p) =>
  s.units.some((o) => o.alive && o.owner === player && same(o.pos, p));

/**
 * 敌方单位 u 是否对 player 可见：
 *   1) 己方单位恒可见；
 *   2) 必须处于己方视野并集内；
 *   3) inGrass 隐身单位「绝对不可见」，除非观察者也有一名单位站在同一格。
 * 这是 viewFor 过滤、canAttack、卡牌选目标的唯一依据，避免三处判定漂移。
 */
export function unitVisibleTo(s, player, u, vis) {
  if (u.owner === player) return true;
  const set = vis || computeVisibility(s, player);
  if (!set.has(key(u.pos))) return false;
  if (u.inGrass) return enemyUnitAt(s, player, u.pos);
  return true;
}

// ---------------------------------------------------------------------------
// 日志（按接收者分别生成，隐藏位置不外泄）
// ---------------------------------------------------------------------------
function unitLabel(e, viewer) {
  const side = e.owner === viewer ? '己方' : '敌方';
  return `${side}${e.class ? CLASS_NAMES[e.class] : '单位'}`;
}
function damageTag(source) {
  return {
    attack: '', collision: '（碰撞）', splash: '（溅射）', fall: '（坠落）',
    trap: '（陷阱）', arrowTrap: '（弩箭）', card: '（通用牌）',
  }[source] || '';
}
function formatEvents(events, viewer, s) {
  const vis = computeVisibility(s, viewer);
  const parts = [];
  // 迭代 6：坠落受阻 / 攀升 / 陷阱开关属于地形公开事件，双方都应看到，不受迷雾裁剪
  // （陷阱格坐标本来就随 view.trapCells 公开，棋盘外观也会同步变化，日志不该说“视野外有行动”）
  const publicKinds = ['fallBlocked', 'climb', 'climbBlocked', 'toggle',
    'smoke', 'smokeEnd', 'cardPlace', 'draw'];
  for (const e of events) {
    // 机关主人对自己明牌机关的触发不受视野裁剪（明牌装置，双方都该知道它响了）
    const ownerVisible = e.kind === 'arrowTrapTrigger' && e.owner === viewer;
    // 事件主坐标若不在该玩家视野内，只给模糊描述，绝不输出坐标
    if (e.pos && !vis.has(key(e.pos)) && !ownerVisible && !publicKinds.includes(e.kind)) {
      if (['attack', 'move', 'place', 'summon', 'toggle'].includes(e.kind)) parts.push('视野外有行动');
      continue;
    }
    switch (e.kind) {
      case 'move': parts.push(`${unitLabel(e, viewer)}移动 ${P(e.from)}→${P(e.to)}`); break;
      case 'attack': {
        const tn = e.targetIsDevice
          ? DEVICE_NAMES[e.targetDeviceType]
          : unitLabel({ owner: e.targetOwner, class: e.targetClass }, viewer);
        parts.push(`${unitLabel(e, viewer)} 攻击${tn}`); break;
      }
      case 'damage':
        if (e.source === 'collision') break; // 碰撞伤害已由 collision 事件描述，避免重复
        parts.push(`${unitLabel(e, viewer)} -${e.amount}${damageTag(e.source)}`);
        break;
      case 'death': parts.push(`${unitLabel(e, viewer)}被击败`); break;
      case 'knockback': parts.push(`${unitLabel(e, viewer)}被击退`); break;
      case 'collision':
        parts.push(e.crateBreak && e.damage === 0 ? '木箱碎裂，抵消碰撞伤害'
          : `${unitLabel(e, viewer)}碰撞 -${e.damage}`);
        break;
      case 'deviceDestroyed': parts.push(`${e.owner === viewer ? '己方' : '敌方'}${DEVICE_NAMES[e.type]}被破坏`); break;
      case 'place': parts.push(`${e.owner === viewer ? '己方' : '敌方'}布置${DEVICE_NAMES[e.type]} ${P(e.pos)}`); break;
      case 'summon': parts.push(`${e.owner === viewer ? '己方' : '敌方'}召唤${CLASS_NAMES[e.cls]} ${P(e.pos)}`); break;
      case 'toggle': {
        const layerName = e.z === 2 ? '顶层' : '中层';
        parts.push(`${e.owner === viewer ? '己方' : '敌方'}${e.open ? '打开' : '关闭'}${layerName}陷阱`);
        break;
      }
      case 'fall': parts.push(`${e.isDevice ? '装置' : unitLabel(e, viewer)}坠落至下层中心`); break;
      case 'fallBlocked':
        parts.push(e.isDevice ? '装置坠落受阻'
          : `${PLAYER_NAMES[e.owner] || '玩家'} 的单位坠落受阻，被下层单位顶住。`);
        break;
      case 'climb': parts.push(`${unitLabel(e, viewer)}借攀升器抵达中层中心`); break;
      case 'climbBlocked': parts.push(`${unitLabel(e, viewer)}攀升受阻（AP 不足或中层被占）`); break;
      case 'trapTrigger': parts.push('触发固定陷阱'); break;
      case 'teleport': parts.push(`${unitLabel(e, viewer)}被传送`); break;
      case 'arrowTrapTrigger':
        parts.push(e.owner === viewer ? '己方弩箭机关触发' : '触发敌方弩箭机关'); break;
      case 'reveal': parts.push(`${unitLabel(e, viewer)}离开隐身`); break;
      case 'cardPlay': parts.push(e.actor === viewer ? '打出一张卡牌' : '对方打出一张卡牌'); break;
      case 'cardPlace': parts.push(`${e.actor === viewer ? '己方' : '对方'}用卡牌布置${DEVICE_NAMES[e.deviceType] || '装置'}`); break;
      case 'smoke': parts.push(`${e.owner === viewer ? '己方' : '对方'}释放【致盲烟雾】`); break;
      case 'smokeEnd': parts.push('黑雾消散'); break;
      case 'draw': parts.push(e.actor === viewer ? '主动抽 1 张牌' : '对方主动抽牌'); break;
      case 'heal': parts.push(`${unitLabel(e, viewer)} +${e.amount}（治疗）`); break;
      case 'refresh': parts.push(`${unitLabel(e, viewer)}触发收割，可再次攻击`); break;
      case 'apGain': parts.push(`获得 ${e.amount} AP`); break;
      case 'turn': parts.push(`第 ${e.round} 轮 · ${PLAYER_NAMES[e.next]}行动`); break;
      case 'surrender': parts.push(`${PLAYER_NAMES[e.loser]}投降`); break;
      case 'win': parts.push(e.winner === 'draw' ? '平局' : `${PLAYER_NAMES[e.winner]}获胜`); break;
      default: break;
    }
  }
  return parts.length ? parts.join(' · ') : '行动完成';
}

function pushLog(s, events, actor) {
  s.logs.push({
    id: s.nextLogId++,
    turn: s.turn,
    actor,
    kind: events[0]?.kind || 'system',
    text: { A: formatEvents(events, 'A', s), B: formatEvents(events, 'B', s) },
  });
  if (s.logs.length > 100) s.logs.shift();
}

// ---------------------------------------------------------------------------
// 胜负 / 回合收尾
// ---------------------------------------------------------------------------
export function checkWin(s) {
  if (s.phase === 'gameover') return s.winner;
  const a = s.units.filter((u) => u.owner === 'A' && u.alive).length;
  const b = s.units.filter((u) => u.owner === 'B' && u.alive).length;
  if (a === 0 || b === 0) {
    s.winner = a === 0 && b === 0 ? 'draw' : (a === 0 ? 'B' : 'A');
    s.phase = 'gameover';
    s.ap = 0;
  }
  return s.winner;
}

function tieBreak(s) {
  const count = (p) => s.units.filter((u) => u.owner === p && u.alive).length;
  const hp = (p) => s.units.filter((u) => u.owner === p && u.alive)
    .reduce((n, u) => n + Math.max(0, u.hp), 0);
  const ca = count('A'), cb = count('B'), ha = hp('A'), hb = hp('B');
  if (ca > cb || (ca === cb && ha > hb)) s.winner = 'A';
  else if (cb > ca || (ca === cb && hb > ha)) s.winner = 'B';
  else s.winner = 'draw';
  s.phase = 'gameover';
  s.ap = 0;
}

/** 每个成功 action 的统一收尾：胜负判定 + 事件/日志落库 */
function afterAction(s, events, actor) {
  checkWin(s);
  if (s.phase === 'gameover' && s.winner && !events.some((e) => e.kind === 'win')) {
    events.push({ kind: 'win', winner: s.winner, actor, pos: null });
  }
  s.lastEvents = events;
  s.actionSeq = (s.actionSeq || 0) + 1;
  pushLog(s, events, actor);
}

function guard(s, player) {
  if (s.phase !== 'playing') return '游戏已结束';
  if (s.currentPlayer !== player) return '不是你的回合';
  return null;
}

// ---------------------------------------------------------------------------
// 内部：死亡 / 装置销毁 / 进入格子结算 / 掉落
// ---------------------------------------------------------------------------
function killUnit(s, u, events) {
  if (!u.alive) return;
  u.alive = false;
  u.hp = 0;
  events.push(U(u, { kind: 'death', pos: { ...u.pos } }));
}

function destroyDevice(s, d, events, cause) {
  s.devices = s.devices.filter((x) => x.id !== d.id);
  events.push({
    kind: 'deviceDestroyed', deviceId: d.id, type: d.type, cause,
    pos: { ...d.pos }, owner: d.owner,
  });
}

// ---------------------------------------------------------------------------
// 迭代 6：连续坠落 handleFall / 装置坠落 / 进入格子结算
// ---------------------------------------------------------------------------

/** 下一层中心格能否承接单位（防 Z 轴重叠：有单位 / 阻挡或不可破坏装置都不行） */
function fallTargetFree(s, below) {
  if (getUnitAt(s, below)) return false;
  const d = getDeviceAt(s, below);
  if (!d) return true;
  // 盖在陷阱格上的木箱是「盖板/地板」，可以落上去（不会继续下落）
  const isCover = d.type === 'crate' && isTrapCellCoord(below);
  if (isCover) return true;
  return !(DEVICES[d.type].blocks || DEVICES[d.type].indestructible);
}

/**
 * 需求 4：handleFall(unitId, startZ) —— 连续下落，服务端权威，严格防重叠（方案 B）。
 *  1) 起点必须是「打开的陷阱且没有木箱盖板」的中心格 (1,1,startZ)；否则不坠落。
 *  2) 逐层检查下一层 (1,1,z-1)：
 *     - 有单位 / 不可破坏（或阻挡）装置 → 停止下落，单位停留在当前层的陷阱格
 *       （视为被下方单位顶住、悬空），不扣坠落伤害，并产生 fallBlocked 事件与日志；
 *     - 无阻挡 → 移动到下一层；若该层仍是打开的洞口则继续递归下落，直到落地或遇阻挡。
 *  3) 最终落在 z=0 → 1 点坠落伤害（坚韧 -1 保底 1）；卡在中间层 → 不受坠落伤害。
 * 每次移动前都再次确认目标格无单位，保证同一格永远不会出现两个单位。
 * 注：本模块所有函数均为 (state, ...) 纯函数风格，state 由调用方 clone 后传入。
 */
export function handleFall(s, unitId, startZ, events = []) {
  if (s.fallResolved.includes(unitId)) return;      // 每单位每回合最多一次掉落结算
  const unit = getUnit(s, unitId);
  if (!unit) return;
  const start = { x: 1, y: 1, z: startZ };
  if (!same(unit.pos, start) || !isOpenHoleAt(s, start)) return;

  s.fallResolved.push(unitId);
  let z = startZ;
  let moved = false;
  let blocked = false;
  while (z > 0) {
    const below = { x: 1, y: 1, z: z - 1 };
    if (!fallTargetFree(s, below)) {
      blocked = true;
      events.push(U(unit, {
        kind: 'fallBlocked', pos: { ...unit.pos },
        reason: getUnitAt(s, below) ? 'unit' : 'device', owner: unit.owner,
      }));
      break;
    }
    if (getUnitAt(s, below)) { blocked = true; break; } // 防御性二次防重叠
    const from = { ...unit.pos };
    unit.pos = { ...below };
    unit.inGrass = isGrassCell(s, unit.pos);
    moved = true;
    z -= 1;
    events.push(U(unit, { kind: 'fall', from, to: { ...below }, pos: { ...below } }));
    // 落地条件：下一层不是打开的洞口（盖板支撑 / 陷阱关闭 / 已到底层）
    if (!isOpenHoleAt(s, { x: 1, y: 1, z })) break;
  }
  if (blocked || !moved) return;                    // 卡在中间层：不扣坠落伤害
  if (z === 0) {                                    // 落到最底层：1 点坠落伤害
    const dmg = incomingDamage(unit, FALL_DAMAGE, 'fall');
    unit.hp -= dmg;
    events.push(U(unit, { kind: 'damage', amount: dmg, source: 'fall',
      reduced: dmg !== FALL_DAMAGE, pos: { ...unit.pos } }));
    if (unit.hp <= 0) killUnit(s, unit, events);
  }
}

/** 装置坠落（旧行为保留）：陷阱打开时格上装置掉到 (1,1,0)，被占则销毁 */
function resolveDeviceFall(s, deviceId, events) {
  if (s.fallResolved.includes(deviceId)) return;
  s.fallResolved.push(deviceId);
  const d = s.devices.find((x) => x.id === deviceId);
  if (!d) return;
  const dest = { ...FALL_TARGET };
  if (getUnitAt(s, dest) || getDeviceAt(s, dest)) {
    events.push({ kind: 'fallBlocked', entityId: d.id, isDevice: true, pos: { ...d.pos }, owner: d.owner });
    destroyDevice(s, d, events, 'fall');
    return;
  }
  const from = { ...d.pos };
  d.pos = { ...dest };
  events.push({ kind: 'fall', entityId: d.id, isDevice: true, from, to: dest, pos: dest, owner: d.owner });
}

/** 攀升器目标 (1,1,1) 是否可落脚（防重叠） */
function climbTargetFree(s) {
  return fallTargetFree(s, { ...CLIMB_TARGET });
}

/** 攀升器传送：消耗 1 AP 到中层中心；若中层洞口打开，onEnter 会按 handleFall 继续下落 */
function doClimb(s, unit, events) {
  if (s.ap < CLIMB_AP_COST || !climbTargetFree(s)) return false;
  s.ap -= CLIMB_AP_COST;
  const from = { ...unit.pos };
  unit.pos = { ...CLIMB_TARGET };
  unit.inGrass = isGrassCell(s, unit.pos);
  events.push(U(unit, { kind: 'teleport', from, to: { ...unit.pos }, pos: { ...unit.pos }, source: 'climber' }));
  events.push({ kind: 'climb', pos: { ...unit.pos }, owner: unit.owner });
  // 中层陷阱开着 -> 立刻按正常掉落逻辑结算（可能连续掉到底层）
  onEnter(s, unit, events, { allowClimb: false });
  return true;
}

/** 单位进入某格后的地形/装置结算（移动、击退、传送、卡牌击退、攀升后共用） */
function onEnter(s, unit, events, opts = {}) {
  // 1) 打开的洞口 -> 连续下落 / 被下层顶住卡住（可能改变 unit.pos，后续判定用新位置）
  if (isOpenHoleAt(s, unit.pos)) {
    handleFall(s, unit.id, unit.pos.z, events);
    if (!unit.alive) return;
  }
  // 2) 每次「进入一个格子」都据此刷新隐身状态：进入草丛 => 隐身，离开 => 破隐
  unit.inGrass = isGrassCell(s, unit.pos);
  // 3) 落点装置结算（用最新的 unit.pos）
  const d = getDeviceAt(s, unit.pos);
  if (!d || !DEVICES[d.type].enabled) return;

  // 弩箭机关：仅敌方单位进入触发，1 点伤害、无击退、不消耗装置（后续每次进入都触发）
  if (d.type === 'arrowTrap' && d.owner !== unit.owner) {
    const dmg = incomingDamage(unit, ARROW_TRAP_DAMAGE, 'arrowTrap');
    unit.hp -= dmg;
    events.push(U(unit, { kind: 'damage', amount: dmg, source: 'arrowTrap',
      reduced: dmg !== ARROW_TRAP_DAMAGE, pos: { ...unit.pos } }));
    events.push({ kind: 'arrowTrapTrigger', pos: { ...d.pos }, deviceId: d.id, owner: d.owner });
    if (unit.hp <= 0) killUnit(s, unit, events);
    return;
  }
  if (d.type === 'trap' && d.owner !== unit.owner) {
    const dmg = incomingDamage(unit, TRAP_DAMAGE, 'trap');
    unit.hp -= dmg;
    events.push(U(unit, { kind: 'damage', amount: dmg, source: 'trap',
      reduced: dmg !== TRAP_DAMAGE, pos: { ...unit.pos } }));
    events.push({ kind: 'trapTrigger', pos: { ...unit.pos }, owner: d.owner });
    destroyDevice(s, d, events, 'trap');
    if (unit.hp <= 0) killUnit(s, unit, events);
    return;
  }
  if (d.type === 'portal' && !opts.skipPortal) {
    const pair = s.devices.find((x) => x.id === d.pairedId);
    if (pair && !same(pair.pos, unit.pos)) {
      const dest = { ...pair.pos };
      const free = inBounds(dest) && !getUnitAt(s, dest) && !blockingDeviceAt(s, dest) &&
        !isOpenHoleAt(s, dest);
      if (free) {
        const from = { ...unit.pos };
        unit.pos = dest;
        events.push(U(unit, { kind: 'teleport', from, to: dest, pos: dest }));
        onEnter(s, unit, events, { skipPortal: true }); // 防止配对门来回循环
      }
    }
  }
  // 4) 攀升器：单位移动进入该格时，消耗 1 AP 传送到中层中心（AP 不足 / 中层被占则原地不动）
  if (d.type === 'climber' && opts.allowClimb !== false) {
    if (!doClimb(s, unit, events)) {
      events.push(U(unit, { kind: 'climbBlocked', pos: { ...unit.pos }, owner: unit.owner }));
    }
  }
}

// ---------------------------------------------------------------------------
// 移动
// ---------------------------------------------------------------------------
export function canMove(s, unitId, target, player) {
  const g = guard(s, player); if (g) return fail(g);
  const u = getUnit(s, unitId);
  if (!u) return fail('单位不存在或已被击败');
  if (u.owner !== player) return fail('不能操作对方单位');
  if (s.ap < MOVE_COST) return fail('AP 不足');
  if (!inBounds(target)) return fail('目标格越界');

  const a = u.pos, b = target;
  const sameLayer = a.z === b.z;
  const orthogonalOne = sameLayer &&
    ((Math.abs(a.x - b.x) === 1 && a.y === b.y) || (Math.abs(a.y - b.y) === 1 && a.x === b.x));
  // 严格按坐标配对的楼梯白名单，杜绝错误跨层连通
  const stairUpDown = isStairLink(a, b);
  if (!orthogonalOne && !stairUpDown) return fail('仅允许同层正交移动 1 格或楼梯上下');
  if (!standable(s, b)) {
    // 打开的洞口本身允许进入（进入后由 onEnter -> handleFall 结算掉落），
    // 只有格上已有单位 / 阻挡装置才会走到这里。
    if (getUnitAt(s, b)) return fail('格子被单位占据');
    if (blockingDeviceAt(s, b)) return fail('格子被木箱阻挡');
    return fail('目标格不可站立');
  }
  return { ok: true };
}

export function moveUnit(s, unitId, target, player) {
  const chk = canMove(s, unitId, target, player);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  const u = getUnit(ns, unitId);
  const from = { ...u.pos };
  u.pos = { ...target };
  ns.ap -= MOVE_COST;
  events.push(U(u, { kind: 'move', from, to: { ...target }, pos: { ...target } }));
  onEnter(ns, u, events);
  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 攻击 / 击退 / 碰撞
// ---------------------------------------------------------------------------
function findTarget(s, id) {
  return { unit: getUnit(s, id), device: getDevice(s, id) };
}

export function canAttack(s, attackerId, targetId, player) {
  const g = guard(s, player); if (g) return fail(g);
  const a = getUnit(s, attackerId);
  if (!a) return fail('攻击者不存在或已被击败');
  if (a.owner !== player) return fail('不能操作对方单位');
  if (s.ap < ATTACK_COST) return fail('AP 不足');
  if (a.hasAttacked) return fail('该单位本回合已攻击');
  const { unit: tU, device: tD } = findTarget(s, targetId);
  const t = tU || tD;
  if (!t) return fail('目标不存在');
  const cfg = CLASSES[a.class];

  // 迭代 5：牧师不具备伤害能力，只能治疗己方受伤单位（不能攻击装置 / 敌方 / 满血单位）
  if (cfg.healOnly) {
    if (!tU) return fail('牧师不能攻击装置，只能治疗己方单位');
    if (tU.owner !== player) return fail('牧师不能攻击敌方，只能治疗己方单位');
    if (tU.hp >= tU.maxHp) return fail('该单位已满血，无需治疗');
    if (!isOrthogonalLine(a.pos, tU.pos) || lineDistance(a.pos, tU.pos) > cfg.range) {
      return fail('治疗范围：同层正交直线 2 格内');
    }
    return { ok: true };
  }

  // 其余职业：目标必须是敌方
  if (t.owner === player) return fail('不能攻击己方单位/装置');
  if (tU) {
    if (!unitVisibleTo(s, player, tU)) return fail('目标不可见（可能隐藏在草丛中）');
  } else {
    if (DEVICES[tD.type].indestructible) return fail('该装置不可被攻击破坏');
    if (!DEVICES[tD.type].alwaysVisible && !isVisible(s, player, tD.pos)) return fail('目标不可见');
  }

  if (cfg.rangeType === 'adjacent') {
    const adjacent = a.pos.z === t.pos.z && manhattanXY(a.pos, t.pos) === 1 &&
      (a.pos.x === t.pos.x || a.pos.y === t.pos.y);
    const viaStair = isStairLink(a.pos, t.pos);
    if (!adjacent && !viaStair) return fail('射程：同层正交相邻 1 格或楼梯上下相邻');
  } else {
    if (!isOrthogonalLine(a.pos, t.pos) || lineDistance(a.pos, t.pos) > cfg.range) {
      return fail(`射程：同层正交直线 ${cfg.range} 格内`);
    }
  }
  return { ok: true };
}

/** 内部击退结算（直接作用于已 clone 的 state）
 *  opts.collisionBonus: 由「发起攻击的职业」提供的额外碰撞伤害（盾卫吨位）
 */
function knockback(s, attackerPos, target, events, opts = {}) {
  const dx = target.pos.x - attackerPos.x;
  const dy = target.pos.y - attackerPos.y;
  if (dx === 0 && dy === 0) return; // 上下方向攻击不产生击退
  let vx = 0, vy = 0;
  if (dy === 0) vx = Math.sign(dx);
  else if (dx === 0) vy = Math.sign(dy);
  else if (Math.abs(dx) >= Math.abs(dy)) vx = Math.sign(dx);
  else vy = Math.sign(dy);

  const from = { ...target.pos };
  const behind = { x: target.pos.x + vx, y: target.pos.y + vy, z: target.pos.z };
  events.push(U(target, { kind: 'knockback', dir: { x: vx, y: vy }, from, to: behind, pos: from }));

  let reason = null;
  let device = null;
  if (!inBounds(behind)) reason = 'wall';
  else if (getUnitAt(s, behind)) reason = 'unit';
  // 地面类装置（草丛 / 弩箭机关）不阻挡击退：可穿入，并由 onEnter 触发其效果
  else if ((device = getDeviceAt(s, behind)) && !DEVICES[device.type].passable) reason = 'device';
  // 迭代 6：打开的洞口（无木箱盖板）不再算碰撞阻挡 —— 单位顺势进入，
  // 由 onEnter -> handleFall 结算连续下落；盖在洞口的木箱仍按 device 碰撞处理。

  if (reason) {
    const crateBreak = !!(device && device.type === 'crate');
    // 迭代 6：盖在「打开洞口」上的木箱被撞碎时，按新规则目标仍受碰撞伤害；
    // 普通木箱碎裂沿用旧规则「抵消碰撞伤害」。
    const coverHole = crateBreak && isTrapCellCoord(behind) && trapOpenAt(s, behind);
    // 吨位：盾卫发起的击退，非木箱碰撞额外 +1（1 -> 2）
    const raw = (crateBreak && !coverHole) ? 0 : COLLISION_DAMAGE + (opts.collisionBonus || 0);
    // 迭代 8 坚韧：目标若带减伤被动，所有伤害 -1 保底 1（绝不扣 0 / 负数）
    const dmg = raw > 0 ? incomingDamage(target, raw, 'collision') : 0;
    if (crateBreak) {
      destroyDevice(s, device, events, 'crate');
      events.push({ kind: 'crateBreak', pos: { ...behind }, owner: device.owner, deviceId: device.id });
    }
    events.push(U(target, {
      kind: 'collision', reason, crateBreak, damage: dmg,
      reduced: dmg !== raw, behind, pos: { ...target.pos },
    }));
    if (dmg > 0) {
      target.hp -= dmg;
      events.push(U(target, { kind: 'damage', amount: dmg, source: 'collision', pos: { ...target.pos } }));
      if (target.hp <= 0) killUnit(s, target, events);
    }
    // 迭代 6：撞碎的是「盖在打开洞口上的木箱」时，目标顺惯性进入该格，
    // 立刻由 onEnter -> handleFall 结算掉落（可能连续掉到底层）；其余情况沿用旧配置。
    const fellIntoHole = crateBreak && isTrapCellCoord(behind) && trapOpenAt(s, behind);
    if (target.alive && (fellIntoHole || (crateBreak && CRATE_ADVANCE_ON_BREAK))) {
      target.pos = behind;
      events.push(U(target, { kind: 'knockbackMove', from, to: behind, pos: behind }));
      onEnter(s, target, events);
    }
  } else {
    target.pos = behind;
    events.push(U(target, { kind: 'knockbackMove', from, to: behind, pos: behind }));
    onEnter(s, target, events);
  }
}

/** 对外暴露的纯函数版本 */
export function resolveKnockback(s, attackerPos, targetId, player = s.currentPlayer) {
  const t = getUnit(s, targetId);
  if (!t) return fail('目标不存在');
  const ns = clone(s);
  const events = [];
  knockback(ns, attackerPos, getUnit(ns, targetId), events);
  afterAction(ns, events, player);
  return ok(ns, events);
}

export function resolveAttack(s, attackerId, targetId, player) {
  const chk = canAttack(s, attackerId, targetId, player);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  const a = getUnit(ns, attackerId);
  const { unit: tU, device: tD } = findTarget(ns, targetId);
  const t = tU || tD;
  const targetPos = { ...t.pos };
  const cfg = CLASSES[a.class];

  a.hasAttacked = true;
  ns.ap -= ATTACK_COST;

  // 迭代 8：法师被动「无差别溅射」——名单必须在击退前按「攻击瞬间」位置快照确定。
  // 主目标同层正交相邻的所有存活单位「不分敌我」（含己方友军）全部入列，
  // 仅排除主目标本身与施法者本人；溅射绝不产生击退（下方只扣血，不调用 knockback）。
  const splashVictims = (a.class === 'mage' && cfg.splash > 0)
    ? ns.units.filter((u) => u.alive && u.id !== targetId && u.id !== attackerId &&
        u.pos.z === targetPos.z && manhattanXY(u.pos, targetPos) === 1 &&
        (u.pos.x === targetPos.x || u.pos.y === targetPos.y)).map((u) => u.id)
    : [];

  events.push(U(a, {
    kind: 'attack', class: a.class,
    attackerPos: { ...a.pos }, targetPos,
    targetId, targetOwner: t.owner, targetClass: tU ? tU.class : undefined,
    targetIsDevice: !!tD, targetDeviceType: tD ? tD.type : undefined,
    from: { ...a.pos }, pos: targetPos,
  }));

  // 破隐规则：草丛内的单位一旦「发起攻击」立刻打破隐身，对敌方重新可见
  if (a.inGrass) {
    a.inGrass = false;
    events.push(U(a, { kind: 'reveal', pos: { ...a.pos }, from: null, to: null }));
  }

  if (tU && cfg.healOnly) {
    // 牧师：治疗己方受伤单位，回复 cfg.heal 点且不超过上限；不造成伤害、不产生击退
    const healed = Math.min(cfg.heal, tU.maxHp - tU.hp);
    tU.hp += healed;
    events.push(U(tU, { kind: 'heal', amount: healed, source: 'priest', pos: { ...tU.pos } }));
  } else if (tU) {
    // 迭代 8：普攻伤害同样经过坚韧（所有伤害 -1 保底 1），amount 用结算后的真实扣血
    const dmg = incomingDamage(tU, cfg.atk, 'attack');
    tU.hp -= dmg;
    events.push(U(tU, { kind: 'damage', amount: dmg, source: 'attack',
      reduced: dmg !== cfg.atk, pos: { ...tU.pos } }));
    // 暗杀 / 法师：cfg.knock=false，命中完全不产生击退，目标原地不动
    if (tU.hp <= 0) {
      killUnit(ns, tU, events);
      // 收割特性：击杀目标立刻刷新本回合攻击状态（可再次攻击）
      if (cfg.refreshOnKill) {
        a.hasAttacked = false;
        events.push(U(a, { kind: 'refresh', pos: { ...a.pos } }));
      }
    } else if (cfg.knock) {
      if (a.pos.z !== tU.pos.z) {
        events.push(U(tU, { kind: 'noKnockback', pos: { ...tU.pos } }));
      } else {
        knockback(ns, a.pos, tU, events, { collisionBonus: cfg.collisionBonus || 0 });
      }
    }
  } else {
    // 攻击装置：消耗正常攻击行动并破坏
    destroyDevice(ns, tD, events, 'attack');
  }

  // 迭代 8 法师被动「无差别溅射」：相邻所有单位（敌方 + 己方友军）各 1 点，
  // 绝对不产生击退；盾卫若被溅射同样经过坚韧（1 伤保底 1）。
  for (const vid of splashVictims) {
    const e = getUnit(ns, vid);
    if (!e) continue;
    const dmg = incomingDamage(e, SPLASH_DAMAGE, 'splash');
    e.hp -= dmg;
    events.push(U(e, { kind: 'damage', amount: dmg, source: 'splash',
      reduced: dmg !== SPLASH_DAMAGE, pos: { ...e.pos } }));
    if (e.hp <= 0) killUnit(ns, e, events);
  }

  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 迭代 6：中心陷阱（中层 (1,1,1) / 顶层 (1,1,2) 双陷阱，共用每回合 1 次开关）
// ---------------------------------------------------------------------------
/**
 * 可开关指定陷阱的己方单位：与目标陷阱同层，且在其相邻 8 格内。
 * trapPos 默认中层中心；顶层传 TOP_TRAP。
 */
export function toggleUnits(s, player, trapPos = CENTER_TRAP) {
  return s.units
    .filter((u) => u.alive && u.owner === player && u.pos.z === trapPos.z && chebXY(u.pos, trapPos) <= 1)
    .map((u) => u.id);
}

/** 第 4 参数既可传陷阱坐标对象，也可直接传层号 z（1 中层 / 2 顶层）；缺省中层 */
function resolveTrapPos(arg) {
  if (arg && typeof arg === 'object' && Number.isInteger(arg.z)) return { ...arg };
  return Number(arg) === 2 ? { ...TOP_TRAP } : { ...CENTER_TRAP };
}

export function canToggleTrap(s, unitId, player, trapArg) {
  const g = guard(s, player); if (g) return fail(g);
  if (s.ap < TOGGLE_COST) return fail('AP 不足');
  if (s.perTurnFlags.trapToggled[player]) return fail('每方每回合最多开关 1 次');
  const trapPos = resolveTrapPos(trapArg);
  const u = getUnit(s, unitId);
  if (!u) return fail('单位不存在');
  if (u.owner !== player) return fail('不能操作对方单位');
  if (!toggleUnits(s, player, trapPos).includes(unitId)) {
    return fail(`需要己方单位位于${trapPos.z === 2 ? '顶层' : '中层'}陷阱同层相邻 8 格内`);
  }
  return { ok: true, trapPos };
}

export function toggleCenterTrap(s, unitId, player, trapArg) {
  const chk = canToggleTrap(s, unitId, player, trapArg);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  const trapPos = chk.trapPos;
  const isTop = isTopTrap(trapPos);
  const openNow = isTop ? !ns.topTrapOpen : !ns.centerTrapOpen;
  if (isTop) ns.topTrapOpen = openNow;
  else ns.centerTrapOpen = openNow;
  ns.ap -= TOGGLE_COST;
  ns.perTurnFlags.trapToggled[player] = true;   // 中/顶层共用同一次数
  events.push({
    kind: 'toggle', open: openNow, pos: { ...trapPos }, z: trapPos.z,
    actor: player, owner: player,
  });
  if (openNow) {
    // 打开瞬间：站在该陷阱格上的单位立即按 handleFall 结算连续下落 / 防重叠卡层
    for (const u of ns.units.filter((x) => x.alive && same(x.pos, trapPos))) {
      handleFall(ns, u.id, trapPos.z, events);
    }
    // 格上装置：盖板木箱保留原地（继续盖住洞口），其余装置坠落
    for (const d of ns.devices.filter((x) => same(x.pos, trapPos) && x.type !== 'crate')) {
      resolveDeviceFall(ns, d.id, events);
    }
  }
  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 装置布置（可扩展 DeviceType）
// ---------------------------------------------------------------------------
function findPortalPairCell(s, pos) {
  const valid = (c) => !same(c, pos) && !isStair(c) &&
    !isOpenHoleAt(s, c) &&   // 迭代 6：中/顶层任一打开的洞口都不能放配对门
    !getUnitAt(s, c) && !getDeviceAt(s, c);
  const sameLayer = ALL_CELLS.filter((c) => valid(c) && c.z === pos.z)
    .sort((a, b) => manhattanXY(a, pos) - manhattanXY(b, pos));
  if (sameLayer.length) return { ...sameLayer[0] };
  const any = ALL_CELLS.filter(valid).sort((a, b) => manhattan3(a, pos) - manhattan3(b, pos));
  return any.length ? { ...any[0] } : null;
}

/**
 * 纯位置合法性校验（不含 AP / 每回合次数 / 库存）。
 * 旧 place 路径与「装置卡牌」路径共用同一份判定，杜绝两处规则漂移。
 */
export function canPlaceAt(s, player, type, pos) {
  const cfg = DEVICES[type];
  if (!cfg) return fail('未知装置类型');
  if (!cfg.enabled) return fail('该装置当前未启用');
  if (cfg.ownerOnly && cfg.ownerOnly !== player) return fail('该装置仅特定阵营可用');
  if (!inBounds(pos)) return fail('目标格越界');
  if (Number.isInteger(cfg.layer) && pos.z !== cfg.layer) return fail('该装置只能布置在指定层');
  if (isStair(pos)) return fail('楼梯格不可布置装置');
  // 陷阱格：木箱永远可放（关时普通装置 / 开时盖板）；其余装置仅在陷阱关闭时可放
  if (isTrapCellCoord(pos) && type !== 'crate' &&
      (!ALLOW_PLACE_ON_CLOSED_CENTER || trapOpenAt(s, pos))) {
    return fail('打开的陷阱格只能放置木箱盖板');
  }
  if (anyAt(s, pos)) return fail('目标格已被占据');
  const near = s.units.some((u) => u.alive && u.owner === player &&
    u.pos.z === pos.z && chebXY(u.pos, pos) <= 1 && !same(u.pos, pos));
  if (!near) return fail('目标格同层 8 邻域内必须有己方存活单位');
  let pairPos = null;
  if (cfg.pair) {
    pairPos = findPortalPairCell(s, pos);
    if (!pairPos) return fail('没有可用的配对传送门位置');
  }
  return { ok: true, pairPos };
}

/** 旧路径：右侧面板放置（保留库存 / 每回合 1 次限制，供兼容与单测使用） */
export function canPlaceDevice(s, player, type, pos) {
  const g = guard(s, player); if (g) return fail(g);
  const cfg = DEVICES[type];
  if (!cfg) return fail('未知装置类型');
  if (!cfg.enabled) return fail('该装置当前未启用');
  if (cfg.ownerOnly && cfg.ownerOnly !== player) return fail('该装置仅特定阵营可用');
  if (s.ap < PLACE_COST) return fail('AP 不足');
  if (s.perTurnFlags.placed[player]) return fail('每方每回合最多布置 1 个装置');
  if ((s.inventory[player][type] || 0) <= 0) return fail('库存不足');
  const at = canPlaceAt(s, player, type, pos);
  if (!at.ok) return at;
  return { ok: true, pairPos: at.pairPos };
}

/** 在已 clone 的 state 上真正落下一个装置（供 placeDevice 与装置卡共用） */
function placeDeviceCore(s, player, type, pos, pairPos, events) {
  const d1 = {
    id: `d${s.nextId++}`, owner: player, type, hp: DEVICES[type].hp, pos: { ...pos },
  };
  s.devices.push(d1);
  events.push({ kind: 'place', type, pos: { ...pos }, owner: player, deviceId: d1.id });
  if (DEVICES[type].pair && pairPos) {
    const d2 = {
      id: `d${s.nextId++}`, owner: player, type, hp: DEVICES[type].hp,
      pos: { ...pairPos }, pairedId: d1.id,
    };
    d1.pairedId = d2.id;
    s.devices.push(d2);
    events.push({ kind: 'place', type, pos: { ...pairPos }, owner: player, deviceId: d2.id });
  }
  return d1;
}

export function placeDevice(s, player, type, pos) {
  const chk = canPlaceDevice(s, player, type, pos);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  ns.ap -= PLACE_COST;
  ns.perTurnFlags.placed[player] = true;
  ns.inventory[player][type] -= 1;
  placeDeviceCore(ns, player, type, pos, chk.pairPos, events);
  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 召唤
// ---------------------------------------------------------------------------
/**
 * 解析要召唤的预备池条目。铁律：
 *  1) 只认 s.reservePool[player] 里【本局预选】的条目 —— 客户端传任何名单外的职业都找不到；
 *  2) used === true 的名额视为已召唤，直接排除（整局锁死）；
 *  3) keyOrCls 为空时默认取第一个可用名额（供 hintsFor 计算合法召唤点）。
 */
function resolveReserveEntry(s, player, keyOrCls) {
  const pool = s.reservePool?.[player] || [];
  const lineup = s.lineup?.[player] || [];
  const avail = pool.filter((e) => !e.used && CLASSES[e.cls] &&
    (lineup.length === 0 || lineup.includes(e.cls)));
  if (!keyOrCls) return avail[0] || null;
  return avail.find((e) => e.key === keyOrCls || e.cls === keyOrCls) || null;
}

/** 可读的预备池视图（供前端渲染「可召唤 / 已召唤」条目） */
export function reserveEntries(s, player) {
  return (s.reservePool?.[player] || []).map((e) => ({
    key: e.key, cls: e.cls, used: !!e.used,
    name: CLASS_NAMES[e.cls] || e.cls,
  }));
}

export function canSummon(s, player, keyOrCls, pos) {
  const g = guard(s, player); if (g) return fail(g);
  // 关键：先解析预备池名额，名单外 / 已召唤的单位一律拒绝
  const entry = resolveReserveEntry(s, player, keyOrCls);
  if (!entry) return fail('只能召唤本局预选且尚未出场的单位');
  if (s.ap < SUMMON_COST) return fail('AP 不足');
  if (s.perTurnFlags.summoned[player]) return fail('每回合最多召唤 1 次');
  if ((s.reserve[player] || 0) <= 0) return fail('预备池已空');
  if (s.units.filter((u) => u.owner === player && u.alive).length >= MAX_UNITS_ON_FIELD) {
    return fail(`场上单位已达上限 ${MAX_UNITS_ON_FIELD}`);
  }
  if (!SUMMON_POINTS[player].some((c) => same(c, pos))) return fail('不是合法召唤点');
  if (anyAt(s, pos)) return fail('召唤点已被占据');
  if (!standable(s, pos)) return fail('召唤点不可站立');
  return { ok: true, entry };
}

export function summonUnit(s, player, keyOrCls, pos) {
  const chk = canSummon(s, player, keyOrCls, pos);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  // 标记该名额【已召唤】并锁死：整局不可再次召唤
  const entry = ns.reservePool[player].find((e) => e.key === chk.entry.key);
  entry.used = true;
  ns.ap -= SUMMON_COST;
  ns.reserve[player] = Math.max(0, (ns.reserve[player] || 0) - 1);
  ns.perTurnFlags.summoned[player] = true;
  const cls = entry.cls;
  const hp = CLASSES[cls].hp;
  const u = {
    // 预选名单内职业互不重复，因此用 `${side}-${cls}` 作为稳定 id，
    // 与首发一致；每个名额整局只用一次，不会出现 id 冲突。
    id: `${player}-${cls}`, owner: player, class: cls,
    hp, maxHp: hp, pos: { ...pos },
    hasAttacked: false, // 召唤出的单位本回合可以直接行动
    alive: true, inGrass: false,
  };
  ns.units.push(u);
  events.push(U(u, { kind: 'summon', cls, pos: { ...pos } }));
  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 回合切换 / 投降
// ---------------------------------------------------------------------------
export function endTurn(s, player) {
  const g = guard(s, player); if (g) return fail(g);
  const ns = clone(s);
  const events = [];
  ns.turn += 1;

  if (ns.turn > MAX_HALF_TURNS) {
    tieBreak(ns);
    events.push({ kind: 'turn', next: null, round: Math.ceil((ns.turn - 1) / 2), limit: true, pos: null });
    afterAction(ns, events, player);
    return ok(ns, events);
  }

  // 换手即开启新回合：AP 立刻重置为 5、每回合标志清空（统一入口，避免遗漏导致 AP=0）
  beginPlayerTurn(ns, other(player));
  for (const u of ns.units) u.hasAttacked = false;
  // 最终版任务一：致盲烟雾每经过 1 次回合切换扣 1 层持续时间，归零即消散
  const ended = [];
  ns.smokes = (ns.smokes || []).map((sm) => ({ ...sm, turnsLeft: sm.turnsLeft - 1 }))
    .filter((sm) => {
      if (sm.turnsLeft <= 0) { ended.push(sm); return false; }
      return true;
    });
  for (const sm of ended) {
    events.push({ kind: 'smokeEnd', pos: { ...sm.center }, owner: sm.owner });
  }
  // 最终版任务三：每回合开始为「当前回合玩家」自动抽 2 张（手牌上限严格 5 张）
  drawCards(ns, ns.currentPlayer, DRAW_PER_TURN);
  events.push({ kind: 'turn', next: ns.currentPlayer, round: Math.ceil(ns.turn / 2), pos: null });

  // 迭代 6：陷阱打开时，停留在任一洞口上的单位/装置在新回合开始时再结算一次。
  // 被下层单位顶住的单位会在下层清空后继续下落；盖板木箱不算洞口，保持原位。
  for (const u of ns.units.filter((x) => x.alive && isOpenHoleAt(ns, x.pos))) {
    handleFall(ns, u.id, u.pos.z, events);
  }
  for (const d of ns.devices.filter((x) =>
    isTrapCellCoord(x.pos) && trapOpenAt(ns, x.pos) && x.type !== 'crate')) {
    resolveDeviceFall(ns, d.id, events);
  }
  afterAction(ns, events, player);
  return ok(ns, events);
}

export function surrender(s, player) {
  const g = guard(s, player); if (g) return fail(g);
  const ns = clone(s);
  ns.phase = 'gameover';
  ns.winner = other(player);
  ns.ap = 0;
  const events = [{ kind: 'surrender', loser: player, actor: player, owner: player, pos: null }];
  afterAction(ns, events, player);
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// 迭代 4：通用手牌（全部在服务端校验 / 结算；迭代 8 起无任何职业专属卡 / 主动技能）
// ---------------------------------------------------------------------------

/** 为【强力击退】选一个击退来源：优先同层正交直线上、离目标最近的己方存活单位 */
function pickKnockSource(s, player, target) {
  const mine = s.units.filter((u) => u.alive && u.owner === player);
  if (!mine.length) return { x: target.pos.x - 1, y: target.pos.y, z: target.pos.z };
  const scored = mine.map((u) => ({
    pos: u.pos,
    line: u.pos.z === target.pos.z && isOrthogonalLine(u.pos, target.pos) ? 0 : 1,
    d: manhattanXY(u.pos, target.pos) + (u.pos.z !== target.pos.z ? 6 : 0),
  })).sort((a, b) => a.line - b.line || a.d - b.d);
  return { ...scored[0].pos };
}

/**
 * 沿「源 -> 目标」的水平方向把目标强制推 distance 格（独立于普通攻击的 1 格击退）。
 * 逐格推进：可站立则进入并结算落点（含弩箭机关 / 草丛隐身）；
 * 被墙 / 单位 / 装置阻挡则按正常碰撞规则结算后停下（撞木箱碎裂免伤）。
 * opts.extraOnCollision：每发生一次（非木箱）碰撞，在正常碰撞伤害之外额外再扣的血。
 */
function forcePush(s, sourcePos, target, distance, events, opts = {}) {
  if (target.pos.z !== sourcePos.z) return; // 上下方向不产生击退
  const dx = target.pos.x - sourcePos.x;
  const dy = target.pos.y - sourcePos.y;
  if (dx === 0 && dy === 0) return;
  let vx = 0, vy = 0;
  if (dy === 0) vx = Math.sign(dx);
  else if (dx === 0) vy = Math.sign(dy);
  else if (Math.abs(dx) >= Math.abs(dy)) vx = Math.sign(dx);
  else vy = Math.sign(dy);

  const from = { ...target.pos };
  events.push(U(target, {
    kind: 'knockback', dir: { x: vx, y: vy }, from,
    to: { x: from.x + vx * distance, y: from.y + vy * distance, z: from.z },
    pos: from, source: 'card',
  }));

  for (let step = 0; step < distance && target.alive; step++) {
    const behind = { x: target.pos.x + vx, y: target.pos.y + vy, z: target.pos.z };
    let reason = null, device = null;
    if (!inBounds(behind)) reason = 'wall';
    else if (getUnitAt(s, behind)) reason = 'unit';
    else if ((device = getDeviceAt(s, behind)) && !DEVICES[device.type].passable) reason = 'device';
    // 打开的洞口不算阻挡：单位顺势进入并触发 handleFall（与普通击退一致）

    if (reason) {
      const crateBreak = !!(device && device.type === 'crate');
      const coverHole = crateBreak && isTrapCellCoord(behind) && trapOpenAt(s, behind);
      if (crateBreak) {
        destroyDevice(s, device, events, 'crate');
        events.push({ kind: 'crateBreak', pos: { ...behind }, owner: device.owner, deviceId: device.id });
      }
      // 盖洞木箱碎裂仍受碰撞伤害（迭代 6 新规则），普通木箱碎裂免伤；
      // 迭代 8：碰撞伤害同样经过坚韧（所有伤害 -1 保底 1）。
      const raw = (!crateBreak || coverHole) ? COLLISION_DAMAGE + (opts.extraOnCollision || 0) : 0;
      const dmg = raw > 0 ? incomingDamage(target, raw, 'collision') : 0;
      events.push(U(target, {
        kind: 'collision', reason, crateBreak, damage: dmg, reduced: dmg !== raw,
        behind, pos: { ...target.pos }, source: 'card',
      }));
      if (dmg > 0) {
        target.hp -= dmg;
        events.push(U(target, { kind: 'damage', amount: dmg, source: 'collision', pos: { ...target.pos } }));
        if (target.hp <= 0) killUnit(s, target, events);
      }
      const fellIntoHole = crateBreak && isTrapCellCoord(behind) && trapOpenAt(s, behind);
      if (target.alive && (fellIntoHole || (crateBreak && CRATE_ADVANCE_ON_BREAK))) {
        target.pos = behind;
        events.push(U(target, { kind: 'knockbackMove', from, to: behind, pos: behind }));
        onEnter(s, target, events);
        if (fellIntoHole) break; // 掉洞即结束本次强制击退
        continue;
      }
      break; // 撞了即停
    } else {
      const stepFrom = { ...target.pos };
      target.pos = behind;
      events.push(U(target, { kind: 'knockbackMove', from: stepFrom, to: behind, pos: behind }));
      onEnter(s, target, events);
    }
  }
}

/**
 * 出牌校验（服务端唯一权威）。出牌限额按卡牌类型区分：
 *   - 装置牌（DEVICE_CARDS）：无单回合数量上限，只要每张 AP 够即可连续打出；
 *   - 技能牌（其余卡）：同一玩家一个回合最多 1 张，成功打出后置 skillCardUsed，
 *     仅阻止后续技能牌；两类限额互不干扰。
 * AP 校验对每张牌独立执行，卡牌基础放置 / 结算逻辑保持不变。
 *
 * @param {string|null} targetId 选单位卡的目标 id
 * @param {object|null} pos      选格子卡（装置 / 致盲烟雾）的目标格坐标
 */
export function canPlayCard(s, cardId, targetId, player, pos) {
  const g = guard(s, player); if (g) return fail(g);
  // AP 校验：每张牌打出时独立判断（装置牌 / 技能牌一致）
  if (s.ap < CARD_COST) return fail('AP 不足（打出卡牌需 1 AP）');
  const hand = s.hands?.[player] || [];
  const card = hand.find((c) => c.id === cardId);
  if (!card) return fail('手牌中不存在该卡');
  const cfg = CARDS[card.type];
  if (!cfg) return fail('未知卡牌');
  if (cfg.ownerOnly && cfg.ownerOnly !== player) return fail('该卡牌仅特定阵营可用');
  // 分类限额：装置牌不受限；技能牌本回合已用过则拒绝。
  if (!isDeviceCardType(card.type) && s.perTurnFlags?.skillCardUsed?.[player]) {
    return fail('本回合已打出过技能牌（技能牌每回合最多 1 张）');
  }

  // ---- 选格子卡：致盲烟雾 / 装置卡 ----
  if (cfg.target === 'cell') {
    if (!pos || !inBounds(pos)) return fail('请选择一个目标格');
    if (!isVisible(s, player, pos)) return fail('目标格不在你的视野内（需选择可见格）');
    if (card.type === 'smoke') return { ok: true };
    const dt = DEVICE_CARDS[card.type];
    if (!dt) return fail('未知格子目标卡牌');
    const at = canPlaceAt(s, player, dt, pos);
    if (!at.ok) return at;
    return { ok: true, pairPos: at.pairPos, deviceType: dt };
  }

  // ---- 选单位 / 立即生效卡（旧行为） ----
  if (cfg.target !== 'none') {
    const t = getUnit(s, targetId);
    if (!t) return fail('请选择合法目标单位');
    if (cfg.target === 'enemy') {
      if (t.owner === player) return fail('该牌需要选择敌方单位');
      if (!unitVisibleTo(s, player, t)) return fail('目标不可见（可能隐藏在草丛中）');
    } else { // ally
      if (t.owner !== player) return fail('该牌需要选择己方单位');
      if (card.type === 'bandage' && t.hp >= t.maxHp) return fail('该单位已满血，无需包扎');
    }
  }
  return { ok: true };
}

export function playCard(s, cardId, targetId, player, pos) {
  const chk = canPlayCard(s, cardId, targetId, player, pos);
  if (!chk.ok) return chk;
  const ns = clone(s);
  const events = [];
  const hand = ns.hands[player];
  const idx = hand.findIndex((c) => c.id === cardId);
  const [card] = hand.splice(idx, 1);
  const type = card.type;
  ns.ap -= CARD_COST;
  // 仅「技能牌」消耗本回合限额并置标记；装置牌不设标记，可同回合连续打出。
  // 防御：兼容不含新字段的旧状态对象。
  ns.perTurnFlags ??= zeroFlags();
  ns.perTurnFlags.skillCardUsed ??= { A: false, B: false };
  if (!isDeviceCardType(type)) ns.perTurnFlags.skillCardUsed[player] = true;
  discardCard(ns, player, type);   // 卡牌飞入弃牌堆
  // 事件刻意不含牌型 / 卡牌内容，避免通过广播推断对方手牌
  events.push({ kind: 'cardPlay', actor: player, pos: null });

  if (type === 'smoke') {
    // 最终版任务一：以选中可见格为中心的同层 3x3 黑雾，持续 2 回合
    const sm = {
      id: `sm${ns.nextId++}`, owner: player, center: { ...pos },
      cells: smokeArea(pos), turnsLeft: SMOKE_DURATION,
    };
    ns.smokes ??= [];
    ns.smokes.push(sm);
    events.push({
      kind: 'smoke', pos: { ...pos }, owner: player,
      cells: sm.cells.map((c) => ({ ...c })), turnsLeft: sm.turnsLeft,
    });
  } else if (DEVICE_CARDS[type]) {
    // 最终版任务三：装置卡牌化 —— 扣 AP、亮黄格、点击后落装置，卡牌进弃牌堆
    const dt = DEVICE_CARDS[type];
    placeDeviceCore(ns, player, dt, pos, chk.pairPos, events);
    events.push({ kind: 'cardPlace', actor: player, deviceType: dt, pos: { ...pos } });
  } else if (type === 'powerKnock') {
    const target = getUnit(ns, targetId);
    const src = pickKnockSource(ns, player, target);
    // 迭代 8：通用牌伤害同样经过坚韧（所有伤害 -1 保底 1）
    const dmg = incomingDamage(target, POWER_KNOCK_DAMAGE, 'card');
    target.hp -= dmg;
    events.push(U(target, { kind: 'damage', amount: dmg, source: 'card',
      reduced: dmg !== POWER_KNOCK_DAMAGE, pos: { ...target.pos } }));
    if (target.hp <= 0) killUnit(ns, target, events);
    else forcePush(ns, src, target, POWER_KNOCK_DISTANCE, events,
      { extraOnCollision: POWER_KNOCK_EXTRA_COLLISION });
  } else if (type === 'bandage') {
    const t = getUnit(ns, targetId);
    const healed = Math.min(HEAL_AMOUNT, t.maxHp - t.hp);
    t.hp += healed;
    events.push(U(t, { kind: 'heal', amount: healed, pos: { ...t.pos } }));
  } else if (type === 'insight') {
    ns.ap += INSIGHT_AP;
    events.push({ kind: 'apGain', amount: INSIGHT_AP, actor: player, pos: null });
  }

  afterAction(ns, events, player);
  // 牌名只写进「本人」的日志文本（log.text 按接收者分别存储），对方文本保持通用，
  // 且 cardPlay 事件不含牌型 —— 因此任何网络包里都不存在对方手牌信息。
  const log = ns.logs[ns.logs.length - 1];
  if (log) log.text[player] = `打出【${CARD_NAMES[type]}】 · ${log.text[player]}`;
  return ok(ns, events);
}

// ---------------------------------------------------------------------------
// Hints：服务端替前端算好所有合法目标，前端零规则计算
// ---------------------------------------------------------------------------
function summarizePreview(events, targetId) {
  const knock = events.find((e) => e.kind === 'knockback');
  const collision = events.find((e) => e.kind === 'collision');
  return {
    damage: events.filter((e) => e.kind === 'damage' && e.source === 'attack')
      .reduce((n, e) => n + e.amount, 0),
    // 牧师治疗预览：不是伤害，前端据此显示「治疗 +n」而不是「伤害 0」
    heal: events.filter((e) => e.kind === 'heal').reduce((n, e) => n + (e.amount || 0), 0),
    knock: knock ? { dir: knock.dir, from: knock.from, to: knock.to } : null,
    collision: collision
      ? { reason: collision.reason, damage: collision.damage, crateBreak: collision.crateBreak, behind: collision.behind }
      : null,
    crateBreak: events.some((e) => e.kind === 'crateBreak'),
    splash: events.filter((e) => e.kind === 'damage' && e.source === 'splash')
      .map((e) => ({ unitId: e.unitId, pos: e.pos, amount: e.amount })),
    kills: events.filter((e) => e.kind === 'death').map((e) => e.unitId),
    deviceDestroyed: events.some((e) => e.kind === 'deviceDestroyed' && e.deviceId === targetId),
  };
}

export function buildHints(s, player) {
  const moves = {}, attacks = {}, previews = {};
  const enemyTargets = [
    ...s.units.filter((u) => u.alive && u.owner !== player).map((u) => u.id),
    ...s.devices.filter((d) => d.owner !== player).map((d) => d.id),
  ];
  // 牧师 healOnly：目标池换成「己方存活单位」，敌方单位/装置一律不进入 attacks。
  // 服务端 canAttack 会再按「受伤 + 同层正交直线 2 格内」过滤，
  // 因此前端只会高亮己方受伤单位，敌方绝不高亮（行动按钮随上下文变为「治疗」）。
  const allyTargets = s.units.filter((u) => u.alive && u.owner === player).map((u) => u.id);
  for (const u of s.units.filter((x) => x.alive && x.owner === player)) {
    const pool = CLASSES[u.class].healOnly ? allyTargets : enemyTargets;
    moves[u.id] = ALL_CELLS.filter((c) => canMove(s, u.id, c, player).ok);
    attacks[u.id] = pool.filter((t) => canAttack(s, u.id, t, player).ok);
    previews[u.id] = {};
    for (const t of attacks[u.id]) {
      const dry = resolveAttack(s, u.id, t, player); // 内部 clone，不污染真实 state
      if (dry.ok) previews[u.id][t] = summarizePreview(dry.events, t);
    }
  }
  const placeCells = {};
  for (const type of Object.keys(DEVICES)) {
    placeCells[type] = ALL_CELLS.filter((c) => canPlaceDevice(s, player, type, c).ok);
  }
  // 召唤点合法性用「预备池里第一个可用名额」来判定（名单外职业一律拒绝）
  const summonPoints = SUMMON_POINTS[player].filter((c) => canSummon(s, player, null, c).ok);
  // 迭代 6：中/顶层双陷阱共用每回合 1 次开关，逐个下发可操作单位与当前开关状态
  const canToggleNow = s.ap >= TOGGLE_COST && !s.perTurnFlags.trapToggled[player];
  const toggleUnitIds = canToggleNow ? toggleUnits(s, player, CENTER_TRAP) : [];
  const toggleTraps = [CENTER_TRAP, TOP_TRAP].map((tp) => ({
    z: tp.z, pos: { ...tp }, open: trapOpenAt(s, tp),
    unitIds: canToggleNow ? toggleUnits(s, player, tp) : [],
  }));

  // 每张手牌的合法目标由服务端按真实 canPlayCard 逐候选算出，前端只负责高亮。
  // 出牌限额按类型区分：装置牌无单回合上限（只看 AP）；技能牌本回合已用过则整体不可打。
  const hand = s.hands?.[player] || [];
  const skillUsed = !!s.perTurnFlags?.skillCardUsed?.[player];
  const canPlay = s.ap >= CARD_COST && hand.length > 0;   // 纯 AP + 有牌
  const canPlaySkill = canPlay && !skillUsed;              // 技能牌本回合是否还能打
  const cardTargets = {};
  const cardCells = {};
  const vision = computeVisibility(s, player);
  for (const c of hand) {
    const cfg = CARDS[c.type];
    if (!cfg) { cardTargets[c.id] = []; cardCells[c.id] = []; continue; }
    // 装置牌只受 AP 约束；技能牌额外受「本回合 1 张」约束，两类互不干扰
    const cardPlayable = canPlay && (isDeviceCardType(c.type) || !skillUsed);
    const target = cfg.target;
    if (target === 'cell') {
      cardTargets[c.id] = [];
      if (!cardPlayable) { cardCells[c.id] = []; continue; }
      if (c.type === 'smoke') {
        // 致盲烟雾：全图任意一个「可见格」
        cardCells[c.id] = [...vision].map(parseKey);
      } else {
        const dt = DEVICE_CARDS[c.type];
        cardCells[c.id] = dt ? ALL_CELLS.filter((p) => canPlaceAt(s, player, dt, p).ok) : [];
      }
      continue;
    }
    cardCells[c.id] = [];
    if (!cardPlayable || target === 'none') { cardTargets[c.id] = []; continue; }
    const pool = s.units.filter((u) => u.alive && (target === 'enemy' ? u.owner !== player : u.owner === player));
    cardTargets[c.id] = pool.filter((u) => canPlayCard(s, c.id, u.id, player).ok).map((u) => u.id);
  }
  const canDraw = s.ap >= DRAW_CARD_COST && hand.length < HAND_LIMIT;

  return {
    moves, attacks, previews, placeCells, summonPoints, toggleUnitIds, toggleTraps,
    canToggle: toggleTraps.some((t) => t.unitIds.length > 0),
    canSummon: summonPoints.length > 0,
    canPlace: Object.values(placeCells).some((list) => list.length > 0),
    canPlay, canPlaySkill, canDraw, cardTargets, cardCells,
    ap: s.ap,
  };
}

// ---------------------------------------------------------------------------
// 每玩家专属视图（战争迷雾在服务端过滤，前端拿不到隐藏单位坐标）
// ---------------------------------------------------------------------------
function maskEvent(e, viewer, s) {
  if (!e.pos) return e;
  // 明牌机关：所有者对自己的机关触发恒可见（可播特效 / 写日志），不受视野裁剪
  if (e.kind === 'arrowTrapTrigger' && e.owner === viewer) return e;
  // 迭代 6：坠落受阻 / 攀升 / 陷阱开关是地形公开事件，坐标固定，双方都可见
  if (['fallBlocked', 'climb', 'climbBlocked', 'toggle',
    'smoke', 'smokeEnd', 'cardPlace', 'draw'].includes(e.kind)) return e;
  const vis = computeVisibility(s, viewer);
  if (vis.has(key(e.pos))) return e;
  return {
    ...e, hidden: true,
    pos: null, from: null, to: null, behind: null,
    attackerPos: null, targetPos: null,
  };
}

/**
 * @returns PlayerView —— 只包含该玩家应当看到的信息 + 当前行动方的合法操作提示
 */
export function viewFor(s, player, meta = {}) {
  // ---- 开局盲选：只下发本人 picks 与「对手是否已确认」，绝不泄露对方阵容 ----
  // 选人完成前棋盘为空（units/devices 都是 []），连对方选了什么都不存在于网络包里。
  if (s.phase === 'picking') {
    return {
      seq: s.actionSeq || 0,
      turn: 1, round: 1, maxRounds: Math.floor(MAX_HALF_TURNS / 2),
      currentPlayer: 'A', mySide: player,
      ap: 0, apMax: AP_PER_TURN,
      units: [], devices: [], centerTrapOpen: false, topTrapOpen: false,
      stairs: STAIRS.map((p) => ({ ...p })),
      trapCells: [CENTER_TRAP, TOP_TRAP].map((p) => ({ ...p })),
      phase: 'picking', winner: null,
      inventory: {}, reserve: 0, reservePool: [],
      perTurnFlags: { summoned: false, placed: false, trapToggled: false, skillCardUsed: false },
      hand: [], visionCells: [], unitVision: {}, logs: [], events: [], hints: null,
      smokes: [], smokeCells: [], deckCount: DECK_SIZE, discardCount: 0, discardTop: null,
      canDraw: false, homeLayer: HOME_LAYER[player], spectating: false,
      pick: {
        pool: CLASS_POOL.map((c) => ({
          id: c, name: CLASS_NAMES[c], hp: CLASSES[c].hp, atk: CLASSES[c].atk,
          desc: CLASS_TRAITS[c], color: CLASS_COLORS[c], icon: CLASS_ICONS[c],
        })),
        size: PICK_SIZE,
        myPicks: [...(s.picks?.[player] || [])],
        myConfirmed: !!s.confirmed?.[player],
        opponentConfirmed: !!s.confirmed?.[other(player)],
      },
      ...meta,
    };
  }
  const vision = computeVisibility(s, player);
  // 防御：新回合刚开始（本回合尚未产生任何 action）却异常出现 AP=0 时，按 5 点下发。
  // 玩家在正常回合内把 5 AP 花光变成 0 不受影响（那时 actionSeq 已推进）。
  const viewAp = (s.phase === 'playing' && !s.winner && s.ap === 0 &&
    s.actionSeq === (s.turnStartSeq ?? -1)) ? AP_PER_TURN : s.ap;
  // 草丛隐身：inGrass 的敌方单位即便在视野内也「绝对不可见」（除非同格贴身反隐）
  const units = s.units.filter((u) => u.alive && unitVisibleTo(s, player, u, vision));
  // 最终版任务一：迷雾内的敌方单位 / 装置「绝对不可见」——
  // 服务端只下发己方装置与「视野内」的装置，隐藏坐标根本不进入网络包（防作弊）。
  const devices = s.devices.filter((d) => d.owner === player || vision.has(key(d.pos)));
  const unitVisionMap = {};
  for (const u of s.units) {
    if (u.alive && u.owner === player) unitVisionMap[u.id] = unitVision(s, u);
  }
  return {
    seq: s.actionSeq,
    turn: s.turn,
    round: Math.ceil(s.turn / 2),
    maxRounds: Math.floor(MAX_HALF_TURNS / 2),
    currentPlayer: s.currentPlayer,
    mySide: player,
    ap: viewAp,
    apMax: AP_PER_TURN,
    units,
    devices,
    centerTrapOpen: s.centerTrapOpen,
    topTrapOpen: !!s.topTrapOpen,
    stairs: STAIRS.map((p) => ({ ...p })),
    trapCells: [CENTER_TRAP, TOP_TRAP].map((p) => ({ ...p })),
    phase: s.phase,
    winner: s.winner || null,
    inventory: { ...s.inventory[player] },
    reserve: s.reserve[player],
    // 预备召唤池：仅本局预选的 2 个单位，前端据此渲染「可召唤 / 已召唤」入口
    reservePool: reserveEntries(s, player),
    // 每回合标志按「当前玩家」展平成布尔（原实现取 s.perTurnFlags[player] 恒为 undefined）
    perTurnFlags: {
      summoned: !!s.perTurnFlags.summoned?.[player],
      placed: !!s.perTurnFlags.placed?.[player],
      trapToggled: !!s.perTurnFlags.trapToggled?.[player],
      skillCardUsed: !!s.perTurnFlags.skillCardUsed?.[player],
    },
    // 通用手牌：只下发「本人」手牌。s.hands 整体（含对方手牌）绝不进入网络包，
    // 也不放进 meta；对方玩家的视图里完全不存在这些卡牌对象。
    hand: (s.hands?.[player] || []).map((c) => ({
      id: c.id, type: c.type,
      name: CARDS[c.type].name, desc: CARDS[c.type].desc,
      target: CARDS[c.type].target, cost: CARD_COST,
      device: CARDS[c.type].device || null,
    })),
    visionCells: [...vision].map(parseKey),
    // 最终版：黑雾 / 牌库 / 弃牌堆 / 主动抽牌 / 己方初始层
    smokes: (s.smokes || []).map((sm) => ({
      id: sm.id, owner: sm.owner, center: { ...sm.center },
      cells: (sm.cells || smokeArea(sm.center)).map((c) => ({ ...c })),
      turnsLeft: sm.turnsLeft,
    })),
    smokeCells: (s.smokes || []).flatMap((sm) =>
      (sm.cells || smokeArea(sm.center)).map((c) => ({ ...c }))),
    deckCount: s.decks?.[player] ?? DECK_SIZE,
    discardCount: (s.discards?.[player] || []).length,
    discardTop: (s.discards?.[player] || []).at(-1)?.name || null,
    canDraw: s.phase === 'playing' && s.currentPlayer === player &&
      s.ap >= DRAW_CARD_COST && (s.hands?.[player] || []).length < HAND_LIMIT,
    homeLayer: HOME_LAYER[player],
    spectating: false,
    unitVision: unitVisionMap,
    logs: s.logs.map((l) => ({ id: l.id, turn: l.turn, kind: l.kind, actor: l.actor, text: l.text[player] })),
    events: (s.lastEvents || []).map((e) => maskEvent(e, player, s)),
    hints: (player === s.currentPlayer && s.phase === 'playing') ? buildHints(s, player) : null,
    ...meta,
  };
}
