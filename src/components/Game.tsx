import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  PlayerView, Pos, Unit, Device, CardView, ReserveEntry,
} from '../types';
import { socket } from '../net';
import { audio } from '../audio';
import { Board } from './Board';
import { EmoteControl, SoundToggle, EmoteBubbles } from './Emote';
import {
  PLAYER_NAMES, CARD_INFO, isDeviceCard, classGlyph, samePos, keyOf, EMOJI_OK,
} from '../ui';

interface Props {
  view: PlayerView;
  notice: string | null;
  setNotice: (s: string | null) => void;
  onLeave: () => void;
}

const HAND_LIMIT = 5;

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export function Game({ view, notice, setNotice, onLeave }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [cardMode, setCardMode] = useState<string | null>(null);
  const [summonMode, setSummonMode] = useState(false);
  /** 当前选中的预备池名额 key：召唤入口只来自预备池条目点击 */
  const [summonKey, setSummonKey] = useState<string | null>(null);
  const [flyCard, setFlyCard] = useState<{ card: CardView; to: 'center' | 'discard' } | null>(null);
  const [drawnIds, setDrawnIds] = useState<Set<string>>(new Set());
  const lastPlayer = useRef(view.currentPlayer);
  const flyTimer = useRef<number | null>(null);
  const prevHandRef = useRef<Set<string>>(new Set(view.hand.map((c) => c.id)));

  // 观战者：只读，继承被观战玩家的迷雾视野
  const spectating = !!view.spectating;
  const myTurn = view.currentPlayer === view.mySide && view.phase === 'playing' && !spectating;
  const waiting = !myTurn && view.phase === 'playing' && !spectating;
  const h = view.hints;
  const selUnit = view.units.find((u) => u.id === selected);
  const isPriest = selUnit?.class === 'priest';
  const visionSet = new Set(view.visionCells.map(keyOf));

  useEffect(() => {
    if (lastPlayer.current !== view.currentPlayer) {
      lastPlayer.current = view.currentPlayer;
      setSelected(null);
      setCardMode(null);
      setSummonMode(false);
      setSummonKey(null);
    }
  }, [view.currentPlayer]);

  useEffect(() => {
    if (cardMode && !view.hand.some((c) => c.id === cardMode)) setCardMode(null);
  }, [view.hand, cardMode]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3400);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  // 手牌 diff：新出现的卡播放「从牌库飞入」动画
  useEffect(() => {
    const now = new Set(view.hand.map((c) => c.id));
    const added = [...now].filter((id) => !prevHandRef.current.has(id));
    prevHandRef.current = now;
    if (!added.length) return;
    setDrawnIds(new Set(added));
    const t = window.setTimeout(() => setDrawnIds(new Set()), 760);
    return () => window.clearTimeout(t);
  }, [view.hand]);

  /** 卡牌飞行动画：打牌飞向中央淡出；装置 / 烟雾卡飞入弃牌堆 */
  const launchFly = (card: CardView, to: 'center' | 'discard') => {
    setFlyCard({ card, to });
    if (flyTimer.current) window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => setFlyCard(null), 760);
  };

  const cancelModes = () => {
    setCardMode(null); setSummonMode(false); setSelected(null); setSummonKey(null);
  };

  // 黄色高亮格：卡牌选格 / 召唤，统一过滤为「可见格」（迷雾格绝不亮起、绝不响应点击）
  const rawOverlay = cardMode ? (h?.cardCells?.[cardMode] || [])
    : summonMode ? (h?.summonPoints || []) : [];
  const overlayCells = rawOverlay.filter((p) => visionSet.has(keyOf(p)));
  const overlayKind: 'card' | 'summon' | null = cardMode ? 'card' : summonMode ? 'summon' : null;

  // ---- 卡牌 ----
  const cardReason = (card: CardView): string | null => {
    if (spectating) return '观战模式为只读';
    if (!myTurn) return '等待对方行动中，操作已锁定';
    if (!h) return '暂无可用操作';
    if (h.ap < card.cost) return `AP 不足（打出需 ${card.cost} AP）`;
    // 出牌限额按类型区分：装置牌无单回合数量上限（只看 AP）；技能牌每回合最多 1 张。
    // 服务端 canPlayCard 会以同一分类再次权威校验，这里仅做即时提示。
    if (!isDeviceCard(card.type) && view.perTurnFlags.skillCardUsed) {
      return '本回合已打出过技能牌（技能牌每回合限 1 张，装置牌仍可继续打出）';
    }
    if (!h.canPlay) return '本回合暂不可打出卡牌';
    if (card.target === 'cell' &&
        !(h.cardCells?.[card.id] || []).some((p) => visionSet.has(keyOf(p)))) {
      return '当前没有可见的合法格';
    }
    if (card.target !== 'none' && card.target !== 'cell' &&
        !(h.cardTargets?.[card.id] || []).length) return '当前没有合法目标';
    return null;
  };

  const chooseCard = (card: CardView) => {
    if (cardMode === card.id) { setCardMode(null); return; }
    const r = cardReason(card);
    if (r) { setNotice(r); return; }
    if (card.target === 'none') {
      launchFly(card, 'center');
      socket.emit('playCard', { cardId: card.id });
      setCardMode(null);
      setSummonMode(false);
      setNotice(`已打出【${card.name}】`);
      return;
    }
    setSummonMode(false);
    setSelected(null);
    setCardMode(card.id);
    setNotice(card.target === 'cell'
      ? `已选择【${card.name}】：点击棋盘上黄色高亮格完成放置（消耗 1 AP）；再次点卡牌或「取消」退出`
      : `已选择【${card.name}】：点击紫色高亮的目标单位施放；再次点卡牌或「取消」退出`);
  };

  // ---- 主动抽牌（点击牌库，1 AP） ----
  const drawFromDeck = () => {
    if (spectating) return setNotice('观战模式为只读');
    if (!myTurn) return setNotice('等待对方行动中，操作已锁定');
    if (view.hand.length >= HAND_LIMIT) return setNotice('手牌已达上限 5 张');
    if (!h?.canDraw) return setNotice('AP 不足，无法主动抽牌');
    audio.play('ui');
    socket.emit('drawCard', {});
    setNotice('花 1 AP 主动抽 1 张');
  };

  // ---- 召唤队友（2 AP）：入口【仅限预备池条目点击】，本局预选单位各一次 ----
  const summonReason = (): string | null => {
    if (spectating) return '观战模式为只读';
    if (!myTurn) return '等待对方行动中，操作已锁定';
    if (!h) return '暂无可用操作';
    if (h.ap < 2) return 'AP 不足（召唤需 2 AP）';
    if (view.reserve <= 0 || !(view.reservePool || []).some((e) => !e.used)) {
      return '预备池已空（本局预选单位已全部出场）';
    }
    if (view.perTurnFlags.summoned) return '每回合最多召唤 1 次';
    if (!(h.summonPoints || []).some((p) => visionSet.has(keyOf(p)))) {
      return '己方初始层没有可见的合法空格';
    }
    return null;
  };
  /** 点击预备池里某个【未召唤】名额 -> 进入选格模式；再点一次取消 */
  const chooseReserve = (entry: ReserveEntry) => {
    if (entry.used) return;                 // 已召唤：整局锁死，点击无效
    if (summonMode && summonKey === entry.key) { cancelModes(); return; }
    const r = summonReason();
    if (r) { setNotice(r); return; }
    setCardMode(null);
    setSelected(null);
    setSummonKey(entry.key);
    setSummonMode(true);
    setNotice(`已选择【${entry.name}】：点击黄色高亮的己方初始层空格完成召唤（消耗 2 AP），新队友本回合可直接行动`);
  };

  const handleCell = (pos: Pos, unit?: Unit, device?: Device) => {
    if (!myTurn) return;
    // 迷雾格一律不可点击（Board 已拦截，此处再兜底）
    if (!visionSet.has(keyOf(pos))) return;

    // 1) 召唤模式：只提交「预备池里选中的名额 key」，服务端再校验一次
    if (summonMode) {
      if (overlayCells.some((c) => samePos(c, pos))) {
        if (!summonKey) { cancelModes(); return; }
        socket.emit('summon', { reserveKey: summonKey, pos });
        setSummonMode(false);
        setSummonKey(null);
        setNotice('召唤成功：新队友本回合可直接行动');
      } else {
        setNotice('请点击黄色高亮的己方初始层空格召唤');
      }
      return;
    }

    // 2) 卡牌模式
    if (cardMode) {
      const card = view.hand.find((c) => c.id === cardMode);
      if (!card) { setCardMode(null); return; }
      if (card.target === 'cell') {
        if (overlayCells.some((c) => samePos(c, pos))) {
          launchFly(card, 'discard');
          socket.emit('playCard', { cardId: cardMode, pos });
          setCardMode(null);
          setSelected(null);
          setNotice(`已打出【${card.name}】`);
        } else {
          setNotice('请点击黄色高亮的合法格；再次点手牌可取消');
        }
      } else {
        const legal = new Set(h?.cardTargets?.[cardMode] || []);
        if (unit?.id && legal.has(unit.id)) {
          launchFly(card, 'center');
          socket.emit('playCard', { cardId: cardMode, targetId: unit.id });
          setCardMode(null);
          setNotice(`已打出【${card.name}】`);
        } else {
          setNotice('请点击紫色高亮的合法目标单位；再次点手牌可取消');
        }
      }
      return;
    }

    // 3) 点击己方单位：立刻同时显示移动范围（绿格）与攻击范围（红圈），无悬浮菜单
    if (unit && unit.owner === view.mySide) {
      setSelected(unit.id);
      return;
    }

    // 4) 点击中心陷阱格切换开关（无需按钮，1 AP，中/顶层共用每回合 1 次）
    const trap = (h?.toggleTraps || []).find((t) => samePos(t.pos, pos) && t.unitIds.length);
    if (trap && h?.canToggle) {
      socket.emit('toggleTrap', { unitId: trap.unitIds[0], z: trap.z });
      setNotice(`已切换${trap.z === 2 ? '顶层' : '中层'}中心陷阱（1 AP）`);
      return;
    }

    // 5) 点击敌方单位 / 装置：直接攻击
    const enemy = (unit && unit.owner !== view.mySide) ? unit
      : (device && device.owner !== view.mySide && device.type !== 'grass') ? device : null;
    if (enemy) {
      if (selected && h?.attacks[selected]?.includes(enemy.id)) {
        socket.emit('attack', { attackerId: selected, targetId: enemy.id });
      } else {
        setNotice(isPriest
          ? '牧师只能治疗己方受伤单位，不能攻击敌方'
          : '目标不在射程内、不可见，或该单位本回合已攻击 / AP 不足');
      }
      return;
    }

    // 6) 点击绿色可达格：直接移动
    if (selected && (h?.moves[selected] || []).some((c) => samePos(c, pos))) {
      socket.emit('move', { unitId: selected, targetPos: pos });
      return;
    }

    // 7) 空白 / 非法格：取消选中
    setSelected(null);
  };

  const overlayText = !view.opponentConnected
    ? '对方已断开连接，等待重新加入…'
    : `等待 ${PLAYER_NAMES[view.currentPlayer]} 行动中...`;

  const smokeMin = view.smokes.length
    ? Math.min(...view.smokes.map((s) => s.turnsLeft)) : 0;

  return (
    <div className={`game side-${view.mySide.toLowerCase()} ${spectating ? 'spectating' : ''}`}>
      {/* 结束回合：Portal 到 body，fixed 右上角 + 最高层级。
          横屏/竖屏/弹窗/展开卡牌/滚动日志时都脱离文档流，永远可见可点击。 */}
      {createPortal(
        <button
          className="primary endturn-fixed"
          disabled={!myTurn}
          onClick={() => { audio.play('ui'); socket.emit('endTurn', {}); }}
        >
          结束回合
        </button>,
        document.body,
      )}
      <div className="fx-flash-overlay" aria-hidden="true" />
      <EmoteBubbles />
      <header className="hud">
        <div className="hud-left">
          <div className="hud-title">立方战术 <span className="room-badge">房间 {view.roomCode}</span></div>
          <div className="hud-sub">
            {spectating
              ? `观战模式 · 正在观看 ${PLAYER_NAMES[view.mySide]} 的迷雾视野（只读）`
              : `你是 ${PLAYER_NAMES[view.mySide]}（${view.mySide === 'A' ? '底层 · 先手' : '顶层'}）`}
          </div>
        </div>
        <div className="hud-stats">
          <Stat label="当前行动" value={PLAYER_NAMES[view.currentPlayer]} accent={myTurn} />
          <Stat label="回合" value={`${view.round} / ${view.maxRounds}`} />
          <div className={`stat ap ${myTurn ? 'accent' : ''}`}>
            <div className="stat-label">行动点 AP</div>
            <div className="ap-value">{view.ap}<span>/{view.apMax}</span></div>
            <div className="ap-pips">
              {Array.from({ length: Math.max(view.apMax, view.ap) }, (_, i) => (
                <i key={i} className={i < view.ap ? 'on' : ''} />
              ))}
            </div>
          </div>
        </div>
        <div className="hud-actions">
          <EmoteControl />
          <SoundToggle />
          <button className="ghost hud-mini" disabled={!myTurn}
            onClick={() => socket.emit('surrender', {})}>投降</button>
          <button className="ghost hud-mini" onClick={onLeave}>退出</button>
        </div>
      </header>

      <div className="strip">
        <div className="inventory">
          <span className="inv-item">预备池 <b>{view.reserve}</b> / 2</span>
          <span className="inv-item">牌库 <b>{view.deckCount}</b></span>
          <span className="inv-item">弃牌堆 <b>{view.discardCount}</b></span>
          <span className="inv-item">手牌 <b>{view.hand.length}/5</b></span>
          {view.smokes.length > 0 && (
            <span className="inv-item smoke">🌫️ 黑雾 ×{view.smokes.length} · 剩 {smokeMin} 回合</span>
          )}
        </div>
        {spectating && <span className="spectate-badge">👁 观战 · 只读</span>}
      </div>

      <div className="stage">
        <div className="left-col">
          <div className="board-wrap">
            <Board
              view={view}
              selected={selected}
              cardMode={cardMode}
              overlayCells={overlayCells}
              overlayKind={overlayKind}
              disabled={!myTurn || !view.opponentConnected || spectating}
              onCell={handleCell}
            />
            {(waiting || (!view.opponentConnected && !spectating)) && view.phase === 'playing' && (
              <div className="wait-overlay">
                <div className="wait-card">
                  <div className="spinner" />
                  <h2>{overlayText}</h2>
                  <p>当前回合所有操作已锁定，棋盘按你自己的视野渲染</p>
                </div>
              </div>
            )}
            {view.phase === 'gameover' && (
              <div className="over-overlay">
                <div className="over-card">
                  <p className="eyebrow">对局结束</p>
                  <h2>{view.winner === 'draw' ? '平局' : `${PLAYER_NAMES[view.winner!]} 获胜`}</h2>
                  <p>{view.winner === view.mySide ? '恭喜，你赢了。' : view.winner === 'draw' ? '存活单位数与总生命值均相同。' : '本局落败，可以再来一局。'}</p>
                  <div className="over-actions">
                    {!spectating && <button className="primary" onClick={() => socket.emit('restart', {})}>重新开始</button>}
                    <button className="ghost" onClick={onLeave}>退出房间</button>
                  </div>
                </div>
              </div>
            )}
            {notice && <div className="toast" onClick={() => setNotice(null)}>{notice}</div>}
          </div>

          {/* ---- 手牌区：牌库 / 横向重叠扇形手牌 / 弃牌堆 ---- */}
          <section className="hand-zone">
            <div className="hand-head">
              <h3>我的手牌 <small>仅你可见 · 技能牌每回合 1 张 / 装置牌不限量 · 自动抽 2 张 · 主动抽牌 1 AP · 上限 5 张</small></h3>
              <div className="hand-meta">
                {view.perTurnFlags.skillCardUsed && <span className="hand-used">本回合技能牌已用</span>}
                <span className="hand-count">{view.hand.length} / {HAND_LIMIT}</span>
                {(cardMode || summonMode) && (
                  <button className="ghost small" onClick={() => { cancelModes(); setNotice('已取消选择'); }}>
                    取消
                  </button>
                )}
              </div>
            </div>

            <div className="hand-table">
              <button
                className={`pile deck-pile ${h?.canDraw && myTurn && view.hand.length < HAND_LIMIT ? '' : 'is-disabled'}`}
                onClick={drawFromDeck}
                title="花 1 AP 主动抽 1 张（手牌上限 5）"
              >
                <span className="pile-icon">🂠</span>
                <span className="pile-label">牌库</span>
                <span className="pile-count">{view.deckCount}</span>
                <small>1 AP · 抽 1 张</small>
              </button>

              <div className="hand-list">
                {view.hand.map((c, i) => {
                  const reason = cardReason(c);
                  const active = cardMode === c.id;
                  const n = view.hand.length;
                  const off = i - (n - 1) / 2;
                  return (
                    <button
                      key={c.id}
                      className={`hand-card ${active ? 'active' : ''} ${reason ? 'is-disabled' : ''} ${drawnIds.has(c.id) ? 'drawn' : ''}`}
                      style={{
                        '--card-color': CARD_INFO[c.type].color,
                        '--rot': `${off * 5}deg`,
                        '--lift': `${Math.abs(off) * 10}px`,
                        zIndex: active ? 30 : 10 - Math.abs(off),
                      } as CSSProperties}
                      title={reason || c.desc}
                      onClick={() => chooseCard(c)}
                    >
                      <span className="hc-cost" title={`消耗 ${c.cost} AP`}>{c.cost}<small>AP</small></span>
                      <div className="hc-art"><span className="hc-icon">{CARD_INFO[c.type].icon}</span></div>
                      <div className="hc-name">{c.name}</div>
                      <div className="hc-desc">{c.desc}</div>
                      <div className="hc-foot">
                        <span className="hc-tag">{CARD_INFO[c.type].tag}</span>
                        <span className="hc-target">
                          {c.target === 'enemy' ? '选敌方单位' : c.target === 'ally' ? '选己方单位'
                            : c.target === 'cell' ? '选可见格 · 黄格' : '无需目标 · 立即生效'}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {view.hand.length === 0 && <p className="empty">手牌已空，下次轮到你时会自动抽 2 张</p>}
              </div>

              <div className="pile discard-pile" title="打出的卡牌飞入弃牌堆；牌库抽空时自动洗回">
                <span className="pile-icon">🗃️</span>
                <span className="pile-label">弃牌堆</span>
                <span className="pile-count">{view.discardCount}</span>
                <small>{view.discardTop || '空'}</small>
              </div>
            </div>

            <div className="hand-extra">
              {/* 召唤入口【仅限预备池点击】：本局预选的 2 个名额，已召唤的整局锁死 */}
              <div className="reserve-pool">
                <div className="rp-title">预备召唤池 <small>本局预选 · 每个名额整局限 1 次 · 2 AP · {view.mySide === 'A' ? '底层 z=0' : '顶层 z=2'}</small></div>
                <div className="rp-list">
                  {(view.reservePool || []).map((entry) => {
                    const chosen = summonMode && summonKey === entry.key;
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className={`rp-item ${entry.used ? 'used' : ''} ${chosen ? 'active' : ''}`}
                        disabled={entry.used}
                        title={entry.used ? '【已召唤】整局锁死，无法再次召唤' : `点击召唤【${entry.name}】（消耗 2 AP）`}
                        onClick={() => chooseReserve(entry)}
                      >
                        <span className="rp-icon">{classGlyph(entry.cls)}</span>
                        <span className="rp-name">{entry.name}</span>
                        <span className="rp-state">{entry.used ? '已召唤' : chosen ? '选格中' : '可召唤'}</span>
                      </button>
                    );
                  })}
                  {(view.reservePool || []).length === 0 && <span className="rp-empty">无可召唤单位</span>}
                </div>
              </div>
              <p className="hand-tip">
                {spectating ? '观战模式：只读，无法操作。'
                  : cardMode ? '点击棋盘黄色高亮格完成放置 / 释放烟雾；或紫色高亮单位施放。'
                    : summonMode ? '点击棋盘黄色高亮格完成召唤，新队友本回合可直接行动；再点该名额可取消。'
                      : myTurn ? '点击己方单位：同时显示绿色移动格与红色攻击圈；点绿格移动、点红圈敌人攻击、点空白取消。召唤只从左侧预备池点选。'
                        : '等待对方行动中，操作已锁定。'}
              </p>
            </div>

            {/* 图例：默认折叠成一行，点开才显示大段说明，不再挤压手牌区 */}
            <details className="legend">
              <summary className="legend-summary">图例 / 操作说明 <span>（点击展开）</span></summary>
              <div className="legend-body">
                <span className="legend-item"><i className="sw stair" />楼梯（上下 1 AP）</span>
                <span className="legend-item"><i className="sw hole" />中/顶层洞口（连续坠落）</span>
                <span className="legend-item"><i className="sw crate" />木箱</span>
                <span className="legend-item"><i className="sw trap" />固定陷阱</span>
                <span className="legend-item"><i className="sw portal" />传送门</span>
                <span className="legend-item"><i className="sw arrow" />弩箭机关</span>
                <span className="legend-item"><i className="sw grass" />草丛（隐身）</span>
                <span className="legend-item"><i className="sw climber" />攀升器（仅 A）</span>
                <span className="legend-item"><i className="sw fog" />战争迷雾（视野外不可见/不可点）</span>
                <span className="legend-item"><i className="sw smoke" />致盲烟雾 3x3</span>
                <span className="legend-item"><i className="sw own" />蓝圈=己方</span>
                <span className="legend-item"><i className="sw enemy" />红圈=敌方</span>
                <p className="legend-note">
                  棋子中心 {EMOJI_OK ? 'Emoji' : '单字'} 表示职业（{EMOJI_OK
                    ? '⚔️ 战 · 🏹 弓 · 🔮 法 · 🗡️ 刺 · ✨ 牧 · 🛡️ 盾'
                    : '战 / 弓 / 法 / 刺 / 牧 / 盾'}）；细长血条按绿→黄→红变色。
                  <strong>绿格=移动范围，红圈=攻击范围，黄格=卡牌放置/召唤，紫圈=施法目标，暗金=陷阱开关。</strong>
                  红色虚线 = 击退路径。装置已全部卡牌化：出牌扣 1 AP → 亮黄格 → 点击完成放置 → 卡牌飞入弃牌堆。
                </p>
              </div>
            </details>

            {flyCard && (
              <div
                className={`card-ghost ${flyCard.to === 'discard' ? 'to-discard' : 'to-center'}`}
                style={{ '--card-color': CARD_INFO[flyCard.card.type].color } as CSSProperties}
              >
                <span className="cg-icon">{CARD_INFO[flyCard.card.type].icon}</span>
                <strong>{flyCard.card.name}</strong>
              </div>
            )}
          </section>
        </div>

        {/* 右侧操作日志区（结束回合已移到 body 层，固定右上角） */}
        <aside className="side">
          <div className="side-head">操作区</div>
          {spectating && <p className="side-note">👁 观战模式：你看到的是 {PLAYER_NAMES[view.mySide]} 的视野，无法操作。</p>}

          <section className="panel log-panel">
            <h3>操作日志 <small>隐藏单位位置不会显示</small></h3>
            <div className="log-list">
              {[...view.logs].reverse().slice(0, 40).map((l) => (
                <div key={l.id} className={`log-line ${l.actor === view.mySide ? 'mine' : ''}`}>
                  <span className="log-turn">T{l.turn}</span>{l.text}
                </div>
              ))}
              {view.logs.length === 0 && <p className="empty">暂无操作</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
