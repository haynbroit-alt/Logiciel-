// Couche d'abstraction IA : OMNIA fonctionne avec plusieurs fournisseurs, ou sans aucun.
// - local      : aucun modèle génératif, moteurs déterministes uniquement (gratuit, hors ligne).
// - ollama     : modèles open source exécutés localement (gratuit).
// - openai / mistral / groq / openrouter / compatible : toute API « chat completions ».
// - anthropic  : Claude, via le SDK officiel (dépendance optionnelle).
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider, PRESETS } from './openai-compatible.js';

export const PROVIDERS = ['local', 'anthropic', ...Object.keys(PRESETS), 'compatible'];

export function createAI(cfg = {}) {
  const name = (cfg.provider ?? 'local').toLowerCase();
  let provider = null;
  if (name === 'anthropic') provider = createAnthropicProvider(cfg);
  else if (name !== 'local') {
    if (!PRESETS[name] && name !== 'compatible') throw new Error(`Fournisseur d'IA inconnu : ${name}. Valeurs possibles : ${PROVIDERS.join(', ')}`);
    provider = createOpenAICompatibleProvider(name, cfg);
  }
  return {
    provider: name,
    model: provider?.model ?? null,
    generative: Boolean(provider),
    // Retourne { text, provider, model } ou lève une erreur ; les appelants basculent alors
    // sur le mode local et le signalent à l'utilisateur (transparence sur l'origine des résultats).
    async complete({ system, prompt, maxTokens = 4000 }) {
      if (!provider) throw new Error('Aucun fournisseur d\'IA générative configuré');
      const text = await provider.complete({ system, prompt, maxTokens });
      return { text, provider: name, model: provider.model };
    },
  };
}

// Extrait le premier objet JSON d'une réponse de modèle (tolère les blocs ```json).
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
