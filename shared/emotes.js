// ============================================================================
// 局内表情：纯「旁路互动」数据，服务端与验收脚本共用的唯一真源。
//
// 设计约束（严格遵守「不改核心数值和联机架构」）：
//   * 表情不进入 GameState，不写入 shared/rules.js，不消耗 AP，不影响胜负；
//   * 服务端只认 id 白名单，emoji / label 由服务端下发，客户端无法伪造内容；
//   * 广播走独立 socket 事件 emote，不复用 broadcast()/state 通道。
// ============================================================================

export const EMOTES = [
  { id: 'cool',  emoji: '😎', label: '摸头', color: '#38bdf8' },
  { id: 'laugh', emoji: '😂', label: '大笑', color: '#fbbf24' },
  { id: 'cry',   emoji: '😭', label: '大哭', color: '#60a5fa' },
  { id: 'angry', emoji: '🤬', label: '生气', color: '#f87171' },
  { id: 'like',  emoji: '👍', label: '点赞', color: '#4ade80' },
  { id: 'think', emoji: '🤔', label: '思考', color: '#a78bfa' },
];

export const EMOTE_IDS = EMOTES.map((e) => e.id);

/** 服务端权威冷却：同一阵营 3 秒内重复发送无效（不消耗 AP） */
export const EMOTE_CD_MS = 3000;
/** 气泡停留时长（弹入动画结束后停留，再淡出） */
export const EMOTE_HOLD_MS = 2000;

export function findEmote(id) {
  return EMOTES.find((e) => e.id === id) || null;
}
