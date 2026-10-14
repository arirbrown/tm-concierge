// Every LLM prompt used by the concierge lives in this file.
// Each prompt asks Claude for JSON only; the backend validates the result.

function intentExtraction({ today, weekday }) {
  return `You extract search intent from a fan's message for a Ticketmaster event search.
Today is ${weekday}, ${today}.

Return ONLY a JSON object (no prose, no code fences) with exactly these keys:
{
  "in_scope": boolean,      // true if the message is about finding or attending live events (concerts, sports, theatre, comedy...) or answers the concierge's last question. false for unrelated requests (weather, coding, trivia, homework...).
  "city": string | null,    // city name only, e.g. "Chicago". null if no city is stated. Never guess a city.
  "state_code": string | null, // two-letter state/province code if you know it for that city, e.g. "IL"
  "timezone": string | null,   // IANA timezone of the city, e.g. "America/Chicago"
  "date_phrase": string | null, // the date words the fan used, verbatim, e.g. "this weekend", "tomorrow night"
  "start_date": "YYYY-MM-DD" | null, // first day of the window, resolved relative to today
  "end_date": "YYYY-MM-DD" | null,   // last day of the window (inclusive)
  "segment": "music" | "sports" | "arts" | null, // arts = theatre, comedy, dance, classical
  "cues": string,           // mood, genre and vibe words, e.g. "upbeat, high energy, going with a friend". "" if none.
  "party_size": integer | null // total people including the fan ("with a friend" = 2)
}

Date rules: "this weekend" = the coming Friday through Sunday; if today is Friday, Saturday or Sunday it is today through Sunday. "Tonight"/"today" = today only. If no dates are mentioned, use null for all three date fields.
If "Previous intent" is provided, the new message may only add or change some fields (for example it may only name a city). Return the full merged intent, keeping previous values the fan did not change.`;
}

function rankEvents({ cues, city, dateLabel }) {
  return `You are a Ticketmaster concierge choosing events for a fan in ${city} (${dateLabel}).
The fan's cues: "${cues || 'no specific preferences'}".

You will receive candidate events, one per line, each starting with its id. These come straight from the Ticketmaster Discovery API.
Choose the 3 that best match the fan's cues. Only use ids from the list. Prefer variety (different nights or venues) when choices are equally good. Skip anything that looks sold out, cancelled, or is an add-on rather than a show (parking, VIP upgrade, lounge access).

Return ONLY a JSON object (no prose, no code fences):
{
  "picks": [ { "id": "<id from the list>", "reason": "<max 12 words on why it fits the cues>" } ],  // exactly 3, best first (fewer only if fewer candidates)
  "chat_sentence": "<one warm sentence, max 20 words, describing the picks as a set, e.g. 'Three upbeat shows this weekend that should be a blast with a friend.' Do NOT name any artist, event or venue. Do not claim anything about seat availability.>",
  "hero_summary": "<one short line, e.g. 'Upbeat live music in Chicago, Fri–Sun, picked for you.'>"
}`;
}

function eventSelection({ picks }) {
  const list = picks
    .map((p, i) => `${i + 1}. ${p.name} (${p.dayTime}, ${p.venue})`)
    .join('\n');
  return `A Ticketmaster concierge just showed a fan these three events:
${list}

Decide what the fan's latest message means. Return ONLY a JSON object (no prose):
{ "action": "select" | "new_search" | "off_topic" | "unclear", "index": 1 | 2 | 3 | null }

- "select": the fan chose one of the three (by name, partial name, number, ordinal like "the first one", or day). Set "index".
- "new_search": the fan wants different options (other dates, another city, another genre, "anything else?").
- "off_topic": the message has nothing to do with events or tickets.
- "unclear": anything else.`;
}

function seatPreference({ eventName, priceMin, priceMax, proposal, current, partySize }) {
  return `You parse a fan's seat preferences for "${eventName}". Seats cost $${priceMin}–$${priceMax} each.
${proposal ? `The concierge has proposed: ${proposal}.` : 'No seats have been proposed yet; the concierge asked what the fan is looking for.'}
Preferences so far: ${JSON.stringify(current || {})}. Known party size: ${partySize || 'unknown'}.

Return ONLY a JSON object (no prose):
{
  "action": "accept" | "change" | "reject" | "anything" | "off_topic",
  "quantity": integer | null,
  "budget_per_seat": number | null,
  "near_stage": boolean | null,
  "aisle": boolean | null
}

- "accept": the fan approves the proposed seats ("perfect", "yes", "book it", "those work"). Only possible when seats were proposed.
- "change": the fan states new or updated preferences (quantity, budget, location).
- "reject": the fan says no or asks for other seats without giving new preferences.
- "anything": the fan has no particular preference.
- "off_topic": unrelated to tickets or events.
- quantity: number of tickets. "going with a friend" / "the two of us" = 2, "just me" = 1. null if not stated in this message.
- budget_per_seat: maximum price per ticket in dollars. If the fan gives a total budget, divide by the quantity. null if not stated in this message.
- near_stage: true if they want to be close to the stage / floor / front. null if not stated.
- aisle: true if they want aisle seats. null if not stated.`;
}

function yesNo({ question }) {
  return `A Ticketmaster concierge asked the fan: "${question}"
Classify the fan's reply. Return ONLY a JSON object (no prose):
{ "answer": "yes" | "no" | "unclear" | "off_topic" }`;
}

module.exports = { intentExtraction, rankEvents, eventSelection, seatPreference, yesNo };
