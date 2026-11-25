import { useEffect, useRef, useState } from 'react';
import type { PlayerView, RoomInfo, Side, SpectateAck } from './types';
import {
  socket, clientId, emitAck, savedRoom, saveRoom,
  fetchNetworkInfo, joinBaseUrl, scanRoomCode, scanSpectate, requestShutdown,
  type AckResult, type NetworkInfo, type ShutdownResult,
} from './net';
import { Lobby, Waiting, QrInviteModal } from './components/Lobby';
import { Pick } from './components/Pick';
import { Game } from './components/Game';
import {
  ExitGameButton, GameExitedScreen, isDesktopClient, tryCloseGameWindow,
  type ExitReason,
} from './components/ExitGame';
import { audio } from './audio';

// 扫码链接 ?room=XXXX / 观战链接 ?spectate=XXXX&side=A：模块加载时读一次
const SCANNED_CODE = scanRoomCode();
const SPECTATE_LINK = scanSpectate();

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState<{ code: string; side: Side } | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  /** 最终版：观战者（只读，继承所观战玩家的迷雾视野） */
  const [spectating, setSpectating] = useState<{ code: string; side: Side } | null>(null);
  /** v5：大厅退出 / 房主关闭游戏后的全屏退出页；null = 正常游戏 */
  const [exited, setExited] = useState<ExitReason | null>(null);
  /** v5/v6：/api/shutdown 的结果（closed 进程已关 / cloud 云端仅退页面 / failed 失败） */
  const [shutdownAck, setShutdownAck] = useState<ShutdownResult | null>(null);
  const autoJoined = useRef(false);

  useEffect(() => {
    fetchNetworkInfo().then((info) => { if (info) setNetwork(info); });
  }, []);

  useEffect(() => { if (view) setShowQr(false); }, [view]);

  const joinRoom = async (code: string) => {
    audio.unlock();
    setBusy(true); setError(null);
    try {
      const r = await emitAck<AckResult>('joinRoom', { code, clientId });
      if (!r.ok || !r.code || !r.side) throw new Error(r.error || '加入房间失败');
      setRoom({ code: r.code, side: r.side });
      saveRoom({ code: r.code, side: r.side });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const createRoom = async () => {
    audio.unlock();
    setBusy(true); setError(null);
    try {
      const r = await emitAck<AckResult>('createRoom', { clientId });
      if (!r.ok || !r.code || !r.side) throw new Error(r.error || '创建房间失败');
      setRoom({ code: r.code, side: r.side });
      saveRoom({ code: r.code, side: r.side });
      if (r.side === 'A') setShowQr(true);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  /** 观战：不占 A/B 席位，服务端按 side 下发带迷雾的专属 PlayerView */
  const joinSpectate = async (code: string, side: Side) => {
    audio.unlock();
    setBusy(true); setError(null);
    try {
      const r = await emitAck<SpectateAck>('spectate', { code, side, clientId });
      if (!r.ok || !r.code) throw new Error(r.error || '观战失败');
      saveRoom(null);
      setRoom(null);
      setSpectating({ code: r.code, side: r.side || side });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      // 观战链接优先：直接进入只读观战，不恢复本机旧房间
      if (SPECTATE_LINK && !autoJoined.current) {
        autoJoined.current = true;
        void joinSpectate(SPECTATE_LINK.code, SPECTATE_LINK.side);
        return;
      }
      if (SCANNED_CODE && !autoJoined.current) {
        autoJoined.current = true;
        saveRoom(null);
        void joinRoom(SCANNED_CODE);
        return;
      }
      const saved = savedRoom();
      if (saved) {
        emitAck<AckResult>('resume', { code: saved.code, clientId })
          .then((r) => {
            if (r.ok && r.code && r.side) setRoom({ code: r.code, side: r.side });
            else { saveRoom(null); setRoom(null); setView(null); }
          })
          .catch(() => { /* 服务端未启动时由 connect_error 提示 */ });
      }
    };
    const onDisconnect = () => setConnected(false);
    const onState = (v: PlayerView) => { setView(v); setError(null); };
    const onRoom = (info: RoomInfo) => {
      setRoomInfo(info);
      if (info.code && info.side) {
        setRoom({ code: info.code, side: info.side });
        saveRoom({ code: info.code, side: info.side });
      }
      setBusy(false);
    };
    const onErr = (m: unknown) => {
      const s = typeof m === 'string' ? m : (m as { message?: string })?.message || '操作失败';
      setNotice(s);
      setError(s);
      setBusy(false);
    };
    const onConnectError = (e: Error) => {
      setError(`无法连接联机服务端：${e.message}。请确认已双击「一键启动」脚本`);
      setBusy(false);
    };
    // v5：房主（或本机）关闭了游戏进程。广播先于断线到达，让所有客户端
    // 显示退出页而不是陷入「连接已断开，正在重连…」的循环。
    const onServerShutdown = () => {
      setExited((cur) => cur ?? 'remote');
      try { socket.disconnect(); } catch { /* 忽略 */ }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state', onState);
    socket.on('room', onRoom);
    socket.on('error', onErr);
    socket.on('connect_error', onConnectError);
    socket.on('serverShutdown', onServerShutdown);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state', onState);
      socket.off('room', onRoom);
      socket.off('error', onErr);
      socket.off('connect_error', onConnectError);
      socket.off('serverShutdown', onServerShutdown);
    };
  }, []);

  const leaveRoom = () => {
    socket.emit('leaveRoom', {});
    saveRoom(null);
    setRoom(null); setRoomInfo(null); setView(null); setSpectating(null);
    setError(null); setNotice(null); setShowQr(false);
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice(`房间号：${code}（请手动复制）`);
    }
  };

  /**
   * v5：大厅【退出游戏】→【确认】。
   * 1) 立即切到全屏退出页（不再显示大厅 / 断线横幅）；
   * 2) 主动断开 socket，停止自动重连；
   * 3) 请求本机服务端结束游戏进程（node server/server.js，真正的游戏进程）；
   * 4) 尝试关闭浏览器窗口，回到桌面（被浏览器拦截时保留退出页兜底）。
   */
  const handleSelfExit = () => {
    setExited('self');
    setShutdownAck(null);
    try { socket.disconnect(); } catch { /* 忽略 */ }
    void requestShutdown().then((ok) => setShutdownAck(ok));
    // 给 React 一点时间把退出页渲染出来，再尝试关窗
    window.setTimeout(tryCloseGameWindow, 120);
  };

  const activeCode = spectating?.code || room?.code || '';
  const activeSide: Side = spectating?.side || room?.side || 'A';
  // 观战者在选人阶段显示等待卡片；进入对局后直接渲染只读棋盘
  const waitingForStart = !view || (!!spectating && view.phase === 'picking');

  // v5：进程已关闭后，用最高层级的全屏退出页替代一切界面（含断线重连横幅）
  if (exited) return <GameExitedScreen reason={exited} ack={shutdownAck} />;

  return (
    <>
      {!connected && (
        <div className="net-banner">连接已断开，正在重连… 若持续失败请检查服务端是否已启动</div>
      )}
      {!room && !spectating ? (
        <>
          <Lobby
            connected={connected}
            busy={busy}
            error={error}
            network={network}
            scannedCode={SCANNED_CODE}
            onCreate={createRoom}
            onJoin={joinRoom}
            onSpectate={joinSpectate}
          />
          {/* v5：仅「电脑端 + 大厅」出现；等待 / 选人 / 对局 / 观战均不渲染 */}
          {isDesktopClient() && <ExitGameButton onExited={handleSelfExit} />}
        </>
      ) : waitingForStart ? (
        <Waiting
          code={activeCode}
          side={activeSide}
          opponentConnected={roomInfo?.opponentConnected ?? false}
          onLeave={leaveRoom}
          onCopy={() => copyCode(activeCode)}
          copied={copied}
          onShowQr={() => setShowQr(true)}
          spectating={!!spectating}
        />
      ) : view!.phase === 'picking' && view!.pick ? (
        <Pick view={view!} notice={notice} setNotice={setNotice} onLeave={leaveRoom} />
      ) : (
        <Game view={view!} notice={notice} setNotice={setNotice} onLeave={leaveRoom} />
      )}
      {showQr && room && (
        <QrInviteModal
          code={room.code}
          url={`${joinBaseUrl(network)}/?room=${room.code}`}
          onClose={() => setShowQr(false)}
        />
      )}
    </>
  );
}
