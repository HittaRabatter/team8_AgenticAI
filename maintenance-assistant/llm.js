// Minimal Azure OpenAI chat client. Settings come from the Settings screen (or .env); returns control to rules when unset.
const { getLlm } = require("./config");

const isConfigured = () => {
  const c = getLlm();
  return Boolean(c.endpoint && c.deployment && c.apiKey);
};

async function chatJson(system, payload) {
  const c = getLlm();
  const url = `${c.endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(c.deployment)}/chat/completions?api-version=${c.apiVersion || "2024-10-21"}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": c.apiKey },
    body: JSON.stringify({
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM request failed with status ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = { isConfigured, chatJson };
