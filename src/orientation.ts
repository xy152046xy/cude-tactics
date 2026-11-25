// ============================================================================
// 全屏能力层（纯前端，不触碰联机 / 规则 / 数值）
//
// 最终版：移除所有方向锁定与竖屏遮罩，支持竖屏 / 横屏自由双向切换。
//   * 只提供「进入全屏」能力，绝不调用 screen.orientation.lock()；
//   * Fullscreen API 必须由用户手势触发，因此只在按钮 onClick 里调用；
//   * 浏览器不支持 / 用户拒绝时静默降级，绝不抛错打断游戏。
// ============================================================================

type WebkitFullscreenEl = HTMLElement & {
  webkitRequestFullscreen?: (options?: unknown) => Promise<void> | void;
};
type WebkitFullscreenDoc = Document & { webkitFullscreenElement?: Element | null };

export interface FullscreenResult {
  fullscreen: boolean;
  /** 兼容旧调用：恒为 false —— 本版不再锁定任何方向 */
  locked: boolean;
}

/** 进入全屏；不锁定方向，横竖屏切换完全交给用户与系统旋转。 */
export async function enterFullscreen(): Promise<FullscreenResult> {
  const result: FullscreenResult = { fullscreen: false, locked: false };
  try {
    const el = document.documentElement as WebkitFullscreenEl;
    const doc = document as WebkitFullscreenDoc;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      result.fullscreen = true;
    } else if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen.call(el, { navigationUI: 'hide' });
      result.fullscreen = true;
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      await el.webkitRequestFullscreen({ navigationUI: 'hide' });
      result.fullscreen = true;
    }
  } catch {
    // 用户拒绝 / 浏览器不支持 / 非手势触发：静默降级
  }
  return result;
}

/** 兼容旧组件名：行为已改为纯全屏（不再锁横屏）。 */
export const enterLandscapeFullscreen = enterFullscreen;

/** 供真机验收脚本读取的能力快照（只读，不改变任何状态）。 */
export function fullscreenCapability() {
  return {
    requestFullscreen: typeof document.documentElement.requestFullscreen === 'function',
    orientationLock: false,
    fullscreenElement: !!document.fullscreenElement,
    orientation: screen?.orientation?.type ?? 'unknown',
    portrait: window.innerHeight > window.innerWidth,
  };
}
