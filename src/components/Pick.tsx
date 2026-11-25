import { useEffect, useState, type CSSProperties } from 'react';
import type { PlayerView, UnitClass } from '../types';
import { socket } from '../net';
import { PLAYER_NAMES, classGlyph, EMOJI_OK } from '../ui';

interface Props {
  view: PlayerView;              // phase === 'picking'，view.pick 由服务端下发
  notice: string | null;
  setNotice: (s: string | null) => void;
  onLeave: () => void;
}

const fmt = (n: number) => String(n).padStart(2, '0');

/**
 * 开局盲选（BP）界面。
 * 全部渲染数据来自服务端 view.pick：只含本人已选 + 对手「是否已确认」，
 * 前端不持有职业数值，也拿不到对方阵容。
 */
export function Pick({ view, notice, setNotice, onLeave }: Props) {
  const pick = view.pick!;
  const [picks, setPicks] = useState<UnitClass[]>(pick.myPicks);
  const [left, setLeft] = useState(60);

  // 服务端每次广播（含断线重连恢复）都以权威 picks 覆盖本地乐观值
  useEffect(() => { setPicks(pick.myPicks); }, [pick.myPicks]);
  useEffect(() => {
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice, setNotice]);

  const locked = pick.myConfirmed;
  const full = picks.length === pick.size;

  const toggle = (id: UnitClass) => {
    if (locked) return setNotice('已确认阵容，请先点「重新选择」');
    let next: UnitClass[];
    if (picks.includes(id)) next = picks.filter((c) => c !== id);
    else {
      if (picks.length >= pick.size) return setNotice(`最多选择 ${pick.size} 个职业，请先取消一个`);
      next = [...picks, id];
    }
    setPicks(next);                              // 乐观更新，点击零延迟
    socket.emit('setPicks', { classes: next }); // 服务端权威保存
  };

  const confirm = () => {
    if (!full) return setNotice(`需选满 ${pick.size} 个职业才能确认`);
    socket.emit('confirmPicks', { classes: picks });
  };

  const statusText = locked
    ? (pick.opponentConfirmed ? '双方已确认，正在进入棋盘…' : '已确认 · 等待对方选择...')
    : (full ? '阵容已就绪，点击「确认阵容」锁定' : `再选 ${pick.size - picks.length} 个职业`);

  return (
    <div className="pick-screen">
      <div className="pick-bg" aria-hidden="true" />
      <div className="pick-shell">
        <header className="pick-head">
          <div className="pick-eyebrow">BAN / PICK · 开局盲选</div>
          <h1>组建你的阵容</h1>
          <p>从 6 个职业中盲选 <strong>{pick.size}</strong> 个组成出战阵容 · 双方确认后开战</p>
          <div className="pick-identity">
            <span className="room-badge">房间 {view.roomCode}</span>
            <span>你是 <strong>{PLAYER_NAMES[view.mySide]}</strong>（{view.mySide === 'A' ? '底层 · 先手' : '顶层'}）</span>
            <span className={view.opponentConnected ? 'ok' : 'bad'}>
              {view.opponentConnected ? '● 对手已连接' : '○ 对手连接中'}
            </span>
          </div>
        </header>

        <div className="pick-grid">
          {pick.pool.map((c) => {
            const on = picks.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={`class-card ${on ? 'picked' : ''} ${locked ? 'locked' : ''}`}
                style={{ '--theme': c.color } as CSSProperties}
                onClick={() => toggle(c.id)}
                aria-pressed={on}
              >
                <span className="cc-check" aria-hidden="true">✓</span>
                <div className="cc-art">
                  <span className={`cc-icon ${EMOJI_OK ? '' : 'cn'}`}>{classGlyph(c.id)}</span>
                  <span className="cc-hp">HP {c.hp}</span>
                </div>
                <div className="cc-body">
                  <div className="cc-name">{c.name}</div>
                  <div className="cc-stats"><span>生命 {c.hp}</span><span>攻击 {c.atk}</span></div>
                  <div className="cc-trait">{c.desc}</div>
                </div>
              </button>
            );
          })}
        </div>

        <footer className="pick-footer">
          <div className="pf-left">
            <div className="pf-count"><strong>{picks.length}</strong> / {pick.size} 已选</div>
            <div className="pf-slots">
              {Array.from({ length: pick.size }, (_, i) => {
                const c = pick.pool.find((x) => x.id === picks[i]);
                return (
                  <span key={i} className={`pf-slot ${c ? 'on' : ''}`} title={c?.name || '空位'}>
                    {c ? classGlyph(c.id) : '＋'}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="pf-mid">
            <div className={`pf-status ${locked ? 'confirmed' : ''} ${pick.opponentConfirmed ? 'opp-ok' : ''}`}>
              <span className="pf-pulse" />
              {statusText}
            </div>
            <div className="pf-timer">
              {left > 0 ? `选人倒计时 ${fmt(Math.floor(left / 60))}:${fmt(left % 60)}` : '∞ 自由选人（倒计时仅作氛围提示）'}
            </div>
          </div>

          <div className="pf-right">
            {locked ? (
              <button className="pick-btn secondary" onClick={() => socket.emit('unconfirmPicks', {})}>
                重新选择
              </button>
            ) : (
              <button className="pick-btn" disabled={!full} onClick={confirm}>
                确认阵容
              </button>
            )}
            <button className="ghost small" onClick={onLeave}>退出房间</button>
          </div>
        </footer>

        {notice && <div className="pick-toast" onClick={() => setNotice(null)}>{notice}</div>}
      </div>
    </div>
  );
}
