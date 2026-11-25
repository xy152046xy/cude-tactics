// ============================================================================
// 纯 Canvas 2D 战斗特效系统（无第三方动画库）
//   * 战士：白/红弧线刀光       * 弓手：带箭头的飞行动画线
//   * 法师：目标处扩散火球       * 受击：红色闪烁 + 伤害飘字（碰撞为绿色 -1）
// ============================================================================
import type { GameEvent } from './types';
import { project, BOARD_W, BOARD_H } from './ui';

type Pt = { x: number; y: number };

type FxKind =
  | 'slash' | 'arrow' | 'fireball' | 'damage' | 'shatter'
  | 'spawn' | 'toggle' | 'teleport' | 'impact' | 'fall'
  | 'arrowTrap' | 'heal' | 'reveal' | 'cardPlay' | 'apGain'
  | 'fallBlocked' | 'climb' | 'climbBlocked';

interface Fx {
  kind: FxKind;
  start: number;
  dur: number;
  a?: Pt;
  b?: Pt;
  p?: Pt;
  text?: string;
  color?: string;
  seed?: number;
  dx?: number;
  dy?: number;
}

export class FxSystem {
  list: Fx[] = [];
  private flashes = new Map<string, number>();

  /** 消费服务端下发的一条 action 的事件流（隐藏事件已无坐标，直接跳过） */
  addFromEvents(events: GameEvent[], now: number) {
    // 同一格在一批事件里可能同时产生攻击伤害与碰撞伤害，做错位避免数字完全重叠
    const dmgCount = new Map<string, number>();
    for (const e of events) {
      if (e.hidden) continue;
      const p = e.pos ? project(e.pos) : null;
      const from = e.from ? project(e.from) : null;
      const to = e.to ? project(e.to) : null;

      switch (e.kind) {
        case 'attack': {
          const a = e.attackerPos ? project(e.attackerPos) : from;
          const b = e.targetPos ? project(e.targetPos) : p;
          if (!a || !b) break;
          if (e.class === 'warrior') this.list.push({ kind: 'slash', start: now, dur: 260, a, b });
          else if (e.class === 'archer') this.list.push({ kind: 'arrow', start: now, dur: 300, a, b });
          else if (e.class === 'mage') this.list.push({ kind: 'fireball', start: now, dur: 420, p: b });
          break;
        }
        case 'damage': {
          if (!p) break;
          // 弩箭机关 / 技能牌伤害为红色 -1；碰撞 / 坠落 / 陷阱为绿色
          const collision = e.source === 'collision' || e.source === 'fall' || e.source === 'trap';
          const k = `${p.x},${p.y}`;
          const n = dmgCount.get(k) || 0;
          dmgCount.set(k, n + 1);
          this.list.push({
            kind: 'damage', start: now, dur: 820, p,
            text: `-${e.amount ?? 1}`,
            color: collision ? '#4ade80' : '#ff5c5c',
            dx: n === 0 ? 0 : (n % 2 ? 26 : -26),
            dy: n * 26,
          });
          if (e.unitId) this.flashes.set(e.unitId, now + 380);
          break;
        }
        case 'arrowTrapTrigger':
          // 520ms：比普攻弹道略慢一档，保证这条小线段在实战节奏里看得清
          if (p) this.list.push({ kind: 'arrowTrap', start: now, dur: 520, p, seed: Math.random() * 1.2 - 0.6 });
          break;
        case 'heal':
          if (p) this.list.push({ kind: 'heal', start: now, dur: 820, p, text: `+${e.amount ?? 2}` });
          break;
        case 'reveal':
          if (p) this.list.push({ kind: 'reveal', start: now, dur: 520, p });
          break;
        case 'cardPlay':
          this.list.push({ kind: 'cardPlay', start: now, dur: 560, p: { x: BOARD_W / 2, y: BOARD_H / 2 } });
          break;
        case 'apGain':
          this.list.push({
            kind: 'apGain', start: now, dur: 900,
            p: { x: BOARD_W / 2, y: BOARD_H / 2 - 46 }, text: `+${e.amount ?? 2} AP`,
          });
          break;
        case 'crateBreak':
          if (p) this.list.push({ kind: 'shatter', start: now, dur: 380, p, seed: Math.random() * 6.28 });
          break;
        case 'collision':
          if (p && !e.crateBreak) this.list.push({ kind: 'impact', start: now, dur: 260, p });
          break;
        case 'place':
        case 'summon':
          if (p) this.list.push({ kind: 'spawn', start: now, dur: 380, p });
          break;
        case 'toggle':
          if (p) this.list.push({ kind: 'toggle', start: now, dur: 420, p });
          break;
        case 'teleport':
          if (from && to) this.list.push({ kind: 'teleport', start: now, dur: 420, a: from, b: to });
          break;
        case 'fall':
          if (from && to) this.list.push({ kind: 'fall', start: now, dur: 320, a: from, b: to });
          break;
        // 迭代 6：被下层单位顶住 / 攀升器传送
        case 'fallBlocked':
          if (p) this.list.push({
            kind: 'fallBlocked', start: now, dur: 900, p,
            text: e.isDevice ? '装置受阻' : '被顶住',
          });
          break;
        case 'climb':
          if (p) this.list.push({ kind: 'climb', start: now, dur: 640, p });
          break;
        case 'climbBlocked':
          if (p) this.list.push({ kind: 'climbBlocked', start: now, dur: 760, p, text: '攀升受阻' });
          break;
        default: break;
      }
    }
  }

  isFlashing(unitId: string, now: number) {
    return (this.flashes.get(unitId) || 0) > now;
  }

  draw(ctx: CanvasRenderingContext2D, now: number) {
    this.list = this.list.filter((f) => now - f.start < f.dur);
    for (const e of [...this.flashes]) if (e[1] <= now) this.flashes.delete(e[0]);

    for (const f of this.list) {
      const t = Math.max(0, Math.min(1, (now - f.start) / f.dur));
      const fade = 1 - t;
      ctx.save();
      ctx.globalAlpha = fade;
      switch (f.kind) {
        case 'slash': {
          const a0 = f.a!, b0 = f.b!;
          // 两端各延长一点，让刀光明显「穿过」目标而不只是压在单位上
          const ex = 0.2;
          const a = { x: a0.x + (a0.x - b0.x) * ex, y: a0.y + (a0.y - b0.y) * ex };
          const b = { x: b0.x + (b0.x - a0.x) * ex, y: b0.y + (b0.y - a0.y) * ex };
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const cx = (a.x + b.x) / 2 + (-dy / len) * 30;
          const cy = (a.y + b.y) / 2 + (dx / len) * 30;
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(255,70,70,.75)';
          ctx.lineWidth = 13 * fade + 2;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x, b.y); ctx.stroke();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 4.5 * fade + 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x, b.y); ctx.stroke();
          break;
        }
        case 'arrow': {
          const a = f.a!, b = f.b!;
          // 先用淡色虚线画出整条弹道，让「飞行」方向一目了然
          ctx.strokeStyle = 'rgba(255,235,160,.28)';
          ctx.lineWidth = 2; ctx.setLineDash([4, 6]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]);

          const head = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const tailT = Math.max(0, t - 0.42);
          const tail = { x: a.x + (b.x - a.x) * tailT, y: a.y + (b.y - a.y) * tailT };
          ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 4; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y); ctx.stroke();
          ctx.strokeStyle = '#fffbe6'; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y); ctx.stroke();
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          ctx.translate(head.x, head.y); ctx.rotate(ang);
          ctx.fillStyle = '#fffbe6';
          ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-7, 7); ctx.lineTo(-7, -7); ctx.closePath(); ctx.fill();
          break;
        }
        case 'fireball': {
          const p = f.p!;
          const r = 7 + 46 * t;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(r, 1));
          g.addColorStop(0, `rgba(255,255,220,${0.95 * fade})`);
          g.addColorStop(0.45, `rgba(255,150,40,${0.85 * fade})`);
          g.addColorStop(1, 'rgba(220,40,20,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = `rgba(255,220,120,${fade})`; ctx.lineWidth = 3 * fade + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.72, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'damage': {
          const p = f.p!;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 24px system-ui, sans-serif';
          const y = Math.max(p.y - 22 - 42 * t + (f.dy || 0), 16);
          const x = p.x + (f.dx || 0);
          ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(f.text || '-1', x, y);
          ctx.fillStyle = f.color || '#ff5c5c';
          ctx.fillText(f.text || '-1', x, y);
          break;
        }
        case 'shatter': {
          const p = f.p!;
          for (let i = 0; i < 8; i++) {
            const ang = (f.seed || 0) + (i / 8) * Math.PI * 2;
            const d = 10 + 34 * t;
            ctx.fillStyle = i % 2 ? '#c98b4b' : '#8b5a2b';
            ctx.save();
            ctx.translate(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d);
            ctx.rotate(ang + t * 3);
            ctx.fillRect(-5, -5, 10, 10);
            ctx.restore();
          }
          break;
        }
        case 'spawn':
        case 'toggle': {
          const p = f.p!;
          ctx.strokeStyle = f.kind === 'toggle' ? '#38bdf8' : '#a78bfa';
          ctx.lineWidth = 3 * fade + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, 8 + 34 * t, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'teleport': {
          ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 3;
          for (const q of [f.a!, f.b!]) {
            ctx.beginPath(); ctx.arc(q.x, q.y, 10 + 26 * t, 0, Math.PI * 2); ctx.stroke();
          }
          break;
        }
        case 'impact': {
          const p = f.p!;
          ctx.strokeStyle = '#fca5a5'; ctx.lineWidth = 3 * fade + 1;
          for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(p.x + Math.cos(ang) * 6, p.y + Math.sin(ang) * 6);
            ctx.lineTo(p.x + Math.cos(ang) * (12 + 18 * t), p.y + Math.sin(ang) * (12 + 18 * t));
            ctx.stroke();
          }
          break;
        }
        case 'fall': {
          const a = f.a!, b = f.b!;
          ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 3;
          ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]);
          break;
        }
        case 'fallBlocked': {
          // 被下层单位顶住：下方橙色阻挡波纹 + 飘字（双方可见的地形公开事件）
          const p = f.p!;
          ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(p.x - 26, p.y + 20); ctx.lineTo(p.x + 26, p.y + 20); ctx.stroke();
          ctx.beginPath(); ctx.arc(p.x, p.y + 20, 8 + 22 * t, Math.PI, Math.PI * 2); ctx.stroke();
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 15px system-ui, sans-serif';
          const y = Math.max(p.y - 30 - 16 * t, 16);
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(f.text || '被顶住', p.x, y);
          ctx.fillStyle = '#fdba74'; ctx.fillText(f.text || '被顶住', p.x, y);
          break;
        }
        case 'climb': {
          // 攀升器传送：蓝色扩散圈 + 向上箭头
          const p = f.p!;
          ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2.5;
          for (let i = 0; i < 3; i++) {
            ctx.beginPath(); ctx.arc(p.x, p.y, 8 + (t * 40 + i * 12), 0, Math.PI * 2); ctx.stroke();
          }
          ctx.strokeStyle = '#e0f2fe'; ctx.lineWidth = 3; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y + 22); ctx.lineTo(p.x, p.y - 22);
          ctx.moveTo(p.x - 8, p.y - 13); ctx.lineTo(p.x, p.y - 22); ctx.lineTo(p.x + 8, p.y - 13);
          ctx.stroke();
          break;
        }
        case 'climbBlocked': {
          const p = f.p!;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 14px system-ui, sans-serif';
          const y = Math.max(p.y - 28 - 14 * t, 16);
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(f.text || '攀升受阻', p.x, y);
          ctx.fillStyle = '#94a3b8'; ctx.fillText(f.text || '攀升受阻', p.x, y);
          break;
        }
        case 'arrowTrap': {
          // 一支小弩箭从格子外侧斜射入触发格中心（带发光，覆盖在单位之上）
          const p = f.p!;
          const ang = -Math.PI / 4 + (f.seed || 0) * 0.35;
          const dist = 58;
          const sx = p.x - Math.cos(ang) * dist, sy = p.y - Math.sin(ang) * dist;
          const headT = Math.min(1, t * 1.18);
          // 允许为负：整条线段从格子外整体滑入，而不是从 0 长度慢慢「长」出来
          // （后者在前 1/3 时间里线段几乎为 0，实战中根本看不到）
          const tailT = headT - 0.62;
          const hx = sx + (p.x - sx) * headT, hy = sy + (p.y - sy) * headT;
          const tx = sx + (p.x - sx) * tailT, ty = sy + (p.y - sy) * tailT;
          ctx.save();
          ctx.lineCap = 'round';
          // 亮黄白箭体 + 外发光，与红色机关图标、红色受击圆明显区分
          ctx.shadowColor = 'rgba(255,225,120,.95)'; ctx.shadowBlur = 12;
          ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 6;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.6;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
          // 箭头
          ctx.translate(hx, hy); ctx.rotate(Math.atan2(p.y - sy, p.x - sx));
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-9, 8); ctx.lineTo(-9, -8); ctx.closePath(); ctx.fill();
          ctx.restore();
          // 命中瞬间在触发格中心补一圈黄色扩散环，强化「箭矢打在身上」的读感
          if (headT >= 0.98) {
            const k = Math.min(1, (t - 0.8) / 0.2);
            ctx.save();
            ctx.strokeStyle = `rgba(255,232,140,${(1 - k) * 0.9})`;
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(p.x, p.y, 9 + 22 * k, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
          }
          break;
        }
        case 'heal': {
          const p = f.p!;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 24px system-ui, sans-serif';
          const y = Math.max(p.y - 22 - 42 * t, 16);
          ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(f.text || '+2', p.x, y);
          ctx.fillStyle = '#4ade80'; ctx.fillText(f.text || '+2', p.x, y);
          break;
        }
        case 'reveal': {
          const p = f.p!;
          ctx.strokeStyle = `rgba(255,255,255,${fade})`; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, 10 + 30 * t, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'cardPlay': {
          const p = f.p!;
          ctx.strokeStyle = `rgba(167,139,250,${fade})`; ctx.lineWidth = 4 * fade + 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, 20 + 120 * t, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = `rgba(56,189,248,${fade * 0.7})`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 10 + 80 * t, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'apGain': {
          const p = f.p!;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 22px system-ui, sans-serif';
          const y = p.y - 30 * t;
          ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(f.text || '+2 AP', p.x, y);
          ctx.fillStyle = '#7dd3fc'; ctx.fillText(f.text || '+2 AP', p.x, y);
          break;
        }
      }
      ctx.restore();
    }
  }
}
