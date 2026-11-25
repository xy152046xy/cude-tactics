// 纯展示层常量与 Canvas 几何换算（不含任何规则逻辑）
import type { Pos, UnitClass, DeviceType, Side, CardType } from './types';

export const CELL = 96;
export const PAD = 24;
export const GAP = 30;
export const TOP = 66;
export const BOARD_W = PAD * 2 + 3 * 3 * CELL + 2 * GAP; // 972
export const BOARD_H = TOP + 3 * CELL + PAD;               // 378

export const LAYER_NAMES = ['底层', '中层', '顶层'];
// ---------- 迭代 5：6 职业展示元数据（与 shared/constants.js 保持一致） ----------
export const CLASS_NAMES: Record<UnitClass, string> = {
  warrior: '战士', archer: '弓手', mage: '法师',
  assassin: '刺客', priest: '牧师', guardian: '盾卫',
};
export const CLASS_SHORT: Record<UnitClass, string> = {
  warrior: '战', archer: '弓', mage: '法',
  assassin: '刺', priest: '牧', guardian: '盾',
};
export const CLASS_ICONS: Record<UnitClass, string> = {
  warrior: '⚔️', archer: '🏹', mage: '🔮',
  assassin: '🗡️', priest: '✨', guardian: '🛡️',
};
export const CLASS_COLORS: Record<UnitClass, string> = {
  warrior: '#ff6b6b', archer: '#4ade80', mage: '#a78bfa',
  assassin: '#64748b', priest: '#f5c451', guardian: '#3b6fc4',
};
/**
 * 迭代 6：棋子的「职业专属主题渐变」——战深红 / 弓深绿 / 法深紫 /
 * 刺黑灰 / 牧亮白 / 盾深蓝。纯展示常量，服务端不参与。
 */
export const CLASS_THEME: Record<UnitClass, { from: string; to: string; light?: boolean }> = {
  warrior:  { from: '#b23b3b', to: '#3a1114' },
  archer:   { from: '#2f8a55', to: '#0e2a1a' },
  mage:     { from: '#7145b5', to: '#231143' },
  assassin: { from: '#525c6b', to: '#12161e' },
  priest:   { from: '#f7f2df', to: '#b6a373', light: true },
  guardian: { from: '#2c559f', to: '#0e1c3e' },
};
export const CLASS_TRAITS: Record<UnitClass, string> = {
  warrior:  '近战 · 命中击退 1 格',
  archer:   '同层全图视野 · 射程 2',
  mage:     '射程 2 · 溅射 1 点',
  assassin: '暗杀：无击退 · 击杀刷新攻击',
  priest:   '治疗：友方回 2 HP · 无伤害',
  guardian: '吨位：碰撞加伤 · 坚韧减伤',
};

/**
 * 运行环境是否具备彩色 Emoji 字体。
 * 部分精简 Linux / 服务器环境只装了 Noto Sans Symbols（单色且缺 🏹🔮✨ 等字形），
 * 直接渲染会出现豆腐块。这里把两个不同 Emoji 各画到 canvas 再比对像素：
 * 若字体不支持，两者都会落到同一个 notdef 方框（dataURL 相同）；支持则明显不同。
 * 不支持时所有职业图标统一回退为大号中文单字，保证视觉始终清晰。
 */
export const EMOJI_OK: boolean = (() => {
  try {
    if (typeof document === 'undefined') return false;
    const draw = (ch: string) => {
      const c = document.createElement('canvas');
      c.width = 36; c.height = 36;
      const x = c.getContext('2d');
      if (!x) return '';
      x.font = '30px sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(ch, 18, 18);
      return c.toDataURL();
    };
    const a = draw('🏹');
    const b = draw('🔮');
    return !!a && a !== b;
  } catch {
    return false;
  }
})();

/** 职业图标字形：有 Emoji 用 Emoji，否则回退中文单字 */
export const classGlyph = (c: UnitClass): string => (EMOJI_OK ? CLASS_ICONS[c] : CLASS_SHORT[c]);

/** 阵营外圈色（相对视角：蓝=己方，红=敌方，与图例一致） */
export const SIDE_RING: Record<Side, string> = { A: '#38bdf8', B: '#f87171' };
/** 血条按比例变色：绿 -> 黄 -> 红 */
export const hpColor = (hp: number, maxHp: number): string => {
  const r = maxHp > 0 ? hp / maxHp : 0;
  if (r > 0.6) return '#4ade80';
  if (r > 0.3) return '#fbbf24';
  return '#ef4444';
};
export const DEVICE_NAMES: Record<DeviceType, string> = {
  crate: '木箱', trap: '固定陷阱', portal: '传送门', arrowTrap: '弩箭机关', grass: '草丛',
  climber: '攀升器',
};
export const PLAYER_NAMES: Record<Side, string> = { A: '玩家 A', B: '玩家 B' };

// ---------- 迭代 9：局内表情（展示数据） ----------
// id 必须与 shared/emotes.js 的 EMOTE_IDS 完全一致，由 tests/lan.test.js 校验。
// 服务端下发的 payload 同样带 emoji/label，这里仅作按钮面板的静态展示用。
export interface EmoteDef { id: string; emoji: string; label: string; color: string }
export const EMOTES: EmoteDef[] = [
  { id: 'cool',  emoji: '😎', label: '摸头', color: '#38bdf8' },
  { id: 'laugh', emoji: '😂', label: '大笑', color: '#fbbf24' },
  { id: 'cry',   emoji: '😭', label: '大哭', color: '#60a5fa' },
  { id: 'angry', emoji: '🤬', label: '生气', color: '#f87171' },
  { id: 'like',  emoji: '👍', label: '点赞', color: '#4ade80' },
  { id: 'think', emoji: '🤔', label: '思考', color: '#a78bfa' },
];
/** 表情 CD（秒）：与服务端 EMOTE_CD_MS 对齐，仅用于本地按钮置灰 */
export const EMOTE_CD_S = 3;

/** 可作装置卡牌放置的类型（与服务端 DEVICES 表一致；攀升器仅 A 的牌库有） */
export const DEVICE_TYPES: DeviceType[] = ['crate', 'trap', 'portal', 'arrowTrap', 'grass', 'climber'];
/**
 * 兼容常量：最终版已取消「明牌装置」概念 ——
 * 迷雾内的敌方单位/装置一律不可见，装置是否已下发完全由服务端按视野决定。
 */
export const ALWAYS_VISIBLE_DEVICES: DeviceType[] = ['arrowTrap', 'grass', 'climber'];

// ---------- 卡牌展示（文案由服务端下发，这里只放配色 / 图标等纯视觉信息） ----------
export interface CardStyle { color: string; icon: string; tag: string; kind: '战术' | '装置' }
export const CARD_INFO: Record<CardType, CardStyle> = {
  powerKnock: { color: '#fb7185', icon: '⤢',   tag: '攻击', kind: '战术' },
  bandage:    { color: '#4ade80', icon: '✚',   tag: '辅助', kind: '战术' },
  insight:    { color: '#38bdf8', icon: '✦',   tag: '增益', kind: '战术' },
  smoke:      { color: '#a78bfa', icon: '🌫️', tag: '迷雾', kind: '战术' },
  crate:      { color: '#d9a066', icon: '📦', tag: '装置', kind: '装置' },
  grass:      { color: '#4ade80', icon: '🌿', tag: '装置', kind: '装置' },
  trap:       { color: '#f87171', icon: '🔺', tag: '装置', kind: '装置' },
  portal:     { color: '#c084fc', icon: '🌀', tag: '装置', kind: '装置' },
  arrowTrap:  { color: '#fb923c', icon: '🎯', tag: '装置', kind: '装置' },
  climber:    { color: '#7dd3fc', icon: '⤴',   tag: '仅 A', kind: '装置' },
};
export const isDeviceCard = (t: CardType): boolean => CARD_INFO[t]?.kind === '装置';

export const keyOf = (p: Pos) => `${p.x},${p.y},${p.z}`;
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
export const isCorner = (p: Pos) => p.x !== 1 && p.y !== 1;
export const isCenterTrap = (p: Pos) => p.x === 1 && p.y === 1 && p.z === 1;

export const layerX = (z: number) => PAD + z * (3 * CELL + GAP);
export const cellRect = (x: number, y: number, z: number) => ({
  x: layerX(z) + x * CELL, y: TOP + y * CELL, w: CELL, h: CELL,
});
/** 屏幕中心（整数坐标） */
export const project = (p: Pos) => ({
  x: layerX(p.z) + (p.x + 0.5) * CELL,
  y: TOP + (p.y + 0.5) * CELL,
});
/** 屏幕中心（支持补间用的小数坐标） */
export const projectF = (x: number, y: number, z: number) => ({
  x: layerX(z) + (x + 0.5) * CELL,
  y: TOP + (y + 0.5) * CELL,
});

/** 画布逻辑坐标 -> 格子坐标；点击落在层间空隙时返回 null */
export function pick(mx: number, my: number): Pos | null {
  for (let z = 0; z < 3; z++) {
    const lx = layerX(z);
    if (mx < lx || mx >= lx + 3 * CELL) continue;
    if (my < TOP || my >= TOP + 3 * CELL) continue;
    const x = Math.floor((mx - lx) / CELL);
    const y = Math.floor((my - TOP) / CELL);
    if (x >= 0 && x < 3 && y >= 0 && y < 3) return { x, y, z };
  }
  return null;
}

export const CENTER_TRAP: Pos = { x: 1, y: 1, z: 1 };
/** 迭代 6：顶层中心陷阱与全部陷阱格（展示用，权威坐标由 viewFor 下发） */
export const TOP_TRAP: Pos = { x: 1, y: 1, z: 2 };
export const TRAP_CELLS: Pos[] = [CENTER_TRAP, TOP_TRAP];
