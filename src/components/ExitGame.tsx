// ============================================================================
// v5：PC 端大厅【退出游戏】
//   * 仅由 App 在「大厅分支」渲染 -> 对局 / 选人 / 等待 / 观战界面天然不出现。
//   * isDesktopClient() 判定 -> 手机、平板等移动端大厅不渲染按钮。
//   * 按钮与确认弹窗用 Portal 挂到 body，避免被大厅卡片的层叠上下文挡住。
//   * 确认后交给 App 统一处理：切退出页 + 请求服务端关闭游戏进程 + 尝试关窗。
//
// 注意：本组件不改动 Lobby.tsx 内任何匹配 / 建房 / 观战 / 扫码逻辑。
// ============================================================================
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { audio } from '../audio';
import { EMOJI_OK } from '../ui';
import type { ShutdownResult } from '../net';

/**
 * 是否为「电脑端」客户端。移动端通过扫码用手机浏览器打开同一大厅，
 * 因此以 UA + iPadOS 伪装识别 + 纯触屏三重判断，避免按钮出现在手机上。
 */
export function isDesktopClient(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // 1) 明确的手机 / 平板 / 移动浏览器 UA
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Windows Phone|HarmonyOS|MiuiBrowser|Silk/i.test(ua)) {
    return false;
  }
  // 2) iPadOS 13+ 默认伪装成 Macintosh，用多点触控兜底识别
  const maxTouch = (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0;
  if (/Macintosh|Mac OS X/i.test(ua) && maxTouch > 1) return false;
  // 3) 无 hover 的纯触屏设备也视为移动端（兼容定制浏览器）
  try {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const hover = window.matchMedia?.('(hover: hover)').matches ?? true;
    if (coarse && !hover) return false;
  } catch { /* matchMedia 不可用时跳过这一层判断 */ }
  return true;
}

/**
 * 尝试关闭游戏窗口，回到桌面。
 * 浏览器安全策略只允许关闭「由脚本打开的窗口」，一键启动脚本打开的
 * 标签页可能被拦截；此时页面保留 GameExitedScreen 作为兜底，可手动关闭。
 */
export function tryCloseGameWindow(): void {
  try { window.close(); } catch { /* 浏览器拦截，保留退出页 */ }
}

interface ExitGameButtonProps {
  /** 点击弹窗【确认】后由 App 执行真正的退出流程 */
  onExited: () => void;
}

export function ExitGameButton({ onExited }: ExitGameButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const desktop = isDesktopClient();

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfirmOpen(false); setBusy(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmOpen]);

  if (!desktop) return null;

  const openConfirm = () => {
    try { audio.unlock(); audio.play('ui'); } catch { /* 音效非关键 */ }
    setConfirmOpen(true);
  };
  const cancel = () => { setConfirmOpen(false); setBusy(false); };
  const confirm = () => {
    setBusy(true);
    setConfirmOpen(false);
    onExited();
  };

  return createPortal(
    <>
      <button
        type="button"
        className="exit-game-fixed"
        title="退出游戏，返回桌面"
        aria-label="退出游戏"
        data-testid="exit-game-button"
        onClick={openConfirm}
      >
        <span className="eg-icon" aria-hidden="true">{EMOJI_OK ? '⏻' : '×'}</span>
        <span>退出游戏</span>
      </button>

      {confirmOpen && (
        <div className="exit-confirm-overlay" onClick={cancel}>
          <div
            className="exit-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="exit-confirm-icon" aria-hidden="true">{EMOJI_OK ? '⏻' : '!'}</div>
            <h2 id="exit-confirm-title">退出游戏</h2>
            <p className="exit-confirm-text">确定退出，返回桌面吗？</p>
            <p className="exit-confirm-note">确认后将关闭游戏进程，其他正在联机的玩家也会断开。</p>
            <div className="exit-confirm-actions">
              <button type="button" className="ghost" data-testid="exit-cancel" onClick={cancel}>取消</button>
              <button
                type="button"
                className="danger-ghost"
                data-testid="exit-confirm"
                disabled={busy}
                onClick={confirm}
              >确认</button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}

export type ExitReason = 'self' | 'remote';

/** 退出后的全屏兜底页：进程已关 / 云端仅退出页面 / 房主已关，都不再显示断线重连横幅。 */
export function GameExitedScreen({ reason, ack }: { reason: ExitReason; ack: ShutdownResult | null }) {
  const self = reason === 'self';
  const main = !self
    ? '房主已关闭游戏，本局已结束。'
    : ack === 'closed' ? '游戏进程已关闭，可以关闭此窗口返回桌面。'
      : ack === 'cloud' ? '云端游戏不会关闭服务器，关闭本标签页即可离开。'
        : ack === 'failed' ? '已退出大厅。若服务端窗口仍在运行，请手动关闭它。'
          : '正在处理退出…';

  return createPortal(
    <div className="game-exited-screen" role="status" data-testid="game-exited">
      <div className="game-exited-card">
        <div className="ge-icon" aria-hidden="true">{EMOJI_OK ? '⏻' : '×'}</div>
        <h1>游戏已退出</h1>
        <p className="ge-main">{main}</p>
        <p className="ge-sub">
          浏览器若阻止自动关闭窗口，请点下面的按钮或直接关闭当前标签页；
          想再玩一次，重新打开游戏网址（本机则双击「一键启动」）即可。
        </p>
        <button type="button" className="ghost small" onClick={tryCloseGameWindow}>关闭此窗口</button>
      </div>
    </div>,
    document.body
  );
}
