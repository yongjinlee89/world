'use strict';

/**
 * 결단 — 국가마다 때때로 찾아오는 선택형 사건.
 *  지도자는 제한 시간 안에 선택지 하나를 고른다 (넘기면 기본 선택). 봇은 성향대로 즉시 고른다.
 *  효과는 현금·금고·피로도·신뢰·과학·한시적 배수(buff) 로 나타난다. 전쟁을 부추기는 선택은 늘 대가가 따른다.
 */

const { RULES, STOCK_ORDER } = require('./data');
const Dip = require('./diplomacy');

// 한시적 국가 배수: game.buff(n, key) 가 합을 돌려준다
function addBuff(game, n, k, v, dur, name) {
  n.buffs.push({ k, v, until: game.time + dur, name });
}
function trustAll(game, n, d) {
  for (const o of game.nations) if (o.idx !== n.idx) Dip.bump(game, n.idx, o.idx, d);
}
function freeCash(n) {
  return n.cash - (n.pots.industry + n.pots.research + n.pots.military + n.pots.finance);
}
function myCities(game, n) {
  return game.cities.filter((c) => c.owner === n.idx);
}
function strongestEnemy(game, n) {
  let best = null;
  for (const o of game.nations) if (o.alive && o.idx !== n.idx && Dip.isHostile(game, n.idx, o.idx) && (!best || o.stats.score > best.stats.score)) best = o;
  return best;
}
function randomOther(game, n) {
  const others = game.nations.filter((o) => o.alive && o.idx !== n.idx);
  return others.length ? others[Math.floor(Math.random() * others.length)] : null;
}

// bot: 성향 이름 → 가중치. 가중치가 큰 선택지를 고른다 (조금 무작위).
const POOL = [
  {
    id: 'strike', name: '총파업', when: (g, n) => g.time > 120 && n.cash > 400 && myCities(g, n).some((c) => c.b.factory > 0),
    text: () => '전국 공장 노동조합이 임금 인상을 요구하며 파업에 들어갔습니다. 생산 라인이 멈춰 있습니다.',
    options: [
      { label: '임금 인상 수용', desc: '현금 −12%, 인구 성장 +(공장 +10% 120초)', bot: { 산업형: 3, 금융형: 1, 기술형: 2, 군국형: 1 },
        apply: (g, n) => { n.cash -= Math.max(150, n.cash * 0.12); addBuff(g, n, 'factory', 0.10, 120, '노사 화합'); } },
      { label: '강경 진압', desc: '피로도 +10, 모든 국가 신뢰 −3', bot: { 군국형: 3, 산업형: 1, 금융형: 1, 기술형: 0 },
        apply: (g, n) => { n.weariness = Math.min(100, n.weariness + 10); trustAll(g, n, -3); } },
      { label: '버티기', desc: '공장 −30% 90초', bot: { 금융형: 2, 기술형: 1, 산업형: 0, 군국형: 1 }, def: true,
        apply: (g, n) => addBuff(g, n, 'factory', -0.30, 90, '파업') },
    ],
  },
  {
    id: 'olympics', name: '올림픽 유치 제안', when: (g, n) => g.time > 300 && freeCash(n) >= 1500,
    text: () => '국제 올림픽 위원회가 우리 수도를 차기 개최지 후보로 지목했습니다. 유치 비용은 1,500 입니다.',
    options: [
      { label: '유치한다', desc: '비축 −1,500 · 모든 국가 신뢰 +8 · 세수 +12% 180초', bot: { 산업형: 2, 금융형: 3, 기술형: 2, 군국형: 1 },
        apply: (g, n) => { n.cash -= 1500; trustAll(g, n, 8); addBuff(g, n, 'income', 0.12, 180, '올림픽 특수'); } },
      { label: '거절한다', desc: '변화 없음', bot: { 군국형: 2, 산업형: 1, 금융형: 1, 기술형: 1 }, def: true, apply: () => {} },
    ],
  },
  {
    id: 'investor', name: '해외 투자 유치', when: (g, n) => g.time > 90,
    text: () => '다국적 기업이 우리 산업에 대규모 투자를 제안했습니다. 대신 2분간 이익의 일부를 가져갑니다.',
    options: [
      { label: '수락', desc: '산업 금고 +700 · 공장 −15% 120초', bot: { 산업형: 3, 금융형: 2, 기술형: 2, 군국형: 2 }, def: true,
        apply: (g, n) => { n.cash += 700; n.pots.industry += 700; addBuff(g, n, 'factory', -0.15, 120, '이익 배분'); } },
      { label: '거절', desc: '변화 없음', bot: { 산업형: 1, 금융형: 1, 기술형: 1, 군국형: 1 }, apply: () => {} },
    ],
  },
  {
    id: 'defector', name: '과학자 망명', when: (g, n) => g.time > 150 && !!randomOther(g, n),
    ctx: (g, n) => ({ from: randomOther(g, n).idx }),
    text: (g, n, c) => `${g.nations[c.from].title}의 수석 연구원이 우리나라로 망명을 요청했습니다. 받아 주면 그 나라와의 관계가 나빠집니다.`,
    options: [
      { label: '받아들인다', desc: '과학 +220 · 해당 국가 신뢰 −10', bot: { 기술형: 3, 산업형: 2, 금융형: 1, 군국형: 2 }, def: true,
        apply: (g, n, c) => { n.science += 220; Dip.bump(g, n.idx, c.from, -10); } },
      { label: '송환한다', desc: '해당 국가 신뢰 +8', bot: { 금융형: 2, 산업형: 1, 기술형: 0, 군국형: 1 },
        apply: (g, n, c) => Dip.bump(g, n.idx, c.from, 8) },
    ],
  },
  {
    id: 'oilspill', name: '유전 사고', when: (g, n) => myCities(g, n).some((c) => c.b.oilwell > 0),
    text: () => '시추소에서 대형 원유 유출 사고가 났습니다. 해안과 농지가 오염되고 있습니다.',
    options: [
      { label: '즉시 정화', desc: '현금 −400', bot: { 산업형: 2, 금융형: 1, 기술형: 3, 군국형: 1 }, def: true,
        apply: (g, n) => { n.cash -= 400; } },
      { label: '방치', desc: '자원 생산 −25% 120초 · 모든 국가 신뢰 −3', bot: { 군국형: 2, 금융형: 2, 산업형: 1, 기술형: 0 },
        apply: (g, n) => { addBuff(g, n, 'resource', -0.25, 120, '오염'); trustAll(g, n, -3); } },
    ],
  },
  {
    id: 'generals', name: '군부의 불만', when: (g, n) => n.budget.military < 18 && (n.stats.units || 0) >= 4,
    text: () => '장성들이 국방 예산 삭감에 항의하며 사임을 시사했습니다. 군의 사기가 흔들립니다.',
    options: [
      { label: '국방 금고 특별 편성', desc: '비축 → 국방 금고 500 (부족하면 있는 만큼)', bot: { 군국형: 3, 산업형: 1, 금융형: 1, 기술형: 1 },
        apply: (g, n) => { const a = Math.max(0, Math.min(500, Math.floor(freeCash(n)))); n.pots.military += a; } },
      { label: '장성 교체', desc: '전군 방어 −10% 120초 · 피로도 −8', bot: { 산업형: 2, 금융형: 2, 기술형: 2, 군국형: 0 }, def: true,
        apply: (g, n) => { addBuff(g, n, 'def', -0.10, 120, '지휘부 교체'); n.weariness = Math.max(0, n.weariness - 8); } },
    ],
  },
  {
    id: 'antiwar', name: '반전 시위', when: (g, n) => n.weariness >= 30 && !!strongestEnemy(g, n),
    ctx: (g, n) => ({ enemy: strongestEnemy(g, n).idx }),
    text: (g, n, c) => `수십만 시민이 ${g.nations[c.enemy].title}과의 전쟁을 끝내라며 거리로 나왔습니다.`,
    options: [
      { label: '휴전 모색', desc: '해당 국가에 불가침 제안 · 피로도 −15', bot: { 산업형: 3, 금융형: 3, 기술형: 3, 군국형: 1 }, def: true,
        apply: (g, n, c) => { n.weariness = Math.max(0, n.weariness - 15); if (Dip.canPropose(g, n.idx, c.enemy, 'peace')) Dip.propose(g, n.idx, c.enemy, 'peace'); } },
      { label: '전쟁 강행', desc: '전군 공격 +10% 120초 · 피로도 +12', bot: { 군국형: 3, 산업형: 0, 금융형: 0, 기술형: 0 },
        apply: (g, n) => { addBuff(g, n, 'atk', 0.10, 120, '총력전'); n.weariness = Math.min(100, n.weariness + 12); } },
    ],
  },
  {
    id: 'quake', name: '대지진', when: (g, n) => myCities(g, n).length >= 2,
    ctx: (g, n) => { const cs = myCities(g, n); return { city: cs[Math.floor(Math.random() * cs.length)].id }; },
    text: (g, n, c) => `${g.cityById.get(c.city).name} 일대에 강진이 발생했습니다. 건물이 무너지고 통신이 끊겼습니다.`,
    options: [
      { label: '긴급 복구', desc: '현금 −450 · 도시 체력 회복', bot: { 산업형: 3, 금융형: 2, 기술형: 2, 군국형: 2 }, def: true,
        apply: (g, n, c) => { n.cash -= 450; const city = g.cityById.get(c.city); if (city) city.hp = city.maxHp; } },
      { label: '자력 복구에 맡김', desc: '도시 건물 1단계 손실 · 인구 −15%', bot: { 군국형: 1, 금융형: 1, 산업형: 0, 기술형: 1 },
        apply: (g, n, c) => { const city = g.cityById.get(c.city); if (!city) return; const ks = Object.keys(city.b).filter((k) => city.b[k] > 0); if (ks.length) city.b[ks[Math.floor(Math.random() * ks.length)]]--; city.pop = Math.round(city.pop * 0.85); city.maxHp = g.cityMaxHp(city); city.hp = Math.min(city.hp, city.maxHp); } },
    ],
  },
  {
    id: 'border', name: '국경 분쟁', when: (g, n) => g.time > 200 && !!strongestEnemy(g, n),
    ctx: (g, n) => ({ enemy: strongestEnemy(g, n).idx }),
    text: (g, n, c) => `${g.nations[c.enemy].title} 국경 수비대와 우리 순찰대가 충돌했습니다. 양측 모두 상대의 도발이라 주장합니다.`,
    options: [
      { label: '협상 테이블로', desc: '해당 국가 신뢰 +8', bot: { 산업형: 3, 금융형: 3, 기술형: 2, 군국형: 1 }, def: true,
        apply: (g, n, c) => Dip.bump(g, n.idx, c.enemy, 8) },
      { label: '무력 시위', desc: '전군 방어 +10% 90초 · 해당 국가 신뢰 −10 · 피로도 +4', bot: { 군국형: 3, 산업형: 0, 금융형: 0, 기술형: 1 },
        apply: (g, n, c) => { addBuff(g, n, 'def', 0.10, 90, '전군 경계'); Dip.bump(g, n.idx, c.enemy, -10); n.weariness = Math.min(100, n.weariness + 4); } },
    ],
  },
  {
    id: 'expo', name: '기술 박람회', when: (g, n) => myCities(g, n).reduce((s, c) => s + c.b.lab, 0) >= 2 && freeCash(n) >= 600,
    text: () => '연구소 연합이 국제 기술 박람회를 열자고 제안합니다. 비용은 600 입니다.',
    options: [
      { label: '개최', desc: '비축 −600 · 과학 +250 · 연구 +30% 120초', bot: { 기술형: 3, 산업형: 2, 금융형: 1, 군국형: 1 },
        apply: (g, n) => { n.cash -= 600; n.science += 250; addBuff(g, n, 'science', 0.30, 120, '박람회'); } },
      { label: '생략', desc: '변화 없음', bot: { 금융형: 2, 군국형: 2, 산업형: 1, 기술형: 0 }, def: true, apply: () => {} },
    ],
  },
  {
    id: 'tax', name: '조세 개혁안', when: (g, n) => g.time > 240,
    text: () => '재무부가 조세 개혁안 두 가지를 올렸습니다. 어느 쪽이든 2분 반 동안 효과가 지속됩니다.',
    options: [
      { label: '감세', desc: '세수 −10% 150초 · 피로도 −12', bot: { 산업형: 2, 금융형: 2, 기술형: 2, 군국형: 1 }, def: true,
        apply: (g, n) => { addBuff(g, n, 'income', -0.10, 150, '감세'); n.weariness = Math.max(0, n.weariness - 12); } },
      { label: '증세', desc: '세수 +18% 150초 · 피로도 +10', bot: { 군국형: 2, 금융형: 2, 산업형: 1, 기술형: 1 },
        apply: (g, n) => { addBuff(g, n, 'income', 0.18, 150, '증세'); n.weariness = Math.min(100, n.weariness + 10); } },
    ],
  },
  {
    id: 'smuggling', name: '밀수 조직 적발', when: (g, n) => g.time > 150,
    text: () => '세관이 대규모 무기·자재 밀수 조직을 적발했습니다. 압수품을 어떻게 할지 결정해야 합니다.',
    options: [
      { label: '압수품 매각', desc: '현금 +350', bot: { 금융형: 3, 산업형: 2, 군국형: 2, 기술형: 1 }, def: true, apply: (g, n) => { n.cash += 350; } },
      { label: '자재로 편입', desc: '철강 +40 · 원유 +25', bot: { 산업형: 3, 군국형: 2, 금융형: 0, 기술형: 1 }, apply: (g, n) => { n.mats.iron += 40; n.mats.oil += 25; } },
      { label: '국제 공조 수사', desc: '모든 국가 신뢰 +4', bot: { 기술형: 2, 금융형: 1, 산업형: 1, 군국형: 0 }, apply: (g, n) => trustAll(g, n, 4) },
    ],
  },
  {
    id: 'bubble', name: '증시 과열 경고', when: (g, n) => STOCK_ORDER.some((k) => n.stocks[k] > 0) && g.time > 200,
    text: () => '중앙은행이 자산 거품을 경고했습니다. 보유 주식을 어떻게 할지 재무부가 지시를 기다립니다.',
    options: [
      { label: '지금 전량 매도', desc: '보유 주식 현금화 (수수료 없음)', bot: { 금융형: 1, 산업형: 2, 기술형: 2, 군국형: 2 },
        apply: (g, n) => { for (const k of STOCK_ORDER) { n.cash += n.stocks[k] * g.stocks[k].price; n.stocks[k] = 0; n.stockCost[k] = 0; } } },
      { label: '계속 보유', desc: '배당 +40% 120초 (거품이 꺼지면 손실)', bot: { 금융형: 3, 산업형: 1, 기술형: 1, 군국형: 1 }, def: true,
        apply: (g, n) => { addBuff(g, n, 'dividend', 0.40, 120, '고배당'); if (Math.random() < 0.35) { for (const k of STOCK_ORDER) g.stocks[k].price *= 0.9; g.pushLog('증시 거품이 꺼졌습니다 — 모든 종목 −10%'); } } },
    ],
  },
];

function pick(game, n) {
  const cands = POOL.filter((d) => d.id !== n._lastDecision && d.when(game, n));
  if (!cands.length) return null;
  return cands[Math.floor(Math.random() * cands.length)];
}

function open(game, n, d) {
  const ctx = d.ctx ? d.ctx(game, n) : {};
  n._lastDecision = d.id;
  const text = d.text(game, n, ctx);
  if (n.isBot || n.autoCabinet) { choose(game, n, d, ctx, botChoice(n, d)); return; }
  n.decision = { id: d.id, name: d.name, text, ctx, left: RULES.decisionSeconds, options: d.options.map((o) => ({ label: o.label, desc: o.desc })) };
  game.pushLog(`결단: ${d.name} — ${RULES.decisionSeconds}초 안에 선택하세요`, n.idx);
}

function botChoice(n, d) {
  const P = n.personality || '산업형';
  let best = 0, bestW = -1;
  d.options.forEach((o, i) => { const w = ((o.bot && o.bot[P]) || 1) + Math.random() * 0.9; if (w > bestW) { bestW = w; best = i; } });
  return best;
}

function choose(game, n, d, ctx, i) {
  const o = d.options[i] || d.options.find((x) => x.def) || d.options[0];
  o.apply(game, n, ctx);
  n.decision = null;
  if (!n.isBot) game.pushLog(`결단 「${d.name}」: ${o.label} — ${o.desc}`, n.idx);
}

function tick(game, dt) {
  for (const n of game.nations) {
    if (!n.alive) continue;
    if (n.decision) {
      n.decision.left -= dt;
      if (n.decision.left <= 0) {
        const d = POOL.find((x) => x.id === n.decision.id);
        const di = d.options.findIndex((o) => o.def);
        choose(game, n, d, n.decision.ctx, di >= 0 ? di : 0);
      }
      continue;
    }
    n._decisionClock = (n._decisionClock === undefined ? 60 + Math.random() * 60 : n._decisionClock) - dt;
    if (n._decisionClock > 0) continue;
    n._decisionClock = RULES.decisionEvery * (0.7 + Math.random() * 0.6);
    const d = pick(game, n);
    if (d) open(game, n, d);
  }
}

// 사람의 선택
function decide(game, pid, optionIdx) {
  const n = game.nation(pid);
  if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
  if (!n.decision) return { ok: false, error: '결정할 사건이 없습니다.' };
  const d = POOL.find((x) => x.id === n.decision.id);
  const i = Number(optionIdx);
  if (!(i >= 0 && i < d.options.length)) return { ok: false, error: '잘못된 선택입니다.' };
  choose(game, n, d, n.decision.ctx, i);
  return { ok: true };
}

module.exports = { POOL, tick, decide, open, addBuff, trustAll, freeCash };
