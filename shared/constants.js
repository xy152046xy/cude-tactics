// ============================================================================
// shared/constants.js —— 所有规则数值集中在此，前端只做渲染，不持有规则常量。
// 纯 ESM，Node 服务端与浏览器均可直接运行（无 TS 转译依赖）。
//
// 最终版（v2）：战争迷雾可视化 / 致盲烟雾 / 固定首发 / 全层召唤 / 装置卡牌化
// ============================================================================

export const GRID = 3;
export const LAYERS = 3;

// ---------- 回合 / 行动点 ----------
export const AP_PER_TURN = 5;
export const MOVE_COST = 1;
export const STAIR_COST = 1;
export const ATTACK_COST = 1;
export const TOGGLE_COST = 1;
export const PLACE_COST = 1;
/** 最终版任务二：回合内召唤队友固定消耗 2 AP */
export const SUMMON_COST = 2;
/** 最终版任务三：点击【牌库】主动抽 1 张消耗 1 AP */
export const DRAW_CARD_COST = 1;
/** 每方牌库初始张数；抽空后自动把弃牌堆洗回牌库（循环牌库） */
export const DECK_SIZE = 60;
/** 最终版任务一：【致盲烟雾】持续 2 个回合（半回合计数，endTurn 递减） */
export const SMOKE_DURATION = 2;
/** 烟雾半径：以选中可见格为中心的同层 3x3 区域 */
export const SMOKE_RADIUS = 1;

/** 完整回合上限 20 轮（双方各行动 20 次）= 40 个半回合 */
export const MAX_FULL_ROUNDS = 20;
export const MAX_HALF_TURNS = MAX_FULL_ROUNDS * 2;

// ---------- 单位 ----------
/** 本局每方最多同时在场 3 个（1 首发 + 2 个预选队友依次召唤） */
export const MAX_UNITS_ON_FIELD = 3;
/** 预备池 = 预选 3 个单位里除首发外的 2 个，整局每个名额只能用 1 次（= PICK_SIZE - 1） */
export const RESERVE_PER_PLAYER = 2;

// ---------- 单位 ----------
// rangeType: 'adjacent' = 同层正交相邻 1 格或楼梯上下；'line' = 同层正交直线 range 格内
export const CLASSES = {
  warrior:  { hp: 5, atk: 2, range: 1, rangeType: 'adjacent', knock: true,  splash: 0, vision: 'cross' },
  archer:   { hp: 3, atk: 2, range: 2, rangeType: 'line',     knock: true,  splash: 0, vision: 'fullLayer' },
  mage:     { hp: 3, atk: 1, range: 2, rangeType: 'line',     knock: false, splash: 1, vision: 'cross' },
  assassin: { hp: 3, atk: 2, range: 1, rangeType: 'adjacent', knock: false, splash: 0, vision: 'cross',
              noKnockback: true, refreshOnKill: true },
  priest:   { hp: 4, atk: 0, range: 2, rangeType: 'line',     knock: false, splash: 0, vision: 'cross',
              healOnly: true, heal: 2 },
  guardian: { hp: 7, atk: 1, range: 1, rangeType: 'adjacent', knock: true,  splash: 0, vision: 'cross',
              collisionBonus: 1, damageReduction: true },
};

// ---------- 装置 ----------
// 最终版：装置不再靠右侧按钮 + 库存放置，而是作为【卡牌】从手牌打出。
// 下面 DEVICES 仍是唯一的装置数值表（库存字段保留给旧 place 路径与展示兼容）。
export const DEVICES = {
  crate:     { hp: 1, blocks: true,  stock: 3, pair: false, enabled: true, label: '木箱' },
  trap:      { hp: 1, blocks: false, stock: 1, pair: false, enabled: true, label: '固定陷阱' },
  portal:    { hp: 1, blocks: false, stock: 1, pair: true,  enabled: true, label: '传送门' },
  arrowTrap: { hp: 1, blocks: false, stock: 2, pair: false, enabled: true, label: '弩箭机关',
               passable: true },
  grass:     { hp: 1, blocks: false, stock: 2, pair: false, enabled: true, label: '草丛',
               passable: true, indestructible: true },
  climber:   { hp: 1, blocks: false, stock: 1, pair: false, enabled: true, label: '攀升器',
               passable: true, ownerOnly: 'A', layer: 0 },
};

// ---------- 关键坐标 ----------
export const CENTER_TRAP = Object.freeze({ x: 1, y: 1, z: 1 });  // 中层中心陷阱
export const TOP_TRAP = Object.freeze({ x: 1, y: 1, z: 2 });     // 上层中心陷阱
export const FALL_TARGET = Object.freeze({ x: 1, y: 1, z: 0 });  // 底层中心（坠落终点）
export const CLIMB_TARGET = Object.freeze({ x: 1, y: 1, z: 1 }); // 攀升器传送目标 = 中层中心
export const CLIMB_AP_COST = 1;
export const TRAP_LAYERS = Object.freeze([1, 2]);

// ---------- 伤害数值 ----------
export const COLLISION_DAMAGE = 1;
export const FALL_DAMAGE = 1;
export const TRAP_DAMAGE = 1;
export const SPLASH_DAMAGE = 1;
export const ARROW_TRAP_DAMAGE = 1;
export const CRATE_ADVANCE_ON_BREAK = false;
export const ALLOW_PLACE_ON_CLOSED_CENTER = true;

// ---------- 初始布阵（最终版任务二）----------
/**
 * 首发固定坐标：每方阵容的【第 1 个单位】出生在此格。
 * 玩家 A（底层 z=0）-> (0,1,0)；玩家 B（顶层 z=2）-> (2,1,2)。
 */
export const FIRST_SPAWN = Object.freeze({
  A: Object.freeze({ x: 0, y: 1, z: 0 }),
  B: Object.freeze({ x: 2, y: 1, z: 2 }),
});
/**
 * 兼容旧版展示/测试用坐标表。注意：最终版开局【只在第 0 项（= FIRST_SPAWN）生成 1 个首发】，
 * 其余预选单位进入预备召唤池，不再直接生成到战场；召唤落点由玩家在己方初始层自行点击。
 */
export const INITIAL_POSITIONS = {
  A: [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 1, z: 0 }],
  B: [{ x: 2, y: 1, z: 2 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 2 }],
};
export const INITIAL_CLASSES = ['warrior', 'archer', 'mage'];

// ---------- 职业池与开局盲选 ----------
export const CLASS_POOL = ['warrior', 'archer', 'mage', 'assassin', 'priest', 'guardian'];
export const PICK_SIZE = 3;
export const GUARDIAN_FLAT_REDUCTION = 1;
export const GUARDIAN_MIN_DAMAGE = 1;

/**
 * 楼梯点位（严格限制，禁止多余点位引发错误跨层连通）：
 *   底层 z=0：(0,2,0)、(2,2,0)
 *   顶层 z=2：(0,2,2)、(2,2,2)
 *   中层 z=1：(0,2,1)、(2,2,1) —— 仅作为上述两组点位「按坐标严格配对」的垂直中转点。
 * 原先中层多出的 (0,0,1)、(2,0,1) 已移除，它们会让视野/移动错误地跨到非楼梯层。
 */
export const STAIRS = Object.freeze([
  { x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 },
  { x: 0, y: 2, z: 1 }, { x: 2, y: 2, z: 1 },
  { x: 0, y: 2, z: 2 }, { x: 2, y: 2, z: 2 },
]);

/**
 * 楼梯连通白名单：只允许「同 (x,y)、相邻层、两端都是楼梯点」的这 4 条边。
 * 移动与跨层视野都以此为准，杜绝任何 (0,0)↔(2,2) 之类的错误跨层连通。
 */
export const STAIR_LINKS = Object.freeze([
  Object.freeze([Object.freeze({ x: 0, y: 2, z: 0 }), Object.freeze({ x: 0, y: 2, z: 1 })]),
  Object.freeze([Object.freeze({ x: 2, y: 2, z: 0 }), Object.freeze({ x: 2, y: 2, z: 1 })]),
  Object.freeze([Object.freeze({ x: 0, y: 2, z: 1 }), Object.freeze({ x: 0, y: 2, z: 2 })]),
  Object.freeze([Object.freeze({ x: 2, y: 2, z: 1 }), Object.freeze({ x: 2, y: 2, z: 2 })]),
]);

/**
 * 最终版任务二：召唤点 = 己方【初始层】的所有 9 个格子。
 * A 在底层 z=0 任意合法空格召唤，B 在顶层 z=2 任意合法空格召唤。
 * 合法性由 canSummon 逐格校验（空格、非阻挡、同层、预备池、AP）。
 */
const layerCells = (z) => {
  const out = [];
  for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) out.push(Object.freeze({ x, y, z }));
  return out;
};
export const SUMMON_POINTS = Object.freeze({ A: layerCells(0), B: layerCells(2) });
/** 各阵营初始层（用于前端提示文案与校验） */
export const HOME_LAYER = Object.freeze({ A: 0, B: 2 });

// ---------- 通用手牌（最终版任务一 / 任务三）----------
export const CARD_COST = 1;
export const HAND_LIMIT = 5;
export const INITIAL_HAND_SIZE = 5;
/** 最终版任务三：每回合开始自动抽 2 张 */
export const DRAW_PER_TURN = 2;
export const HEAL_AMOUNT = 2;
export const INSIGHT_AP = 2;
export const POWER_KNOCK_DAMAGE = 1;
export const POWER_KNOCK_DISTANCE = 2;
export const POWER_KNOCK_EXTRA_COLLISION = 1;

/**
 * 卡牌表：3 张通用战术牌 + 1 张【致盲烟雾】+ 6 张装置卡。
 * target:
 *   'enemy' / 'ally' / 'none' —— 选单位 / 立即生效（旧行为）
 *   'cell' —— 选一个格子（装置卡放置 / 致盲烟雾中心）
 * device: 仅装置卡有，指向 DEVICES 里的类型（打出后放置该装置）
 */
export const CARDS = {
  powerKnock: {
    name: '强力击退', target: 'enemy',
    desc: '视野内一个敌人受 1 伤并被强制击退 2 格；每撞一次额外受 1 伤',
  },
  bandage: {
    name: '紧急包扎', target: 'ally',
    desc: '己方一个单位恢复 2 点生命（不超过上限）',
  },
  insight: {
    name: '战术洞察', target: 'none',
    desc: '本回合立刻获得 2 AP（无需选择目标）',
  },
  // 最终版任务一：1 费通用战术卡
  smoke: {
    name: '致盲烟雾', target: 'cell',
    desc: '选全图任意可见格，笼罩同层 3x3 黑雾 2 回合；雾中敌方单位视野降为自身周围 1 格',
  },
  // 最终版任务三：装置卡牌化（公共牌库）
  crate:     { name: '木箱',     target: 'cell', device: 'crate',
               desc: '放置木箱：阻挡移动，可当洞口盖板；碎裂抵消碰撞伤害' },
  grass:     { name: '草丛',     target: 'cell', device: 'grass',
               desc: '放置草丛：进入单位隐身，攻击 / 离开破隐' },
  trap:      { name: '固定陷阱', target: 'cell', device: 'trap',
               desc: '放置固定陷阱：敌方进入受 1 伤并消失' },
  portal:    { name: '传送门',   target: 'cell', device: 'portal',
               desc: '放置一对传送门：进入其一传送到另一端' },
  arrowTrap: { name: '弩箭机关', target: 'cell', device: 'arrowTrap',
               desc: '放置弩箭机关：敌方每次进入受 1 伤，无击退' },
  // 特例：攀升器只加入玩家 A 的初始牌库，B 永远抽不到
  climber:   { name: '攀升器',   target: 'cell', device: 'climber', ownerOnly: 'A',
               desc: '放置攀升器（仅 A · 仅底层）：进入后花 1 AP 传送到中层中心' },
};
/** 公共牌库：双方共享同一池。climber 虽在表内，但 B 抽牌时被过滤掉 */
export const CARD_POOL = [
  'powerKnock', 'bandage', 'insight', 'smoke',
  'crate', 'grass', 'trap', 'portal', 'arrowTrap', 'climber',
];
/** 仅玩家 A 可抽到的卡（特例：攀升器只加入 A 的初始牌库） */
export const A_ONLY_CARDS = ['climber'];
/** 装置卡 -> 装置类型映射（服务端结算时用） */
export const DEVICE_CARDS = {
  crate: 'crate', grass: 'grass', trap: 'trap',
  portal: 'portal', arrowTrap: 'arrowTrap', climber: 'climber',
};

// ---------- 出牌限额：按卡牌类型区分（服务端唯一权威分类） ----------
/**
 * 装置牌（场上放置类）：只要 AP 足够，同一回合内可连续打出多张，无单回合数量上限。
 * 技能牌（战术牌 / 非放置类）：同一玩家的一个回合内最多打出 1 张。
 * 两类限额互不干扰，AP 仍按每张牌独立校验。
 */
export const SKILL_CARDS = Object.freeze(['powerKnock', 'bandage', 'insight', 'smoke']);
/** 是否为「场上放置类」装置牌 */
export const isDeviceCardType = (t) => Object.prototype.hasOwnProperty.call(DEVICE_CARDS, t);
/** 是否为技能牌（已存在的卡且非装置牌） */
export const isSkillCardType = (t) => !!CARDS[t] && !isDeviceCardType(t);

// ---------- 展示文案 ----------
export const LAYER_NAMES = ['底层', '中层', '顶层'];
export const CLASS_NAMES = {
  warrior: '战士', archer: '弓手', mage: '法师',
  assassin: '刺客', priest: '牧师', guardian: '重装盾卫',
};
export const DEVICE_NAMES = {
  crate: '木箱', trap: '固定陷阱', portal: '传送门',
  arrowTrap: '弩箭机关', grass: '草丛', climber: '攀升器',
};
export const CARD_NAMES = {
  powerKnock: '强力击退', bandage: '紧急包扎', insight: '战术洞察', smoke: '致盲烟雾',
  crate: '木箱', grass: '草丛', trap: '固定陷阱', portal: '传送门',
  arrowTrap: '弩箭机关', climber: '攀升器',
};
export const PLAYER_NAMES = { A: '玩家 A', B: '玩家 B' };
export const CLASS_COLORS = {
  warrior: '#ff6b6b', archer: '#4ade80', mage: '#a78bfa',
  assassin: '#64748b', priest: '#f5c451', guardian: '#3b6fc4',
};
export const CLASS_ICONS = {
  warrior: '⚔️', archer: '🏹', mage: '🔮',
  assassin: '🗡️', priest: '✨', guardian: '🛡️',
};
export const CLASS_TRAITS = {
  warrior:  '近战 · 命中击退 1 格',
  archer:   '同层全图视野 · 射程 2',
  mage:     '攻 1 无击退 · 无差别溅射 1 点（含友军）',
  assassin: '暗杀：无击退 · 击杀刷新攻击',
  priest:   '治疗：友方回 2 HP · 无伤害',
  guardian: 'HP 7 · 吨位碰撞加伤 · 坚韧受伤 -1（保底 1）',
};

// ---------- 全格枚举 ----------
export const ALL_CELLS = [];
for (let z = 0; z < LAYERS; z++) {
  for (let x = 0; x < GRID; x++) {
    for (let y = 0; y < GRID; y++) ALL_CELLS.push(Object.freeze({ x, y, z }));
  }
}
