'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { Room, MAX_PLAYERS } = require('./src/room');
const { diff } = require('./src/diff');

const PORT = process.env.PORT || Number(process.argv[2]) || 7870;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // 웹소켓 전용 — HTTP 롱폴링 폴백은 메시지마다 HTTP 헤더가 붙어 트래픽이 몇 배로 나간다.
  transports: ['websocket'],
  pingInterval: 10000,
  pingTimeout: 10000,
  cors: { origin: '*' },
  perMessageDeflate: { threshold: 256 },
});

app.use(compression());
// 정적 자산 캐시: index.html 은 매번 재검증(no-cache, ETag 로 304), js/css 는 ?v=빌드 버전을 붙여 1년 immutable 캐시.
// 재접속·새로고침 때 수 KB 짜리 index.html 만 다시 받는다. 새로 배포하면 버전이 바뀌어 곧바로 갱신된다.
const BUILD = process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 10) : String(Date.now()).slice(-8);
const fs = require('fs');
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace(/(href|src)="(\/?(?:css|js)\/[^"?]+)(?:\?[^"]*)?"/g, `$1="$2?v=${BUILD}"`);
app.get(['/', '/index.html'], (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(INDEX); });
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  index: false,
  setHeaders: (res, filePath, _stat) => {
    const versioned = res.req && res.req.query && res.req.query.v;
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
app.get('/healthz', (_req, res) => {
  let playing = 0, humans = 0;
  for (const room of rooms.values()) {
    if (room.phase === 'playing') playing++;
    humans += room.players.filter((p) => p.connected && !p.isBot).length;
  }
  res.json({ ok: true, rooms: rooms.size, playing, humans, sockets: io.engine.clientsCount });
});

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socket.id -> {roomId, playerId} */
const sessions = new Map();

/* ------------------------------------------------------------------ diff 브로드캐스트 */
// { v, f } 전체 상태(입장·재동기화) / { v, base, p } base→v 패치. 버전이 어긋나면 클라이언트가 resync.
function snapshotOf(room) {
  return JSON.parse(JSON.stringify(room.state()));
}
function broadcast(room) {
  const snap = snapshotOf(room);
  if (!room._snap) {
    room._snap = snap;
    room._seq = 1;
    io.to(room.id).emit('state', { v: 1, f: snap });
    return;
  }
  const patch = diff(room._snap, snap);
  if (patch === undefined) return;
  const base = room._seq;
  room._seq = base + 1;
  room._snap = snap;
  io.to(room.id).emit('state', { v: room._seq, base, p: patch });
}
function sendFull(socket, room) {
  if (!room._snap) { room._snap = snapshotOf(room); room._seq = 1; }
  socket.emit('state', { v: room._seq, f: room._snap });
}
function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, (r) => broadcast(r));
    rooms.set(roomId, room);
  }
  return room;
}
function normalizeRoomId(raw) {
  const id = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
  return id || 'lobby';
}
function sanitizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return name || '이름없음';
}

/* ------------------------------------------------------------------ 음성 (WebRTC 시그널링만 중계) */
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_PASSWORD || undefined,
    });
  }
  return list;
}
function voicePeers(room, exceptId) {
  return room.players
    .filter((p) => !p.isBot && p.socketId && p.voice && p.voice.on && p.id !== exceptId)
    .map((p) => ({ id: p.id, name: p.name, muted: !!p.voice.muted }));
}
function leaveVoice(room, player) {
  if (!player.voice || !player.voice.on) return;
  player.voice.on = false;
  player.voice.muted = false;
  io.to(room.id).emit('voice:peer-left', { id: player.id });
}

io.on('connection', (socket) => {
  function ctx() {
    const s = sessions.get(socket.id);
    if (!s) return null;
    const room = rooms.get(s.roomId);
    if (!room) return null;
    const player = room.player(s.playerId);
    if (!player) return null;
    return { room, player };
  }

  socket.on('joinRoom', (payload = {}, ack) => {
    const roomId = normalizeRoomId(payload.roomId);
    const playerId = String(payload.playerId || '').slice(0, 64);
    const name = sanitizeName(payload.name);
    if (!playerId) { if (ack) ack({ ok: false, error: '잘못된 접속 정보입니다.' }); return; }
    const prev = sessions.get(socket.id);
    if (prev && prev.roomId !== roomId) {
      const prevRoom = rooms.get(prev.roomId);
      if (prevRoom) prevRoom.disconnect(socket.id);
      socket.leave(prev.roomId);
    }
    const room = getRoom(roomId);
    const result = room.join(playerId, name, socket.id);
    if (!result.ok) { if (ack) ack(result); return; }
    sessions.set(socket.id, { roomId, playerId });
    socket.join(roomId);
    if (ack) ack({ ok: true, roomId });
    sendFull(socket, room);
    broadcast(room);
  });

  socket.on('resync', () => {
    const c = ctx();
    if (c) sendFull(socket, c.room);
  });

  // 백그라운드 탭 절전 — 방송 채널에서 빠지고, 30분 넘게 안 돌아오면 연결을 끊는다
  socket.on('bg', () => {
    const s = sessions.get(socket.id);
    if (!s) return;
    socket.leave(s.roomId);
    clearTimeout(socket._bgTimer);
    socket._bgTimer = setTimeout(() => socket.disconnect(true), 30 * 60 * 1000);
  });
  socket.on('fg', () => {
    clearTimeout(socket._bgTimer);
    const c = ctx();
    if (!c) return;
    socket.join(c.room.id);
    sendFull(socket, c.room);
  });

  function withRoom(handler, { quiet } = {}) {
    return (payload, ack) => {
      const c = ctx();
      if (!c) { if (ack) ack({ ok: false, error: '방에 접속해 있지 않습니다.' }); return; }
      let result;
      try {
        result = handler(c.room, c.player.id, payload || {}) || { ok: true };
      } catch (err) {
        console.error('[action]', err);
        result = { ok: false, error: '처리 중 오류가 났습니다.' };
      }
      if (ack) ack(result);
      if (result.ok && !quiet) broadcast(c.room);
    };
  }

  /* ------------------------------------------------------------ 로비 */
  socket.on('updateSettings', withRoom((room, pid, p) => room.updateSettings(pid, p)));
  socket.on('addBot', withRoom((room, pid) => room.addBot(pid)));
  socket.on('removeBot', withRoom((room, pid) => room.removeBot(pid)));
  socket.on('startGame', withRoom((room, pid) => room.start(pid)));
  socket.on('restart', withRoom((room, pid) => room.restart(pid)));
  socket.on('setSpeed', withRoom((room, pid, p) => room.setSpeed(pid, p.speed)));

  /* ------------------------------------------------------------ 위임 설정 (게임 행동) */
  socket.on('setBudget', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setBudget(pid, p))));
  socket.on('setDoctrine', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setDoctrine(pid, p))));
  socket.on('setIndustry', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setIndustry(pid, p))));
  socket.on('setPortfolio', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setPortfolio(pid, p))));
  socket.on('setLiquidate', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setLiquidate(pid, p.on))));
  socket.on('allocate', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.allocate(pid, p.pot, p.amount))));
  socket.on('recallPot', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.recall(pid, p.pot))));
  socket.on('setAutoReserve', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setAutoReserve(pid, p.on))));
  socket.on('setAutoCabinet', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setAutoCabinet(pid, p.on))));
  socket.on('nuke', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.nuke(pid, p.city))));
  socket.on('setResearch', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setResearchTarget(pid, p.tech || null))));
  socket.on('orderUnit', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.orderUnit(pid, p.unit, p.x, p.y))));
  socket.on('releaseUnit', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.releaseUnit(pid, p.unit))));
  socket.on('dipPropose', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.dipPropose(pid, p.target, p.kind))));
  socket.on('dipRespond', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.dipRespond(pid, p.offer, p.yes))));
  socket.on('dipDeclare', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.dipDeclare(pid, p.target))));
  socket.on('dipTribute', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.dipTribute(pid, p.target, p.amount))));
  // 재미 요소: 결단·국가 프로젝트·세계 의회 투표·첩보
  socket.on('decide', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.decide(pid, p.option))));
  socket.on('setProject', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setProject(pid, p.project || null))));
  socket.on('vote', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.vote(pid, p.v))));
  socket.on('spy', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.spy(pid, p.target, p.op))));

  /* ------------------------------------------------------------ 기타 */
  socket.on('leaveRoom', withRoom((room, pid) => {
    const p = room.player(pid);
    if (p) leaveVoice(room, p);
    room.leave(pid);
    socket.leave(room.id);
    sessions.delete(socket.id);
    return { ok: true };
  }));

  socket.on('chat', withRoom((room, pid, payload) => {
    const text = String(payload.text || '').trim().slice(0, 200);
    if (!text) return { ok: true };
    const p = room.player(pid);
    room.pushChat(p ? p.name : '?', text);
    return { ok: true };
  }));

  /* ------------------------------------------------------------ 음성 */
  socket.on('voice:join', (_payload, ack) => {
    const c = ctx();
    if (!c) return ack && ack({ ok: false, msg: '방에 참가한 뒤 이용할 수 있습니다' });
    const { room, player } = c;
    if (!player.voice) player.voice = { on: false, muted: false };
    const peers = voicePeers(room, player.id);
    player.voice.on = true;
    player.voice.muted = false;
    socket.to(room.id).emit('voice:peer-joined', { id: player.id, name: player.name });
    if (typeof ack === 'function') ack({ ok: true, peers, iceServers: iceServers(), you: player.id });
    broadcast(room);
  });
  socket.on('voice:leave', () => {
    const c = ctx();
    if (!c) return;
    leaveVoice(c.room, c.player);
    broadcast(c.room);
  });
  socket.on('voice:mute', ({ muted } = {}) => {
    const c = ctx();
    if (!c || !c.player.voice) return;
    c.player.voice.muted = !!muted;
    io.to(c.room.id).emit('voice:peer-state', { id: c.player.id, muted: !!muted });
    broadcast(c.room);
  });
  socket.on('voice:signal', ({ to, data } = {}) => {
    const c = ctx();
    if (!c || !to || !data) return;
    const target = c.room.player(String(to));
    if (!target || !target.socketId) return;
    const sock = io.sockets.sockets.get(target.socketId);
    if (sock) sock.emit('voice:signal', { from: c.player.id, data });
  });

  socket.on('disconnect', () => {
    clearTimeout(socket._bgTimer);
    const s = sessions.get(socket.id);
    if (!s) return;
    sessions.delete(socket.id);
    const room = rooms.get(s.roomId);
    if (!room) return;
    const p = room.player(s.playerId);
    if (p) leaveVoice(room, p);
    room.disconnect(socket.id);
    broadcast(room);
  });
});

// 사람이 아무도 없는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.isEmpty()) continue;
    const idle = now - room.updatedAt;
    if (idle > 5 * 60 * 1000) { room.clearAutoTimer(); rooms.delete(id); }
    else if (idle > 2 * 60 * 1000 && room.phase === 'playing') room.resetToLobby(); // 끝난 판은 결과를 남겨 둔다 (다시 접속하면 순위가 보이게)
  }
}, 30 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`패권 서버 실행 중: http://0.0.0.0:${PORT} (최대 ${MAX_PLAYERS}인)`);
});
