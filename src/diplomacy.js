'use strict';

/**
 * 외교 — 국가 쌍마다 관계(적대 war / 불가침 peace / 동맹 ally)와 신뢰(0~100)를 둔다.
 *
 *  - 기본은 적대. 불가침 조약은 PEACE_SECONDS 뒤 만료되어 적대로 돌아가고, 동맹은 깨기 전까지 유지된다.
 *  - 적대가 아닌 나라끼리는 교전·점령·영토 칠하기가 일어나지 않는다. 동맹은 서로의 도시를 함께 지킨다.
 *  - 조공(현금)으로 신뢰를 올리고, 조약을 깨면 신뢰가 크게 떨어지며 제3국의 신뢰도 함께 깎인다.
 *  - 봇에게 한 제안은 즉시 점수로 판정된다. 사람에게 한 제안은 offers 에 쌓여 수락/거절을 기다린다 (OFFER_SECONDS 뒤 만료).
 */

const PEACE_SECONDS = 240;
const OFFER_SECONDS = 60;
const COOLDOWN_SECONDS = 45;
const TRUST_START = 30;
const TRUST_ALLY_MIN = 50;
const TRUST_PEACE_MIN = 20;

const REL_NAME = { war: '적대', peace: '불가침', ally: '동맹' };

function key(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function install(game) {
  game.rel = {};
  game.offers = [];
  game._offerSeq = 0;
  game._dipCooldown = {}; // key|kind → 재제안 가능 시각
  for (let i = 0; i < game.nations.length; i++) {
    for (let j = i + 1; j < game.nations.length; j++) game.rel[key(i, j)] = { s: 'war', trust: TRUST_START, until: 0 };
  }
}

function relOf(game, a, b) {
  return game.rel[key(a, b)] || null;
}
function stateOf(game, a, b) {
  if (a === b) return 'self';
  const r = relOf(game, a, b);
  return r ? r.s : 'war';
}
function isHostile(game, a, b) {
  if (a < 0 || b < 0) return true; // 중립 도시는 모두에게 열려 있다
  if (a === b) return false;
  return stateOf(game, a, b) === 'war';
}
function isAllied(game, a, b) {
  return a >= 0 && b >= 0 && a !== b && stateOf(game, a, b) === 'ally';
}
function bump(game, a, b, d) {
  const r = relOf(game, a, b);
  if (r) r.trust = Math.max(0, Math.min(100, r.trust + d));
}

/* ------------------------------------------------------------------ 관계 변경 */

function setRelation(game, a, b, s) {
  const r = relOf(game, a, b);
  if (!r) return;
  r.s = s;
  r.until = s === 'peace' ? Math.round(game.time + PEACE_SECONDS) : 0;
  const A = game.nations[a], B = game.nations[b];
  // 관계가 바뀌면 양쪽 부대 임무를 즉시 재검토한다
  for (const u of game.units.values()) if ((u.owner === a || u.owner === b) && u.mission !== 'manual') u.nextThink = 0;
  if (s !== 'war') { dropTarget(A, b); dropTarget(B, a); }
}

// 조약을 맺은 나라는 공격 대상에서 뺀다. 고른 나라 목록이면 그 나라만 빠지고(남은 게 없으면 공격 안 함),
// 봇의 단일 대상이면 '모든 적국'으로 돌아간다. 사람의 '공격 안 함'이 '모든 적국'으로 바뀌는 일은 없다.
function dropTarget(N, idx) {
  const t = N.attackTarget;
  if (Array.isArray(t)) { const l = t.filter((i) => i !== idx); N.attackTarget = l.length ? l : 'none'; }
  else if (t === idx) N.attackTarget = 'any';
}

// 조약 파기 → 적대. 신뢰 −40, 제3국의 신뢰 −10, 파기한 쪽 전군 사기(병력) −3
function declareWar(game, a, b) {
  const r = relOf(game, a, b);
  if (!r || r.s === 'war') return { ok: false, error: '이미 적대 관계입니다.' };
  const was = r.s;
  setRelation(game, a, b, 'war');
  r.trust = Math.max(0, r.trust - (was === 'ally' ? 45 : 35));
  for (const n of game.nations) if (n.idx !== a && n.idx !== b) bump(game, a, n.idx, was === 'ally' ? -15 : -10);
  for (const u of game.units.values()) if (u.owner === a) u.strength = Math.max(1, u.strength - 3);
  game.pushLog(`${game.nations[a].title}이(가) ${game.nations[b].title}과의 ${REL_NAME[was]}을(를) 파기하고 적대를 선언했습니다!`, a);
  return { ok: true };
}

function sendTribute(game, a, b, amount) {
  const A = game.nations[a], B = game.nations[b];
  amount = Math.round(Number(amount));
  if (!(amount >= 100)) return { ok: false, error: '조공은 100 이상이어야 합니다.' };
  if (A.cash < amount) return { ok: false, error: '현금이 부족합니다.' };
  A.cash -= amount;
  B.cash += amount;
  // 받는 쪽 국력 대비 의미 있는 금액일수록 신뢰가 많이 오른다 (최대 +25)
  const gain = Math.min(25, Math.round((amount / Math.max(500, B.stats.score * 0.02)) * 10));
  bump(game, a, b, gain);
  game.pushLog(`${A.title}이(가) ${B.title}에 ${amount}을 조공했습니다 (신뢰 +${gain}).`, a);
  return { ok: true, gain };
}

/* ------------------------------------------------------------------ 제안 */

function canPropose(game, a, b, kind) {
  if (a === b) return '자기 자신에게는 제안할 수 없습니다.';
  const A = game.nations[a], B = game.nations[b];
  if (!A || !B || !A.alive || !B.alive) return '상대 국가가 없습니다.';
  const s = stateOf(game, a, b);
  if (kind === 'peace' && s !== 'war') return '이미 적대 관계가 아닙니다.';
  if (kind === 'ally' && s === 'ally') return '이미 동맹입니다.';
  if (kind === 'ally' && s === 'war') return '동맹은 불가침 상태에서만 제안할 수 있습니다.';
  const cd = game._dipCooldown[key(a, b) + '|' + kind + '|' + a];
  if (cd && game.time < cd) return `잠시 뒤(${Math.ceil(cd - game.time)}초) 다시 제안할 수 있습니다.`;
  if (game.offers.some((o) => o.from === a && o.to === b && o.kind === kind)) return '이미 같은 제안이 대기 중입니다.';
  return null;
}

// 봇의 수락 판정 점수 (50 이상이면 수락)
function botScore(game, me, other, kind) {
  const M = game.nations[me], O = game.nations[other];
  const r = relOf(game, me, other);
  const ratio = (O.stats.score || 1) / Math.max(1, M.stats.score || 1); // 상대가 얼마나 센가
  let score = r.trust * 0.6;
  if (ratio > 1.4) score += 25; else if (ratio > 1.1) score += 12; else if (ratio < 0.6) score -= 15; else if (ratio < 0.85) score -= 5;
  // 다른 적이 많을수록 화친이 반갑다. 멀리 있는 나라와는 싸울 일이 없으니 쉽게 맺는다.
  let enemies = 0, threat = 0;
  for (const n of game.nations) if (n.alive && n.idx !== me && n.idx !== other && isHostile(game, me, n.idx)) enemies++;
  for (const c of game.cities) if (c.owner === me) threat = Math.max(threat, game.threatOf(c, me));
  score += enemies * 10 + Math.min(20, threat * 8);
  // 전쟁에 지친 나라는 화친을 반긴다
  score += (M.weariness || 0) * 0.4;
  const capM = game.cityById.get(M.capitalId), capO = game.cityById.get(O.capitalId);
  if (capM && capO) { const dist = Math.hypot(capM.x - capO.x, capM.y - capO.y); if (dist > (game.W + game.H) * 0.35) score += 12; }
  // 상대가 내 도시를 위협하고 있으면 오히려 거절 (항복처럼 보이는 화친은 안 한다)… 단 약하면 받아들인다
  if (threat > 1 && ratio < 1) score -= 15;
  // 성향
  const P = M.personality || '';
  if (P === '군국형') score -= 12; else if (P === '산업형' || P === '금융형') score += 8;
  // 난이도: 쉬울수록 사람의 화친 제안을 잘 받아 준다
  if (!O.isBot && game.ai) score += game.ai.peace;
  if (kind === 'ally') {
    score -= 15;
    if (r.trust < TRUST_ALLY_MIN) return 0;
    // 공동의 적이 있으면 동맹 가치가 크다
    let common = 0;
    for (const n of game.nations) if (n.alive && n.idx !== me && n.idx !== other && isHostile(game, me, n.idx) && isHostile(game, other, n.idx)) common++;
    score += common * 15;
  } else if (r.trust < TRUST_PEACE_MIN) score -= 20;
  // 같은 상대와 조약을 거듭할수록 깎여서 영구 평화로 굳지 않는다
  score -= (r.count || 0) * 6;
  return score;
}

function propose(game, a, b, kind) {
  const err = canPropose(game, a, b, kind);
  if (err) return { ok: false, error: err };
  const A = game.nations[a], B = game.nations[b];
  if (B.isBot) {
    const score = botScore(game, b, a, kind);
    if (score >= 45) { accept(game, a, b, kind); return { ok: true, accepted: true }; }
    game._dipCooldown[key(a, b) + '|' + kind + '|' + a] = game.time + COOLDOWN_SECONDS;
    bump(game, a, b, 2); // 손을 내민 것 자체는 작은 호감
    game.pushLog(`${B.title}이(가) ${A.title}의 ${REL_NAME[kind]} 제안을 거절했습니다.`, b);
    return { ok: true, accepted: false };
  }
  const offer = { id: ++game._offerSeq, from: a, to: b, kind, t: Math.round(game.time), exp: Math.round(game.time + OFFER_SECONDS) };
  game.offers.push(offer);
  game.pushLog(`${A.title}이(가) ${B.title}에 ${REL_NAME[kind]}을(를) 제안했습니다.`, a);
  return { ok: true, pending: true };
}

function accept(game, a, b, kind) {
  const r = relOf(game, a, b);
  setRelation(game, a, b, kind);
  r.count = (r.count || 0) + 1;
  bump(game, a, b, kind === 'ally' ? 10 : 5);
  game.pushLog(`${game.nations[a].title}과 ${game.nations[b].title}이(가) ${REL_NAME[kind]}을(를) 맺었습니다.`, a);
}

function respond(game, who, offerId, yes) {
  const i = game.offers.findIndex((o) => o.id === offerId);
  if (i < 0) return { ok: false, error: '이미 처리된 제안입니다.' };
  const o = game.offers[i];
  if (o.to !== who) return { ok: false, error: '내게 온 제안이 아닙니다.' };
  game.offers.splice(i, 1);
  if (yes) {
    const err = canPropose(game, o.from, o.to, o.kind);
    if (err) return { ok: false, error: err };
    accept(game, o.from, o.to, o.kind);
  } else {
    game._dipCooldown[key(o.from, o.to) + '|' + o.kind + '|' + o.from] = game.time + COOLDOWN_SECONDS;
    game.pushLog(`${game.nations[o.to].title}이(가) ${game.nations[o.from].title}의 ${REL_NAME[o.kind]} 제안을 거절했습니다.`, o.to);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ 틱 */

function tick(game, dt) {
  // 불가침 만료 → 적대 복귀. 평화·동맹 중에는 신뢰가 서서히 오른다.
  for (const k of Object.keys(game.rel)) {
    const r = game.rel[k];
    if (r.s === 'peace' && r.until && game.time >= r.until) {
      r.s = 'war'; r.until = 0;
      const [a, b] = k.split('|').map(Number);
      game.pushLog(`${game.nations[a].title}과 ${game.nations[b].title}의 불가침 조약이 만료되었습니다.`);
      for (const u of game.units.values()) if ((u.owner === a || u.owner === b) && u.mission !== 'manual') u.nextThink = 0;
    } else if (r.s !== 'war') {
      r.trust = Math.min(100, r.trust + (r.s === 'ally' ? 0.05 : 0.02) * dt);
    }
  }
  // 만료된 제안 정리
  for (let i = game.offers.length - 1; i >= 0; i--) if (game.time >= game.offers[i].exp) game.offers.splice(i, 1);
}

/* ------------------------------------------------------------------ 봇 외교 */

function botThink(game, me) {
  const M = game.nations[me];
  if (!M.alive) return;
  const P = M.personality || '';
  const myScore = M.stats.score || 1;
  let threat = 0;
  for (const c of game.cities) if (c.owner === me) threat = Math.max(threat, game.threatOf(c, me));
  for (const O of game.nations) {
    if (!O.alive || O.idx === me) continue;
    const r = relOf(game, me, O.idx);
    const ratio = (O.stats.score || 1) / myScore;
    const hostile = r.s === 'war';
    if (hostile) {
      // 훨씬 센 적과 싸우는 중이고 위협이 크면 화친을 구한다 (성향별 자존심)
      const want = ratio > (P === '군국형' ? 1.8 : 1.25) && threat > 0.4;
      if (want && Math.random() < 0.5 && !canPropose(game, me, O.idx, 'peace')) {
        // 조공을 곁들이면 성사율이 오른다
        if (M.cash > 1000 && r.trust < 50) sendTribute(game, me, O.idx, Math.min(800, Math.round(M.cash * 0.15)));
        propose(game, me, O.idx, 'peace');
      }
      // 멀리 떨어져 싸울 일이 없는 나라와는 느슨한 불가침을 맺어 둔다
      const capM = game.cityById.get(M.capitalId), capO = game.cityById.get(O.capitalId);
      if (capM && capO && Math.hypot(capM.x - capO.x, capM.y - capO.y) > (game.W + game.H) * 0.35 && threat < 0.3 && Math.random() < 0.15 && !canPropose(game, me, O.idx, 'peace')) propose(game, me, O.idx, 'peace');
    } else {
      // 불가침 중: 공동의 적이 있고 신뢰가 높으면 동맹 제안
      if (r.s === 'peace' && r.trust >= TRUST_ALLY_MIN) {
        let common = 0;
        for (const n of game.nations) if (n.alive && n.idx !== me && n.idx !== O.idx && isHostile(game, me, n.idx) && isHostile(game, O.idx, n.idx)) common++;
        if (common > 0 && Math.random() < 0.3 && !canPropose(game, me, O.idx, 'ally')) propose(game, me, O.idx, 'ally');
      }
      // 배신: 압도적으로 세졌고, 다른 적이 없으며, 신뢰가 낮을 때만 (군국형은 더 쉽게)
      let otherEnemies = 0;
      for (const n of game.nations) if (n.alive && n.idx !== me && n.idx !== O.idx && isHostile(game, me, n.idx)) otherEnemies++;
      const betray = ratio < (P === '군국형' ? 0.6 : 0.45) && otherEnemies === 0 && r.trust < 45 && game.time > 300;
      if (betray && Math.random() < 0.15) declareWar(game, me, O.idx);
    }
  }
  // 공격 대상이 비적대면 해제
  if (typeof M.attackTarget === 'number' && !isHostile(game, me, M.attackTarget)) M.attackTarget = 'any';
}

function publicState(game) {
  const rel = {};
  for (const k of Object.keys(game.rel)) { const r = game.rel[k]; rel[k] = { s: r.s, t: Math.round(r.trust), u: r.until || 0 }; }
  return { rel, offers: Object.fromEntries(game.offers.map((o) => [o.id, o])) };
}

module.exports = {
  install, key, relOf, stateOf, isHostile, isAllied, bump, declareWar, sendTribute, propose, respond, canPropose, botScore, tick, botThink, publicState,
  REL_NAME, PEACE_SECONDS, OFFER_SECONDS, TRUST_ALLY_MIN, TRUST_PEACE_MIN,
};
