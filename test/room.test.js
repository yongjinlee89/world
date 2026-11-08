'use strict';

const assert = require('assert');
const { Room, MAX_PLAYERS } = require('../src/room');
const { diff, applyPatch } = require('../src/diff');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); console.error(e); process.exitCode = 1; }
}
console.log('room.test.js');

test('입장·방장·봇·설정', () => {
  const r = new Room('t');
  assert.ok(r.join('a', 'A', 's1').ok);
  assert.strictEqual(r.hostId, 'a');
  assert.ok(!r.join('b', 'A', 's2').ok, '같은 이름 거부');
  assert.ok(r.join('b', 'B', 's2').ok);
  assert.ok(!r.addBot('b').ok, '방장만');
  assert.ok(r.addBot('a').ok);
  assert.ok(!r.updateSettings('a', { duration: 123 }).ok);
  assert.ok(r.updateSettings('a', { duration: 900, mapSize: 0 }).ok);
  assert.strictEqual(r.settings.duration, 900);
  for (let i = r.players.length; i < MAX_PLAYERS; i++) r.addBot('a');
  assert.ok(!r.addBot('a').ok, '정원 초과');
  r.disconnect('s1');
  assert.strictEqual(r.hostId, 'b', '방장이 나가면 다음 사람');
});

test('시작·루프·속도·종료·재시작', () => {
  const r = new Room('t2');
  r.join('a', 'A', 's1');
  assert.ok(!r.start('a').ok, '혼자는 시작 불가');
  r.addBot('a');
  r.updateSettings('a', { mapSize: 0 });
  assert.ok(r.start('a').ok);
  assert.strictEqual(r.phase, 'playing');
  r.stopLoop();
  assert.ok(r.setSpeed('a', 3).ok);
  assert.ok(!r.setSpeed('a', 7).ok);
  for (let i = 0; i < 8; i++) r.step();
  assert.ok(r.game.time > 5, '3배속이면 8틱에 6초');
  const res = r.gameAction('a', (g) => g.setBudget('a', { industry: 1, research: 1, military: 1, finance: 1, reserve: 1 }));
  assert.ok(res.ok);
  assert.ok(!r.gameAction('zzz', () => ({ ok: true })).ok);
  r.game.finish();
  r.step();
  assert.strictEqual(r.phase, 'ended');
  assert.ok(r.restart('a').ok);
  assert.strictEqual(r.phase, 'lobby');
});

test('state() 는 직렬화 가능하고 diff/patch 로 복원된다', () => {
  const r = new Room('t3');
  r.join('a', 'A', 's1'); r.addBot('a'); r.addBot('a');
  r.updateSettings('a', { mapSize: 0 });
  r.start('a'); r.stopLoop();
  const s1 = JSON.parse(JSON.stringify(r.state()));
  for (let i = 0; i < 40; i++) r.game.tick(0.25);
  const s2 = JSON.parse(JSON.stringify(r.state()));
  const p = diff(s1, s2);
  assert.ok(p, '변화가 있다');
  const restored = applyPatch(JSON.parse(JSON.stringify(s1)), p);
  assert.deepStrictEqual(restored, s2);
  const full = JSON.stringify(s2).length, patch = JSON.stringify(p).length;
  assert.ok(patch < full * 0.3, `패치가 전체보다 훨씬 작다 (${patch} vs ${full})`);
  console.log(`    full ${(full / 1024).toFixed(1)}KB, 10s patch ${(patch / 1024).toFixed(1)}KB`);
});

test('빈 방 판정과 로비 복귀', () => {
  const r = new Room('t4');
  r.join('a', 'A', 's1'); r.addBot('a');
  r.start('a'); r.stopLoop();
  r.disconnect('s1');
  assert.ok(r.isEmpty(), '봇만 남으면 빈 방');
  r.resetToLobby();
  assert.strictEqual(r.phase, 'lobby');
  assert.strictEqual(r.game, null);
});

console.log(`${passed} tests passed`);
