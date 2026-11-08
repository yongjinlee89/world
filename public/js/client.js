'use strict';

/**
 * 클라이언트 공통 상태 + 소켓. 다른 스크립트(renderer/input/voice/ui)는 window.HG 를 공유한다.
 */
(function () {
const socket = io({ transports: ['websocket'] });

function myId() {
  let id = localStorage.getItem('hg:playerId');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('hg:playerId', id);
  }
  return id;
}

const HG = window.HG = {
  socket,
  me: myId(),
  S: null,          // 서버 상태(diff 패치로 유지)
  C: null,          // 게임 상수
  joined: false,
  selected: null,   // { kind: 'city'|'unit'|'tile', id | x,y }
  ordering: false,  // 직접 명령 모드
  camera: { x: 0, y: 0, zoom: 22 },
  terrDirty: true,
  lastStateAt: Date.now(),
  listeners: [],
  onState(fn) { this.listeners.push(fn); },
};

HG.$ = (s) => document.querySelector(s);
HG.el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
HG.fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR');
HG.fmt1 = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
HG.mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
HG.myNation = () => HG.S && HG.S.game ? HG.S.game.nations.find((n) => n.id === HG.me) || null : null;
HG.nationByIdx = (i) => HG.S && HG.S.game && i >= 0 ? HG.S.game.nations[i] : null;
HG.colorOf = (i) => { const n = HG.nationByIdx(i); return n ? n.color : '#777'; };
HG.isHost = () => HG.S && HG.S.hostId === HG.me;

let toastTimer = null;
HG.toast = function (msg, bad) {
  const t = HG.$('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
};

HG.emit = function (event, payload, cb) {
  socket.emit(event, payload || {}, (res) => {
    if (res && !res.ok && res.error) HG.toast(res.error, true);
    if (cb) cb(res);
  });
};

/* ================================================================== 입장 */
HG.$('#join-name').value = localStorage.getItem('hg:name') || '';
HG.$('#join-room').value = localStorage.getItem('hg:room') || '';

function join() {
  const name = HG.$('#join-name').value.trim();
  const roomId = HG.$('#join-room').value.trim();
  if (!name) return showJoinError('이름을 입력해 주세요.');
  if (!roomId) return showJoinError('방 코드를 입력해 주세요.');
  localStorage.setItem('hg:name', name);
  localStorage.setItem('hg:room', roomId);
  socket.emit('joinRoom', { roomId, name, playerId: HG.me }, (res) => {
    if (!res || !res.ok) return showJoinError(res ? res.error : '접속에 실패했습니다.');
    HG.joined = true;
    showJoinError('');
  });
}
function showJoinError(msg) { HG.$('#join-error').textContent = msg || ''; }
HG.$('#join-btn').addEventListener('click', join);
HG.$('#join-room').addEventListener('keydown', (e) => e.key === 'Enter' && join());
HG.$('#join-name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

socket.on('connect', () => {
  if (HG.joined) socket.emit('joinRoom', { roomId: localStorage.getItem('hg:room'), name: localStorage.getItem('hg:name'), playerId: HG.me }, () => {});
});

/* 탭을 덮어 두면 20초 뒤 상태 수신을 멈춰 트래픽을 아낀다 */
let bgTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(bgTimer); bgTimer = setTimeout(() => socket.emit('bg'), 20000); }
  else { clearTimeout(bgTimer); socket.emit('fg'); }
});

/* ================================================================== 상태 수신 (diff) */
const PATCH_DEL = '\u0000~del~\u0000';
let stateSeq = 0;
function applyPatch(target, patch) {
  for (const k of Object.keys(patch)) {
    if (k === '$len') continue;
    const v = patch[k];
    if (v === PATCH_DEL) { delete target[k]; continue; }
    const cur = target[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object') applyPatch(cur, v);
    else target[k] = v;
  }
  if (patch.$len !== undefined && Array.isArray(target)) target.length = patch.$len;
}

let bytesIn = 0;
HG.traffic = { bytes: 0, since: Date.now() };
socket.on('state', (msg) => {
  if (!msg) return;
  try { bytesIn += JSON.stringify(msg).length; HG.traffic.bytes = bytesIn; } catch (e) { /* 통계용 */ }
  const prevPhase = HG.S ? HG.S.phase : null;
  const prevRoom = HG.S ? HG.S.roomId : null;
  if (msg.f) {
    HG.S = msg.f;
    stateSeq = msg.v;
    HG.terrDirty = true;
  } else if (msg.p) {
    if (!HG.S || stateSeq !== msg.base) { socket.emit('resync'); return; }
    if (msg.p.game && (msg.p.game.terr || msg.p.game.map)) HG.terrDirty = true;
    applyPatch(HG.S, msg.p);
    stateSeq = msg.v;
  }
  HG.C = HG.S.constants;
  HG.lastStateAt = Date.now();
  const phaseChanged = prevPhase !== HG.S.phase || prevRoom !== HG.S.roomId;
  for (const fn of HG.listeners) { try { fn(phaseChanged); } catch (e) { console.error(e); } }
});
})();
