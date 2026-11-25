import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type CSSProperties } from 'react';
import type { PlayerView, Pos, Unit, Device } from '../types';
import { FxSystem } from '../effects';
import { FeelClock, analyzeEvents, applyFeedback } from '../gamefeel';
import {
  CELL, TOP, BOARD_W, BOARD_H, layerX, cellRect, project, projectF, pick,
  keyOf, samePos, TRAP_CELLS,
  LAYER_NAMES, CLASS_SHORT, CLASS_COLORS, CLASS_THEME, classGlyph, hpColor,
  DEVICE_NAMES,
} from '../ui';

interface Props {
  view: PlayerView;
  selected: string | null;
  /** 当前选中、等待点击棋盘格的手牌 id */
  cardMode: string | null;
  /** 黄色高亮格：装置卡 / 致盲烟雾 / 召唤的合法格（已由 Game 过滤为可见格） */
  overlayCells: Pos[];
  overlayKind: 'card' | 'summon' | null;
  disabled: boolean;
  onCell: (pos: Pos, unit?: Unit, device?: Device) => void;
}
interface RenderArgs extends Props {
  hover: Pos | null;
  dpr: number;
  time: number;
}

const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 统一底格绘制：最终版视觉减负 —— 未选中网格更暗、无边框发光，仅在交互时高亮 */
function fillCell(
  ctx: CanvasRenderingContext2D, p: Pos, color: string, border: string,
  dash: number[] = [], lineWidth = 1.2, glow: string | null = null,
) {
  const r = cellRect(p.x, p.y, p.z);
  ctx.fillStyle = color;
  ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 12; }
  ctx.strokeStyle = border;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
}

/** 黑雾特效：多个缓慢漂移的黑色径向渐变叠出翻滚烟雾，永不遮挡棋盘交互（纯背景层） */
function renderSmoke(ctx: CanvasRenderingContext2D, view: PlayerView, time: number) {
  const t = time / 1000;
  for (const p of view.smokeCells || []) {
    const r = cellRect(p.x, p.y, p.z);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x + 2, r.y + 2, r.w - 4, r.h - 4); ctx.clip();
    ctx.fillStyle = 'rgba(5,4,11,.66)';
    ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
    for (let i = 0; i < 5; i++) {
      const px = r.x + r.w * (0.5 + 0.32 * Math.sin(t * 0.62 + i * 1.9));
      const py = r.y + r.h * (0.5 + 0.32 * Math.cos(t * 0.51 + i * 2.3));
      const rad = r.w * (0.42 + 0.12 * Math.sin(t * 0.8 + i));
      const g = ctx.createRadialGradient(px, py, 1, px, py, rad);
      g.addColorStop(0, 'rgba(1,1,4,.94)');
      g.addColorStop(0.6, 'rgba(10,7,18,.58)');
      g.addColorStop(1, 'rgba(10,7,18,0)');
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(167,139,250,.4)'; ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    ctx.setLineDash([]);
  }
  for (const sm of view.smokes || []) {
    const c = project(sm.center);
    ctx.fillStyle = 'rgba(216,180,254,.9)';
    ctx.font = `600 10px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`黑雾 ${sm.turnsLeft}`, c.x, c.y - 34);
  }
}

/** 地形 / 迷雾 / 高亮 / 装置 / 预览：全部画在底层 Canvas，单位与特效不在这里 */
function renderBoard(ctx: CanvasRenderingContext2D, a: RenderArgs) {
  const { view, selected, cardMode, overlayCells, overlayKind, hover, time } = a;
  ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);

  // ---- 深藏青 / 深蓝灰背景 + 微弱径向渐变 ----
  const bg = ctx.createRadialGradient(BOARD_W / 2, BOARD_H * 0.18, 30, BOARD_W / 2, BOARD_H * 0.55, BOARD_W * 0.78);
  bg.addColorStop(0, '#141d31');
  bg.addColorStop(0.55, '#0b1220');
  bg.addColorStop(1, '#070b13');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  // 视野集合：服务端按「己方所有单位视野并集」权威下发（观战者继承被观战方视野）
  const vision = new Set(view.visionCells.map(keyOf));
  const enemyVisible = (p: Pos) => vision.has(keyOf(p));
  const hints = view.hints;
  const myTurn = view.currentPlayer === view.mySide && view.phase === 'playing' && !!hints && !view.spectating;

  const stairSet = new Set((view.stairs || []).map(keyOf));
  const trapCells = view.trapCells?.length ? view.trapCells : TRAP_CELLS;
  const trapSet = new Set(trapCells.map(keyOf));
  const trapOpen = (p: Pos) => p.z === 2 ? !!view.topTrapOpen : !!view.centerTrapOpen;
  const coveredByCrate = (p: Pos) => view.devices.some((d) => d.type === 'crate' && samePos(d.pos, p));

  // ---- 楼层面板 ----
  for (let z = 0; z < 3; z++) {
    const lx = layerX(z);
    ctx.fillStyle = 'rgba(15,22,37,.7)';
    ctx.strokeStyle = 'rgba(140,170,215,.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, lx - 7, TOP - 34, 3 * CELL + 14, 3 * CELL + 42, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7f95b4';
    ctx.font = `600 14px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${LAYER_NAMES[z]}  ·  z=${z}`, lx + 4, TOP - 17);
  }

  // ---- 地形格（全图始终可见，未选中格进一步调暗、取消常驻发光） ----
  for (let z = 0; z < 3; z++) {
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        const p = { x, y, z };
        const stair = stairSet.has(keyOf(p));
        const isTrap = trapSet.has(keyOf(p));
        const open = isTrap && trapOpen(p);
        const covered = isTrap && coveredByCrate(p);
        const r = cellRect(x, y, z);

        if (isTrap) {
          if (open && !covered) {
            const c = project(p);
            const g = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, CELL * 0.54);
            g.addColorStop(0, '#000000');
            g.addColorStop(0.5, '#04060c');
            g.addColorStop(1, '#101828');
            ctx.fillStyle = g;
            ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
            ctx.strokeStyle = 'rgba(239,68,68,.42)'; ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = covered ? '#1a2030' : '#141a27';
            ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
            ctx.strokeStyle = 'rgba(140,170,215,.18)'; ctx.lineWidth = 1;
            ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
            ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(r.x + 9, r.y + r.h - 9); ctx.lineTo(r.x + r.w - 9, r.y + r.h - 9);
            ctx.stroke();
          }
        } else if (stair) {
          fillCell(ctx, p, '#172238', 'rgba(150,180,225,.28)', [], 1.2);
        } else {
          fillCell(ctx, p, '#151a27', 'rgba(255,255,255,.065)', [], 1);
        }

        ctx.fillStyle = 'rgba(160,180,200,.22)';
        ctx.font = `10px ${FONT}`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`${x},${y}`, r.x + 7, r.y + 6);

        if (stair) {
          ctx.fillStyle = 'rgba(201,162,39,.6)';
          ctx.font = `16px ${FONT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('⇅', r.x + r.w / 2, r.y + r.h / 2 + 14);
        }
        if (isTrap) {
          const c = project(p);
          if (open && !covered) {
            ctx.fillStyle = 'rgba(0,0,0,.85)';
            ctx.beginPath(); ctx.arc(c.x, c.y, 21, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(239,68,68,.4)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.arc(c.x, c.y, 21, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = 'rgba(120,160,215,.32)'; ctx.lineWidth = 1.4;
            for (let i = -2; i <= 2; i++) {
              ctx.beginPath(); ctx.moveTo(c.x - 20, c.y + i * 8); ctx.lineTo(c.x + 20, c.y + i * 8); ctx.stroke();
            }
          }
          ctx.fillStyle = open ? (covered ? '#fbbf24' : '#fca5a5') : '#829fbe';
          ctx.font = `600 11px ${FONT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const layerName = z === 2 ? '顶层' : '中层';
          ctx.fillText(open ? (covered ? '洞口·已盖' : '洞口') : `${layerName}陷阱(关)`, c.x, c.y - 32);
        }
      }
    }
  }

  // ---- 战争迷雾：视野外所有格子覆盖 rgba(0,0,0,0.75) 深色半透明遮罩 ----
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  for (let z = 0; z < 3; z++) {
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        if (vision.has(`${x},${y},${z}`)) continue;
        const r = cellRect(x, y, z);
        ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
      }
    }
  }

  // ---- 致盲烟雾：黑色翻滚烟雾（画在迷雾之上，双方都能看到黑雾区域） ----
  if (view.smokeCells?.length) renderSmoke(ctx, view, time);

  // ---- 草丛：半透明绿色纹理（仅己方 / 视野内装置，服务端已过滤迷雾内敌方装置） ----
  for (const d of view.devices.filter((x) => x.type === 'grass' &&
    (x.owner === view.mySide || vision.has(keyOf(x.pos))))) {
    const r = cellRect(d.pos.x, d.pos.y, d.pos.z);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x + 3, r.y + 3, r.w - 6, r.h - 6); ctx.clip();
    ctx.fillStyle = 'rgba(34,197,94,.14)';
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    ctx.strokeStyle = 'rgba(74,222,128,.3)'; ctx.lineWidth = 2;
    for (let i = -r.h; i < r.w + r.h; i += 11) {
      ctx.beginPath();
      ctx.moveTo(r.x + i, r.y + r.h);
      ctx.lineTo(r.x + i + 16, r.y + r.h - 20);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(74,222,128,.5)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8); ctx.setLineDash([]);
    ctx.fillStyle = '#86efac'; ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('草', r.x + 7, r.y + r.h - 6);
  }

  // ---- 操作高亮与攻击预览（只在交互时发光） ----
  if (myTurn && hints) {
    const highlight = (cells: Pos[], color: string, border: string, glow: string) => {
      for (const p of cells) {
        if (!vision.has(keyOf(p))) continue;   // 迷雾格绝不亮起、绝不响应点击
        const r = cellRect(p.x, p.y, p.z);
        ctx.save();
        ctx.shadowColor = glow; ctx.shadowBlur = 16;
        ctx.fillStyle = color;
        ctx.fillRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = border; ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
        ctx.restore();
      }
    };

    // 点击己方单位：立刻「同时」显示移动范围（绿格）与攻击范围（红圈）
    if (selected) {
      highlight(hints.moves[selected] || [],
        'rgba(22,101,52,.34)', 'rgba(74,222,128,.72)', 'rgba(34,197,94,.5)');

      const attacker = view.units.find((u) => u.id === selected);
      const healing = !!attacker && (hints.attacks[selected] || []).some((id) =>
        view.units.some((u) => u.id === id && u.owner === view.mySide));
      const ring = healing ? 'rgba(74,222,128,.85)' : 'rgba(239,68,68,.85)';
      for (const tid of hints.attacks[selected] || []) {
        const t = view.units.find((u) => u.id === tid) || view.devices.find((d) => d.id === tid);
        if (!t || (t.owner !== view.mySide && !enemyVisible(t.pos))) continue;
        const c = project(t.pos);
        ctx.save();
        ctx.shadowColor = ring; ctx.shadowBlur = 12;
        ctx.strokeStyle = ring; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(c.x, c.y, 34, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        if (attacker && !healing) {
          const ac = project(attacker.pos);
          ctx.strokeStyle = 'rgba(248,113,113,.4)'; ctx.lineWidth = 3.5; ctx.setLineDash([8, 6]);
          ctx.beginPath(); ctx.moveTo(ac.x, ac.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.setLineDash([]);
        }
        const pv = hints.previews[selected]?.[tid];
        if (pv?.knock) {
          const to = projectF(pv.knock.to.x, pv.knock.to.y, pv.knock.to.z);
          ctx.strokeStyle = pv.collision ? 'rgba(251,191,36,.55)' : 'rgba(253,164,175,.5)';
          ctx.lineWidth = 3.5; ctx.setLineDash([8, 6]);
          ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(to.x, to.y); ctx.stroke();
          ctx.setLineDash([]);
          const ang = Math.atan2(to.y - c.y, to.x - c.x);
          ctx.save(); ctx.translate(to.x, to.y); ctx.rotate(ang);
          ctx.fillStyle = pv.collision ? '#fbbf24' : '#fda4af';
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-12, 7); ctx.lineTo(-12, -7); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        if (pv) {
          const colDmg = pv.collision?.damage || 0;
          const label = pv.heal ? `治疗 +${pv.heal}`
            : pv.crateBreak && colDmg === 0 ? '木箱碎裂·免碰撞'
              : pv.crateBreak && colDmg > 0 ? `碎裂盖洞·碰撞 ${colDmg}`
                : pv.collision ? `碰撞 ${colDmg}`
                  : pv.knock ? '击退 1 格' : `伤害 ${pv.damage}`;
          const splash = pv.splash.length ? ` · 溅射 ${pv.splash.length}` : '';
          const text = label + splash;
          ctx.font = `bold 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const w = ctx.measureText(text).width + 10;
          const ly = Math.max(c.y - 44, 24);
          ctx.fillStyle = 'rgba(10,15,24,.92)';
          ctx.fillRect(c.x - w / 2, ly - 8, w, 16);
          ctx.fillStyle = pv.heal ? '#86efac' : (pv.crateBreak && colDmg === 0) ? '#86efac' : '#fecaca';
          ctx.fillText(text, c.x, ly);
        }
        for (const sp of pv?.splash || []) {
          const s = project(sp.pos);
          ctx.strokeStyle = 'rgba(251,191,36,.7)'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(s.x, s.y, 28, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }

    // 黄色高亮格：装置卡放置 / 致盲烟雾中心 / 召唤
    if (overlayCells.length) {
      const label = overlayKind === 'summon' ? '召唤' : '放置';
      highlight(overlayCells,
        'rgba(250,204,21,.30)', 'rgba(250,204,21,.92)', 'rgba(250,204,21,.45)');
      for (const p of overlayCells.slice(0, 9)) {
        const c = project(p);
        ctx.fillStyle = 'rgba(250,204,21,.9)';
        ctx.font = `600 9px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, c.x, c.y + 32);
      }
    }

    // 陷阱开关（无需按钮，直接点暗金高亮的中心陷阱格）
    if (hints.canToggle) {
      highlight((hints.toggleTraps || []).filter((t) => t.unitIds.length).map((t) => t.pos),
        'rgba(180,140,40,.2)', 'rgba(217,162,39,.6)', 'rgba(217,162,39,.35)');
    }

    // 选单位卡的施法目标：紫色圈
    if (cardMode && hints.cardTargets) {
      const legal = new Set(hints.cardTargets[cardMode] || []);
      for (const u of view.units) {
        if (!legal.has(u.id)) continue;
        const c = project(u.pos);
        ctx.strokeStyle = '#f0abfc'; ctx.lineWidth = 3; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(c.x, c.y, 35, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  // ---- 装置：迷雾内的敌方装置绝对不渲染 ----
  const visibleDevices = view.devices.filter((d) =>
    d.owner === view.mySide || vision.has(keyOf(d.pos)));
  for (const d of visibleDevices) {
    if (d.type === 'portal' && d.pairedId) {
      const pair = visibleDevices.find((x) => x.id === d.pairedId);
      if (pair) {
        const p1 = project(d.pos), p2 = project(pair.pos);
        ctx.strokeStyle = 'rgba(192,132,252,.4)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
  for (const d of visibleDevices) {
    if (d.type === 'grass') continue;
    const c = project(d.pos);
    const own = d.owner === view.mySide;
    ctx.save(); ctx.translate(c.x, c.y);
    if (d.type === 'crate') {
      ctx.fillStyle = '#8b5a2b'; ctx.strokeStyle = '#d9a066'; ctx.lineWidth = 2;
      ctx.fillRect(-20, -20, 40, 40); ctx.strokeRect(-20, -20, 40, 40);
      ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(20, 20); ctx.moveTo(20, -20); ctx.lineTo(-20, 20); ctx.stroke();
    } else if (d.type === 'trap') {
      ctx.fillStyle = 'rgba(239,68,68,.25)'; ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(18, 14); ctx.lineTo(-18, 14); ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else if (d.type === 'arrowTrap') {
      ctx.fillStyle = 'rgba(248,113,113,.22)'; ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(17, 0); ctx.lineTo(0, 17); ctx.lineTo(-17, 0); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#fecdd3'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(-9, 9); ctx.lineTo(9, -9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(9, -9); ctx.lineTo(2, -8); ctx.moveTo(9, -9); ctx.lineTo(8, -2); ctx.stroke();
    } else if (d.type === 'climber') {
      ctx.fillStyle = 'rgba(125,211,252,.16)'; ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#e0f2fe'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 11); ctx.lineTo(0, -11);
      ctx.moveTo(-7, -4); ctx.lineTo(0, -11); ctx.lineTo(7, -4);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
    }
    if (d.type !== 'arrowTrap') {
      ctx.fillStyle = own ? '#7dd3fc' : '#fca5a5';
      ctx.font = `bold 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(DEVICE_NAMES[d.type], 0, 30);
    }
    ctx.restore();
  }

  // ---- 悬停 ----
  if (hover) {
    const r = cellRect(hover.x, hover.y, hover.z);
    ctx.strokeStyle = vision.has(keyOf(hover)) ? 'rgba(125,211,252,.7)' : 'rgba(120,130,150,.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.fillStyle = 'rgba(10,15,24,.85)';
    ctx.fillRect(r.x + 4, r.y + r.h - 22, 62, 18);
    ctx.fillStyle = '#e2e8f0'; ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${LAYER_NAMES[hover.z]} (${hover.x},${hover.y})`, r.x + 8, r.y + r.h - 13);
  }
}

export function Board(props: Props) {
  const boardRef = useRef<HTMLCanvasElement>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const fxRef = useRef(new FxSystem());
  const feelClockRef = useRef(new FeelClock());
  const seqRef = useRef(-1);
  const hoverRef = useRef<Pos | null>(null);
  const dprRef = useRef(1);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

  // 消费服务端事件流：特效进 FxSystem，受击单位交给 DOM 棋子白闪 class
  useEffect(() => {
    const v = props.view;
    if (v.seq === seqRef.current) return;
    seqRef.current = v.seq;
    const now = feelClockRef.current.now();
    fxRef.current.addFromEvents(v.events, now);
    applyFeedback(analyzeEvents(v.events), feelClockRef.current);
    const ids = v.events
      .filter((e) => !e.hidden && e.kind === 'damage' && e.unitId)
      .map((e) => e.unitId as string);
    if (ids.length) {
      setFlashIds(new Set(ids));
      window.setTimeout(() => setFlashIds(new Set()), 220);
    }
  }, [props.view]);

  useEffect(() => {
    const board = boardRef.current;
    const fxCanvas = fxCanvasRef.current;
    if (!board || !fxCanvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      for (const c of [board, fxCanvas]) {
        c.width = Math.round(BOARD_W * dpr);
        c.height = Math.round(BOARD_H * dpr);
      }
    };
    resize();
    window.addEventListener('resize', resize);
    let raf = 0;
    const loop = (t: number) => {
      const ctx = board.getContext('2d');
      if (ctx) {
        renderBoard(ctx, {
          ...propsRef.current,
          hover: hoverRef.current,
          dpr: dprRef.current,
          time: t,
        });
      }
      const f = fxCanvas.getContext('2d');
      if (f) {
        f.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
        f.clearRect(0, 0, BOARD_W, BOARD_H);
        fxRef.current.draw(f, feelClockRef.current.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  const toLogical = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = boardRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      mx: (e.clientX - rect.left) * (BOARD_W / rect.width),
      my: (e.clientY - rect.top) * (BOARD_H / rect.height),
    };
  };

  // DOM 棋子层：服务端已按视野过滤，这里再按己方视野裁剪一次，迷雾内敌方单位绝不渲染
  const { view, selected } = props;
  const visionSet = new Set(view.visionCells.map(keyOf));
  const visibleUnits = view.units.filter((u) => u.owner === view.mySide || visionSet.has(keyOf(u.pos)));
  const hints = view.hints;
  const targetIds = new Set<string>(selected ? (hints?.attacks[selected] || []) : []);
  const selectedUnit = view.units.find((u) => u.id === selected);
  const healing = !!selectedUnit && [...targetIds].some((id) =>
    view.units.some((u) => u.id === id && u.owner === view.mySide));
  const trapKeys = new Set((view.trapCells?.length ? view.trapCells : TRAP_CELLS).map(keyOf));

  return (
    <div className="board-inner">
      <canvas
        ref={boardRef}
        className="board-canvas"
        style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}` }}
        onClick={(e) => {
          if (props.disabled) return;
          const { mx, my } = toLogical(e);
          const p = pick(mx, my);
          if (!p) return;
          // 迷雾内的格子绝对不可点击（敌方单位/装置不下发，也不响应任何操作）
          if (!visionSet.has(keyOf(p))) return;
          const unit = view.units.find((u) => samePos(u.pos, p));
          const device = view.devices.find((d) => samePos(d.pos, p));
          props.onCell(p, unit, device);
        }}
        onMouseMove={(e) => {
          const { mx, my } = toLogical(e);
          hoverRef.current = pick(mx, my);
        }}
        onMouseLeave={() => { hoverRef.current = null; }}
      />

      <div className="unit-layer" aria-hidden="true">
        {visibleUnits.map((u) => {
          const c = project(u.pos);
          const own = u.owner === view.mySide;
          const targetable = targetIds.has(u.id);
          const ratio = Math.max(0, Math.min(1, u.maxHp > 0 ? u.hp / u.maxHp : 0));
          const suspended = trapKeys.has(keyOf(u.pos)) &&
            (u.pos.z === 2 ? !!view.topTrapOpen : !!view.centerTrapOpen) &&
            !view.devices.some((d) => d.type === 'crate' && samePos(d.pos, u.pos));
          const theme = CLASS_THEME[u.class];
          const cls = [
            'piece', own ? 'own' : 'enemy',
            theme.light ? 'light-theme' : '',
            selected === u.id ? 'selected' : '',
            targetable ? (healing ? 'targetable heal' : 'targetable') : '',
            u.hasAttacked ? 'attacked' : '',
            u.inGrass ? 'in-grass' : '',
            flashIds.has(u.id) ? 'flashing' : '',
            suspended ? 'hovering' : '',
          ].filter(Boolean).join(' ');
          return (
            <div
              key={u.id}
              className={cls}
              style={{
                left: `${(c.x / BOARD_W) * 100}%`,
                top: `${(c.y / BOARD_H) * 100}%`,
                '--cls': CLASS_COLORS[u.class],
                '--cls-from': theme.from,
                '--cls-to': theme.to,
                '--ring': own ? '#38bdf8' : '#f87171',
              } as CSSProperties}
            >
              <div className="piece-disc">
                <span className="piece-emoji">{classGlyph(u.class)}</span>
              </div>
              <div className="piece-hpbar">
                <i style={{ width: `${ratio * 100}%`, '--hp': hpColor(u.hp, u.maxHp) } as CSSProperties} />
              </div>
              <div className="piece-hptext">{u.hp}/{u.maxHp}</div>
              <span className="piece-cls">{CLASS_SHORT[u.class]}</span>
              {u.inGrass && <span className="piece-badge grass">隐身</span>}
              {u.hasAttacked && <span className="piece-badge atk">已攻击</span>}
            </div>
          );
        })}
      </div>

      {/* 透明特效层置于棋子之上 */}
      <canvas
        ref={fxCanvasRef}
        className="fx-canvas"
        style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}` }}
        aria-hidden="true"
      />
    </div>
  );
}
