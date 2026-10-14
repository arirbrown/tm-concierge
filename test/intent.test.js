const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiscoveryIntent, parseSeatPreference } = require('../server/intent');

// The LLM is stubbed so these run offline and deterministically.
const stubLLM = (response) => async () => response;

test('missing city: intent is flagged so the bot asks instead of searching', async () => {
  const intent = await parseDiscoveryIntent('Something upbeat this weekend?', {
    today: '2026-10-14',
    llm: stubLLM({ in_scope: true, city: null, date_phrase: 'this weekend', segment: 'music', cues: 'upbeat' }),
  });
  assert.equal(intent.needsCity, true);
  assert.equal(intent.city, null);
  assert.equal(intent.inScope, true);
});

test('"this weekend" resolves to the coming Friday through Sunday', async () => {
  // Wednesday 2026-10-14. Even if the model returns wrong dates, the phrase wins.
  const intent = await parseDiscoveryIntent("I'm in Chicago this weekend with a friend", {
    today: '2026-10-14',
    llm: stubLLM({ in_scope: true, city: 'Chicago', timezone: 'America/Chicago', date_phrase: 'this weekend', start_date: '2026-10-14', end_date: '2026-10-14', party_size: 2 }),
  });
  assert.equal(intent.startDate, '2026-10-16');
  assert.equal(intent.endDate, '2026-10-18');
  assert.equal(intent.dateLabel, 'This weekend');
  assert.equal(intent.classificationName, 'Music');
  assert.equal(intent.partySize, 2);

  // On a Saturday, "this weekend" is today through Sunday.
  const sat = await parseDiscoveryIntent('Chicago this weekend', {
    today: '2026-10-17',
    llm: stubLLM({ in_scope: true, city: 'Chicago', date_phrase: 'this weekend' }),
  });
  assert.deepEqual([sat.startDate, sat.endDate], ['2026-10-17', '2026-10-18']);
});

test('budget parsing: per-seat, formatted strings, and totals split by quantity', async () => {
  const ctx = { event: { name: 'Test Show' }, priceRange: { min: 45, max: 350 } };

  const regexFallback = await parseSeatPreference('Aisle seats close to the stage, under $200 each. Going with a friend.', {
    ...ctx,
    llm: stubLLM({ action: 'change', quantity: 2, budget_per_seat: null, near_stage: true, aisle: true }),
  });
  assert.equal(regexFallback.budget, 200);
  assert.equal(regexFallback.quantity, 2);
  assert.equal(regexFallback.nearStage, true);
  assert.equal(regexFallback.aisle, true);

  const formatted = await parseSeatPreference('up to $1,150 a seat', {
    ...ctx,
    llm: stubLLM({ action: 'change', quantity: 2, budget_per_seat: '$1,150' }),
  });
  assert.equal(formatted.budget, 1150);

  const total = await parseSeatPreference('$400 total for the two of us', {
    ...ctx,
    llm: stubLLM({ action: 'change', quantity: 2 }),
  });
  assert.equal(total.budget, 200);
});
