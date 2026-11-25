// ============================================================================
// 最终版：横竖屏自由切换
//   * FullscreenButton：只进入/退出全屏，绝不锁定屏幕方向；
//     保留旧导出名 FullscreenLandscapeButton 以兼容大厅引用。
//   * PortraitGate：已废弃 —— 不再渲染任何竖屏遮罩，也不再往 body 加
//     portrait-blocked 类。竖屏与横屏由同一套响应式布局自动重排。
// ============================================================================
import { useState } from 'react';
import { enterFullscreen } from '../orientation';
import { audio } from '../audio';
import { EMOJI_OK } from '../ui';

/** 点击：先解锁 AudioContext，再切换全屏；方向完全交给用户自由旋转。 */
export function FullscreenButton({ block = false }: { block?: boolean }) {
  const [hint, setHint] = useState<string | null>(null);

  const go = async () => {
    audio.unlock();
    audio.play('ui');
    const r = await enterFullscreen();
    setHint(r.fullscreen
      ? '已进入全屏 · 横屏 / 竖屏可自由旋转'
      : '浏览器未允许全屏，横竖屏切换仍可正常使用');
    window.setTimeout(() => setHint(null), 2800);
  };

  return (
    <div className={`landscape-cta-wrap ${block ? 'block' : ''}`}>
      <button className="landscape-cta" onClick={go} type="button">
        <span className="lc-glyph">{EMOJI_OK ? '⛶' : '全'}</span>
        <span className="lc-text">全屏游玩</span>
        <span className="lc-arrow">{EMOJI_OK ? '↗' : '→'}</span>
      </button>
      {hint && <p className="lc-hint">{hint}</p>}
    </div>
  );
}

/** 兼容旧引用名（行为已改为纯全屏，不含任何方向锁定）。 */
export const FullscreenLandscapeButton = FullscreenButton;

/** 已废弃：不再遮挡竖屏，保留空实现避免历史引用报错。 */
export function PortraitGate() {
  return null;
}
