'use strict';

/**
 * 음성 채팅 (WebRTC 풀메시). 서버는 offer/answer/ICE 만 중계한다.
 * 새로 들어온 쪽이 기존 참가자 전원에게 offer 를 보내고, 기존 참가자는 answer 만 한다.
 * 마이크는 보안 컨텍스트(https 또는 localhost)에서만 열린다.
 */
(function () {
const HG = window.HG;
const socket = HG.socket;

const V = HG.voice = {
  active: false, connecting: false, muted: false, deafened: false,
  localStream: null, peers: new Map(), iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  levels: new Map(), myLevel: 0, error: null, audioCtx: null, meterTimer: null,
};

function unsupportedReason() {
  if (!window.RTCPeerConnection) return '이 브라우저는 WebRTC 를 지원하지 않습니다';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
    return '마이크는 HTTPS 또는 localhost 에서만 열립니다 — 배포된 https 주소로 접속하세요';
  }
  return null;
}
V.unsupportedReason = unsupportedReason;
const notify = (m, bad) => HG.toast && HG.toast(m, bad);
const refresh = () => HG.renderVoice && HG.renderVoice();

V.join = async function () {
  if (V.active || V.connecting) return;
  const reason = unsupportedReason();
  if (reason) { V.error = reason; notify(reason, true); refresh(); return; }
  V.connecting = true; V.error = null; refresh();
  try {
    V.localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    V.connecting = false;
    V.error = e && e.name === 'NotAllowedError' ? '마이크 권한이 거부되었습니다 (주소창의 자물쇠에서 허용)' : '마이크를 열 수 없습니다: ' + (e && e.name ? e.name : e);
    notify(V.error, true); refresh(); return;
  }
  socket.emit('voice:join', {}, (res) => {
    V.connecting = false;
    if (!res || !res.ok) { stopLocalStream(); V.error = (res && res.msg) || '음성 참가에 실패했습니다'; notify(V.error, true); refresh(); return; }
    V.active = true; V.muted = false;
    if (res.iceServers && res.iceServers.length) V.iceServers = res.iceServers;
    startMeters();
    for (const p of res.peers || []) connectTo(p.id, true);
    notify(res.peers && res.peers.length ? `음성 참가 (${res.peers.length}명과 연결 중)` : '음성 참가 — 아직 혼자입니다');
    refresh();
  });
};
V.leave = function () {
  if (!V.active) return;
  socket.emit('voice:leave');
  teardown();
  notify('음성에서 나갔습니다');
  refresh();
};
V.toggle = () => (V.active ? V.leave() : V.join());
V.toggleMute = function () {
  if (!V.active) return;
  V.muted = !V.muted;
  for (const t of V.localStream ? V.localStream.getAudioTracks() : []) t.enabled = !V.muted;
  socket.emit('voice:mute', { muted: V.muted });
  refresh();
};
V.toggleDeafen = function () {
  V.deafened = !V.deafened;
  for (const peer of V.peers.values()) if (peer.audio) peer.audio.muted = V.deafened;
  refresh();
};

function stopLocalStream() {
  if (!V.localStream) return;
  for (const t of V.localStream.getTracks()) t.stop();
  V.localStream = null;
}
function teardown() {
  for (const id of Array.from(V.peers.keys())) closePeer(id);
  stopLocalStream(); stopMeters();
  V.active = false; V.muted = false; V.levels.clear(); V.myLevel = 0;
}
function closePeer(id) {
  const peer = V.peers.get(id);
  if (!peer) return;
  try { peer.pc.close(); } catch (e) { /* 이미 닫힘 */ }
  if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
  if (peer.analyserSrc) { try { peer.analyserSrc.disconnect(); } catch (e) {} }
  V.peers.delete(id); V.levels.delete(id);
}
function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers: V.iceServers });
  const peer = { pc, audio: null, stream: null, candidateQueue: [], analyserSrc: null };
  V.peers.set(id, peer);
  if (V.localStream) for (const track of V.localStream.getAudioTracks()) pc.addTrack(track, V.localStream);
  pc.onicecandidate = (ev) => { if (ev.candidate) socket.emit('voice:signal', { to: id, data: { candidate: ev.candidate } }); };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    peer.stream = stream;
    if (!peer.audio) {
      const el = document.createElement('audio');
      el.autoplay = true; el.playsInline = true; el.muted = V.deafened; el.style.display = 'none';
      document.body.appendChild(el);
      peer.audio = el;
    }
    peer.audio.srcObject = stream;
    const p = peer.audio.play();
    if (p && p.catch) p.catch(() => {});
    attachMeter(id, stream);
    refresh();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') notify('음성 연결 실패 (NAT 통과 불가 — TURN 서버 필요)', true);
    refresh();
  };
  return peer;
}
async function connectTo(id, isOfferer) {
  let peer = V.peers.get(id);
  if (!peer) peer = createPeer(id);
  if (!isOfferer) return peer;
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('voice:signal', { to: id, data: { sdp: peer.pc.localDescription } });
  } catch (e) { console.error('voice offer failed', e); }
  return peer;
}
async function handleSignal(from, data) {
  if (!V.active) return;
  let peer = V.peers.get(from);
  if (!peer) peer = createPeer(from);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const c of peer.candidateQueue) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
      peer.candidateQueue.length = 0;
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      else peer.candidateQueue.push(data.candidate);
    }
  } catch (e) { console.error('voice signal error', e); }
}

// --- 말하는 중 표시
function ensureAudioCtx() {
  if (!V.audioCtx) { const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null; V.audioCtx = new Ctx(); }
  if (V.audioCtx.state === 'suspended') V.audioCtx.resume().catch(() => {});
  return V.audioCtx;
}
function attachMeter(id, stream) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser);
    const peer = V.peers.get(id);
    if (peer) { peer.analyser = analyser; peer.analyserSrc = src; peer.buf = new Uint8Array(analyser.fftSize); }
  } catch (e) {}
}
function rmsOf(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / buf.length);
}
function startMeters() {
  const ctx = ensureAudioCtx();
  if (ctx && V.localStream) {
    try {
      const src = ctx.createMediaStreamSource(V.localStream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser);
      V.myAnalyser = analyser; V.myBuf = new Uint8Array(analyser.fftSize); V.myAnalyserSrc = src;
    } catch (e) {}
  }
  if (V.meterTimer) clearInterval(V.meterTimer);
  V.meterTimer = setInterval(() => {
    let changed = false;
    if (V.myAnalyser) { const lvl = V.muted ? 0 : rmsOf(V.myAnalyser, V.myBuf); if (Math.abs(lvl - V.myLevel) > 0.01) changed = true; V.myLevel = lvl; }
    for (const [id, peer] of V.peers) {
      if (!peer.analyser) continue;
      const lvl = rmsOf(peer.analyser, peer.buf);
      if (Math.abs(lvl - (V.levels.get(id) || 0)) > 0.01) changed = true;
      V.levels.set(id, lvl);
    }
    if (changed) refresh();
  }, 120);
}
function stopMeters() {
  if (V.meterTimer) { clearInterval(V.meterTimer); V.meterTimer = null; }
  if (V.myAnalyserSrc) { try { V.myAnalyserSrc.disconnect(); } catch (e) {} V.myAnalyserSrc = null; }
  V.myAnalyser = null;
}
V.isSpeaking = (id) => (id === HG.me ? V.myLevel : V.levels.get(id) || 0) > 0.045;
V.peerStatus = (id) => {
  const peer = V.peers.get(id);
  if (!peer) return 'none';
  const s = peer.pc.connectionState;
  return s === 'connected' ? 'connected' : s === 'failed' || s === 'closed' ? 'failed' : 'connecting';
};

socket.on('voice:peer-joined', ({ id }) => { if (!V.active) return; if (!V.peers.has(id)) createPeer(id); refresh(); });
socket.on('voice:peer-left', ({ id }) => { closePeer(id); refresh(); });
socket.on('voice:peer-state', () => refresh());
socket.on('voice:signal', ({ from, data }) => handleSignal(from, data));
socket.on('disconnect', () => { if (V.active) { teardown(); refresh(); } });

// --- 공용 UI 박스
HG.renderVoiceBox = function (container) {
  if (!container || !HG.S) return;
  const players = (HG.S.roomPlayers || []).filter((p) => !p.isBot);
  const reason = unsupportedReason();
  container.innerHTML = '';
  const head = HG.el('div', 'row space');
  const lbl = HG.el('span', null, V.active ? `🎙 음성 참가 중${V.muted ? ' (마이크 꺼짐)' : ''}` : '🎙 음성 채팅');
  head.appendChild(lbl);
  const btns = HG.el('div', 'row');
  if (!V.active) {
    const b = HG.el('button', 'primary', V.connecting ? '연결 중…' : '음성 참가');
    b.disabled = !!reason || V.connecting;
    b.onclick = () => V.join();
    btns.appendChild(b);
  } else {
    const m = HG.el('button', null, V.muted ? '🔇 마이크 켜기' : '🎤 마이크 끄기'); m.onclick = () => V.toggleMute(); btns.appendChild(m);
    const d = HG.el('button', null, V.deafened ? '🔈 소리 켜기' : '🔊 소리 끄기'); d.onclick = () => V.toggleDeafen(); btns.appendChild(d);
    const l = HG.el('button', null, '나가기'); l.onclick = () => V.leave(); btns.appendChild(l);
  }
  head.appendChild(btns);
  container.appendChild(head);
  const row = HG.el('div', 'vrow');
  for (const p of players) {
    const on = p.voice && p.voice.on;
    if (!on && p.id !== HG.me) continue;
    const chip = HG.el('span', 'peer');
    const ring = HG.el('span', 'ring');
    if (p.id === HG.me) { if (V.active && V.isSpeaking(p.id)) ring.classList.add('speaking'); }
    else {
      const st = V.active ? V.peerStatus(p.id) : 'none';
      if (st === 'connecting') ring.classList.add('connecting');
      else if (st === 'failed') ring.classList.add('failed');
      else if (st === 'connected' && V.isSpeaking(p.id)) ring.classList.add('speaking');
    }
    chip.appendChild(ring);
    chip.appendChild(document.createTextNode(p.name + (p.id === HG.me ? ' (나)' : '') + (p.voice && p.voice.muted ? ' 🔇' : '')));
    row.appendChild(chip);
  }
  container.appendChild(row);
  if (reason) container.appendChild(HG.el('div', 'err', reason));
  else if (V.error) container.appendChild(HG.el('div', 'err', V.error));
};
})();
