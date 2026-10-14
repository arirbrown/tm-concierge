const prompts = require('./prompts');

const SEGMENTS = { music: 'Music', sports: 'Sports', arts: 'Arts & Theatre' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// Deterministic resolution for the most common relative phrases; anything else falls back to Claude's dates.
function resolveDateWindow(phrase, today) {
  if (!phrase) return null;
  const p = phrase.toLowerCase();
  const dow = dayOfWeek(today);
  if (/\bnext weekend\b/.test(p)) return null;
  if (/\bweekend\b/.test(p)) {
    if (dow === 0) return { start: today, end: today };
    if (dow === 5 || dow === 6) return { start: today, end: addDays(today, 7 - dow) };
    return { start: addDays(today, 5 - dow), end: addDays(today, 7 - dow) };
  }
  if (/\b(tonight|today)\b/.test(p)) return { start: today, end: today };
  if (/\btomorrow\b/.test(p)) return { start: addDays(today, 1), end: addDays(today, 1) };
  return null;
}

function dateLabel(window, phrase, today) {
  if (phrase && /\bweekend\b/i.test(phrase) && !/\bnext\b/i.test(phrase)) return 'This weekend';
  if (window.start === window.end) {
    if (window.start === today) return 'Today';
    if (window.start === addDays(today, 1)) return 'Tomorrow';
    return WEEKDAYS[dayOfWeek(window.start)];
  }
  const short = (iso) => WEEKDAYS[dayOfWeek(iso)].slice(0, 3);
  return `${short(window.start)}–${short(window.end)}`;
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function blank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

async function parseDiscoveryIntent(message, { today, prior = null, llm }) {
  const system = prompts.intentExtraction({ today, weekday: WEEKDAYS[dayOfWeek(today)] });
  const user = `Previous intent: ${prior ? JSON.stringify(prior.raw) : 'none'}\nFan message: "${message}"`;
  const raw = (await llm(system, user)) || {};

  const pick = (key) => (blank(raw[key]) && prior ? prior.raw[key] : raw[key]);
  const city = blank(pick('city')) ? null : String(pick('city')).trim();
  const datePhrase = pick('date_phrase') || null;

  let window = resolveDateWindow(datePhrase, today);
  const s = pick('start_date');
  const e = pick('end_date');
  if (!window && ISO_DATE.test(s || '')) window = { start: s, end: ISO_DATE.test(e || '') && e >= s ? e : s };
  if (!window) window = { start: today, end: addDays(today, 6) };

  const segment = SEGMENTS[pick('segment')] ? pick('segment') : 'music';
  const partySize = Number.isInteger(toNumber(pick('party_size'))) ? toNumber(pick('party_size')) : null;

  return {
    raw: { ...raw, city, date_phrase: datePhrase, start_date: window.start, end_date: window.end, segment },
    inScope: raw.in_scope !== false,
    needsCity: !city,
    city,
    stateCode: pick('state_code') || null,
    timezone: validTimezone(pick('timezone')),
    startDate: window.start,
    endDate: window.end,
    dateLabel: dateLabel(window, datePhrase, today),
    segment,
    classificationName: SEGMENTS[segment],
    cues: pick('cues') || '',
    partySize,
  };
}

// Regex fallback when the model omits a budget: "under $200 each", "$400 total".
function extractBudget(text, quantity) {
  const m = String(text).match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!m) return null;
  const amount = toNumber(m[1]);
  if (amount == null) return null;
  if (/\b(total|all in|altogether|combined)\b/i.test(text) && quantity > 1) return Math.round((amount / quantity) * 100) / 100;
  return amount;
}

async function parseSeatPreference(message, { event, priceRange, proposal = null, current = {}, partySize = null, llm }) {
  const system = prompts.seatPreference({
    eventName: event.name,
    priceMin: priceRange.min,
    priceMax: priceRange.max,
    proposal,
    current,
    partySize,
  });
  const raw = (await llm(system, `Fan message: "${message}"`)) || {};
  const actions = ['accept', 'change', 'reject', 'anything', 'off_topic'];
  const action = actions.includes(raw.action) ? raw.action : 'change';

  const q = toNumber(raw.quantity);
  const quantity = Number.isInteger(q) && q >= 1 && q <= 8 ? q : current.quantity || partySize || 2;
  let budget = toNumber(raw.budget_per_seat);
  if (budget == null || budget <= 0) budget = extractBudget(message, quantity);
  if (budget == null) budget = current.budget ?? null;

  return {
    action,
    quantity,
    budget,
    nearStage: typeof raw.near_stage === 'boolean' ? raw.near_stage : !!current.nearStage,
    aisle: typeof raw.aisle === 'boolean' ? raw.aisle : !!current.aisle,
  };
}

module.exports = {
  parseDiscoveryIntent,
  parseSeatPreference,
  resolveDateWindow,
  extractBudget,
  addDays,
  dayOfWeek,
  WEEKDAYS,
};
