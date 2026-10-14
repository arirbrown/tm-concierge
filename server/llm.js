const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';
let client;

function getClient() {
  if (!client) {
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Only needed for keys that are not scoped to a workspace.
      ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}),
    });
  }
  return client;
}

function parseJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM response contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function callJSON(system, user, { maxTokens = 600 } = {}) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJSON(text);
}

module.exports = { callJSON, parseJSON, MODEL };
