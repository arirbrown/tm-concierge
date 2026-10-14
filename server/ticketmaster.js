const { WEEKDAYS, addDays } = require('./intent');

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function isoZ(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Local-day window in the city's timezone -> UTC timestamps the API expects.
function utcWindow(startDate, endDate, tz) {
  const startNaive = Date.parse(`${startDate}T00:00:00Z`);
  const endNaive = Date.parse(`${endDate}T23:59:59Z`);
  if (!tz) return { start: isoZ(startNaive - 14 * 3600e3), end: isoZ(endNaive + 12 * 3600e3) };
  return { start: isoZ(startNaive - tzOffsetMs(startNaive, tz)), end: isoZ(endNaive - tzOffsetMs(endNaive, tz)) };
}

async function fetchEvents(params) {
  const qs = new URLSearchParams({ apikey: process.env.TICKETMASTER_API_KEY || '', ...params });
  const res = await fetch(`${BASE}?${qs}`);
  if (!res.ok) throw new Error(`Ticketmaster Discovery API returned HTTP ${res.status}`);
  const data = await res.json();
  return (data._embedded && data._embedded.events) || [];
}

async function searchEvents(intent) {
  const window = utcWindow(intent.startDate, intent.endDate, intent.timezone);
  const params = {
    city: intent.city,
    startDateTime: window.start,
    endDateTime: window.end,
    classificationName: intent.classificationName,
    size: '40',
    sort: 'date,asc',
  };
  const onsale = (list) => list.filter((e) => e.dates && e.dates.status && e.dates.status.code === 'onsale');
  let events = onsale(await fetchEvents(params));
  let widened = false;
  if (events.length < 5) {
    const wider = onsale(await fetchEvents({ ...params, radius: '50', unit: 'miles' }));
    if (wider.length > events.length) { events = wider; widened = true; }
  }
  const inWindow = (e) => {
    const d = e.dates.start && e.dates.start.localDate;
    return !d || (d >= intent.startDate && d <= intent.endDate);
  };
  const seen = new Set();
  events = events.filter((e) => {
    if (!inWindow(e) || /sold out/i.test(e.name)) return false;
    const key = `${e.name.toLowerCase()}|${e.dates.start.localDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { events, widened };
}

function pickImage(images = []) {
  const wide = images.filter((i) => i.ratio === '16_9');
  const pool = wide.length ? wide : images;
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => Math.abs(a.width - 640) - Math.abs(b.width - 640) || (a.fallback ? 1 : -1))[0].url;
}

function formatTime(localTime) {
  if (!localTime) return 'Time TBA';
  const [h, m] = localTime.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

function usablePriceRange(event) {
  const pr = event.priceRanges && event.priceRanges[0];
  if (pr && pr.min > 0 && pr.max > pr.min) return { min: pr.min, max: pr.max, real: true };
  return null;
}

function toCard(event) {
  const venue = (event._embedded && event._embedded.venues && event._embedded.venues[0]) || {};
  const localDate = event.dates.start.localDate;
  const [y, mo, d] = localDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const time = formatTime(event.dates.start.localTime);
  const cls = (event.classifications && event.classifications[0]) || {};
  const attractions = ((event._embedded && event._embedded.attractions) || []).map((a) => a.name);
  const pr = usablePriceRange(event);
  return {
    id: event.id,
    name: event.name,
    url: event.url,
    image: pickImage(event.images),
    localDate,
    weekdayLong: WEEKDAYS[dow],
    dateBlock: { mon: MONTHS[mo - 1].toUpperCase(), dd: String(d), yyyy: String(y) },
    dayTime: `${WEEKDAYS[dow].slice(0, 3)} • ${time}`,
    dateLong: `${WEEKDAYS[dow].slice(0, 3)} • ${MONTHS[mo - 1]} ${d} • ${time}`,
    venue: venue.name || 'Venue TBA',
    city: (venue.city && venue.city.name) || '',
    stateCode: (venue.state && venue.state.stateCode) || '',
    genre: [cls.genre && cls.genre.name, cls.subGenre && cls.subGenre.name].filter((g) => g && g !== 'Undefined').join(' / '),
    attractions,
    tag: pr ? `On sale · from $${Math.round(pr.min)}` : 'On sale now',
    priceRange: pr,
  };
}

function describe(card) {
  return [
    card.id,
    card.name,
    card.genre || 'genre n/a',
    card.venue,
    `${card.weekdayLong} ${card.localDate} ${card.dayTime.split(' • ')[1]}`,
    card.attractions.length ? `artists: ${card.attractions.join(', ')}` : 'artists: n/a',
  ].join(' | ');
}

module.exports = { searchEvents, toCard, describe, utcWindow, pickImage, addDays };
