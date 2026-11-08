'use strict';

const assert = require('assert');
const { Game } = require('../src/game');
const D = require('../src/data');

function mk(n = 3, settings = {}) {
  const infos = [];
  for (let i = 0; i < n; i++) infos.push({ id: 'p' + i, name: 'P' + i, isBot: i > 0 });
  return new Game(infos, { duration: 600, seed: 7, ...settings });
}
function run(g, seconds) {
  for (let t = 0; t < seconds; t += 0.25) g.tick(0.25);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); console.error(e); process.exitCode = 1; }
}

console.log('game.test.js');

test('지도·도시·수도가 생성되고 각 국가는 수도와 시작 부대를 가진다', () => {
  const g = mk(4);
  assert.strictEqual(g.nations.length, 4);
  for (const n of g.nations) {
    const cap = g.cityById.get(n.capitalId);
    assert.ok(cap && cap.owner === n.idx);
    assert.strictEqual([...g.units.values()].filter((u) => u.owner === n.idx).length, 2);
  }
  assert.ok(g.cities.length >= 4 + 8);
  // 수도 타일은 수도 주인의 영토
  for (const n of g.nations) {
    const cap = g.cityById.get(n.capitalId);
    assert.strictEqual(g.territory[cap.y * g.W + cap.x], n.idx);
  }
});

test('예산·교리·산업·포트폴리오 비율은 정규화되어 합이 100 이 된다', () => {
  const g = mk(2);
  assert.ok(g.setBudget('p0', { industry: 3, research: 1, military: 1, finance: 0, reserve: 0 }).ok);
  const b = g.nation('p0').budget;
  assert.strictEqual(Math.round(b.industry + b.research + b.military + b.finance + b.reserve), 100);
  assert.strictEqual(b.industry, 60);
  assert.ok(g.setDoctrine('p0', { defend: 1, expand: 0, attack: 1, target: 1 }).ok);
  assert.strictEqual(g.nation('p0').doctrine.defend, 50);
  assert.strictEqual(g.nation('p0').attackTarget, 1);
  assert.ok(g.setDoctrine('p0', { defend: 1, expand: 0, attack: 1, target: 0 }).ok, '자기 자신을 공격 대상으로 지정하면 any 로 떨어진다');
  assert.strictEqual(g.nation('p0').attackTarget, 'any');
  assert.ok(g.setIndustry('p0', { resource: 0, factory: 0, infra: 0, defense: 0 }).ok);
  assert.strictEqual(g.nation('p0').industry.resource, 35, '전부 0 이면 기본값');
  assert.ok(g.setPortfolio('p0', { defense: 100 }).ok);
  assert.strictEqual(g.nation('p0').portfolio.defense, 100);
  assert.ok(!g.setBudget('nobody', {}).ok);
});

test('경제가 돌아가고 장관들이 건물·부대·연구·주식에 돈을 쓴다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  const before = n.cash;
  run(g, 120);
  const myCities = g.cities.filter((c) => c.owner === n.idx);
  const levels = myCities.reduce((s, c) => s + Object.values(c.b).reduce((a, b) => a + b, 0), 0);
  assert.ok(levels > 4, '건물이 늘어난다: ' + levels);
  assert.ok([...g.units.values()].filter((u) => u.owner === n.idx).length >= 3, '부대가 늘어난다');
  assert.ok(n.techs.length >= 1, '기술을 완성한다');
  assert.ok(D.STOCK_ORDER.some((k) => n.stocks[k] > 0), '주식을 산다');
  assert.ok(n.stats.net > 0, '순수입이 양수');
  assert.ok(Number.isFinite(n.cash));
  assert.notStrictEqual(n.cash, before);
});

test('연구 목표를 찍으면 선행 기술부터 경로를 따라 연구한다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  assert.ok(g.setResearchTarget('p0', 'composite').ok);
  const path = g.researchPath(n, 'composite');
  assert.deepStrictEqual(path, ['mech', 'composite']);
  n.science = 10000;
  g.ministerResearch(n); // mech 선택 + 완료
  assert.ok(n.techs.includes('mech'));
  g.ministerResearch(n);
  assert.ok(n.techs.includes('composite'));
  assert.strictEqual(n.tier.armor, 2, '복합장갑으로 기갑 티어 2');
  assert.strictEqual(n.researchTarget, null);
  assert.ok(!g.setResearchTarget('p0', 'mech').ok, '보유 기술은 목표로 못 찍는다');
  assert.ok(!g.setResearchTarget('p0', 'nope').ok);
});

test('기술은 병종·건물을 해금하고 배수를 바꾼다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  assert.ok(!g.unitUnlocked(n, 'air'));
  assert.ok(!g.buildingUnlocked(n, 'bunker'));
  n.techs.push('aviation', 'fortification', 'massprod');
  g.refreshMult(n);
  assert.ok(g.unitUnlocked(n, 'air'));
  assert.ok(g.buildingUnlocked(n, 'bunker'));
  assert.ok(Math.abs(n.mult.factory - 1.2) < 1e-9);
  assert.ok(Math.abs(n.mult.cityDef - 1.15) < 1e-9);
});

test('직접 명령은 내 부대만, 통행 가능한 타일로만 받는다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  const u = [...g.units.values()].find((x) => x.owner === n.idx);
  const other = [...g.units.values()].find((x) => x.owner !== n.idx);
  assert.ok(!g.orderUnit('p0', other.id, 1, 1).ok);
  // 바다 타일 찾기
  let wi = g.map.tiles.indexOf('water');
  assert.ok(!g.orderUnit('p0', u.id, wi % g.W, Math.floor(wi / g.W)).ok);
  const cap = g.cityById.get(n.capitalId);
  assert.ok(g.orderUnit('p0', u.id, cap.x + 2, cap.y).ok);
  assert.strictEqual(u.mission, 'manual');
  assert.ok(g.releaseUnit('p0', u.id).ok);
  assert.notStrictEqual(u.mission, 'manual');
});

test('도시 점령: 체력 0 + 적 지상군 점거 시간이 지나면 주인이 바뀌고 영토가 재계산된다', () => {
  const g = mk(2);
  const a = g.nation('p0'), b = g.nation('p1');
  const target = g.cityById.get(b.capitalId);
  // b 의 부대를 전부 제거하고 a 의 강한 부대를 도시 위에 올린다
  for (const [id, u] of g.units) if (u.owner === b.idx) g.units.delete(id);
  const u = g.spawnUnit(a, 'armor', target);
  u.strength = 100;
  target.hp = 1;
  // 보호 기간 중에는 점령되지 않는다
  for (let t = 0; t < 20; t += 0.25) { const grid = g.buildUnitGrid(); g.tickCombat(0.25, grid); g.tickCities(0.25, grid); }
  assert.strictEqual(target.owner, b.idx, '보호 기간 중 점령 불가');
  g.time = 300;
  for (let t = 0; t < 30 && target.owner !== a.idx; t += 0.25) {
    const grid = g.buildUnitGrid();
    g.tickCombat(0.25, grid);
    g.tickCities(0.25, grid);
  }
  assert.strictEqual(target.owner, a.idx);
  assert.strictEqual(g.territory[target.y * g.W + target.x], a.idx);
  assert.ok(target.unrest > 0, '점령지 저항');
  assert.ok(b.weariness > 0, '잃은 쪽 피로도');
  // b 는 도시가 없으면 멸망
  if (!g.cities.some((c) => c.owner === b.idx)) assert.strictEqual(b.alive, false);
});

test('전투: 상성이 손실에 반영된다 (기갑 > 보병)', () => {
  const g = mk(2);
  const a = g.nation('p0'), b = g.nation('p1');
  for (const id of [...g.units.keys()]) g.units.delete(id);
  const cap = g.cityById.get(a.capitalId);
  const plain = { x: cap.x, y: cap.y };
  const tank = g.spawnUnit(a, 'armor', plain);
  const inf = g.spawnUnit(b, 'inf', plain);
  const grid = g.buildUnitGrid();
  g.tickCombat(1, grid);
  assert.ok(100 - inf.strength > 100 - tank.strength, '보병이 더 많이 잃는다');
});

test('영토는 도시 관할 구역을 따른다: 부대가 지나가도 안 바뀌고, 도시를 점령하면 구역 전체가 넘어간다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  // 모든 육지 칸 대부분이 어느 도시엔가 속한다
  const land = g.map.tiles.filter((t) => t !== 'water').length;
  const covered = g.map.prov.filter((p) => p >= 0).length;
  assert.ok(covered / land > 0.8, `관할 비율 ${covered}/${land}`);
  // 수도 관할 구역은 넉넉하다
  const capIdx = g.cities.findIndex((c) => c.id === n.capitalId);
  assert.ok(g.map.prov.filter((p) => p === capIdx).length >= 60);
  // 중립 도시 하나의 구역에 부대를 세워 둬도 영토는 그대로
  const ci = g.cities.findIndex((c) => c.owner === -1);
  const c = g.cities[ci];
  const tiles = g.map.prov.map((p, i) => (p === ci ? i : -1)).filter((i) => i >= 0);
  const u = [...g.units.values()].find((x) => x.owner === n.idx);
  u.tx = tiles[0] % g.W; u.ty = Math.floor(tiles[0] / g.W); u.x = u.tx; u.y = u.ty;
  g.tick(0.25);
  assert.strictEqual(g.territory[tiles[0]], -1, '지나가기만 해서는 영토가 안 된다');
  // 도시를 병합하면 구역 전체가 넘어간다
  g.captureCity(c, n.idx);
  for (const i of tiles) assert.strictEqual(g.territory[i], n.idx);
  assert.ok(c.resTiles.iron + c.resTiles.oil + c.resTiles.farm >= 0);
  // 도시 수가 충분하다 (국가당 중립 4개 이상)
  assert.ok(g.cities.filter((x) => x.owner === -1).length >= 8);
});

test('시장: 사면 오르고 팔면 내리며 기준가로 되돌아간다', () => {
  const g = mk(2);
  const base = g.market.iron.price;
  g.marketBuy('iron', 50);
  assert.ok(g.market.iron.price > base);
  const high = g.market.iron.price;
  g.tickMarket(5);
  assert.ok(g.market.iron.price < high);
  g.marketSell('iron', 80);
  assert.ok(g.market.iron.price < base);
});

test('재무부: 적자면 주식을 팔아 현금을 메운다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  n.stocks.food = 100;
  n.cash = -500;
  g.ministerFinance(n);
  assert.ok(n.cash > -500);
  assert.ok(n.stocks.food < 100);
  n.liquidate = true;
  g.ministerFinance(n);
  assert.strictEqual(n.stocks.food, 0);
  assert.strictEqual(n.liquidate, false);
});

test('외교: 불가침·동맹·파기·조공과 전투 차단', () => {
  const Dip = require('../src/diplomacy');
  const g = mk(3);
  const a = g.nation('p0'), b = g.nation('p1');
  assert.strictEqual(Dip.stateOf(g, 0, 1), 'war');
  // 동맹은 불가침 상태에서만
  assert.ok(!g.dipPropose('p0', 1, 'ally').ok);
  // 사람→봇 제안은 즉시 판정. 신뢰를 올리면 받아 준다
  assert.ok(g.dipTribute('p0', 1, 1000).ok);
  g.rel[Dip.key(0, 1)].trust = 90;
  const res = g.dipPropose('p0', 1, 'peace');
  assert.ok(res.ok && res.accepted, '신뢰 90이면 불가침 수락');
  assert.strictEqual(Dip.stateOf(g, 0, 1), 'peace');
  assert.ok(!g.hostile(0, 1));
  // 비적대국은 공격 대상으로 못 찍는다
  assert.ok(!g.setDoctrine('p0', { defend: 1, expand: 1, attack: 1, target: 1 }).ok);
  // 비적대국끼리는 교전하지 않는다
  for (const id of [...g.units.keys()]) g.units.delete(id);
  const cap = g.cityById.get(a.capitalId);
  const u1 = g.spawnUnit(a, 'armor', cap), u2 = g.spawnUnit(b, 'inf', cap);
  g.tickCombat(1, g.buildUnitGrid());
  assert.strictEqual(u1.strength, 100); assert.strictEqual(u2.strength, 100);
  // 동맹
  assert.ok(g.dipPropose('p0', 1, 'ally').ok);
  assert.strictEqual(Dip.stateOf(g, 0, 1), 'ally');
  // 파기 → 적대, 신뢰 급락, 제3국 신뢰도 하락
  const t3 = g.rel[Dip.key(0, 2)].trust;
  assert.ok(g.dipDeclare('p0', 1).ok);
  assert.strictEqual(Dip.stateOf(g, 0, 1), 'war');
  assert.ok(g.rel[Dip.key(0, 1)].trust < 60);
  assert.ok(g.rel[Dip.key(0, 2)].trust < t3);
  // 사람→사람 제안은 대기열에 쌓이고 수락으로 성사된다
  const g2 = new Game([{ id: 'h1', name: 'H1' }, { id: 'h2', name: 'H2' }], { duration: 600, seed: 3 });
  const r2 = g2.dipPropose('h1', 1, 'peace');
  assert.ok(r2.ok && r2.pending);
  const offer = g2.offers[0];
  assert.ok(!g2.dipRespond('h1', offer.id, true).ok, '보낸 사람은 수락 못 한다');
  assert.ok(g2.dipRespond('h2', offer.id, true).ok);
  assert.strictEqual(Dip.stateOf(g2, 0, 1), 'peace');
  // 불가침은 만료되면 적대로 돌아간다
  g2.time = g2.rel[Dip.key(0, 1)].until + 1;
  Dip.tick(g2, 0.25);
  assert.strictEqual(Dip.stateOf(g2, 0, 1), 'war');
  const json = JSON.stringify(g2.publicState());
  assert.ok(json.includes('"dip"'));
});

test('상성 인식 위임: 항공 위협에는 기갑을 보내지 않고, 반격 불가 시 방공 도시로 물러나며, 편성은 대응 병종을 고른다', () => {
  const g = mk(2);
  const a = g.nation('p0'), b = g.nation('p1');
  for (const id of [...g.units.keys()]) g.units.delete(id);
  a.techs.push('mech', 'aviation'); g.refreshMult(a);
  b.techs.push('aviation'); g.refreshMult(b);
  const cap = g.cityById.get(a.capitalId);
  // a 의 두 번째 도시를 만들어 두 수비 후보가 있게 한다
  const other = g.cities.find((c) => c.owner === -1 && Math.hypot(c.x - cap.x, c.y - cap.y) > 8);
  other.owner = a.idx; g.recomputeTerritory();
  // b 의 항공기 3대가 수도를 친다
  for (let i = 0; i < 3; i++) { const e = g.spawnUnit(b, 'air', cap); e.x = cap.x + 1; e.tx = cap.x + 1; }
  const td = g.threatDetail(cap, a.idx);
  assert.ok(td.by.air > 0 && td.by.armor === 0);
  const tank = g.spawnUnit(a, 'armor', other);
  const jet = g.spawnUnit(a, 'air', other);
  assert.ok(g.effectiveness(tank, td.by) < 0.3, '기갑은 항공 위협에 안 통한다');
  assert.ok(g.effectiveness(jet, td.by) >= 1, '항공은 항공 위협에 통한다');
  tank.mission = 'defend'; jet.mission = 'defend';
  g.thinkUnit(tank, a); g.thinkUnit(jet, a);
  assert.strictEqual(jet.targetCity, cap.id, '항공전대는 위협받는 수도로');
  assert.notStrictEqual(tank.targetCity, cap.id, '기갑은 항공만 오는 수도로 가지 않는다');
  // 국방부 편성: 항공 위협이면 항공을 뽑는다
  g.nationThreat(a);
  assert.ok(a.threat.share.air > 0.9);
  assert.strictEqual(g.pickUnitType(a), 'air');
  // 반격 불가 후퇴: 기갑이 항공기에게 맞고 있으면 방공포대 있는 도시로
  cap.b.aa = 1; tank.x = cap.x + 3; tank.y = cap.y; tank.tx = tank.x; tank.ty = tank.y; tank.lastStr = 100; tank.strength = 90; tank.fight = false;
  for (let i = 0; i < 3; i++) { const e = g.spawnUnit(b, 'air', cap); e.x = tank.x + 1; e.tx = tank.x + 1; e.y = tank.y; e.ty = tank.y; }
  g.thinkUnit(tank, a);
  assert.ok(tank.goal && tank.goal.x === cap.x && tank.goal.y === cap.y, '방공포대 도시로 후퇴');
});

test('특별 집행·회수: 비축을 금고로 옮기면 장관이 바로 쓰고, 사람은 자동 재배분이 꺼져 있다', () => {
  const g = mk(2);
  const n = g.nation('p0');
  assert.strictEqual(n.autoReserve, false);
  assert.strictEqual(g.nation('p1').autoReserve, true, '봇은 자동 재배분');
  const earmarked = () => n.pots.industry + n.pots.research + n.pots.military + n.pots.finance;
  const free = Math.floor(n.cash - earmarked());
  assert.ok(!g.allocate('p0', 'military', free + 1).ok, '가용 현금 초과는 거부');
  assert.ok(!g.allocate('p0', 'nope', 10).ok);
  assert.ok(g.allocate('p0', 'military', free).ok);
  assert.ok(Math.floor(n.cash - earmarked()) <= 0);
  const before = [...g.units.values()].filter((u) => u.owner === n.idx).length;
  g.tickCabinet();
  assert.ok(n.queue.length > 0, '국방부가 즉시 생산 계약');
  assert.ok(n.queue.length <= D.RULES.prodQueueMax, '대기열은 상한까지만');
  assert.strictEqual([...g.units.values()].filter((u) => u.owner === n.idx).length, before, '돈을 내도 바로 나오지 않는다');
  // 생산력만큼 시간이 지나면 나온다
  const need = n.queue[0].need;
  const secs = need / g.prodRate(n);
  assert.ok(secs >= 3, `생산에 시간이 걸린다 (${secs.toFixed(1)}초)`);
  for (let t = 0; t < secs + 0.6; t += 0.25) g.tickProduction(0.25);
  const after = [...g.units.values()].filter((u) => u.owner === n.idx).length;
  assert.ok(after > before, '생산 완료 후 편성');
  // 공장이 많을수록 빠르다
  const cap = g.cityById.get(n.capitalId);
  const r0 = g.prodRate(n); cap.b.factory += 3;
  assert.ok(g.prodRate(n) > r0 * 1.5, '공장 규모만큼 생산력 증가');
  n.pots.research = 0; n.pots.industry = 300;
  assert.ok(g.recall('p0', 'industry').ok);
  assert.strictEqual(n.pots.industry, 0);
  assert.ok(!g.recall('p0', 'industry').ok, '빈 금고는 회수 불가');
  // 사람은 비축이 커져도 자동으로 빠져나가지 않는다
  n.cash += 10000;
  const f0 = n.cash - earmarked();
  g.tickCabinet();
  assert.ok(n.cash - earmarked() >= f0 - 1, '자동 재배분 꺼짐');
  assert.ok(g.setAutoReserve('p0', true).ok);
  g.tickCabinet();
  assert.ok(n.cash - earmarked() < f0 - 1000, '켜면 재배분');
});

test('전쟁은 비싸고 평화는 돈이 된다: 피로도·교역·저항·핵·승리 조건', () => {
  const Dip = require('../src/diplomacy');
  const g = mk(3);
  const a = g.nation('p0'), b = g.nation('p1');
  // 전멸 → 잃은 쪽 피로도 +5, 격멸한 쪽 +1.5
  for (const id of [...g.units.keys()]) g.units.delete(id);
  const cap = g.cityById.get(a.capitalId);
  const tank = g.spawnUnit(a, 'armor', cap); const inf = g.spawnUnit(b, 'inf', cap); inf.strength = 1;
  g.tickCombat(1, g.buildUnitGrid());
  assert.ok(!g.units.has(inf.id));
  assert.ok(b.weariness >= D.RULES.wearinessPerLoss - 1 && a.weariness >= D.RULES.wearinessPerKill - 0.5);
  assert.strictEqual(a.stats.kills, 1); assert.strictEqual(b.stats.losses, 1);
  // 피로도는 세수를 깎고, 불가침·동맹은 세수를 올린다
  a.weariness = 100; g.tickEconomy(0.25); const wearyIncome = a.stats.income;
  a.weariness = 0; g.tickEconomy(0.25); const baseIncome = a.stats.income;
  assert.ok(wearyIncome < baseIncome * 0.6, '피로도 100 이면 세수 절반');
  g.rel[Dip.key(0, 1)].s = 'ally'; g.rel[Dip.key(0, 2)].s = 'peace';
  g.tickEconomy(0.25);
  assert.ok(Math.abs(a.stats.trade - 0.12) < 1e-9 && a.stats.income > baseIncome * 1.1, '교역 +12%');
  // 저항 중인 도시는 수입 0, 주둔군이 있으면 빨리 안정
  const other = g.cities.find((c) => c.owner === -1);
  other.owner = a.idx; other.unrest = 100; other.pop = 100;
  g.tickEconomy(1); assert.ok(other.unrest < 100 && other.unrest > 98);
  const gar = g.spawnUnit(a, 'inf', other); g.tickEconomy(1); assert.ok(other.unrest < 97.5, '주둔군 2배 안정');
  g.units.delete(gar.id);
  // 핵: 기술·현금·대기·적대 조건
  const tcity = g.cityById.get(b.capitalId);
  assert.ok(!g.nuke('p0', tcity.id).ok, '기술 없음');
  a.techs.push('nuke'); g.refreshMult(a); a.cash = 10000;
  g.rel[Dip.key(0, 1)].s = 'war';
  const popBefore = tcity.pop, trust2 = g.rel[Dip.key(0, 2)].trust;
  assert.ok(g.nuke('p0', tcity.id).ok);
  assert.strictEqual(tcity.hp, 0); assert.ok(tcity.pop <= popBefore / 2 + 1); assert.ok(tcity.unrest > 0);
  assert.ok(g.rel[Dip.key(0, 2)].trust < trust2, '세계 신뢰 하락');
  assert.ok(!g.nuke('p0', tcity.id).ok, '재사용 대기');
  // 승리 조건: 경제 승리
  const g2 = mk(2, { victory: 'economic' });
  g2.time = 200; g2.nation('p0').stats.score = 999999; g2.checkEnd();
  assert.strictEqual(g2.ended, true); assert.strictEqual(g2.endReason, 'economic'); assert.strictEqual(g2.winner, 'p0');
  const g3 = mk(2, { victory: 'conquest', duration: 100 });
  g3.time = 150; g3.checkEnd(); assert.strictEqual(g3.ended, false, '정복전은 시간으로 안 끝난다');
  const st = g2.publicState(); assert.ok(st.hist && st.hist.t.length >= 1, '종료 시 국력 추이 전송');
  // 자동 내각: 켜면 봇 로직이 사람 국가의 예산을 바꾼다
  const { think } = require('../src/bot');
  const g4 = mk(2); const h = g4.nation('p0'); h.budget = { industry: 1, research: 1, military: 96, finance: 1, reserve: 1 };
  think(g4, 'p0', { diplomacy: false });
  assert.ok(h.budget.military < 90, '자동 내각이 예산 조정');
});

test('제한 시간이 끝나면 순위가 정해지고 상태가 직렬화된다', () => {
  const g = mk(3, { duration: 30 });
  run(g, 31);
  assert.strictEqual(g.ended, true);
  assert.strictEqual(g.ranking.length, 3);
  assert.ok(g.winner);
  const s = g.publicState();
  const json = JSON.stringify(s);
  assert.ok(json.length > 1000);
  assert.ok(!json.includes('NaN'), 'NaN 없음');
  assert.ok(!json.includes('Infinity'), 'Infinity 없음');
  assert.strictEqual(s.terr.length, g.W * g.H);
});

test('결단: 사람에게는 선택지가 열리고, 고르면 효과가 적용되며, 시간이 지나면 기본 선택이 된다', () => {
  const Decisions = require('../src/decisions');
  const g = mk(2);
  const n = g.nation('p0');
  g.time = 400;
  const d = Decisions.POOL.find((x) => x.id === 'tax');
  Decisions.open(g, n, d);
  assert.ok(n.decision && n.decision.id === 'tax' && n.decision.options.length === 2);
  assert.ok(!g.decide('p0', 9).ok, '범위 밖 선택은 거부');
  assert.ok(g.decide('p0', 1).ok);
  assert.strictEqual(n.decision, null);
  assert.ok(n.buffs.some((b) => b.k === 'income' && b.v > 0), '증세 버프');
  assert.ok(g.buff(n, 'income') > 0);
  // 시간 초과 → 기본 선택 (감세: 피로도 감소)
  n.weariness = 30;
  Decisions.open(g, n, d);
  n.decision.left = 0.1;
  Decisions.tick(g, 0.25);
  assert.strictEqual(n.decision, null);
  assert.ok(n.weariness < 30, '기본 선택(감세)이 적용됐다');
  // 봇은 즉시 고른다
  const b = g.nation('p1');
  Decisions.open(g, b, d);
  assert.strictEqual(b.decision, null);
  assert.ok(b.buffs.length >= 1);
  // 버프 만료
  g.time += 1000;
  g.tick(0.25);
  assert.strictEqual(n.buffs.length, 0);
});

test('국가 프로젝트: 기술이 있어야 목표로 정할 수 있고, 산업 금고로 지어지며, 완성하면 세계에 하나뿐이고 경쟁자는 절반을 돌려받는다', () => {
  const g = mk(2);
  const a = g.nation('p0'), b = g.nation('p1');
  assert.ok(!g.setProject('p0', 'expo').ok, '대량생산 기술 없이는 불가');
  assert.ok(g.setProject('p0', 'peace').ok, '평화 기념관은 기술 불필요');
  a.cash = 10000; a.pots.industry = 1000;
  b.cash = 10000; b.pots.industry = 1000; b.projectTarget = 'peace';
  // 산업 예산 유입분의 일부가 프로젝트로 간다 — 산업 금고 잔액은 공장용으로 남는다
  const potBefore = a.pots.industry;
  g.tickEconomy(2);
  assert.ok((g.projects.peace.prog[a.idx] || 0) > 0 && !g.projects.peace.done, '유입분 일부 투입');
  assert.ok(a.pots.industry >= potBefore * 0.99, '산업 금고를 깎아 먹지 않는다');
  assert.ok((g.projects.peace.prog[b.idx] || 0) > 0, '경쟁자도 투입');
  // 산업 금고가 넘치면 초과분이 들어간다
  for (let i = 0; i < 10 && !g.projects.peace.done; i++) { a.pots.industry = 6000; a.cash = 10000; g.tickCabinet(); }
  assert.ok(g.projects.peace.done && g.projects.peace.owner === a.idx, 'p0 이 완성');
  assert.strictEqual(a.projectTarget, null);
  assert.strictEqual(b.projectTarget, null, '경쟁자의 목표는 해제');
  assert.ok(g.log.some((l) => l.n === b.idx && l.text.includes('경쟁에서 밀렸습니다')));
  assert.ok(!g.setProject('p1', 'peace').ok, '이미 완성된 프로젝트는 불가');
  assert.ok(g.projectBonus(a, 'wearinessDecay') === 2 && g.projectBonus(a, 'trade') === 0.05);
  a.techs.push('massprod'); g.refreshMult(a);
  assert.ok(g.setProject('p0', 'expo').ok);
  const w1 = g.netWorth(a);
  g.projects.peace.owner = -1;
  const w0 = g.netWorth(a);
  g.projects.peace.owner = a.idx;
  assert.ok(Math.abs(w1 - w0 - 2500 * D.RULES.projectPrestige) < 1, '위신(비용의 절반)이 국력에 더해진다');
});

test('세계 의회: 결의안이 상정되고 투표로 가결되면 세계 효과가 걸린다 (휴전은 점령을 막는다)', () => {
  const Council = require('../src/council');
  const g = mk(3);
  g.time = 300;
  g._councilClock = 0;
  Council.tick(g, 0.25);
  assert.ok(g.council, '투표 시작');
  // 사람이 찬성, 봇 표는 강제로 찬성
  assert.ok(g.vote('p0', 1).ok);
  for (const n of g.nations) g.council.votes[n.idx] = 1;
  const id = g.council.id;
  g.council.left = 0.1;
  Council.tick(g, 0.25);
  assert.strictEqual(g.council, null);
  assert.ok(g.lastCouncil && g.lastCouncil.id === id && g.lastCouncil.passed);
  const r = Council.RESOLUTIONS[id];
  if (r.world) for (const k of Object.keys(r.world)) assert.ok(Council.worldBuff(g, k) !== 0, `세계 효과 ${k}`);
  if (id === 'truce') assert.ok(g.truce());
  assert.ok(!g.vote('p0', 1).ok, '투표가 없으면 거부');
  const ps = g.publicState();
  assert.ok(ps.council && Array.isArray(ps.council.active) && ps.council.last);
  // 핵 금지 조약이 발효 중이면 핵을 쓸 수 없다
  g.world.buffs.push({ k: 'nonuke', v: 1, until: g.time + 100, name: 'x' });
  const n = g.nation('p0'); n.techs.push('nuke'); g.refreshMult(n); n.cash = 99999;
  const enemy = g.cities.find((c) => c.owner === 1);
  assert.ok(!g.nuke('p0', enemy.id).ok);
});

test('첩보: 비축과 대기 시간이 필요하고, 성공하면 효과·실패하면 신뢰 하락, 업적은 조건을 채우면 달성된다', () => {
  const Dip = require('../src/diplomacy');
  const Ach = require('../src/achievements');
  const g = mk(2);
  const a = g.nation('p0'), b = g.nation('p1');
  a.cash = 100; a.pots.industry = 0; a.pots.research = 0; a.pots.military = 0; a.pots.finance = 0;
  assert.ok(!g.spy('p0', 1, 'steal').ok, '비축 부족');
  a.cash = 5000;
  assert.ok(!g.spy('p0', 1, 'nope').ok);
  const trustBefore = Dip.relOf(g, 0, 1).trust;
  const sciBefore = a.science;
  const r = g.spy('p0', 1, 'steal');
  assert.ok(r.ok);
  assert.ok(!g.spy('p0', 1, 'steal').ok, '재사용 대기');
  if (r.success) { assert.ok(a.science > sciBefore); assert.strictEqual(a.stats.spies, 1); }
  else assert.ok(Dip.relOf(g, 0, 1).trust < trustBefore);
  // 업적
  a.techs.push('mech');
  Ach.tick(g);
  assert.ok(a.ach.includes('firsttech'), '세계 최초 기술 업적');
  b.techs.push('mech');
  Ach.tick(g);
  assert.ok(!b.ach.includes('firsttech'), '세계 최초는 한 나라만');
  a.stats.score = 25000; Ach.tick(g);
  assert.ok(a.ach.includes('rich'));
  const ps = g.publicState();
  assert.ok(Array.isArray(ps.nations[0].ach) && ps.nations[0].ach.includes('rich'));
  assert.ok(ps.projects && ps.projects.expo && ps.projects.expo.d === 0);
});

console.log(`${passed} tests passed`);
