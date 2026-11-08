'use strict';

/**
 * 화면 전환 + HUD + 사이드 패널(국정/산업/과학/금융/군사/순위/기록) + 선택 카드.
 * 서버 상태는 1초마다 오므로, 슬라이더는 사용자가 만지는 동안엔 서버 값으로 덮어쓰지 않는다.
 */
(function () {
const HG = window.HG;
const { $, el, fmt, fmt1, mmss } = HG;
const ICONS = window.HG_ICONS;

let activeTab = localStorage.getItem('hg:tab') || 'policy';
let resultDismissed = false;
let lastThreat = 0, lastAlertAt = 0;

function showAlert(me) {
  const a = $('#alert');
  const earmarked = me.pots.industry + me.pots.research + me.pots.military + me.pots.finance;
  const free = Math.max(0, Math.floor(me.cash - earmarked));
  const s = me.threat.share;
  const main = HG.C.UNIT_ORDER.filter((t) => s[t] > 0).sort((x, y) => s[y] - s[x])[0];
  a.innerHTML = `<b>⚠ 긴급: 도시가 공격받고 있습니다</b><span class="hint">주력 위협 ${main ? HG.C.UNITS[main].name : '-'} · 비축 ${fmt(free)}</span>`;
  const row = el('div', 'row');
  const b1 = el('button', 'primary', `국방에 비축 100% 투입`); b1.disabled = free < 1; b1.onclick = () => { HG.emit('allocate', { pot: 'military', amount: free }); a.classList.add('hidden'); };
  const b2 = el('button', null, '군사 탭'); b2.onclick = () => { setTab('army'); a.classList.add('hidden'); };
  const b3 = el('button', null, '닫기'); b3.onclick = () => a.classList.add('hidden');
  row.append(b1, b2, b3);
  a.appendChild(row);
  a.classList.remove('hidden');
  clearTimeout(a._t); a._t = setTimeout(() => a.classList.add('hidden'), 15000);
}
function setTab(name) {
  activeTab = name;
  try { localStorage.setItem('hg:tab', name); } catch (e) {}
  for (const t of $('#tabs').querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === activeTab);
  for (const body of document.querySelectorAll('.tab-body')) body.classList.toggle('hidden', body.id !== 'tab-' + activeTab);
  renderTab();
}
const editing = {}; // group → 마지막으로 만진 시각
const sendTimers = {};

/* ================================================================== 공통 */
function show(id) {
  for (const s of ['screen-join', 'screen-lobby', 'screen-game']) $('#' + s).classList.toggle('hidden', s !== id);
}
function render(phaseChanged) {
  const S = HG.S;
  if (!S) return;
  if (!HG.joined) { show('screen-join'); return; }
  if (S.phase === 'lobby') { show('screen-lobby'); renderLobby(); return; }
  show('screen-game');
  if (phaseChanged) { resultDismissed = false; HG.selected = null; }
  renderGame();
}
HG.onState(render);
HG.renderVoice = () => {
  if (!HG.S) return;
  if (HG.S.phase === 'lobby') HG.renderVoiceBox($('#lobby-voice'));
  else {
    HG.renderVoiceBox($('#game-voice'));
    const b = $('#tb-voice');
    const V = HG.voice;
    b.classList.toggle('on', V.active);
    b.textContent = V.active ? (V.muted ? '🔇' : (V.isSpeaking(HG.me) ? '🟢' : '🎙')) : '🎙';
  }
};

/* ================================================================== 대기실 */
function renderLobby() {
  const S = HG.S;
  $('#lobby-room-code').textContent = '#' + S.roomId;
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  S.roomPlayers.forEach((p, i) => {
    const li = el('li');
    const dot = el('span', 'dot' + (p.connected ? ' on' : ''));
    dot.style.background = p.connected ? (HG.C ? undefined : undefined) : undefined;
    li.appendChild(dot);
    li.appendChild(el('span', null, p.name + (p.id === HG.me ? ' (나)' : '')));
    const tags = [];
    if (p.id === S.hostId) tags.push('방장');
    if (p.isBot) tags.push('컴퓨터');
    if (p.voice && p.voice.on) tags.push(p.voice.muted ? '🔇' : '🎙');
    li.appendChild(el('span', 'badge', tags.join(' · ')));
    ul.appendChild(li);
  });
  HG.renderVoiceBox($('#lobby-voice'));
  const isHost = HG.isHost();
  const st = $('#lobby-settings');
  st.innerHTML = '';
  const labels = { startCash: '시작 자금', duration: '제한 시간', mapSize: '지도 크기', victory: '승리 조건' };
  const fmtV = { startCash: (v) => fmt(v), duration: (v) => Math.round(v / 60) + '분', mapSize: (v) => ['작게', '보통', '크게'][v], victory: (v) => ['시간 종료 국력', '최후 생존', '경제(국력 5만)'][v] };
  for (const [key, choices] of Object.entries(S.settingChoices)) {
    const row = el('div', 'setting');
    row.appendChild(el('span', 'name', labels[key] || key));
    for (const v of choices) {
      const b = el('button', S.settings[key] === v ? 'active' : '', fmtV[key](v));
      b.disabled = !isHost;
      b.onclick = () => HG.emit('updateSettings', { [key]: v });
      row.appendChild(b);
    }
    st.appendChild(row);
  }
  $('#lobby-bot-actions').classList.toggle('hidden', !isHost);
  $('#lobby-start').disabled = !isHost;
  $('#lobby-hint').textContent = isHost ? '국가가 2개 이상이면 시작할 수 있습니다. 혼자라면 컴퓨터를 추가하세요.' : '방장이 시작하기를 기다리는 중…';
}
$('#lobby-add-bot').onclick = () => HG.emit('addBot');
$('#lobby-remove-bot').onclick = () => HG.emit('removeBot');
$('#lobby-start').onclick = () => HG.emit('startGame');
$('#lobby-leave').onclick = () => { HG.emit('leaveRoom'); HG.joined = false; HG.S = null; show('screen-join'); };

/* ================================================================== 게임 */
function renderGame() {
  const S = HG.S, g = S.game;
  if (!g) return;
  renderTopbar(g);
  renderTab();
  renderSelection();
  renderResult(S, g);
  HG.renderVoice();
}

function renderTopbar(g) {
  const S = HG.S;
  const me = HG.myNation();
  if (me) {
    $('#tb-flag').style.background = me.color; $('#tb-flag').style.color = me.color;
    $('#tb-title').textContent = me.title + (me.alive ? '' : ' (멸망)');
    // 재정 스냅샷은 3초에 한 번 오므로, 그 사이는 순수입으로 이어 계산해 보여 준다.
    // 표시는 "가용 현금"(금고에 배정되지 않은 비축) — 금고에 쌓인 돈은 장관이 쓰기로 정해진 돈이다.
    const ahead = Math.max(0, Math.min(4, g.t - (g.econT || g.t)));
    const earmarked = me.pots.industry + me.pots.research + me.pots.military + me.pots.finance;
    const total = me.cash + me.stats.net * ahead;
    $('#tb-cash').textContent = fmt(total - earmarked);
    $('#tb-cash').parentElement.title = `가용 현금(비축) ${fmt(total - earmarked)} + 각 부처 금고 ${fmt(earmarked)} = 총 ${fmt(total)}\n비축은 국정 탭의 특별 집행으로 한 번에 투입할 수 있습니다`;
    const net = $('#tb-net'); net.textContent = (me.stats.net >= 0 ? '+' : '') + fmt1(me.stats.net) + '/s'; net.className = me.stats.net >= 0 ? 'up' : 'down';
    $('#tb-sci').textContent = fmt(me.sci);
    $('#tb-scirate').textContent = '+' + fmt1(me.stats.science) + '/s';
    $('#tb-mats').textContent = `철 ${me.mats.iron} · 유 ${me.mats.oil} · 곡 ${me.mats.grain}`;
    $('#tb-mil').textContent = `${me.stats.units} / 🏙 ${me.stats.cities} / ⬛ ${me.stats.tiles}`;
  }
  const left = g.victory === 'conquest' ? g.t : g.dur - g.t;
  $('#tb-time').textContent = (g.victory === 'conquest' ? '⏱ ' : '') + mmss(left);
  $('#tb-time').title = { score: '제한 시간 종료 시 국력 1위', conquest: '최후의 생존 국가 승리 (제한 시간 없음)', economic: `국력 ${fmt(HG.C.RULES.economicVictory)} 선착 또는 시간 종료` }[g.victory] || '';
  $('#time-fill').style.width = Math.min(100, (g.t / g.dur) * 100) + '%';
  const ev = $('#tb-event');
  const bits = [];
  const grace = HG.C.RULES.graceSeconds - g.t;
  if (grace > 0) bits.push(`🛡 보호 ${mmss(grace)}`);
  if (me && me.weariness >= 10) bits.push(`😩 피로 ${me.weariness}`);
  if (me && me.stats.trade > 0) bits.push(`🤝 교역 +${me.stats.trade}%`);
  if (g.event) bits.push(`⚡ ${g.event.name} (${Math.max(0, g.event.u - g.t)}s)`);
  if (bits.length) { ev.textContent = bits.join(' · '); ev.classList.remove('hidden'); ev.title = '보호 기간: 도시 점령 불가·민병대 2배 / 피로도: 세수 감소, 40 이상이면 인구 정체 / 교역: 불가침·동맹국당 세수 +4~8%'; } else ev.classList.add('hidden');
  // 긴급 경보: 위협이 새로 커지면 토스트 + 원클릭 특별 집행
  if (me && me.threat) {
    const th = me.threat.total;
    if (th >= 1.2 && (lastThreat < 1.2) && Date.now() - lastAlertAt > 45000) { lastAlertAt = Date.now(); showAlert(me); }
    lastThreat = th;
  }
  const spec = $('#spectate');
  if (me && !me.alive) { spec.classList.remove('hidden'); } else spec.classList.add('hidden');
  renderNews(g);
  if (me) renderDecision(g, me);
  for (const b of $('#tb-speed').querySelectorAll('button')) { b.classList.toggle('active', Number(b.dataset.speed) === S.speed); b.disabled = !HG.isHost(); }
}
$('#tb-speed').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) HG.emit('setSpeed', { speed: Number(b.dataset.speed) }); });
$('#tb-voice').onclick = () => { $('#voice-modal').classList.remove('hidden'); HG.renderVoice(); };
$('#voice-close').onclick = () => $('#voice-modal').classList.add('hidden');
$('#tb-panel').onclick = () => $('#side').classList.toggle('collapsed');
if (window.innerWidth < 900) $('#side').classList.add('collapsed');

/* ---------------------------------------------------------------- 세계 뉴스 / 결단 */
let lastNewsKey = '';
function renderNews(g) {
  const box = $('#news');
  const nw = g.news;
  if (!nw) { box.classList.add('hidden'); return; }
  const key = nw.t + '|' + nw.text;
  if (key !== lastNewsKey) {
    lastNewsKey = key;
    box.textContent = nw.text;
    box.style.borderColor = nw.c >= 0 ? HG.colorOf(nw.c) : 'rgba(251,191,36,0.4)';
    box.classList.remove('hidden');
    clearTimeout(box._t); box._t = setTimeout(() => box.classList.add('hidden'), 12000);
  }
}
let lastDecisionId = '';
function renderDecision(g, me) {
  const box = $('#decision');
  const d = me.decision;
  if (!d || !me.alive) { box.classList.add('hidden'); lastDecisionId = ''; return; }
  const key = d.id + '|' + d.text;
  if (key !== lastDecisionId) {
    lastDecisionId = key;
    box.innerHTML = '';
    const h = el('h3'); h.innerHTML = `⚖ 결단: ${d.name}<span class="left"></span>`; box.appendChild(h);
    box.appendChild(el('p', null, d.text));
    d.options.forEach((o, i) => {
      const b = el('button', 'opt' + (i === 0 ? ' def' : ''));
      b.innerHTML = `<b>${o.label}</b><span>${o.desc}</span>`;
      b.onclick = () => { HG.emit('decide', { option: i }); box.classList.add('hidden'); };
      box.appendChild(b);
    });
    const tm = el('div', 'timer'); tm.innerHTML = '<i></i>'; box.appendChild(tm);
    box.appendChild(el('div', 'hint', '시간이 지나면 기본 선택(첫 번째)이 적용됩니다. 자동 내각을 켜 두면 내각이 대신 고릅니다.'));
    box.classList.remove('hidden');
  }
  const left = Math.max(0, d.u - g.t);
  box.querySelector('.left').textContent = `${left}초`;
  box.querySelector('.timer i').style.width = Math.max(0, Math.min(100, (left / HG.C.RULES.decisionSeconds) * 100)) + '%';
}

/* ---------------------------------------------------------------- 탭 */
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});
// 저장된 탭 복원
for (const t of $('#tabs').querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === activeTab);
for (const body of document.querySelectorAll('.tab-body')) body.classList.toggle('hidden', body.id !== 'tab-' + activeTab);
function renderTab() {
  const g = HG.S.game;
  const me = HG.myNation();
  if (!me) return;
  ({ policy: renderPolicy, industry: renderIndustry, tech: renderTech, finance: renderFinance, army: renderArmy, dip: renderDip, rank: renderRank, log: renderLog })[activeTab](g, me);
  // 내게 온 외교 제안 수를 탭에 표시
  let incoming = Object.values((g.dip && g.dip.offers) || {}).filter((o) => o.to === me.idx).length;
  if (g.council && g.council.vote && !(g.council.vote.votes[me.idx])) incoming++; // 아직 투표 안 한 결의안
  const badge = $('#dip-badge');
  badge.textContent = incoming;
  badge.classList.toggle('hidden', incoming === 0);
}

/* ---------------------------------------------------------------- 외교 */
const REL_NAME = { war: '적대', peace: '불가침', ally: '동맹' };
function relKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function renderDip(g, me) {
  const box = $('#tab-dip');
  box.innerHTML = '<h4>외교</h4><p class="hint">기본은 적대입니다. 불가침은 4분 뒤 만료되고, 동맹은 깨기 전까지 유지되며 서로의 도시를 함께 지킵니다. 조약을 깨면 신뢰가 크게 떨어지고 제3국의 신뢰도 깎입니다.</p>';
  const dip = g.dip || { rel: {}, offers: {} };
  const offers = Object.values(dip.offers || {});
  const incoming = offers.filter((o) => o.to === me.idx);
  renderCouncil(box, g, me);
  if (incoming.length) {
    box.appendChild(el('h4', null, '받은 제안'));
    for (const o of incoming) {
      const from = HG.nationByIdx(o.from);
      const d = el('div', 'box offer');
      d.innerHTML = `<div class="title"><span class="flag" style="background:${from.color};color:${from.color}"></span>${from.title}<span class="sz">${REL_NAME[o.kind]} 제안 · ${Math.max(0, o.exp - g.t)}초 남음</span></div>`;
      const row = el('div', 'row');
      const y = el('button', 'primary', '수락'); y.onclick = () => HG.emit('dipRespond', { offer: o.id, yes: true }); row.appendChild(y);
      const nn = el('button', null, '거절'); nn.onclick = () => HG.emit('dipRespond', { offer: o.id, yes: false }); row.appendChild(nn);
      d.appendChild(row);
      box.appendChild(d);
    }
  }
  box.appendChild(el('h4', null, '국가별 관계'));
  for (const n of g.nations) {
    if (n.idx === me.idx) continue;
    const r = dip.rel[relKey(me.idx, n.idx)] || { s: 'war', t: 30, u: 0 };
    const d = el('div', 'box');
    const pending = offers.find((o) => o.from === me.idx && o.to === n.idx);
    d.innerHTML = `<div class="title"><span class="flag" style="background:${n.color};color:${n.color}"></span>${n.title}${n.alive ? '' : ' (멸망)'}<span class="rel ${r.s}">${REL_NAME[r.s]}${r.s === 'peace' && r.u ? ` ${Math.max(0, r.u - g.t)}s` : ''}</span><span class="sz">${n.isBot ? '컴퓨터' : n.name} · 국력 ${fmt(n.stats.score)}</span></div>
      <div class="kv"><span class="k">신뢰</span><span class="v">${r.t}</span></div><div class="bar" style="margin:4px 0 8px"><i style="width:${r.t}%;background:${r.t >= 50 ? '#4ade80' : r.t >= 20 ? '#fbbf24' : '#f87171'}"></i></div>`;
    if (!n.alive) { box.appendChild(d); continue; }
    const row = el('div', 'row'); row.style.flexWrap = 'wrap';
    const mk = (label, cls, fn, title) => { const b = el('button', cls || '', label); b.onclick = fn; if (title) b.title = title; row.appendChild(b); return b; };
    if (r.s === 'war') mk(pending && pending.kind === 'peace' ? '불가침 제안 중…' : '불가침 제안', 'primary', () => HG.emit('dipPropose', { target: n.idx, kind: 'peace' }), '4분간 서로 교전·점령 불가. 신뢰 20 이상이면 받아 줄 확률이 높습니다.').disabled = !!pending;
    if (r.s === 'peace') mk(pending && pending.kind === 'ally' ? '동맹 제안 중…' : '동맹 제안', 'primary', () => HG.emit('dipPropose', { target: n.idx, kind: 'ally' }), '무기한. 서로의 도시를 함께 수비합니다. 신뢰 50 이상 필요.').disabled = !!pending;
    if (r.s !== 'war') mk('적대 선언', '', () => { if (confirm(`${n.title}과의 ${REL_NAME[r.s]}을(를) 파기하고 적대를 선언할까요? 신뢰가 크게 떨어집니다.`)) HG.emit('dipDeclare', { target: n.idx }); });
    mk('조공 300', '', () => HG.emit('dipTribute', { target: n.idx, amount: 300 }), '현금 300을 보내 신뢰를 올립니다.');
    mk('조공 1000', '', () => HG.emit('dipTribute', { target: n.idx, amount: 1000 }));
    d.appendChild(row);
    // 첩보 작전
    const spy = el('div', 'spy-row');
    const wait = Math.max(0, me.spyReady - g.t);
    const free = Math.floor(me.cash - (me.pots.industry + me.pots.research + me.pots.military + me.pots.finance));
    const chance = Math.round((HG.C.RULES.spyBase + (me.techs.includes('recon') ? 0.15 : 0) - (n.techs.includes('recon') ? 0.15 : 0) - (n.techs.includes('cyber') ? 0.15 : 0)) * 100);
    for (const op of Object.values(HG.C.SPY_OPS)) {
      const b = el('button', null, `${op.icon} ${op.name} ${op.cost}`);
      b.title = `${op.desc}\n성공률 ${chance}% · 실패하면 발각되어 신뢰 −${HG.C.RULES.spyCaughtTrust} (제3국 −5)${wait ? `\n재정비 ${wait}초` : ''}`;
      b.disabled = wait > 0 || free < op.cost;
      b.onclick = () => { if (confirm(`${n.title}에 「${op.name}」을(를) 실행할까요? 비축 ${op.cost} · 성공률 ${chance}%`)) HG.emit('spy', { target: n.idx, op: op.id }); };
      spy.appendChild(b);
    }
    d.appendChild(spy);
    box.appendChild(d);
  }
  // 제3국 간 관계 요약
  const others = g.nations.filter((n) => n.idx !== me.idx && n.alive);
  const lines = [];
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
    const r = dip.rel[relKey(others[i].idx, others[j].idx)];
    if (r && r.s !== 'war') lines.push(`${others[i].title} ↔ ${others[j].title}: ${REL_NAME[r.s]}`);
  }
  if (lines.length) { box.appendChild(el('h4', null, '세계 정세')); for (const l of lines) box.appendChild(el('div', 'hint', l)); }
}

// 세계 의회: 진행 중 투표 + 발효 중 결의
function renderCouncil(box, g, me) {
  const C = g.council || {};
  const v = C.vote;
  const d = el('div', 'council');
  if (v) {
    const mine = v.votes[me.idx] || 0;
    let yes = 0, no = 0;
    for (const n of g.nations) { const x = v.votes[n.idx] || 0; if (x > 0) yes++; else if (x < 0) no++; }
    d.innerHTML = `<div class="title">🏛 세계 의회 투표<span class="sz">${Math.max(0, v.u - g.t)}초 남음 · 찬성 ${yes} / 반대 ${no}</span></div><div><b>${v.name}</b></div><div class="hint">${v.desc}</div>`;
    const votes = el('div', 'votes');
    for (const n of g.nations) { if (!n.alive) continue; const x = v.votes[n.idx] || 0; const sp = el('span', x > 0 ? 'y' : x < 0 ? 'n' : '', `${n.title} ${x > 0 ? '찬성' : x < 0 ? '반대' : '기권'}`); votes.appendChild(sp); }
    d.appendChild(votes);
    const row = el('div', 'row');
    for (const [lb, val] of [['찬성', 1], ['반대', -1], ['기권', 0]]) { const b = el('button', 'vote' + (mine === val ? ' active' : ''), lb); b.onclick = () => HG.emit('vote', { v: val }); row.appendChild(b); }
    d.appendChild(row);
    d.appendChild(el('div', 'hint', '국가당 1표 (세계 박람회 보유국 +1). 찬성이 많으면 가결되어 모두에게 적용됩니다.'));
  } else {
    const active = (C.active || []).map((a) => `${a.name} (${Math.max(0, a.u - g.t)}s)`);
    const last = C.last ? `최근: 「${(HG.C.RESOLUTIONS[C.last.id] || {}).name}」 ${C.last.passed ? '가결' : '부결'} (${C.last.yes}:${C.last.no})` : '아직 결의안이 없었습니다';
    d.innerHTML = `<div class="title">🏛 세계 의회<span class="sz">${HG.mmss(HG.C.RULES.councilEvery)}마다 결의안</span></div><div class="hint">${active.length ? '발효 중: ' + active.join(' · ') : last}</div>`;
  }
  box.appendChild(d);
}

// 슬라이더 그룹: 처음 한 번 DOM 을 만들고, 이후엔 값만 갱신한다
function sliderGroup(container, group, keys, labels, colors, values, send, extra) {
  let box = container.querySelector(`[data-group="${group}"]`);
  if (!box) {
    box = el('div', 'slider-group'); box.dataset.group = group;
    for (const k of keys) {
      const row = el('div', 'slider');
      row.appendChild(el('span', 'name', labels[k]));
      const input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 100; input.step = 1; input.dataset.key = k;
      input.style.setProperty('--c', colors[k] || 'var(--accent)');
      const pct = el('span', 'pct');
      const onInput = () => {
        editing[group] = Date.now();
        updatePcts(box);
        clearTimeout(sendTimers[group]);
        sendTimers[group] = setTimeout(() => {
          const vals = {};
          for (const i of box.querySelectorAll('input')) vals[i.dataset.key] = Number(i.value);
          send(vals);
        }, 350);
      };
      input.addEventListener('input', onInput);
      row.appendChild(input); row.appendChild(pct);
      box.appendChild(row);
    }
    container.appendChild(box);
  }
  if (!editing[group] || Date.now() - editing[group] > 2500) {
    for (const i of box.querySelectorAll('input')) i.value = values[i.dataset.key] || 0;
    updatePcts(box);
  }
  return box;
}
function updatePcts(box) {
  const inputs = [...box.querySelectorAll('input')];
  const sum = inputs.reduce((s, i) => s + Number(i.value), 0) || 1;
  for (const i of inputs) {
    const p = Math.round((Number(i.value) / sum) * 100);
    i.nextSibling.textContent = p + '%';
    i.style.setProperty('--fill', i.value + '%');
  }
}
function ensure(container, cls, build) {
  let node = container.querySelector(':scope > .' + cls);
  if (!node) { node = el('div', cls); build(node); container.appendChild(node); }
  return node;
}

/* ---------------------------------------------------------------- 국정 */
function renderPolicy(g, me) {
  const box = $('#tab-policy');
  const h1 = ensure(box, 'h-budget', (n) => { n.innerHTML = '<h4>예산 배분</h4><p class="hint">흑자(순수입)가 이 비율로 각 부처 금고에 쌓이고, 장관이 금고 안에서 집행합니다. 비축은 당신의 저축입니다 — 모아 두었다가 아래 <b>특별 집행</b>으로 필요한 부처에 한 번에 쏟아부을 수 있습니다.</p>'; });
  sliderGroup(box, 'budget', ['industry', 'research', 'military', 'finance', 'reserve'],
    { industry: '산업', research: '연구', military: '국방', finance: '금융', reserve: '비축' },
    { industry: '#f59e0b', research: '#a78bfa', military: '#f87171', finance: '#34d399', reserve: '#94a3b8' },
    me.budget, (v) => HG.emit('setBudget', v));
  const pots = ensure(box, 'pot-row', () => {});
  pots.innerHTML = '';
  const earmarked = me.pots.industry + me.pots.research + me.pots.military + me.pots.finance;
  const free = Math.max(0, Math.floor(me.cash - earmarked));
  const POT_LABEL = { industry: '산업', research: '연구', military: '국방', finance: '금융' };
  for (const k of Object.keys(POT_LABEL)) {
    const p = el('span', 'pot'); p.innerHTML = `${POT_LABEL[k]} 금고 <b>${fmt(me.pots[k])}</b>`;
    if (me.pots[k] >= 1) { const b = el('button', 'mini', '회수'); b.title = '아직 쓰지 않은 금고 돈을 비축으로 되돌립니다'; b.onclick = (e) => { e.stopPropagation(); HG.emit('recallPot', { pot: k }); }; p.appendChild(b); }
    pots.appendChild(p);
  }
  const r = el('span', 'pot'); r.innerHTML = `비축(가용) <b>${fmt(free)}</b>`; pots.appendChild(r);

  // ---- 특별 집행: 비축 → 부처 금고 일시 투입
  const sp = ensure(box, 'special', (n) => {
    n.className = 'special'; // 'box' 를 붙이면 아래 ensure(box,'box') 가 이 요소를 집어 덮어쓴다
    n.innerHTML = `<div class="title">특별 집행 <span class="sz">비축을 한 번에 투입</span></div>
      <div class="row" style="margin-bottom:6px"><span class="hint">금액</span><div class="chips" id="sp-amt"></div></div>
      <div class="chips" id="sp-pot"></div>
      <label class="row" style="margin-top:8px;gap:6px;cursor:pointer"><input type="checkbox" id="sp-auto" style="width:auto;margin:0"/> <span class="hint">비축이 순수입 60초분(최소 1,500)을 넘으면 예산 비율대로 자동 재배분</span></label>`;
    n._amtMode = 0.5;
  });
  const amts = sp.querySelector('#sp-amt');
  amts.innerHTML = '';
  for (const [lb, v] of [['25%', 0.25], ['50%', 0.5], ['100%', 1]]) {
    const b = el('button', 'chip' + (sp._amtMode === v ? ' active' : ''), lb);
    b.onclick = () => { sp._amtMode = v; renderPolicy(g, HG.myNation()); };
    amts.appendChild(b);
  }
  const amount = Math.floor(free * sp._amtMode);
  const potsRow = sp.querySelector('#sp-pot');
  potsRow.innerHTML = '';
  for (const k of Object.keys(POT_LABEL)) {
    const b = el('button', 'chip', `${POT_LABEL[k]}에 ${fmt(amount)} 투입`);
    b.disabled = amount < 1;
    b.onclick = () => HG.emit('allocate', { pot: k, amount });
    potsRow.appendChild(b);
  }
  const auto = sp.querySelector('#sp-auto');
  auto.checked = !!me.autoReserve;
  auto.onchange = () => HG.emit('setAutoReserve', { on: auto.checked });

  // ---- 자동 내각: 봇의 상황 대응을 내 국가에도
  const ac = ensure(box, 'autocab', (n) => {
    n.innerHTML = `<label class="row" style="gap:6px;cursor:pointer;margin:4px 0 10px"><input type="checkbox" id="ac-on" style="width:auto;margin:0"/> <span><b>자동 내각</b> <span class="hint">— 위협·국력·시간대에 따라 예산·교리·산업 비율을 6초마다 자동 조정합니다 (외교·투자 비중은 그대로). 켜 두면 슬라이더를 직접 만져도 곧 덮어씁니다.</span></span></label>`;
  });
  const acOn = ac.querySelector('#ac-on');
  acOn.checked = !!me.autoCabinet;
  acOn.onchange = () => HG.emit('setAutoCabinet', { on: acOn.checked });
  const bf = ensure(box, 'buffs', () => {});
  bf.innerHTML = '';
  const BUFF_NAME = { income: '세수', factory: '공장', resource: '자원', science: '연구', upkeep: '유지비', dividend: '배당', atk: '공격', def: '방어' };
  for (const b of me.buffs || []) { const good = (b.k === 'upkeep') ? b.v < 0 : b.v > 0; bf.appendChild(el('span', 'buff ' + (good ? 'up' : 'down'), `${b.n}: ${BUFF_NAME[b.k] || b.k} ${b.v > 0 ? '+' : ''}${b.v}% (${Math.max(0, b.u - g.t)}s)`)); }
  for (const a of (g.council && g.council.active) || []) bf.appendChild(el('span', 'buff', `🏛 ${a.name} (${Math.max(0, a.u - g.t)}s)`));
  const war = ensure(box, 'warbox', (n) => { n.className = 'warbox hint'; });
  war.innerHTML = `전쟁 피로도 <b>${me.weariness}</b> (세수 −${me.stats.weary}%) · 교역 보너스 <b>+${me.stats.trade}%</b> · 격멸 ${me.stats.kills} / 손실 ${me.stats.losses}`;
  const inc = ensure(box, 'box', (n) => {});
  inc.innerHTML = `<div class="kv">
    <span class="k">세수·영토</span><span class="v up">+${fmt1(me.stats.income)}/s</span>
    <span class="k">공장 판매</span><span class="v up">+${fmt1(me.stats.sales)}/s</span>
    <span class="k">배당</span><span class="v up">+${fmt1(me.stats.dividend)}/s</span>
    <span class="k">유지비(부대·건물·재료)</span><span class="v down">−${fmt1(me.stats.expense)}/s</span>
    <span class="k"><b>순수입</b></span><span class="v ${me.stats.net >= 0 ? 'up' : 'down'}"><b>${me.stats.net >= 0 ? '+' : ''}${fmt1(me.stats.net)}/s</b></span>
  </div>`;

  ensure(box, 'h-doc', (n) => { n.innerHTML = '<h4>군사 교리 (위임 비율)</h4><p class="hint">국방부가 새 부대와 기존 부대를 이 비율로 수비·확장(중립 도시 병합)·공격에 배치합니다.</p>'; });
  sliderGroup(box, 'doctrine', ['defend', 'expand', 'attack'],
    { defend: '수비', expand: '확장', attack: '공격' },
    { defend: '#60a5fa', expand: '#4ade80', attack: '#f87171' },
    me.doctrine, (v) => HG.emit('setDoctrine', v));
  const tgt = ensure(box, 'target-row', (n) => { n.innerHTML = '<div class="hint" style="margin:8px 0 4px">공격 대상 국가</div>'; });
  let chips = tgt.querySelector('.chips');
  if (!chips) { chips = el('div', 'chips'); tgt.appendChild(chips); }
  chips.innerHTML = '';
  const mk = (label, val, color, hostile) => {
    const b = el('button', 'chip' + (String(me.attackTarget) === String(val) ? ' active' : ''), label);
    if (color) b.style.borderColor = color;
    if (hostile === false) { b.disabled = true; b.title = '적대 관계가 아닙니다 (외교 탭)'; }
    b.onclick = () => HG.emit('setDoctrine', { ...me.doctrine, target: val });
    chips.appendChild(b);
  };
  mk('모든 적국', 'any');
  for (const n of g.nations) {
    if (n.idx === me.idx || !n.alive) continue;
    const r = g.dip && g.dip.rel[relKey(me.idx, n.idx)];
    mk(n.title, n.idx, n.color, !r || r.s === 'war');
  }
}

/* ---------------------------------------------------------------- 산업 */
function renderIndustry(g, me) {
  const box = $('#tab-industry');
  ensure(box, 'h-ind', (n) => { n.innerHTML = '<h4>산업 정책</h4><p class="hint">산업부가 산업 금고로 어떤 종류의 건물부터 지을지 정합니다. 자원 = 광산·시추소·농장, 기반 = 연구소·거래소, 국방 = 병영·벙커·방공포대.</p>'; });
  sliderGroup(box, 'industry', ['resource', 'factory', 'infra', 'defense'],
    { resource: '자원', factory: '공장', infra: '기반', defense: '국방시설' },
    { resource: '#d6a04c', factory: '#f59e0b', infra: '#a78bfa', defense: '#f87171' },
    me.industry, (v) => HG.emit('setIndustry', v));
  const mkt = ensure(box, 'box', () => {});
  const M = HG.C.MATERIALS;
  mkt.innerHTML = `<div class="title">자재 시장 <span class="sz">기준가 대비</span></div><div class="kv">${Object.keys(M).map((k) => {
    const p = g.market[k], d = (p / M[k].base - 1) * 100;
    return `<span class="k">${M[k].name}${me.mats[k] !== undefined ? ` <span class="muted">보유 ${me.mats[k]}</span>` : ''}</span><span class="v">${p.toFixed(2)} <span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d.toFixed(0)}%</span></span>`;
  }).join('')}</div>`;
  renderProjects(box, g, me);
  const list = ensure(box, 'city-list', () => {});
  list.innerHTML = '<h4>내 도시</h4>';
  const B = HG.C.BUILDINGS;
  for (const c of g.cities.filter((x) => x.o === me.idx)) {
    const d = el('div', 'box');
    const used = Object.values(c.b).reduce((a, b) => a + b, 0);
    d.innerHTML = `<div class="title">${c.id === me.capital ? '★ ' : ''}${c.name}<span class="sz">인구 ${c.pop} · 부지 ${used}/${c.slots} · 체력 ${c.hp}/${c.maxHp}</span></div>`;
    const bl = el('div', 'bld');
    for (const k of HG.C.BUILDING_ORDER) {
      if (!c.b[k]) continue;
      bl.appendChild(el('span', null, `${B[k].name} ${c.b[k]}`));
    }
    if (!used) bl.appendChild(el('span', 'empty', '건물 없음'));
    d.appendChild(bl);
    d.appendChild(el('div', 'hint', `자원 타일: 철광 ${c.res.iron} · 유전 ${c.res.oil} · 농지 ${c.res.farm}`));
    d.style.cursor = 'pointer';
    d.onclick = () => { HG.selected = { kind: 'city', id: c.id }; HG.camera.x = c.x; HG.camera.y = c.y; renderSelection(); };
    list.appendChild(d);
  }
}

// 국가 프로젝트 (불가사의): 세계에 하나뿐. 목표로 정하면 산업부가 산업 금고의 절반까지 매 주기 투입한다.
function renderProjects(box, g, me) {
  const wrap = ensure(box, 'projects', (n) => { n.innerHTML = '<h4>국가 프로젝트</h4><p class="hint">세계에 하나뿐인 대사업입니다. 목표로 정하면 산업부가 산업 금고의 절반까지 2초마다 투입합니다 — 특별 집행으로 산업 금고를 채우면 빨라집니다. 다른 나라가 먼저 완성하면 투입액의 절반만 돌려받습니다.</p>'; });
  let list = wrap.querySelector('.plist');
  if (!list) { list = el('div', 'plist'); wrap.appendChild(list); }
  list.innerHTML = '';
  const P = HG.C.PROJECTS, T = HG.C.TECHS;
  for (const id of HG.C.PROJECT_ORDER) {
    const def = P[id], st = (g.projects || {})[id] || { o: -1, d: 0, prog: {} };
    const d = el('div', 'box project' + (st.d ? ' done' : '') + (me.project === id ? ' mine' : ''));
    const mine = st.prog[me.idx] || 0;
    let bestOther = 0, bestIdx = -1;
    for (const [k, v] of Object.entries(st.prog)) if (Number(k) !== me.idx && v > bestOther) { bestOther = v; bestIdx = Number(k); }
    const owner = st.d ? HG.nationByIdx(st.o) : null;
    const need = def.req && !me.techs.includes(def.req) ? `「${T[def.req].name}」 필요` : '';
    d.innerHTML = `<div class="ic">${def.icon}</div><div class="nm">${def.name} <span class="muted" style="font-weight:400">${fmt(def.cost)}</span></div>`;
    const right = el('div');
    if (owner) right.innerHTML = `<span class="flag" style="background:${owner.color};color:${owner.color};width:10px;height:10px;display:inline-block;border-radius:3px;vertical-align:middle;margin-right:4px"></span>${owner.title} 완성`;
    else if (me.project === id) { const b = el('button', 'chip active', '추진 중 · 중단'); b.onclick = () => HG.emit('setProject', { project: null }); right.appendChild(b); }
    else { const b = el('button', 'chip', '목표로'); b.disabled = !!need || (def.coastal && !g.cities.some((c) => c.o === me.idx && c.cs)); b.title = need || (def.coastal ? '해안 도시 필요' : ''); b.onclick = () => HG.emit('setProject', { project: id }); right.appendChild(b); }
    d.appendChild(right);
    d.appendChild(el('div', 'ds', def.desc + (need && !owner ? ` · ${need}` : '')));
    if (!st.d && (mine > 0 || bestOther > 0)) {
      const pb = el('div', 'pb');
      pb.innerHTML = `<div class="hint">나 ${fmt(mine)} / ${fmt(def.cost)}${bestIdx >= 0 ? ` · 경쟁 ${HG.nationByIdx(bestIdx).title} ${Math.round((bestOther / def.cost) * 100)}%` : ''}</div><div class="bar"><i style="width:${Math.min(100, (mine / def.cost) * 100)}%;background:${me.color}"></i></div>`;
      if (bestIdx >= 0) { const b2 = el('div', 'bar'); b2.style.marginTop = '2px'; b2.innerHTML = `<i style="width:${Math.min(100, (bestOther / def.cost) * 100)}%;background:${HG.colorOf(bestIdx)}"></i>`; pb.appendChild(b2); }
      d.appendChild(pb);
    }
    list.appendChild(d);
  }
}

/* ---------------------------------------------------------------- 과학 */
let techBuilt = false;
function renderTech(g, me) {
  const box = $('#tab-tech');
  const T = HG.C.TECHS;
  const CW = 190, RH = 66;
  if (!techBuilt) {
    box.innerHTML = '<h4>기술 트리</h4><p class="hint">기술을 클릭하면 목표로 정하고, 과학부가 선행 기술부터 차례로 연구합니다. 다시 클릭하면 해제.</p>';
    const wrap = el('div', 'tech-wrap');
    const grid = el('div', 'tech-grid');
    grid.style.width = 4 * CW + 'px'; grid.style.height = 10 * RH + 20 + 'px';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const id of HG.C.TECH_ORDER) {
      const t = T[id];
      for (const r of t.req) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const a = T[r];
        const x1 = a.col * CW + 166, y1 = a.row * RH + 20 + 28, x2 = t.col * CW, y2 = t.row * RH + 20 + 28;
        p.setAttribute('d', `M${x1},${y1} C${x1 + 20},${y1} ${x2 - 20},${y2} ${x2},${y2}`);
        p.dataset.from = r; p.dataset.to = id;
        svg.appendChild(p);
      }
    }
    grid.appendChild(svg);
    ['1시대 · 산업', '2시대 · 정보화', '2시대 · 전자전', '3시대 · 첨단'].forEach((lb, i) => { const e = el('div', 'era-label', lb); e.style.left = i * CW + 'px'; grid.appendChild(e); });
    for (const id of HG.C.TECH_ORDER) {
      const t = T[id];
      const d = el('div', 'tech'); d.dataset.id = id;
      d.style.left = t.col * CW + 'px'; d.style.top = t.row * RH + 20 + 'px';
      d.innerHTML = `<b>${t.name}</b><span class="cost">🔬 ${t.cost}</span><span class="d">${t.desc}</span><i class="prog" style="width:0"></i>`;
      d.title = t.desc + (t.req.length ? ' / 선행: ' + t.req.map((r) => T[r].name).join(', ') : '');
      d.onclick = () => {
        const me2 = HG.myNation();
        if (!me2 || me2.techs.includes(id)) return;
        HG.emit('setResearch', { tech: me2.target === id ? null : id });
      };
      grid.appendChild(d);
    }
    wrap.appendChild(grid);
    box.appendChild(wrap);
    techBuilt = true;
  }
  const cur = ensure(box, 'cur', () => {});
  cur.className = 'cur box';
  const r = me.researching;
  cur.innerHTML = r
    ? `<div class="title">연구 중: ${T[r.id].name}<span class="sz">${r.p}% · 과학 ${fmt(me.sci)} (+${fmt1(me.stats.science)}/s)</span></div><div class="bar"><i style="width:${r.p}%"></i></div>${me.target ? `<div class="hint" style="margin-top:4px">목표: ${T[me.target].name}</div>` : ''}`
    : '<div class="hint">연구할 기술이 없습니다.</div>';
  box.insertBefore(cur, box.querySelector('.tech-wrap'));
  // 상태 갱신
  const owned = new Set(me.techs);
  const pathSet = new Set();
  if (me.target) { const visit = (id) => { if (owned.has(id) || pathSet.has(id)) return; for (const q of T[id].req) visit(q); pathSet.add(id); }; visit(me.target); }
  for (const d of box.querySelectorAll('.tech')) {
    const id = d.dataset.id, t = T[id];
    const avail = t.req.every((q) => owned.has(q));
    d.classList.toggle('owned', owned.has(id));
    d.classList.toggle('locked', !owned.has(id) && !avail && !pathSet.has(id));
    d.classList.toggle('researching', !!r && r.id === id);
    d.classList.toggle('target', me.target === id);
    d.classList.toggle('onpath', pathSet.has(id) && me.target !== id);
    d.querySelector('.prog').style.width = r && r.id === id ? r.p + '%' : '0';
  }
  for (const p of box.querySelectorAll('svg path')) {
    p.classList.toggle('owned', owned.has(p.dataset.from) && owned.has(p.dataset.to));
    p.classList.toggle('path', pathSet.has(p.dataset.to) && (owned.has(p.dataset.from) || pathSet.has(p.dataset.from)));
  }
}

/* ---------------------------------------------------------------- 금융 */
function renderFinance(g, me) {
  const box = $('#tab-finance');
  const ST = HG.C.STOCKS;
  ensure(box, 'h-fin', (n) => { n.innerHTML = '<h4>투자 포트폴리오</h4><p class="hint">재무부가 금융 금고를 이 비중으로 종목에 넣습니다. 방산은 전쟁 격화, 에너지는 원유값, 테크는 세계 연구량, 건설은 건설량을 따라 움직입니다.</p>'; });
  sliderGroup(box, 'portfolio', HG.C.STOCK_ORDER,
    Object.fromEntries(HG.C.STOCK_ORDER.map((k) => [k, ST[k].name.slice(0, 4)])),
    { defense: '#f87171', energy: '#fbbf24', tech: '#a78bfa', constr: '#fb923c', food: '#4ade80' },
    me.portfolio, (v) => HG.emit('setPortfolio', v));
  const act = ensure(box, 'row', (n) => {
    const b = el('button', null, ''); b.id = 'btn-liq'; b.onclick = () => HG.emit('setLiquidate', { on: !HG.myNation().liquidate }); n.appendChild(b);
    n.appendChild(el('span', 'hint', '전량 매도 후 다시 비중대로 매수합니다.'));
    n.style.margin = '8px 0';
  });
  act.querySelector('#btn-liq').textContent = me.liquidate ? '현금화 중… (취소)' : '전량 현금화';
  const tbl = ensure(box, 'tbl-wrap', (n) => { n.innerHTML = '<table class="tbl"><thead><tr><th>종목</th><th>주가</th><th>추세</th><th>보유</th><th>손익</th></tr></thead><tbody></tbody></table>'; });
  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';
  let total = 0;
  for (const k of HG.C.STOCK_ORDER) {
    const s = g.stocks[k];
    const h = Object.keys(s.h || {}).map(Number).sort((a, b) => a - b).map((i) => s.h[i]);
    const prev = h.length > 6 ? h[h.length - 7] : h[0] || s.p;
    const ch = (s.p / prev - 1) * 100;
    const qty = me.stocks[k], val = qty * s.p, cost = me.stockCost[k];
    total += val;
    const pl = qty > 0 ? (val / Math.max(1, cost) - 1) * 100 : 0;
    const tr = el('tr');
    tr.innerHTML = `<td>${ST[k].name}</td><td>${s.p.toFixed(2)} <span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'}${Math.abs(ch).toFixed(1)}%</span></td><td></td><td>${qty}주<br><span class="muted">${fmt(val)}</span></td><td class="${pl >= 0 ? 'up' : 'down'}">${qty ? (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%' : '-'}</td>`;
    const cv = document.createElement('canvas'); cv.className = 'spark'; cv.width = 140; cv.height = 48;
    drawSpark(cv, h, ch >= 0 ? '#4ade80' : '#f87171');
    tr.children[2].appendChild(cv);
    tb.appendChild(tr);
  }
  const sum = ensure(box, 'box', () => {});
  sum.innerHTML = `<div class="kv"><span class="k">주식 평가액</span><span class="v">${fmt(total)}</span><span class="k">배당 수입</span><span class="v up">+${fmt1(me.stats.dividend)}/s</span><span class="k">금융 금고</span><span class="v">${fmt(me.pots.finance)}</span></div>`;
}
function drawSpark(cv, h, color) {
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (!h || h.length < 2) return;
  const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
  c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round';
  c.beginPath();
  h.forEach((v, i) => { const x = (i / (h.length - 1)) * (cv.width - 4) + 2, y = cv.height - 4 - ((v - min) / span) * (cv.height - 8); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.stroke();
  c.globalAlpha = 0.15; c.lineTo(cv.width - 2, cv.height); c.lineTo(2, cv.height); c.closePath(); c.fillStyle = color; c.fill(); c.globalAlpha = 1;
}

/* ---------------------------------------------------------------- 군사 */
function renderArmy(g, me) {
  const box = $('#tab-army');
  const U = HG.C.UNITS;
  const head = ensure(box, 'h-army', () => {});
  const counts = Object.fromEntries(HG.C.UNIT_ORDER.map((t) => [t, 0]));
  const mine = Object.entries(g.units).filter(([, u]) => u.o === me.idx);
  for (const [, u] of mine) counts[u.t]++;
  // 위협 분석: 지금 내 도시를 치는 적 구성과, 국방부가 그에 맞춰 우선 편성할 병종
  let threatHtml = '<div class="hint" style="margin-top:6px">현재 내 도시를 위협하는 적이 없습니다.</div>';
  if (me.threat && me.threat.total > 0.3) {
    const s = me.threat.share;
    const parts = HG.C.UNIT_ORDER.filter((t) => s[t] > 0).sort((a, b) => s[b] - s[a]).map((t) => `${U[t].name.slice(0, 2)} ${s[t]}%`);
    const counters = [];
    if (s.air >= 30) counters.push('방공포대', '항공전대', me.techs.includes('manpads') ? '보병(휴대방공)' : '휴대 방공 연구');
    if (s.armor >= 30) counters.push('항공전대', me.techs.includes('atgm') ? '보병(대전차)' : '포병');
    if (s.inf >= 30) counters.push('기갑사단', '포병여단');
    if (s.navy >= 30) counters.push('항공전대', '구축함대');
    if (s.arty >= 30) counters.push('기갑사단', '항공전대');
    threatHtml = `<div class="box" style="margin-top:8px"><div class="title">⚠ 위협 분석<span class="sz">강도 ${me.threat.total.toFixed(1)}</span></div><div class="hint">${parts.join(' · ')}</div><div class="hint">대응 우선: ${[...new Set(counters)].join(', ') || '현 편성 유지'}</div><div class="hint">상성이 안 맞는 부대(예: 항공 상대의 기갑)는 수비에 보내지 않고, 반격 불가 시 방공망 도시로 물러납니다.</div></div>`;
  }
  head.innerHTML = `<h4>병력 ${mine.length} / ${HG.C.RULES.maxUnitsPerNation}</h4><div class="chips">${HG.C.UNIT_ORDER.map((t) => `<span class="chip" style="border-color:${U[t].tech && !me.techs.includes(U[t].tech) ? 'rgba(255,255,255,0.1)' : me.color}">${U[t].name} ${counts[t]} <span class="muted">T${me.tier[t]}${U[t].tech && !me.techs.includes(U[t].tech) ? ' 🔒' : ''}</span></span>`).join('')}</div>${threatHtml}<p class="hint" style="margin-top:6px">국방 금고 ${fmt(me.pots.military)} · 유지비 합계는 국정 탭 참고. 행을 클릭하면 지도에서 찾고, 선택한 뒤 우클릭(길게 누르기)으로 직접 명령할 수 있습니다.</p>`;
  const list = ensure(box, 'unit-list', () => {});
  list.innerHTML = '';
  const mLabel = { defend: '수비', expand: '확장', attack: '공격', manual: '직접' };
  mine.sort((a, b) => a[1].m.localeCompare(b[1].m) || b[1].s - a[1].s);
  for (const [id, u] of mine) {
    const row = el('div', 'unit-row' + (HG.selected && HG.selected.kind === 'unit' && HG.selected.id === id ? ' sel' : ''));
    const cv = document.createElement('canvas'); cv.width = 48; cv.height = 48;
    const c2 = cv.getContext('2d'); (ICONS[u.t] || ICONS.inf)(c2, 24, 24, 40, me.color);
    row.appendChild(cv);
    const mid = el('div'); mid.innerHTML = `<div>${U[u.t].name} <span class="muted small">T${me.tier[u.t]}</span></div><div class="sub">병력 ${u.s}% ${u.f ? '· <span class="down">교전 중</span>' : ''}</div>`;
    row.appendChild(mid);
    row.appendChild(el('span', 'mission ' + u.m, mLabel[u.m] || u.m));
    row.onclick = () => { HG.selected = { kind: 'unit', id }; HG.camera.x = u.x; HG.camera.y = u.y; renderSelection(); renderArmy(g, me); };
    list.appendChild(row);
  }
}

/* ---------------------------------------------------------------- 순위 */
function renderRank(g, me) {
  const box = $('#tab-rank');
  box.innerHTML = '<h4>국력 순위</h4>';
  const ns = g.nations.slice().sort((a, b) => (b.alive - a.alive) || b.stats.score - a.stats.score);
  const recon = me.techs.includes('recon');
  const tbl = el('table', 'tbl');
  tbl.innerHTML = '<thead><tr><th>#</th><th>국가</th><th>국력</th><th>도시</th><th>영토</th><th>부대</th><th>기술</th></tr></thead>';
  const tb = el('tbody');
  ns.forEach((n, i) => {
    const tr = el('tr');
    const r = n.idx !== me.idx && g.dip ? g.dip.rel[relKey(me.idx, n.idx)] : null;
    const relTag = r ? ` <span class="rel ${r.s}">${REL_NAME[r.s]}</span>` : '';
    // 정찰 위성이 있어야 타국 내부(예산·교리·공격 대상·피로도)를 볼 수 있다
    let intel = '';
    if (n.idx !== me.idx) {
      intel = recon
        ? `<br><span class="muted">예산 산${n.budget.industry}/연${n.budget.research}/국${n.budget.military}/금${n.budget.finance} · 교리 수${n.doctrine.defend}/확${n.doctrine.expand}/공${n.doctrine.attack} · 목표 ${n.attackTarget === 'any' ? '모든 적' : (HG.nationByIdx(n.attackTarget) || {}).title} · 피로 ${n.weariness}</span>`
        : `<br><span class="muted">🔒 내부 정보 — 정찰 위성 필요</span>`;
    }
    const A = HG.C.ACHIEVEMENTS;
    const achs = (n.ach || []).map((id) => { const a = A.find((x) => x.id === id); return a ? `<span class="ach" title="${a.name} — ${a.desc}">${a.icon}</span>` : ''; }).join('');
    const wonders = Object.values(g.projects || {}).filter((p) => p.d && p.o === n.idx).map((p) => `<span class="ach" title="${HG.C.PROJECTS[p.id].name}">${HG.C.PROJECTS[p.id].icon}</span>`).join('');
    const badges = achs || wonders ? `<div class="ach-row">${wonders}${achs}</div>` : '';
    tr.innerHTML = `<td>${i + 1}</td><td><span class="flag" style="background:${n.color};color:${n.color};width:10px;height:10px;margin-right:6px;vertical-align:middle"></span>${n.title}${relTag}<br><span class="muted">${n.name}${n.alive ? '' : ' (멸망)'}</span>${badges}${intel}</td><td>${fmt(n.stats.score)}</td><td>${n.stats.cities}</td><td>${n.stats.tiles}</td><td>${n.stats.units}</td><td>${n.techs.length}</td>`;
    if (n.id === me.id) tr.style.background = 'rgba(94,234,212,0.08)';
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  box.appendChild(tbl);
  box.appendChild(el('p', 'hint', { score: '승리: 제한 시간 종료 시 국력 1위', conquest: '승리: 최후의 생존 국가', economic: `승리: 국력 ${fmt(HG.C.RULES.economicVictory)} 선착 (또는 시간 종료 시 1위)` }[g.victory] || ''));
  // 내 업적 현황
  const ab = el('div', 'box');
  const mineSet = new Set(me.ach || []);
  ab.innerHTML = `<div class="title">업적 <span class="sz">${mineSet.size} / ${HG.C.ACHIEVEMENTS.length} · 1개당 위신 +${HG.C.RULES.achPrestige}</span></div>`;
  const row = el('div', 'ach-row'); row.style.fontSize = '18px';
  for (const a of HG.C.ACHIEVEMENTS) { const sp = el('span', 'ach' + (mineSet.has(a.id) ? '' : ' locked'), a.icon); sp.title = `${a.name} — ${a.desc}${a.first ? ' (세계 최초만)' : ''}`; row.appendChild(sp); }
  ab.appendChild(row);
  box.appendChild(ab);
  box.appendChild(el('p', 'hint', `국력 = 현금 + 주식 + 자재 + 건물 + 부대 + 영토. 수신 트래픽 ${(HG.traffic.bytes / 1024).toFixed(0)} KB (${((HG.traffic.bytes / 1024) / Math.max(1, (Date.now() - HG.traffic.since) / 1000)).toFixed(1)} KB/s, 압축 전)`));
}

/* ---------------------------------------------------------------- 기록/채팅 */
let lastLogKey = '';
function renderLog(g, me) {
  const S = HG.S;
  const list = $('#log-list');
  const items = [];
  for (const e of Object.values(S.log || {})) items.push({ t: e.t, text: e.text, n: e.n, kind: 'log', id: 'l' + e.id });
  for (const e of Object.values(S.chat || {})) items.push({ t: null, text: `${e.name}: ${e.text}`, kind: 'chat', id: 'c' + e.id, ts: e.t });
  const key = items.map((i) => i.id).join(',');
  if (key === lastLogKey) return;
  lastLogKey = key;
  const logs = items.filter((i) => i.kind === 'log').sort((a, b) => a.t - b.t).slice(-50);
  const chats = items.filter((i) => i.kind === 'chat').sort((a, b) => a.ts - b.ts).slice(-30);
  list.innerHTML = '';
  for (const i of [...chats, ...logs]) {
    const d = el('div', 'l' + (i.kind === 'chat' ? ' chat' : ''));
    if (i.kind === 'log') { d.appendChild(el('span', 't', mmss(i.t))); if (i.n >= 0) d.style.borderLeftColor = HG.colorOf(i.n); }
    d.appendChild(document.createTextNode(i.text));
    list.appendChild(d);
  }
  list.scrollTop = list.scrollHeight;
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  HG.emit('chat', { text });
  inp.value = '';
});

/* ---------------------------------------------------------------- 선택 카드 */
function renderSelection() {
  const S = HG.S, g = S && S.game;
  const box = $('#selection');
  const sel = HG.selected;
  if (!g || !sel) { box.classList.add('hidden'); return; }
  const me = HG.myNation();
  const T = HG.C.TERRAIN, U = HG.C.UNITS, B = HG.C.BUILDINGS;
  box.classList.remove('hidden');
  const close = `<button class="close" id="sel-close">✕</button>`;
  if (sel.kind === 'unit') {
    const u = g.units[sel.id];
    if (!u) { HG.selected = null; box.classList.add('hidden'); return; }
    const n = HG.nationByIdx(u.o);
    const mine = me && u.o === me.idx;
    const mLabel = { defend: '수비', expand: '확장', attack: '공격', manual: '직접 명령' };
    box.innerHTML = `<h3><span class="flag" style="background:${n.color};color:${n.color}"></span>${U[u.t].name} <span class="muted small">T${n.tier[u.t]}</span>${close}</h3>
      <div class="kv"><span class="k">소속</span><span class="v">${n.title}</span><span class="k">병력</span><span class="v">${u.s}%</span><span class="k">임무</span><span class="v">${mLabel[u.m] || u.m}${u.f ? ' · <span class="down">교전</span>' : ''}</span>
      <span class="k">공/방/사거리</span><span class="v">${U[u.t].atk}/${U[u.t].def}/${U[u.t].range + (u.t === 'arty' ? n.techs.filter((t) => t === 'rocket' || t === 'precision').length : u.t === 'navy' ? n.techs.filter((t) => t === 'missileship').length : 0)}</span><span class="k">유지비</span><span class="v">${U[u.t].upkeep}/s</span></div>`;
    if (mine) {
      const row = el('div', 'row'); row.style.marginTop = '8px';
      const b1 = el('button', 'primary', HG.ordering ? '지점을 클릭하세요…' : '직접 명령'); b1.onclick = () => HG.setOrdering(!HG.ordering); row.appendChild(b1);
      const b2 = el('button', null, '위임으로 복귀'); b2.onclick = () => HG.emit('releaseUnit', { unit: sel.id }); row.appendChild(b2);
      box.appendChild(row);
      box.appendChild(el('p', 'hint', '직접 명령 후 25초 동안 목표 없이 대기하면 다시 교리에 따라 위임됩니다.'));
    }
  } else if (sel.kind === 'city') {
    const c = g.cities.find((x) => x.id === sel.id);
    if (!c) { HG.selected = null; box.classList.add('hidden'); return; }
    const n = HG.nationByIdx(c.o);
    const used = Object.values(c.b).reduce((a, b) => a + b, 0);
    box.innerHTML = `<h3><span class="flag" style="background:${n ? n.color : '#999'};color:${n ? n.color : '#999'}"></span>${c.name} <span class="muted small">${['', '소도시', '도시', '대도시'][c.size]}${n && n.capital === c.id ? ' · 수도' : ''}</span>${close}</h3>
      <div class="kv"><span class="k">소속</span><span class="v">${n ? n.title : '중립'}</span><span class="k">인구</span><span class="v">${c.pop}</span><span class="k">체력</span><span class="v">${c.hp} / ${c.maxHp}</span><span class="k">부지</span><span class="v">${used} / ${c.slots}</span><span class="k">자원 타일</span><span class="v">철 ${c.res.iron} · 유 ${c.res.oil} · 농 ${c.res.farm}</span></div>
      <div class="bar" style="margin:6px 0"><i style="width:${(c.hp / c.maxHp) * 100}%;background:${c.hp / c.maxHp > 0.5 ? '#4ade80' : '#f87171'}"></i></div>`;
    const bl = el('div', 'bld');
    for (const k of HG.C.BUILDING_ORDER) if (c.b[k]) bl.appendChild(el('span', null, `${B[k].name} Lv${c.b[k]}`));
    if (!used) bl.appendChild(el('span', 'empty', '건물 없음'));
    box.appendChild(bl);
    if (c.cap) box.appendChild(el('p', 'hint', `⚠ ${HG.nationByIdx(c.cap.by).title}이(가) 점령 중 ${c.cap.p}%`));
    if (c.unrest > 0) box.appendChild(el('p', 'hint', `☢/✊ 저항·피폭 중 ${c.unrest}초 — 수입 0, 인구 감소. 아군 지상군이 주둔하면 2배 빨리 안정됩니다.`));
    if (me && c.o === me.idx) box.appendChild(el('p', 'hint', '건설은 산업부가 산업 정책 비율에 따라 자동으로 합니다.'));
    if (me && me.alive && c.o >= 0 && c.o !== me.idx && me.techs.includes('nuke')) {
      const r = g.dip && g.dip.rel[relKey(me.idx, c.o)];
      const ready = g.t >= (me.nukeReady || 0);
      const b = el('button', 'danger', ready ? `☢ 핵 타격 (${fmt(HG.C.RULES.nukeCost)})` : `☢ 대기 ${mmss(me.nukeReady - g.t)}`);
      b.disabled = !ready || !(r && r.s === 'war') || me.cash < HG.C.RULES.nukeCost;
      b.title = '도시 체력 0, 인구·건물 절반, 반경 2 적 부대 소멸, 150초 피폭. 모든 국가의 신뢰 −30, 피로도 상승.';
      b.onclick = () => { if (confirm(`${c.name}에 핵 타격을 가합니다. 세계 모든 국가의 신뢰가 30 떨어집니다. 진행할까요?`)) HG.emit('nuke', { city: c.id }); };
      box.appendChild(b);
    }
  } else {
    const t = g.map.tiles[sel.y * g.map.w + sel.x];
    const r = g.map.res[sel.y * g.map.w + sel.x];
    const o = g.terr[sel.y * g.map.w + sel.x];
    const n = HG.nationByIdx(o);
    box.innerHTML = `<h3>${T[t].name} <span class="muted small">(${sel.x}, ${sel.y})</span>${close}</h3><div class="kv"><span class="k">영토</span><span class="v">${n ? n.title : '미점유'}</span><span class="k">이동 비용</span><span class="v">${isFinite(T[t].moveCost) ? T[t].moveCost : '통행 불가'}</span><span class="k">방어 보정</span><span class="v">×${T[t].def}</span>${r ? `<span class="k">자원</span><span class="v">${HG.C.RESOURCES[r].name}</span>` : ''}</div>`;
  }
  $('#sel-close').onclick = () => { HG.selected = null; HG.setOrdering(false); renderSelection(); };
}
HG.renderSelection = renderSelection;

/* ---------------------------------------------------------------- 결과 */
function renderResult(S, g) {
  const ov = $('#result-overlay');
  if (!g.ended || resultDismissed) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  $('#result-reason').textContent = { time: '제한 시간 종료', conquest: '최후의 생존', economic: '경제 승리' }[g.endReason] || '';
  const ol = $('#result-list');
  ol.innerHTML = '';
  for (const r of g.ranking || []) {
    const li = el('li');
    const n = HG.nationByIdx(r.idx);
    const wonders = Object.values(g.projects || {}).filter((p) => p.d && p.o === r.idx).map((p) => HG.C.PROJECTS[p.id].icon).join('');
    li.innerHTML = `<span class="flag" style="background:${n.color};color:${n.color};width:10px;height:10px;margin-right:6px;vertical-align:middle"></span><b>${r.title}</b> <span class="muted">${r.name}</span> — 국력 ${fmt(r.score)} ${wonders}<br><span class="muted small">도시 ${r.cities} · 영토 ${r.tiles} · 기술 ${r.techs} · 업적 ${(n.ach || []).length} · 격멸 ${r.kills} / 손실 ${r.losses} · 점령 ${r.captures}${r.alive ? '' : ' · 멸망'}</span>`;
    ol.appendChild(li);
  }
  drawHistChart($('#result-chart'), g);
  $('#result-restart').classList.toggle('hidden', !HG.isHost());
  $('#result-hint').textContent = HG.isHost() ? '다시 하기를 누르면 대기실로 돌아갑니다.' : '방장이 다시 시작하기를 기다리는 중…';
}
// 국력 추이 그래프 (종료 시 서버가 hist 를 보낸다)
function drawHistChart(cv, g) {
  if (!cv || !g.hist || !g.hist.t.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 400, H = 160;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const T = g.hist.t, S = g.hist.s;
  let max = 1; for (const row of S) for (const v of row) max = Math.max(max, v);
  const x = (i) => 36 + (i / Math.max(1, T.length - 1)) * (W - 46), y = (v) => H - 20 - (v / max) * (H - 30);
  c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 1; c.font = '10px ' + getComputedStyle(document.body).fontFamily; c.fillStyle = '#8d9bb5'; c.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; c.beginPath(); c.moveTo(36, y(v)); c.lineTo(W - 10, y(v)); c.stroke(); c.fillText(fmt(v), 32, y(v) + 3); }
  c.textAlign = 'center'; for (let k = 0; k <= 4; k++) { const i = Math.round(((T.length - 1) * k) / 4); c.fillText(mmss(T[i]), x(i), H - 6); }
  g.nations.forEach((n, ni) => {
    c.strokeStyle = n.color; c.lineWidth = 2; c.beginPath();
    let started = false;
    S.forEach((row, i) => { const v = row[ni]; if (!v) return; if (!started) { c.moveTo(x(i), y(v)); started = true; } else c.lineTo(x(i), y(v)); });
    c.stroke();
  });
}
$('#result-restart').onclick = () => HG.emit('restart');
$('#result-close').onclick = () => { resultDismissed = true; $('#result-overlay').classList.add('hidden'); };

// 음성 미터 등 1초 미만 갱신이 필요한 것들
setInterval(() => { if (HG.S && HG.S.phase !== 'lobby' && HG.joined) HG.renderVoice(); }, 400);
// 카메라 위치 저장 (재접속·새로고침 시 복원)
setInterval(() => {
  if (!HG.S || HG.S.phase === 'lobby' || !HG.S.game || !HG.cameraReady) return;
  try { localStorage.setItem('hg:cam:' + HG.S.roomId, JSON.stringify({ x: HG.camera.x, y: HG.camera.y, zoom: HG.camera.zoom, t: HG.S.game.t })); } catch (e) {}
}, 3000);
HG.restoreCamera = (roomId, gameT) => {
  try {
    const c = JSON.parse(localStorage.getItem('hg:cam:' + roomId) || 'null');
    if (!c || gameT < c.t - 5) return false; // 새 판이면 무시
    HG.camera.x = c.x; HG.camera.y = c.y; HG.camera.zoom = c.zoom;
    return true;
  } catch (e) { return false; }
};
})();
