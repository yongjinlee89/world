'use strict';

/**
 * 지도 입력: 드래그 이동, 휠/핀치 확대, 클릭 선택, 우클릭(길게 누르기) 직접 명령.
 */
(function () {
const HG = window.HG;
const canvas = document.getElementById('map');
const minimap = document.getElementById('minimap');

let dragging = false, dragStart = null, dragMoved = false;
let longPressTimer = null;

const ZMIN = 7, ZMAX = 64;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) { handleOrder(e.clientX, e.clientY); return; }
  dragging = true; dragMoved = false;
  dragStart = { x: e.clientX, y: e.clientY, camX: HG.camera.x, camY: HG.camera.y };
  canvas.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
  HG.camera.x = dragStart.camX - dx / HG.camera.zoom;
  HG.camera.y = dragStart.camY - dy / HG.camera.zoom;
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('dragging');
  if (!dragMoved && e.target === canvas && e.button === 0) handleClick(e.clientX, e.clientY);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

function zoomAt(sx, sy, factor) {
  const before = HG.screenToTile(sx, sy);
  HG.camera.zoom = Math.max(ZMIN, Math.min(ZMAX, HG.camera.zoom * factor));
  const after = HG.screenToTile(sx, sy);
  HG.camera.x += before.x - after.x;
  HG.camera.y += before.y - after.y;
}

// ---- 터치
const touches = new Map();
let pinchStart = 0, pinchZoom = 0;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
  if (touches.size === 2) {
    const a = [...touches.values()];
    pinchStart = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    pinchZoom = HG.camera.zoom;
    clearTimeout(longPressTimer);
  } else if (touches.size === 1) {
    const t = e.changedTouches[0];
    dragStart = { x: t.clientX, y: t.clientY, camX: HG.camera.x, camY: HG.camera.y };
    dragMoved = false;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => { if (!dragMoved) { handleOrder(t.clientX, t.clientY); dragMoved = true; } }, 550);
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) { const p = touches.get(t.identifier); if (p) { p.x = t.clientX; p.y = t.clientY; } }
  if (touches.size === 2 && pinchStart > 0) {
    const a = [...touches.values()];
    const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    const cx = (a[0].x + a[1].x) / 2, cy = (a[0].y + a[1].y) / 2;
    const before = HG.screenToTile(cx, cy);
    HG.camera.zoom = Math.max(ZMIN, Math.min(ZMAX, pinchZoom * (dist / pinchStart)));
    const after = HG.screenToTile(cx, cy);
    HG.camera.x += before.x - after.x; HG.camera.y += before.y - after.y;
  } else if (touches.size === 1 && dragStart) {
    const t = [...touches.values()][0];
    const dx = t.x - dragStart.x, dy = t.y - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) { dragMoved = true; clearTimeout(longPressTimer); }
    HG.camera.x = dragStart.camX - dx / HG.camera.zoom;
    HG.camera.y = dragStart.camY - dy / HG.camera.zoom;
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  clearTimeout(longPressTimer);
  for (const t of e.changedTouches) {
    if (touches.size === 1 && !dragMoved) handleClick(t.clientX, t.clientY);
    touches.delete(t.identifier);
  }
  if (touches.size < 2) pinchStart = 0;
}, { passive: false });

// ---- 선택
function pick(sx, sy) {
  const g = HG.S && HG.S.game;
  if (!g) return null;
  const tile = HG.screenToTile(sx, sy);
  const hitR = HG.camera.zoom < 14 ? 1.6 : 1.0;
  let best = null, bestD = Infinity;
  for (const [id, u] of Object.entries(g.units)) {
    const p = HG.unitPos(id, u);
    const d = Math.hypot(p.x - tile.x, p.y - tile.y);
    if (d < hitR && d < bestD) { bestD = d; best = { kind: 'unit', id }; }
  }
  if (best) return best;
  for (const c of g.cities) {
    const d = Math.hypot(c.x - tile.x, c.y - tile.y);
    if (d < 1.4 + c.size * 0.2 && d < bestD) { bestD = d; best = { kind: 'city', id: c.id }; }
  }
  if (best) return best;
  const tx = Math.round(tile.x), ty = Math.round(tile.y);
  if (tx < 0 || ty < 0 || tx >= g.map.w || ty >= g.map.h) return null;
  return { kind: 'tile', x: tx, y: ty };
}

function handleClick(sx, sy) {
  if (HG.ordering) { handleOrder(sx, sy); return; }
  const sel = pick(sx, sy);
  HG.selected = sel && sel.kind !== 'tile' ? sel : (sel && HG.selected ? null : sel);
  HG.renderSelection && HG.renderSelection();
}

// 직접 명령: 선택한 내 부대를 그 지점으로 보낸다
function handleOrder(sx, sy) {
  const g = HG.S && HG.S.game;
  const sel = HG.selected;
  if (!g || !sel || sel.kind !== 'unit') return;
  const u = g.units[sel.id];
  const me = HG.myNation();
  if (!u || !me || u.o !== me.idx) return;
  const tile = HG.screenToTile(sx, sy);
  const x = Math.round(tile.x), y = Math.round(tile.y);
  HG.emit('orderUnit', { unit: sel.id, x, y }, (res) => {
    if (res && res.ok) { HG.toast('직접 명령: 이동 지시'); HG.flashOrder && HG.flashOrder(x, y); }
  });
  HG.ordering = false;
  canvas.classList.remove('ordering');
}
HG.setOrdering = (on) => { HG.ordering = !!on; canvas.classList.toggle('ordering', !!on); };

// ---- 미니맵 클릭 → 카메라 이동
minimap.addEventListener('mousedown', (e) => moveByMinimap(e.clientX, e.clientY));
minimap.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.touches[0]; moveByMinimap(t.clientX, t.clientY); }, { passive: false });
function moveByMinimap(sx, sy) {
  const g = HG.S && HG.S.game;
  if (!g) return;
  const r = minimap.getBoundingClientRect();
  HG.camera.x = ((sx - r.left) / r.width) * g.map.w;
  HG.camera.y = ((sy - r.top) / r.height) * g.map.h;
}

// ---- 키보드
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'Escape') { HG.selected = null; HG.setOrdering(false); HG.renderSelection && HG.renderSelection(); }
  const step = 6 / HG.camera.zoom * 10;
  if (e.key === 'ArrowLeft' || e.key === 'a') HG.camera.x -= step;
  if (e.key === 'ArrowRight' || e.key === 'd') HG.camera.x += step;
  if (e.key === 'ArrowUp' || e.key === 'w') HG.camera.y -= step;
  if (e.key === 'ArrowDown' || e.key === 's') HG.camera.y += step;
});
})();
