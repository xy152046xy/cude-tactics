// ============================================================================
// 迭代 9：局内表情互动 + 右上角静音开关（纯 UI 表现层）
//   * EmoteControl : 表情按钮 + 6 宫格面板，服务端权威 3 秒 CD（本地乐观置灰）
//   * SoundToggle  : 🔊 / 🔇 一键静音
//   * EmoteBubbles : 接收服务端 emote 广播，按发送方阵营在屏幕左/右侧弹气泡
// ============================================================================
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { socket } from '../net';
import { audio } from '../audio';
import { EMOTES, EMOTE_CD_S, EMOJI_OK } from '../ui';
import type { EmotePayload, EmoteCooldown } from '../types';

/** 最终版：弹性缩放弹入 ~0.45s + 停留 ~2s + 向上淡出 ~0.45s，到点从 DOM 移除 */
const HOLD_MS = 2500;

/** 右上角：表情按钮 + 弹出面板 */
export function EmoteControl() {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(0);        // 剩余 CD（ms）
  const cdUntil = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onCooldown = (p: EmoteCooldown) => {
      const ms = Math.max(0, Number(p?.remainingMs) || 0);
      cdUntil.current = Date.now() + ms;
      setLeft(ms);
    };
    // 点击面板外收起
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    socket.on('emoteCooldown', onCooldown);
    document.addEventListener('pointerdown', onDocDown);
    return () => {
      socket.off('emoteCooldown', onCooldown);
      document.removeEventListener('pointerdown', onDocDown);
    };
  }, []);

  // CD 倒计时刷新
  useEffect(() => {
    const t = window.setInterval(() => {
      setLeft(Math.max(0, cdUntil.current - Date.now()));
    }, 100);
    return () => window.clearInterval(t);
  }, []);

  const cooling = left > 0;

  const send = (id: string) => {
    if (cooling) return;
    audio.unlock();
    audio.play('ui');
    socket.emit('emote', { id });
    cdUntil.current = Date.now() + EMOTE_CD_S * 1000;
    setLeft(EMOTE_CD_S * 1000);
    setOpen(false);
  };

  return (
    <div className="emote-control" ref={wrapRef}>
      <button
        className={`icon-btn emote-btn ${open ? 'on' : ''}`}
        title="局内表情（不消耗 AP，3 秒 CD）"
        onClick={() => { audio.unlock(); audio.play('ui'); setOpen((v) => !v); }}
      >
        <span className="ib-glyph">{EMOJI_OK ? '😀' : '表'}</span>
        <span className="ib-text">表情</span>
        {cooling && <span className="ib-cd">{(left / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="emote-panel" role="menu">
          <div className="ep-title">
            {cooling ? `冷却中 ${(left / 1000).toFixed(1)}s` : '选择一个表情 · 3 秒 CD'}
          </div>
          <div className="ep-grid">
            {EMOTES.map((e) => (
              <button
                key={e.id}
                className={`ep-item ${cooling ? 'disabled' : ''}`}
                style={{ '--ep-color': e.color } as CSSProperties}
                disabled={cooling}
                onClick={() => send(e.id)}
                title={e.label}
              >
                <span className="ep-emoji">{EMOJI_OK ? e.emoji : e.label.slice(0, 1)}</span>
                <span className="ep-label">{e.label}</span>
              </button>
            ))}
          </div>
          <div className="ep-foot">不消耗 AP · 对手与观战者可见</div>
        </div>
      )}
    </div>
  );
}

/** 右上角：一键静音 */
export function SoundToggle() {
  const [muted, setMuted] = useState(audio.muted);
  const toggle = () => {
    audio.unlock();
    const m = audio.toggleMute();
    setMuted(m);
    if (!m) audio.play('ui');   // 取消静音时给一声反馈
  };
  return (
    <button
      className={`icon-btn sound-btn ${muted ? 'muted' : ''}`}
      title={muted ? '音效已关闭，点击开启' : '音效开启，点击静音'}
      aria-pressed={muted}
      onClick={toggle}
    >
      <span className="ib-glyph">{muted ? (EMOJI_OK ? '🔇' : '静') : (EMOJI_OK ? '🔊' : '音')}</span>
      <span className="ib-text">{muted ? '已静音' : '音效'}</span>
    </button>
  );
}

interface Bubble extends EmotePayload { key: number }

/** 全屏气泡层：A 在左、B 在右（按发送方阵营，双方看到一致的位置） */
export function EmoteBubbles() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const onEmote = (p: EmotePayload) => {
      if (!p || (p.side !== 'A' && p.side !== 'B')) return;
      const key = ++seq.current;
      setBubbles((prev) => [...prev.slice(-3), { ...p, key }]);
      window.setTimeout(() => {
        setBubbles((prev) => prev.filter((b) => b.key !== key));
      }, HOLD_MS);
    };
    socket.on('emote', onEmote);
    return () => { socket.off('emote', onEmote); };
  }, []);

  return (
    <div className="emote-bubbles" aria-hidden="true">
      {bubbles.map((b) => (
        <div
          key={b.key}
          className={`emote-bubble side-${b.side.toLowerCase()}`}
          style={{ '--eb-color': b.color } as CSSProperties}
        >
          <div className="eb-emoji">{EMOJI_OK ? b.emoji : b.label}</div>
          <div className="eb-label">{b.label}</div>
          <div className="eb-who">{b.side === 'A' ? '玩家 A' : '玩家 B'}</div>
        </div>
      ))}
    </div>
  );
}
