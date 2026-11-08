'use strict';

/**
 * 병종·건물 아이콘을 캔버스에 직접 그린다 (이모지 없음 — 기기마다 모양이 달라지는 것을 막는다).
 * 모든 함수는 (ctx, cx, cy, size, color) 를 받고 중심 기준으로 그린다.
 */
(function () {
const ICONS = window.HG_ICONS = {};

function base(ctx, cx, cy, s, color, shape) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s / 24, s / 24);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  shape(ctx, color);
  ctx.restore();
}

// 보병: 병사 실루엣(머리 + 몸통 + 소총 사선)
ICONS.inf = (ctx, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => {
  c.fillStyle = color;
  c.beginPath(); c.arc(0, -6.5, 3.2, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(-5, -2); c.lineTo(5, -2); c.lineTo(6, 8); c.lineTo(-6, 8); c.closePath(); c.fill();
  c.strokeStyle = color; c.lineWidth = 2.2;
  c.beginPath(); c.moveTo(-8, 7); c.lineTo(8, -5); c.stroke();
});

// 기갑: 전차 측면(차체 + 포탑 + 포신 + 궤도)
ICONS.armor = (ctx, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => {
  c.fillStyle = color;
  c.beginPath(); c.roundRect(-10, 1, 20, 6, 3); c.fill();
  c.beginPath(); c.roundRect(-5, -5, 10, 6, 2); c.fill();
  c.strokeStyle = color; c.lineWidth = 2;
  c.beginPath(); c.moveTo(4, -2.5); c.lineTo(12, -4); c.stroke();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -7; i <= 7; i += 3.5) { c.beginPath(); c.arc(i, 5.5, 1.1, 0, Math.PI * 2); c.fill(); }
});

// 포병: 자주포(차체 + 긴 포신 위로)
ICONS.arty = (ctx, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => {
  c.fillStyle = color;
  c.beginPath(); c.roundRect(-9, 2, 18, 6, 2.5); c.fill();
  c.beginPath(); c.roundRect(-4, -3, 8, 5, 1.5); c.fill();
  c.strokeStyle = color; c.lineWidth = 2.4;
  c.beginPath(); c.moveTo(1, -2); c.lineTo(11, -11); c.stroke();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -6; i <= 6; i += 4) { c.beginPath(); c.arc(i, 6.5, 1.1, 0, Math.PI * 2); c.fill(); }
});

// 항공: 제트기 위에서 본 모양(동체 + 후퇴익 + 꼬리)
ICONS.air = (ctx, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => {
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, -11); c.lineTo(2.2, -3); c.lineTo(11, 3); c.lineTo(11, 6); c.lineTo(2.4, 3.5);
  c.lineTo(2, 8); c.lineTo(5, 10.5); c.lineTo(5, 12); c.lineTo(0, 10.5); c.lineTo(-5, 12); c.lineTo(-5, 10.5); c.lineTo(-2, 8);
  c.lineTo(-2.4, 3.5); c.lineTo(-11, 6); c.lineTo(-11, 3); c.lineTo(-2.2, -3); c.closePath(); c.fill();
});

// 해군: 군함 측면(선체 + 함교 + 함포)
ICONS.navy = (ctx, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => {
  c.fillStyle = color;
  c.beginPath(); c.moveTo(-12, 3); c.lineTo(12, 3); c.lineTo(9, 8); c.lineTo(-10, 8); c.closePath(); c.fill();
  c.beginPath(); c.roundRect(-4, -4, 8, 7, 1.5); c.fill();
  c.fillRect(-1.5, -9, 3, 5);
  c.strokeStyle = color; c.lineWidth = 2;
  c.beginPath(); c.moveTo(5, 1); c.lineTo(11, -2); c.stroke();
  c.beginPath(); c.moveTo(-6, 1); c.lineTo(-11, -1); c.stroke();
});

// 건물 아이콘 (작은 패널용)
ICONS.building = {
  mine: (c) => { c.beginPath(); c.moveTo(-9, 8); c.lineTo(0, -8); c.lineTo(9, 8); c.closePath(); c.fill(); c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.moveTo(-3, 8); c.lineTo(0, 1); c.lineTo(3, 8); c.fill(); },
  oilwell: (c) => { c.beginPath(); c.moveTo(-6, 9); c.lineTo(-1, -9); c.lineTo(1, -9); c.lineTo(6, 9); c.closePath(); c.fill(); c.fillRect(-9, -4, 18, 2); c.fillRect(-7, 3, 14, 2); },
  farm: (c) => { for (let i = -8; i <= 8; i += 4) { c.fillRect(i - 1, -8, 2, 17); } c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(-9, 2, 18, 2); },
  factory: (c) => { c.beginPath(); c.moveTo(-10, 9); c.lineTo(-10, -2); c.lineTo(-4, 2); c.lineTo(-4, -2); c.lineTo(2, 2); c.lineTo(2, -2); c.lineTo(8, 2); c.lineTo(8, 9); c.closePath(); c.fill(); c.fillRect(-8, -10, 3, 9); c.fillRect(5, -8, 3, 7); },
  lab: (c) => { c.beginPath(); c.moveTo(-3, -9); c.lineTo(3, -9); c.lineTo(3, -2); c.lineTo(9, 8); c.lineTo(-9, 8); c.lineTo(-3, -2); c.closePath(); c.fill(); },
  exchange: (c) => { c.fillRect(-9, 6, 18, 3); c.fillRect(-7, -2, 3, 8); c.fillRect(-1.5, -2, 3, 8); c.fillRect(4, -2, 3, 8); c.beginPath(); c.moveTo(-10, -2); c.lineTo(0, -9); c.lineTo(10, -2); c.closePath(); c.fill(); },
  barracks: (c) => { c.fillRect(-10, -1, 20, 10); c.beginPath(); c.moveTo(-11, -1); c.lineTo(0, -9); c.lineTo(11, -1); c.closePath(); c.fill(); },
  bunker: (c) => { c.beginPath(); c.moveTo(-10, 8); c.lineTo(-8, -2); c.lineTo(-3, -7); c.lineTo(3, -7); c.lineTo(8, -2); c.lineTo(10, 8); c.closePath(); c.fill(); },
  aa: (c) => { c.fillRect(-8, 4, 16, 5); c.strokeStyle = c.fillStyle; c.lineWidth = 2.2; c.beginPath(); c.moveTo(-2, 4); c.lineTo(5, -9); c.moveTo(2, 4); c.lineTo(9, -9); c.stroke(); },
  port: (c) => { c.fillRect(-10, 4, 20, 3); c.fillRect(-8, -8, 2.5, 12); c.fillRect(-8, -8, 12, 2.5); c.fillRect(2, -8, 2, 5); },
};
ICONS.drawBuilding = (ctx, kind, cx, cy, s, color) => base(ctx, cx, cy, s, color, (c) => { c.fillStyle = color; (ICONS.building[kind] || ICONS.building.factory)(c); });

// 자원 타일 마커
ICONS.resource = {
  iron: (c) => { c.fillStyle = '#c9ced8'; c.beginPath(); c.moveTo(-7, 6); c.lineTo(-3, -5); c.lineTo(2, 1); c.lineTo(7, -6); c.lineTo(8, 6); c.closePath(); c.fill(); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.moveTo(-3, 6); c.lineTo(0, -1); c.lineTo(3, 6); c.fill(); },
  oil: (c) => { c.fillStyle = '#2b2b33'; c.beginPath(); c.ellipse(0, 0, 8, 6, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = '#5a5a66'; c.beginPath(); c.ellipse(-2, -2, 3, 1.5, -0.5, 0, Math.PI * 2); c.fill(); },
  farm: (c) => { c.fillStyle = '#d9b63a'; for (let i = -6; i <= 6; i += 4) { c.fillRect(i - 1, -7, 2, 14); } c.fillStyle = '#8c6d1f'; c.fillRect(-8, 5, 16, 2); },
};
ICONS.drawResource = (ctx, kind, cx, cy, s) => base(ctx, cx, cy, s, null, (c) => (ICONS.resource[kind] || ICONS.resource.iron)(c));

/* ------------------------------------------------------------------ 편대 미니 스프라이트 (전투신용)
 * (ctx, m=크기, facing=라디안, anim={phase, moving, firing}) — 원점이 스프라이트 중심.
 * 지상 차량·함선은 facing 으로 회전하고, 병사는 좌우만 뒤집는다. 호출자가 translate 만 해 두면 된다.
 */
ICONS.mini = {
  inf(c, m, facing, a) {
    const flip = Math.cos(facing) < 0 ? -1 : 1;
    c.save(); c.scale(flip, 1);
    const swing = a.moving ? Math.sin(a.phase * 9) : 0;
    c.strokeStyle = a.dark; c.lineWidth = m * 0.22; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-m * 0.1, m * 0.15); c.lineTo(-m * 0.1 - swing * m * 0.35, m * 0.75);
    c.moveTo(m * 0.1, m * 0.15); c.lineTo(m * 0.1 + swing * m * 0.35, m * 0.75); c.stroke();
    c.fillStyle = a.col; c.beginPath(); c.roundRect(-m * 0.3, -m * 0.35, m * 0.6, m * 0.6, m * 0.15); c.fill();
    c.fillStyle = a.dark; c.beginPath(); c.arc(0, -m * 0.55, m * 0.26, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#2a2a2a'; c.lineWidth = m * 0.12;
    const recoil = a.firing ? Math.max(0, Math.sin(a.phase * 20)) * m * 0.1 : 0;
    c.beginPath(); c.moveTo(-m * 0.2 - recoil, m * 0.1); c.lineTo(m * 0.75 - recoil, -m * 0.25); c.stroke();
    c.restore();
  },
  armor(c, m, facing, a) {
    c.save(); c.rotate(facing);
    const L = m * 1.5, W = m * 0.95;
    c.fillStyle = '#1b1f26'; c.fillRect(-L / 2, -W / 2 - m * 0.08, L, m * 0.22); c.fillRect(-L / 2, W / 2 - m * 0.14, L, m * 0.22);
    if (a.moving) { c.fillStyle = 'rgba(255,255,255,0.25)'; const off = (a.phase * 6) % 0.3; for (let x = -L / 2 + off * m; x < L / 2; x += m * 0.3) { c.fillRect(x, -W / 2 - m * 0.06, m * 0.1, m * 0.18); c.fillRect(x, W / 2 - m * 0.12, m * 0.1, m * 0.18); } }
    const g = c.createLinearGradient(0, -W / 2, 0, W / 2); g.addColorStop(0, a.light); g.addColorStop(1, a.dark);
    c.fillStyle = g; c.beginPath(); c.roundRect(-L / 2, -W / 2 + m * 0.08, L, W - m * 0.16, m * 0.15); c.fill();
    c.fillStyle = a.col; c.beginPath(); c.arc(-m * 0.1, 0, m * 0.36, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#15181d'; c.lineWidth = m * 0.14; c.lineCap = 'round';
    const recoil = a.firing ? Math.max(0, Math.sin(a.phase * 14)) * m * 0.18 : 0;
    c.beginPath(); c.moveTo(-m * 0.1 - recoil, 0); c.lineTo(m * 1.05 - recoil, 0); c.stroke();
    c.restore();
  },
  arty(c, m, facing, a) {
    c.save(); c.rotate(facing);
    c.fillStyle = '#1b1f26'; c.beginPath(); c.arc(-m * 0.3, -m * 0.4, m * 0.2, 0, Math.PI * 2); c.arc(-m * 0.3, m * 0.4, m * 0.2, 0, Math.PI * 2); c.fill();
    c.fillStyle = a.col; c.beginPath(); c.roundRect(-m * 0.6, -m * 0.3, m * 0.9, m * 0.6, m * 0.1); c.fill();
    c.strokeStyle = a.dark; c.lineWidth = m * 0.1; c.beginPath(); c.moveTo(-m * 0.5, -m * 0.15); c.lineTo(-m * 1.1, -m * 0.35); c.moveTo(-m * 0.5, m * 0.15); c.lineTo(-m * 1.1, m * 0.35); c.stroke();
    c.strokeStyle = '#15181d'; c.lineWidth = m * 0.16; c.lineCap = 'round';
    const recoil = a.firing ? Math.max(0, Math.sin(a.phase * 10)) * m * 0.3 : 0;
    c.beginPath(); c.moveTo(-m * 0.1 - recoil, 0); c.lineTo(m * 1.2 - recoil, -m * 0.1); c.stroke();
    c.restore();
  },
  air(c, m, facing, a) {
    c.save(); c.rotate(facing + Math.PI / 2);
    const bank = a.moving ? Math.sin(a.phase * 2.2) * 0.25 : 0;
    c.scale(1 - Math.abs(bank) * 0.6, 1);
    c.fillStyle = a.dark;
    c.beginPath(); c.moveTo(0, -m * 1.1); c.lineTo(m * 0.22, -m * 0.3); c.lineTo(m * 1.1, m * 0.3); c.lineTo(m * 1.1, m * 0.6); c.lineTo(m * 0.24, m * 0.35); c.lineTo(m * 0.2, m * 0.8); c.lineTo(m * 0.5, m * 1.05); c.lineTo(m * 0.5, m * 1.2); c.lineTo(0, m * 1.05); c.lineTo(-m * 0.5, m * 1.2); c.lineTo(-m * 0.5, m * 1.05); c.lineTo(-m * 0.2, m * 0.8); c.lineTo(-m * 0.24, m * 0.35); c.lineTo(-m * 1.1, m * 0.6); c.lineTo(-m * 1.1, m * 0.3); c.lineTo(-m * 0.22, -m * 0.3); c.closePath(); c.fill();
    c.fillStyle = a.light; c.beginPath(); c.moveTo(0, -m * 0.9); c.lineTo(m * 0.12, -m * 0.2); c.lineTo(0, m * 0.9); c.lineTo(-m * 0.12, -m * 0.2); c.closePath(); c.fill();
    c.fillStyle = '#9ad8ff'; c.beginPath(); c.ellipse(0, -m * 0.45, m * 0.1, m * 0.22, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = `rgba(120,200,255,${0.5 + 0.5 * Math.sin(a.phase * 30)})`; c.beginPath(); c.arc(0, m * 1.0, m * 0.14, 0, Math.PI * 2); c.fill();
    c.restore();
  },
  navy(c, m, facing, a) {
    c.save(); c.rotate(facing);
    const L = m * 2.2, W = m * 0.7;
    c.fillStyle = '#0f1a2a'; c.beginPath(); c.moveTo(L / 2 + m * 0.15, m * 0.08); c.lineTo(-L / 2 + m * 0.1, W / 2 + m * 0.1); c.lineTo(-L / 2 - m * 0.05, W / 2 + m * 0.1); c.lineTo(-L / 2 - m * 0.05, m * 0.1); c.closePath(); c.fill();
    const g = c.createLinearGradient(0, -W / 2, 0, W / 2); g.addColorStop(0, '#d9dde6'); g.addColorStop(1, '#8a929f');
    c.fillStyle = g; c.beginPath(); c.moveTo(L / 2, 0); c.lineTo(L * 0.2, -W / 2); c.lineTo(-L / 2, -W / 2 + m * 0.05); c.lineTo(-L / 2, W / 2 - m * 0.05); c.lineTo(L * 0.2, W / 2); c.closePath(); c.fill();
    c.fillStyle = a.col; c.beginPath(); c.roundRect(-m * 0.5, -m * 0.22, m * 0.8, m * 0.44, m * 0.08); c.fill();
    c.fillStyle = a.dark; c.fillRect(-m * 0.15, -m * 0.12, m * 0.25, m * 0.24);
    c.strokeStyle = '#15181d'; c.lineWidth = m * 0.11; c.lineCap = 'round';
    const recoil = a.firing ? Math.max(0, Math.sin(a.phase * 12)) * m * 0.12 : 0;
    c.beginPath(); c.moveTo(m * 0.45 - recoil, 0); c.lineTo(m * 0.95 - recoil, -m * 0.05); c.moveTo(-m * 0.6, 0); c.lineTo(-m * 1.0, m * 0.03); c.stroke();
    c.restore();
  },
};
})();
