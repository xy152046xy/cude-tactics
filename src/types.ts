// 前端类型定义：与服务端 viewFor() 下发的 PlayerView 一一对应。
// 前端不持有任何规则实现，只描述「服务端会给我什么」。
// 最终版（v2）：战争迷雾 / 致盲烟雾 / 装置卡牌 / 主动抽牌 / 观战继承视野

export type Pos = { x: number; y: number; z: number };
export type Side = 'A' | 'B';
export type UnitClass = 'warrior' | 'archer' | 'mage' | 'assassin' | 'priest' | 'guardian';
export type DeviceType = 'crate' | 'trap' | 'portal' | 'arrowTrap' | 'grass' | 'climber';
export type Phase = 'picking' | 'playing' | 'gameover' | 'handoff';
export type RoomStatus = 'waiting' | 'picking' | 'playing' | 'gameover';
/** 兼容保留（最终版已删除右侧工具按钮，UI 不再使用该联合类型） */
export type Tool = 'move' | 'attack' | 'crate' | 'trap' | 'portal' | 'arrowTrap' | 'grass' | 'climber' | 'summon' | 'toggle';
export type VisionMode = 'union' | 'focus';

// ---------- 卡牌 ----------
/** 3 张通用战术牌 + 致盲烟雾 + 6 张装置卡 */
export type CardType =
  | 'powerKnock' | 'bandage' | 'insight' | 'smoke'
  | 'crate' | 'grass' | 'trap' | 'portal' | 'arrowTrap' | 'climber';
/** 'cell' = 选一个格子（装置放置 / 致盲烟雾中心） */
export type CardTarget = 'enemy' | 'ally' | 'none' | 'cell';

export interface Card {
  id: string;
  type: CardType;
}
export type Hand = Card[];

/** viewFor 只把「本人」的手牌以该结构下发；对方手牌完全不出现在网络包里 */
export interface CardView {
  id: string;
  type: CardType;
  name: string;
  desc: string;
  target: CardTarget;
  cost: number;
  /** 装置卡对应的装置类型；非装置卡为 null */
  device: DeviceType | null;
}

export interface Unit {
  id: string;
  owner: Side;
  class: UnitClass;
  hp: number;
  maxHp: number;
  pos: Pos;
  hasAttacked: boolean;
  alive: boolean;
  inGrass: boolean;
}

export interface Device {
  id: string;
  owner: Side;
  type: DeviceType;
  hp: number;
  pos: Pos;
  pairedId?: string;
}

/** 致盲烟雾：同层 3x3 黑雾，持续 2 回合 */
export interface SmokeView {
  id: string;
  owner: Side;
  center: Pos;
  cells: Pos[];
  turnsLeft: number;
}

export interface Preview {
  damage: number;
  heal?: number;
  knock: { dir: { x: number; y: number }; from: Pos; to: Pos } | null;
  collision: {
    reason: 'wall' | 'unit' | 'device' | 'hole';
    damage: number;
    crateBreak: boolean;
    behind: Pos;
  } | null;
  crateBreak: boolean;
  splash: { unitId: string; pos: Pos; amount: number }[];
  kills: string[];
  deviceDestroyed: boolean;
}

export interface Hints {
  moves: Record<string, Pos[]>;
  attacks: Record<string, string[]>;
  previews: Record<string, Record<string, Preview>>;
  placeCells: Record<DeviceType, Pos[]>;
  summonPoints: Pos[];
  toggleUnitIds: string[];
  toggleTraps: { z: number; pos: Pos; open: boolean; unitIds: string[] }[];
  canToggle: boolean;
  canSummon: boolean;
  canPlace: boolean;
  /** 是否还有牌且 AP 足够（装置牌 / 技能牌共同的最低门槛） */
  canPlay: boolean;
  /** 技能牌本回合是否还能打出（canPlay && !skillCardUsed）；装置牌不受此限 */
  canPlaySkill: boolean;
  /** 最终版：花 1 AP 点击牌库主动抽 1 张 */
  canDraw: boolean;
  cardTargets: Record<string, string[]>;
  /** 最终版：选格子卡的合法格（装置放置 / 致盲烟雾的可见格） */
  cardCells: Record<string, Pos[]>;
  ap: number;
}

export interface GameEvent {
  kind: string;
  pos?: Pos | null;
  from?: Pos | null;
  to?: Pos | null;
  behind?: Pos | null;
  attackerPos?: Pos | null;
  targetPos?: Pos | null;
  dir?: { x: number; y: number };
  class?: UnitClass;
  cls?: UnitClass;
  owner?: Side;
  actor?: Side;
  unitId?: string;
  targetId?: string;
  deviceId?: string;
  amount?: number;
  source?: string;
  reason?: string;
  damage?: number;
  crateBreak?: boolean;
  hidden?: boolean;
  type?: DeviceType;
  deviceType?: DeviceType;
  open?: boolean;
  cells?: Pos[];
  turnsLeft?: number;
  z?: number;
  winner?: Side | 'draw';
  loser?: Side;
  next?: Side | null;
  round?: number;
  isDevice?: boolean;
  targetIsDevice?: boolean;
  targetOwner?: Side;
  targetClass?: UnitClass;
  targetDeviceType?: DeviceType;
  [k: string]: unknown;
}

export interface LogEntry {
  id: number;
  turn: number;
  kind: string;
  actor: Side;
  text: string;
}

export interface PickClassInfo {
  id: UnitClass;
  name: string;
  hp: number;
  atk: number;
  desc: string;
  color: string;
  icon: string;
}
export interface PickData {
  pool: PickClassInfo[];
  size: number;
  myPicks: UnitClass[];
  myConfirmed: boolean;
  opponentConfirmed: boolean;
}

/** 预备召唤池条目：本局预选的队友，每个整局只能召唤一次 */
export interface ReserveEntry {
  key: string;
  cls: UnitClass;
  used: boolean;
  name: string;
}

export interface PlayerView {
  seq: number;
  turn: number;
  round: number;
  maxRounds: number;
  currentPlayer: Side;
  mySide: Side;
  ap: number;
  apMax: number;
  units: Unit[];
  devices: Device[];
  centerTrapOpen: boolean;
  topTrapOpen: boolean;
  stairs: Pos[];
  trapCells: Pos[];
  phase: Phase;
  winner: Side | 'draw' | null;
  inventory: Record<string, number>;
  /** 预备召唤池中尚未出场的名额数量 */
  reserve: number;
  /** 本局预选的预备单位：只能从这里点选召唤，used=true 表示【已召唤】且整局锁死 */
  reservePool: ReserveEntry[];
  /** skillCardUsed：本回合技能牌是否已使用（装置牌不受此标记限制，新回合重置） */
  perTurnFlags: { summoned: boolean; placed: boolean; trapToggled: boolean; skillCardUsed: boolean };
  hand: CardView[];
  /** 视野内的格子（迷雾遮罩按此取反） */
  visionCells: Pos[];
  unitVision: Record<string, Pos[]>;
  /** 最终版：致盲烟雾 */
  smokes: SmokeView[];
  smokeCells: Pos[];
  /** 最终版：牌库 / 弃牌堆 */
  deckCount: number;
  discardCount: number;
  discardTop: string | null;
  canDraw: boolean;
  /** 己方初始层：A=0，B=2 */
  homeLayer: number;
  /** 观战者：只读，继承 mySide 的迷雾视野 */
  spectating: boolean;
  logs: LogEntry[];
  events: GameEvent[];
  hints: Hints | null;
  pick?: PickData;
  roomCode: string;
  status: RoomStatus;
  opponentConnected: boolean;
}

export interface RoomInfo {
  code: string;
  side: Side;
  status: RoomStatus;
  opponentConnected: boolean;
}

// ---------- 局内表情（独立 Socket 旁路事件） ----------
export interface EmotePayload {
  side: Side;
  id: string;
  emoji: string;
  label: string;
  color: string;
  serverTs: number;
}
export interface EmoteCooldown {
  remainingMs: number;
}
/** 观战订阅的应答 */
export interface SpectateAck {
  ok: boolean;
  code?: string;
  side?: Side;
  error?: string;
}
