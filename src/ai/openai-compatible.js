// Fournisseur générique pour toute API compatible « chat completions »
// (Ollama en local, Mistral, OpenAI, Groq, OpenRouter, serveur auto-hébergé…).
export const PRESETS = {
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', keyRequired: false },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyRequired: true },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyRequired: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyRequired: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', keyRequired: true },
};

export function createOpenAICompatibleProvider(name, cfg) {
  const preset = PRESETS[name] ?? { baseUrl: '', model: '', keyRequired: false };
  const baseUrl = (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const model = cfg.model || preset.model;
  if (!baseUrl) throw new Error('OMNIA_AI_BASE_URL est requis pour le fournisseur « compatible ».');
  if (!model) throw new Error('OMNIA_AI_MODEL est requis pour le fournisseur « compatible ».');
  if (preset.keyRequired && !cfg.apiKey) throw new Error(`OMNIA_AI_API_KEY est requis pour le fournisseur « ${name} ».`);
  return {
    model,
    async complete({ system, prompt, maxTokens }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`Fournisseur d'IA ${name} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error(`Fournisseur d'IA ${name} : réponse vide.`);
      return text;
    },
  };
}
