const crypto = require('crypto');
const prompts = require('./prompts');
const { callJSON } = require('./llm');
const { parseDiscoveryIntent, parseSeatPreference } = require('./intent');
const tm = require('./ticketmaster');
const { buildSeatMap, pickSeats } = require('./seats');

const FALLBACK_PRICES = { min: 45, max: 350, real: false };
const PARKING = { name: 'Lot H', description: 'right by the entrance', price: 42 };
const CARD = 'Amex ending 1337';
const REDIRECT = {
  early: "I can only help with finding live events and tickets. What kind of night are you after?",
  late: "I can only help with events and tickets, so let's get back to your order.",
};

function money(n, { cents = false } = {}) {
  const fixed = cents || !Number.isInteger(n) ? 2 : 0;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: fixed, maximumFractionDigits: fixed })}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function newSession(name) {
  return {
    name, stage: 'discovery', greeted: false, history: [], view: { type: 'welcome', name },
    intent: null, picks: [], event: null, priceRange: null, seatMap: null,
    pref: null, selection: null, rejected: [], parking: false, order: null,
  };
}

function seatPhrase(sel) {
  const seats = sel.seats.length > 1 ? `Seats ${sel.seats[0]}–${sel.seats[sel.seats.length - 1]}` : `Seat ${sel.seats[0]}`;
  return `Section ${sel.section}, Row ${sel.row}, ${seats}`;
}

function totals(s) {
  const tickets = s.selection.subtotal;
  const fees = round2(tickets * 0.08);
  const parking = s.parking ? PARKING.price : 0;
  return { tickets, fees, parking, total: round2(tickets + fees + parking) };
}

function seatsView(s) {
  return {
    type: 'seats', simulated: true, event: s.event, map: s.seatMap,
    selection: s.selection, parking: s.parking ? PARKING : null,
    totals: s.selection ? totals(s) : null,
  };
}

class Conversation {
  constructor({ llm = callJSON } = {}) {
    this.llm = llm;
  }

  greet(s, text) {
    if (s.greeted) return text;
    s.greeted = true;
    return `Hi ${s.name}! ${text}`;
  }

  async handle(s, { message, action, today }) {
    const replies = [];
    const say = (text) => replies.push(text);
    try {
      await this.route(s, { message: (message || '').trim(), action, today }, say);
    } catch (err) {
      console.error('[concierge] turn failed:', err.message);
      say('Sorry, I hit a snag on my end. Mind trying that again?');
    }
    const out = replies.map((text) => ({ id: crypto.randomUUID(), role: 'bot', text }));
    s.history.push(...out);
    return out;
  }

  async route(s, input, say) {
    switch (s.stage) {
      case 'discovery':
      case 'awaiting_city':
        return this.discovery(s, input, say);
      case 'results':
        return this.results(s, input, say);
      case 'seats':
      case 'proposed':
        return this.seats(s, input, say);
      case 'parking':
        return this.parkingTurn(s, input, say);
      case 'charge':
        return this.charge(s, input, say);
      default:
        return say("You're all set! Tap reset up top to plan another night out.");
    }
  }

  async discovery(s, { message, today }, say) {
    const intent = await parseDiscoveryIntent(message, { today, prior: s.intent, llm: this.llm });
    if (!intent.inScope) return say(this.greet(s, REDIRECT.early));
    s.intent = intent;
    if (intent.needsCity) {
      s.stage = 'awaiting_city';
      return say(this.greet(s, 'Sounds fun! Which city should I look in?'));
    }

    const { events } = await tm.searchEvents(intent);
    if (!events.length) {
      s.stage = 'discovery';
      return say(this.greet(s, `I couldn't find on-sale ${intent.segment} events in ${intent.city} for that window. Want to try different dates or a nearby city?`));
    }
    const cards = events.map(tm.toCard);
    const ranked = await this.llm(
      prompts.rankEvents({ cues: intent.cues, city: intent.city, dateLabel: intent.dateLabel }),
      cards.map(tm.describe).join('\n'),
      { maxTokens: 800 },
    );
    const byId = new Map(cards.map((c) => [c.id, c]));
    const picks = [];
    for (const p of (ranked && ranked.picks) || []) {
      const card = byId.get(p.id);
      if (card && !picks.includes(card)) picks.push({ ...card, reason: String(p.reason || '') });
      if (picks.length === 3) break;
    }
    for (const c of cards) {
      if (picks.length >= Math.min(3, cards.length)) break;
      if (!picks.find((p) => p.id === c.id)) picks.push({ ...c, reason: '' });
    }

    s.picks = picks;
    s.stage = 'results';
    const state = intent.stateCode || picks[0].stateCode;
    s.view = {
      type: 'discovery',
      name: s.name,
      title: /weekend/i.test(intent.dateLabel) ? "Here's your weekend." : 'Here are your picks.',
      summary: (ranked && ranked.hero_summary) || `Live ${intent.segment} in ${intent.city}, picked for you.`,
      chips: [state ? `${intent.city}, ${state}` : intent.city, intent.dateLabel],
      picks,
    };
    const sentence = (ranked && ranked.chat_sentence) || `I found ${picks.length} shows that fit.`;
    say(this.greet(s, `${sentence.replace(/[.!?\s]+$/, '')}, so take a look on the right and pick the one you like!`));
  }

  async results(s, { message, action, today }, say) {
    let index = null;
    if (action && action.type === 'select') index = Number(action.index);
    else {
      const r = await this.llm(prompts.eventSelection({ picks: s.picks }), `Fan message: "${message}"`);
      if (r.action === 'select' && r.index >= 1 && r.index <= s.picks.length) index = r.index - 1;
      else if (r.action === 'new_search') {
        s.stage = 'discovery';
        return this.discovery(s, { message, today }, say);
      } else if (r.action === 'off_topic') return say(REDIRECT.early);
      else return say('Just tell me which one you like, by name or number.');
    }
    if (!(index >= 0 && index < s.picks.length)) return say('Just tell me which one you like, by name or number.');

    s.event = s.picks[index];
    s.priceRange = s.event.priceRange || FALLBACK_PRICES;
    s.seatMap = buildSeatMap(s.event.id, s.priceRange);
    s.pref = { quantity: (s.intent && s.intent.partySize) || null, budget: null, nearStage: false, aisle: false };
    s.selection = null;
    s.rejected = [];
    s.stage = 'seats';
    s.view = seatsView(s);
    say(`Great pick. Seats start at ${money(s.priceRange.min)} and go up to ${money(s.priceRange.max)}. Anything in particular you're looking for?`);
  }

  async seats(s, { message, action }, say) {
    let pref;
    if (action && action.type === 'accept' && s.selection) pref = { ...s.pref, action: 'accept' };
    else {
      pref = await parseSeatPreference(message, {
        event: s.event,
        priceRange: s.priceRange,
        proposal: s.stage === 'proposed' && s.selection ? `${seatPhrase(s.selection)}, ${money(s.selection.price)} each` : null,
        current: s.pref,
        partySize: s.intent && s.intent.partySize,
        llm: this.llm,
      });
    }

    if (pref.action === 'off_topic') return say(REDIRECT.late);
    if (pref.action === 'accept' && s.stage === 'proposed') {
      s.stage = 'parking';
      return say(`Want to add parking? ${PARKING.name}, ${PARKING.description}, is ${money(PARKING.price)}.`);
    }
    if (pref.action === 'reject' && s.selection) s.rejected.push(s.selection.section);
    else s.rejected = [];

    s.pref = { quantity: pref.quantity, budget: pref.budget, nearStage: pref.nearStage, aisle: pref.aisle };
    const sel = pickSeats(s.seatMap, s.pref, s.rejected);
    if (!sel) {
      s.rejected = [];
      return say("That's everything I have that fits. Want to try a different budget or location?");
    }
    s.selection = sel;
    s.stage = 'proposed';
    s.view = seatsView(s);
    const where = `${seatPhrase(sel)}${sel.aisle ? ', on the aisle' : ''}`;
    if (sel.withinBudget) say(`How about these? ${where}. ${money(sel.price)} each.`);
    else say(`Nothing's open under ${money(s.pref.budget)} right now; the closest is ${where} at ${money(sel.price)} each. Want those?`);
  }

  async yesNo(question, message) {
    const r = await this.llm(prompts.yesNo({ question }), `Fan reply: "${message}"`);
    return r.answer;
  }

  chargeQuestion(s) {
    return `Should I charge your ${CARD.replace(' ending ', ' ending ')} on file for ${money(totals(s).total, { cents: true })}?`;
  }

  async parkingTurn(s, { message }, say) {
    const answer = await this.yesNo(`Want to add parking? ${PARKING.name}, ${PARKING.description}, is $${PARKING.price}.`, message);
    if (answer === 'off_topic') return say(REDIRECT.late);
    if (answer !== 'yes' && answer !== 'no') return say(`Want me to add parking in ${PARKING.name} for ${money(PARKING.price)}? Just say yes or no.`);
    s.parking = answer === 'yes';
    s.stage = 'charge';
    s.view = seatsView(s);
    say(`${s.parking ? 'Done.' : 'No problem.'} ${this.chargeQuestion(s)}`);
  }

  async charge(s, { message }, say) {
    const answer = await this.yesNo(this.chargeQuestion(s), message);
    if (answer === 'off_topic') return say(REDIRECT.late);
    if (answer === 'no') {
      s.stage = 'proposed';
      return say("No problem, nothing's been charged. Tell me what you'd like to change about your seats.");
    }
    if (answer !== 'yes') return say(`Just say yes and I'll charge ${money(totals(s).total, { cents: true })} to your ${CARD}.`);

    const t = totals(s);
    const cityCode = (s.event.city || 'TM').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    const digits = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
    s.order = {
      number: `#${digits(2)}-${digits(5)}/${cityCode}`,
      event: s.event,
      selection: s.selection,
      parking: s.parking ? PARKING : null,
      totals: t,
      payment: CARD,
    };
    s.stage = 'done';
    s.view = { type: 'order', simulated: true, order: s.order };
    say(`You're all set for ${s.event.weekdayLong}! Tickets are in your app 🎶`);
  }
}

module.exports = { Conversation, newSession, money };
