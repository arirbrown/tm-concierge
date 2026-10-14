// Simulated arena inventory. Geometry, availability and prices are generated
// deterministically from the event id so the same event always looks the same.

const VIEW = { w: 480, h: 270, cx: 250, cy: 135 };
const STAGE = { x: 102, y: 110, w: 24, h: 50 };
const TIER_RANK = { floor: 0, lower: 1, upper: 2 };
const STAGE_CENTER = { x: STAGE.x + STAGE.w / 2, y: STAGE.y + STAGE.h / 2 };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function ellipsePoint(rx, ry, deg) {
  const a = (deg * Math.PI) / 180;
  return [VIEW.cx + rx * Math.cos(a), VIEW.cy + ry * Math.sin(a)];
}

function ring({ first, count, inner, outer, gapHalf, offset }) {
  const startDeg = 180 + gapHalf;
  const span = 360 - 2 * gapHalf;
  const step = span / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a0 = startDeg + i * step + 0.7;
    const a1 = startDeg + (i + 1) * step - 0.7;
    const pts = [];
    for (let k = 0; k <= 4; k++) pts.push(ellipsePoint(outer.rx, outer.ry, a0 + ((a1 - a0) * k) / 4));
    for (let k = 4; k >= 0; k--) pts.push(ellipsePoint(inner.rx, inner.ry, a0 + ((a1 - a0) * k) / 4));
    const mid = (a0 + a1) / 2;
    const label = ellipsePoint((inner.rx + outer.rx) / 2, (inner.ry + outer.ry) / 2, mid);
    out.push({
      id: String(first + ((i - offset + count) % count)),
      points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      label: { x: +label[0].toFixed(1), y: +label[1].toFixed(1) },
    });
  }
  return out;
}

function floor() {
  const out = [];
  const cols = [[3, 2, 1], [6, 5, 4]];
  cols.forEach((ids, c) => {
    ids.forEach((id, r) => {
      const x = 140 + c * 56;
      const y = 87 + r * 33;
      out.push({
        id: String(id),
        rect: { x, y, w: 52, h: 29 },
        label: { x: x + 26, y: y + 14.5 },
      });
    });
  });
  return out;
}

function buildSeatMap(eventId, priceRange) {
  const tiers = {
    floor: floor(),
    lower: ring({ first: 101, count: 22, inner: { rx: 150, ry: 78 }, outer: { rx: 180, ry: 98 }, gapHalf: 38, offset: 2 }),
    upper: ring({ first: 301, count: 34, inner: { rx: 188, ry: 104 }, outer: { rx: 222, ry: 126 }, gapHalf: 22, offset: 4 }),
  };
  const band = { floor: [0.82, 1.0], lower: [0.3, 0.65], upper: [0.04, 0.28] };
  const { min, max } = priceRange;
  const sections = [];
  for (const [tier, list] of Object.entries(tiers)) {
    const dists = list.map((s) => Math.hypot(s.label.x - STAGE_CENTER.x, s.label.y - STAGE_CENTER.y));
    const dMin = Math.min(...dists);
    const dMax = Math.max(...dists);
    list.forEach((s, i) => {
      const closeness = 1 - (dists[i] - dMin) / (dMax - dMin || 1);
      const [lo, hi] = band[tier];
      const raw = min + (max - min) * (lo + (hi - lo) * closeness);
      const price = Math.min(max, Math.max(min, max - min >= 50 ? Math.round(raw / 5) * 5 : Math.round(raw * 2) / 2));
      const r = hash(`${eventId}:${s.id}`);
      const availability = tier !== 'floor' && r < 0.18 ? 'sold' : r < 0.45 ? 'limited' : 'available';
      sections.push({ ...s, tier, distance: +dists[i].toFixed(1), price, availability });
    });
  }
  return { view: VIEW, stage: STAGE, sections, priceRange };
}

function pickSeats(map, pref, exclude = []) {
  const open = map.sections.filter((s) => s.availability !== 'sold' && !exclude.includes(s.id));
  if (!open.length) return null;
  const within = pref.budget == null ? open : open.filter((s) => s.price <= pref.budget);
  // "Close to the stage": floor beats lower bowl beats upper deck, then map distance.
  const closeness = (x) => TIER_RANK[x.tier] * 1000 + x.distance;
  const pool = within.length
    ? within.slice().sort((a, b) => (pref.nearStage || !pref.budget ? closeness(a) - closeness(b) : b.price - a.price || closeness(a) - closeness(b)))
    : open.slice().sort((a, b) => a.price - b.price || a.distance - b.distance);
  const s = pool[0];
  const r = hash(`${s.id}:${pref.quantity}:${exclude.length}`);
  const row = s.tier === 'upper' ? 1 + Math.floor(r * 8) : 2 + Math.floor(r * 7);
  const firstSeat = pref.aisle ? 1 : 5 + Math.floor(hash(`${s.id}:seat`) * 10);
  const seats = Array.from({ length: pref.quantity }, (_, i) => firstSeat + i);
  const { min, max } = map.priceRange;
  const platinum = s.tier === 'floor' || s.price >= min + 0.6 * (max - min);
  return {
    section: s.id,
    tier: s.tier,
    row,
    seats,
    aisle: !!pref.aisle,
    price: s.price,
    quantity: pref.quantity,
    label: platinum ? 'Official Platinum' : 'Standard',
    withinBudget: within.length > 0,
    subtotal: Math.round(s.price * pref.quantity * 100) / 100,
  };
}

module.exports = { buildSeatMap, pickSeats };
