// ============================================================================
// 轻量音效管理器：Web Audio API 实时合成，零外部音频文件。
//
// 浏览器自动播放限制：AudioContext 只能在用户手势中创建 / resume。
// main.tsx 会在首次 pointerdown / keydown 时调用 unlock()，App 中创建房间 /
// 加入房间 / 确认阵容等按钮也会兜底调用一次，确保进对局前音频已解锁。
//
// 全部 API 都有 try/catch：任何环境（无 Web Audio / 被策略拦截）都静默降级，
// 绝不影响游戏逻辑。playCount / unlocked / muted 可观测，供真机验收断言。
// ============================================================================

export type SfxName = 'ui' | 'slash' | 'arrow' | 'explosion' | 'impact';

const MUTE_KEY = 'cube-tactics-muted';

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private _muted = false;
  private _playCount = 0;

  constructor() {
    try { this._muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* 隐私模式 */ }
  }

  get muted() { return this._muted; }
  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }
  get playCount() { return this._playCount; }
  get state() { return this.ctx?.state ?? 'none'; }

  /** 必须在用户手势里调用；幂等，可重复调用 */
  unlock() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this._muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch { /* 无音频能力：静默降级 */ }
  }

  setMuted(v: boolean) {
    this._muted = !!v;
    try { localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0'); } catch { /* ignore */ }
    try {
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this._muted ? 0 : 0.5, this.ctx.currentTime, 0.01);
      }
    } catch { /* ignore */ }
  }

  toggleMute() { this.setMuted(!this._muted); return this._muted; }

  /** 复用一段 1 秒白噪声，供破空 / 爆炸 / 撞击类音色取用 */
  private noise(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.noiseBuffer) return this.noiseBuffer;
    const len = Math.floor(this.ctx.sampleRate * 1);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  /** 一个带 ADSR 包络的振荡器音 */
  private tone(
    type: OscillatorType, f0: number, f1: number, t0: number, dur: number,
    peak: number, dest: AudioNode,
  ) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  /** 一段经滤波的噪声（bandpass / lowpass） */
  private noiseBurst(
    filterType: BiquadFilterType, f0: number, f1: number, q: number,
    t0: number, dur: number, peak: number, dest: AudioNode,
  ) {
    const ctx = this.ctx!;
    const buf = this.noise();
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t0);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.015, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  play(name: SfxName) {
    if (this._muted) return;
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime + 0.001;
      const out = this.master;
      switch (name) {
        case 'ui':
          // 清脆的「滴」：短促上滑正弦 + 一点高频泛音
          this.tone('sine', 760, 1180, t, 0.09, 0.34, out);
          this.tone('sine', 1520, 1760, t + 0.005, 0.06, 0.10, out);
          break;
        case 'slash':
          // 战士挥刀破空：带通白噪声快速下扫 + 一记短促气声
          this.noiseBurst('bandpass', 3600, 700, 0.8, t, 0.16, 0.55, out);
          this.tone('triangle', 260, 120, t, 0.1, 0.12, out);
          break;
        case 'arrow':
          // 弓手箭矢「嗖」：高频下滑正弦 + 细噪声
          this.tone('sine', 2100, 620, t, 0.2, 0.22, out);
          this.noiseBurst('bandpass', 4800, 1600, 2.2, t, 0.17, 0.28, out);
          break;
        case 'explosion':
          // 法师爆炸：低频轰鸣 + 低通噪声 + 一点下滑方波
          this.tone('sine', 150, 42, t, 0.34, 0.5, out);
          this.tone('square', 220, 60, t, 0.2, 0.12, out);
          this.noiseBurst('lowpass', 1600, 180, 0.7, t, 0.3, 0.42, out);
          break;
        case 'impact':
          // 撞墙 / 木箱碎裂：沉闷低频撞击 + 短噪声
          this.tone('sine', 190, 55, t, 0.18, 0.55, out);
          this.noiseBurst('lowpass', 900, 200, 0.7, t, 0.13, 0.4, out);
          break;
      }
      this._playCount += 1;
    } catch { /* 单次音效失败不影响游戏 */ }
  }
}

export const audio = new AudioManager();

/** 全局首次用户手势解锁（main.tsx 调用）；同时暴露可观测句柄供验收脚本读取 */
export function installAudioUnlock() {
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  try {
    (window as unknown as { __cubeAudio?: AudioManager }).__cubeAudio = audio;
  } catch { /* ignore */ }
}
