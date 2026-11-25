import { createRoot } from 'react-dom/client';
import App from './App';
import { installAudioUnlock } from './audio';
import { installFeelDebug } from './gamefeel';
import { fullscreenCapability } from './orientation';
import './styles.css';

// 迭代 9：浏览器自动播放限制 —— 首次点击/按键即解锁 AudioContext，
// 并且把音频句柄暴露给真机验收脚本读取（unlocked / muted / playCount）。
installAudioUnlock();
installFeelDebug();

// 迭代 10：真机横竖屏验收用只读句柄（函数调用时实时读取，不触发全屏 / 锁定动作）
try {
  (window as unknown as { __cubeOrientation?: unknown }).__cubeOrientation = fullscreenCapability;
} catch { /* ignore */ }

// 不启用 StrictMode：避免开发期 effect 双调用导致 Socket.io 监听重复注册
createRoot(document.getElementById('root')!).render(<App />);
