// ============================================================================
// 战斗打击感（Game Feel）：全部由服务端下发的 view.events 驱动，纯前端表现层，
// 不触碰 GameState、不改动 shared/rules.js、不改任何核心数值。
//
//   顿帧 Hit Stop  : FeelClock 冻结特效时间轴 60ms，之后再继续播放击退动画
//   屏幕震动 Shake : 普攻 2px/100ms；碰撞 / 坠落 / 木箱碎裂 6px/200ms
//   法师溅射       : 全屏白色轻闪 0.2 / 100ms
//   受击闪烁       : 棋子纯白闪 2 次（CSS，见 styles.css .piece.flashing）
//   合成音效       : 按攻击职业 / 碰撞类型派发给 audio.play()
// ============================================================================
import type { GameEvent } from './types';
import { audio, type SfxName } from './audio';

export const HIT_STOP_MS = 60;

/**
 * 打击感「游戏时钟」。rAF 原始时间戳是单调递增的，无法暂停；
 * 这里维护一个可冻结的虚拟时钟：hitStop() 后 60ms 内 now() 恒定返回冻结瞬间的
 * 值，特效因此「定格」；冻结结束后时间轴整体后移 60ms，动画从断点继续播放，
 * 而不是快进补帧 —— 这正是「卡肉」的手感来源。
 */
export class FeelClock {
  private frozenTotal = 0;
  private freezeStart = 0;
  private freezeUntil = 0;
  private freezeAmount = 0;

  /** 返回当前「游戏时间」（已扣除所有历史顿帧） */
  now(): number {
    const raw = performance.now();
    if (raw < this.freezeUntil) {
      // 冻结期间：恒定返回触发前的时钟值，特效保持同一帧
      return this.freezeStart - this.frozenTotal + this.freezeAmount;
    }
    return raw - this.frozenTotal;
  }

  /** 触发一次顿帧；已在冻结中则不叠加，避免连击时越卡越长 */
  hitStop(ms = HIT_STOP_MS) {
    const raw = performance.now();
    if (raw < this.freezeUntil) return;
    this.freezeStart = raw;
    this.freezeAmount = ms;
    this.freezeUntil = raw + ms;
    this.frozenTotal += ms;
  }

  get frozen() { return performance.now() < this.freezeUntil; }
}

export type ShakeLevel = 'none' | 'light' | 'heavy';

export interface FeelCue {
  shake: ShakeLevel;
  fullFlash: boolean;      // 法师溅射 -> 全屏白闪
  hitStop: boolean;        // 是否顿帧
  sounds: SfxName[];       // 需要播放的音效（已去重）
}

const HEAVY_DAMAGE_SOURCES = new Set(['collision', 'fall', 'trap', 'arrowTrap']);
const ATTACK_SOUND: Record<string, SfxName> = {
  warrior: 'slash', assassin: 'slash', guardian: 'impact',
  archer: 'arrow', mage: 'explosion',
};

/** 把一批服务端事件翻译成打击反馈；hidden 事件（视野外）一律忽略 */
export function analyzeEvents(events: GameEvent[]): FeelCue {
  const cue: FeelCue = { shake: 'none', fullFlash: false, hitStop: false, sounds: [] };
  const soundSet = new Set<SfxName>();
  const elevate = (lv: ShakeLevel) => {
    if (lv === 'heavy') cue.shake = 'heavy';
    else if (lv === 'light' && cue.shake === 'none') cue.shake = 'light';
  };

  for (const e of events) {
    if (e.hidden) continue;
    switch (e.kind) {
      case 'attack': {
        const cls = String(e.class || '');
        // 普通攻击命中：轻震；法师攻击触发全屏白闪（溅射表现）
        elevate('light');
        if (cls === 'mage') cue.fullFlash = true;
        const s = ATTACK_SOUND[cls];
        if (s) soundSet.add(s);
        break;
      }
      case 'damage': {
        cue.hitStop = true;                       // 任意伤害都顿帧
        const src = String(e.source || '');
        if (HEAVY_DAMAGE_SOURCES.has(src)) elevate('heavy');
        else if (src === 'splash') cue.fullFlash = true;  // 法师无差别溅射
        else elevate('light');
        if (HEAVY_DAMAGE_SOURCES.has(src)) soundSet.add('impact');
        break;
      }
      case 'collision':
      case 'crateBreak':
      case 'fall':
      case 'fallBlocked':
        cue.hitStop = true;
        elevate('heavy');                        // 碰撞 / 坠落 / 碎裂：强震
        soundSet.add('impact');
        break;
      case 'arrowTrapTrigger':
        cue.hitStop = true;
        elevate('light');
        break;
      default: break;
    }
  }
  cue.sounds = [...soundSet];
  return cue;
}

/** 重启动画的小工具：移除 -> 强制 reflow -> 加回 */
function replay(el: Element | null, cls: string, ms: number) {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

/**
 * 把一条反馈作用到 DOM 与音频：屏幕震动、全屏白闪、顿帧定格提示、合成音效。
 * 使用 classList 直接操作，避免因高频 setState 打断 rAF 特效循环。
 */
export function applyFeedback(cue: FeelCue, clock: FeelClock) {
  for (const s of cue.sounds) audio.play(s);
  if (cue.hitStop) clock.hitStop(HIT_STOP_MS);

  // 震动作用于主舞台 .stage：它是普通文档流元素，不含 fixed 子元素，
  // transform 不会破坏全屏白闪叠层 / 表情气泡的视口定位。
  const stage = document.querySelector('.stage') || document.querySelector('.game');
  if (!stage) return;
  if (cue.shake === 'heavy') replay(stage, 'fx-shake-heavy', 210);
  else if (cue.shake === 'light') replay(stage, 'fx-shake-light', 110);
  // 全屏白色轻闪：fixed 覆盖层，独立于震动，保证「法师溅射」全屏可见
  if (cue.fullFlash) replay(document.querySelector('.fx-flash-overlay'), 'fx-flash-on', 110);
  // 顿帧标记：给棋盘外框一个极短的定格高亮（box-shadow 不产生包含块，安全）
  if (cue.hitStop) replay(document.querySelector('.game'), 'fx-hitstop', HIT_STOP_MS + 20);
}

/**
 * 供真机验收脚本读取的只读调试句柄（与 __cubeAudio 一致）。
 * 生产构建里同样存在，但只是暴露纯函数 analyzeEvents 与一个显式的 simulate()，
 * 不会自行触发任何反馈、不监听事件、不影响正常对局。
 */
export function installFeelDebug() {
  try {
    const clock = new FeelClock();
    (window as unknown as { __cubeFeel?: unknown }).__cubeFeel = {
      analyze: (events: GameEvent[]) => analyzeEvents(events),
      simulate: (cue: FeelCue) => applyFeedback(cue, clock),
      hitStopMs: HIT_STOP_MS,
      // 顿帧时钟自检：冻结期间 now() 应恒定，冻结结束后连续、不快进
      testClock: () => {
        const c = new FeelClock();
        const before = c.now();
        c.hitStop(HIT_STOP_MS);
        const during1 = c.now();
        const frozen = c.frozen;
        const during2 = c.now();
        return { before, during1, during2, frozen,
          heldSteady: Math.abs(during2 - during1) < 1,
          noRewind: Math.abs(during1 - before) < 20 };
      },
    };
  } catch { /* ignore */ }
}
