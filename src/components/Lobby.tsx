import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Side } from '../types';
import type { NetworkInfo } from '../net';
import { joinBaseUrl } from '../net';
import { EMOJI_OK, PLAYER_NAMES } from '../ui';
import { FullscreenLandscapeButton } from './Orientation';

interface LobbyProps {
  connected: boolean;
  busy: boolean;
  error: string | null;
  network: NetworkInfo | null;
  scannedCode: string | null;
  onCreate: () => void;
  onJoin: (code: string) => void;
  /** 最终版：观战（只读，继承所观战玩家的迷雾视野） */
  onSpectate: (code: string, side: Side) => void;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

export function Lobby({ connected, busy, error, network, scannedCode, onCreate, onJoin, onSpectate }: LobbyProps) {
  const [code, setCode] = useState(scannedCode || '');
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (scannedCode) setCode(scannedCode); }, [scannedCode]);

  // v6：不写死 localhost:3000 —— 云端自动取当前公网域名，局域网取当前 IP
  const base = joinBaseUrl(network) || (typeof location !== 'undefined' ? location.origin : '');
  const isCloud = network?.mode === 'cloud';
  const usable = isCloud ? true : !!network?.lanUsable;

  const doCopy = async () => {
    const ok = await copyText(base);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="lobby">
      <div className="lobby-card">
        <div className="brand-mark">3³</div>
        <h1>立方战术</h1>
        <p className="subtitle">3×3×3 · 双人回合制策略（局域网 / 公网网页版）</p>

        <div className={`conn-pill ${connected ? 'ok' : 'bad'}`}>
          <span className="dot" />
          {connected ? '已连接联机服务器' : '正在连接服务器…'}
        </div>

        {/* 迭代 10：手机端一键进入全屏并尝试锁定横屏（桌面点击同样可用，只是无需旋转） */}
        <FullscreenLandscapeButton />

        <button className="primary big" disabled={!connected || busy} onClick={onCreate}>
          创建房间 <span className="tag">玩家 A</span>
        </button>

        <div className="divider"><span>或</span></div>

        <label className="field-label" htmlFor="room-code">加入已有房间</label>
        <div className="join-row">
          <input
            id="room-code"
            className="code-input"
            value={code}
            inputMode="numeric"
            maxLength={4}
            placeholder="4 位房间号"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 4 && connected) onJoin(code); }}
          />
          <button className="primary" disabled={!connected || busy || code.length !== 4} onClick={() => onJoin(code)}>
            加入 <span className="tag">玩家 B</span>
          </button>
        </div>

        {/* 最终版：观战入口（不占席位，只读继承某一方的战争迷雾视野） */}
        <div className="spectate-row">
          <span className="field-label">观战模式 · 用上面的房间号，只读观看某一方视野</span>
          <div className="spectate-btns">
            <button
              className="ghost small"
              disabled={!connected || busy || code.length !== 4}
              onClick={() => onSpectate(code, 'A')}
            >{EMOJI_OK ? '👁 ' : ''}观战玩家 A</button>
            <button
              className="ghost small"
              disabled={!connected || busy || code.length !== 4}
              onClick={() => onSpectate(code, 'B')}
            >{EMOJI_OK ? '👁 ' : ''}观战玩家 B</button>
          </div>
        </div>

        {scannedCode && (
          <p className="scan-hint">
            已识别扫码房间号 <strong>{scannedCode}</strong>，{busy ? '正在自动加入…' : '点「加入」即可进入'}
          </p>
        )}
        {error && <p className="err-text">{error}</p>}

        {/* 极简联机：当前页面所在域名（云端 = 公网域名 / 本地 = 局域网 IP）+ 二维码 */}
        <div className="lan-panel">
          <div className="lan-info">
            <div className="lan-title">{EMOJI_OK ? (isCloud ? '🌐 ' : '📶 ') : ''}{isCloud ? '公网联机' : '局域网联机'}</div>
            <div className="lan-url" title={base}>{base}</div>
            <div className="lan-actions">
              <button className="ghost small" onClick={doCopy}>{copied ? '已复制 ✓' : '复制链接'}</button>
              <span className={`lan-tag ${usable ? 'ok' : 'warn'}`}>
                {isCloud ? '公网可访问' : usable ? '手机可扫' : '仅本机'}
              </span>
            </div>
            <p className="lan-note">
              {isCloud
                ? '把上面的网址发给朋友，或让 TA 扫二维码；手机、电脑浏览器直接打开即可，不需要连同一个 Wi-Fi。'
                : '手机与电脑连同一个 Wi-Fi，扫码即可打开游戏；创建房间后会生成带房间号的二维码。'}
            </p>
            {!isCloud && !usable && (
              <p className="lan-warn">未检测到可用局域网 IP，若手机打不开，请把上方地址换成电脑的局域网 IP。</p>
            )}
          </div>
          <div className="lan-qr" title={`扫码打开 ${base}`}>
            <QRCodeSVG value={base} size={112} bgColor="#ffffff" fgColor="#0b1220" level="M" marginSize={0} />
          </div>
        </div>

        <ul className="tips">
          {isCloud ? (
            <>
              <li>云端网页版：把当前网址发给朋友，手机或电脑浏览器直接打开即可，无需安装、无需同一 Wi-Fi</li>
              <li>A 创建房间 → 把带房间号的二维码或邀请链接发给朋友，B 会自动填入并加入</li>
            </>
          ) : (
            <>
              <li>双击 <code>一键启动.bat</code>（Windows）或 <code>一键启动.command</code>（Mac），自动装依赖、构建、开服务并打开浏览器</li>
              <li>终端里会打印局域网地址，把它发给朋友；或让朋友扫上面的二维码</li>
              <li>A 创建房间 → 把带房间号的二维码给朋友扫，B 会自动填入并加入</li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}

interface WaitingProps {
  code: string;
  side: Side;
  opponentConnected: boolean;
  onLeave: () => void;
  onCopy: () => void;
  copied: boolean;
  onShowQr: () => void;
  /** 观战等待：不显示扫码邀请、文案改为只读 */
  spectating?: boolean;
}

export function Waiting({ code, side, opponentConnected, onLeave, onCopy, copied, onShowQr, spectating }: WaitingProps) {
  return (
    <div className="lobby">
      <div className="lobby-card waiting-card">
        <p className="eyebrow">房间已就绪</p>
        <div className="room-code" onClick={onCopy} title="点击复制房间号">{code}</div>
        <button className="ghost small" onClick={onCopy}>{copied ? '已复制 ✓' : '复制房间号'}</button>
        <p className="identity">
          {spectating
            ? <>观战中：<strong>{PLAYER_NAMES[side]}</strong> 的迷雾视野（只读）</>
            : <>你是 <strong>{PLAYER_NAMES[side]}</strong>（{side === 'A' ? '底层 · 先手' : '顶层'}）</>}
        </p>
        <div className={`waiting-state ${opponentConnected ? 'ok' : ''}`}>
          <span className="dot" />
          {spectating ? '正在同步该玩家视野，等待对局开始…'
            : opponentConnected ? '对手已连接，正在同步对局…' : '等待对手加入房间…'}
        </div>
        {side === 'A' && !spectating && (
          <>
            <p className="hint-text">把房间号告诉朋友，或直接让 TA 扫下面弹出的二维码。</p>
            <button className="primary qr-again" onClick={onShowQr}>{EMOJI_OK ? '📱 ' : ''}显示扫码邀请</button>
          </>
        )}
        <button className="ghost" onClick={onLeave}>{spectating ? '退出观战' : '退出房间'}</button>
      </div>
    </div>
  );
}

interface QrInviteModalProps {
  code: string;
  url: string;
  onClose: () => void;
}

/** 创建房间成功后弹出：二维码内容带 ?room=XXXX，朋友扫码即自动填入并加入。 */
export function QrInviteModal({ code, url, onClose }: QrInviteModalProps) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    const ok = await copyText(url);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <p className="qr-eyebrow">房间已创建</p>
        <div className="qr-room-code">{code}</div>
        <div className="qr-box">
          <QRCodeSVG value={url} size={190} bgColor="#ffffff" fgColor="#0b1220" level="M" marginSize={0} />
        </div>
        <p className="qr-desc">朋友用手机扫一扫，会自动打开游戏、填入房间号并加入。</p>
        <div className="qr-url" title={url}>{url}</div>
        <div className="qr-actions">
          <button className="ghost small" onClick={doCopy}>{copied ? '已复制 ✓' : '复制邀请链接'}</button>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
        <p className="qr-tip">保持「服务端」窗口开着，朋友才能连进来。</p>
      </div>
    </div>
  );
}
