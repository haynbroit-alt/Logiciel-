// Couche d'abstraction IA : OMNIA fonctionne avec plusieurs fournisseurs, ou sans aucun.
// - local      : aucun modèle génératif, moteurs déterministes uniquement (gratuit, hors ligne).
// - ollama     : modèles open source exécutés localement (gratuit).
// - openai / mistral / groq / openrouter / compatible : toute API « chat completions ».
// - anthropic  : Claude, via le SDK officiel (dépendance optionnelle).
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider, PRESETS } from './openai-compatible.js';

export const PROVIDERS = ['local', 'anthropic', ...Object.keys(PRESETS), 'compatible'];

function createProvider(name, cfg) {
  if (name === 'anthropic') return createAnthropicProvider(cfg);
  if (!PRESETS[name] && name !== 'compatible') throw new Error(`Fournisseur d'IA inconnu : ${name}. Valeurs possibles : ${PROVIDERS.join(', ')}`);
  return createOpenAICompatibleProvider(name, cfg);
}

// `provider` accepte une liste ordonnée (« ollama,mistral ») : chaque fournisseur est essayé à son tour.
// Avec plusieurs fournisseurs, chacun lit ses propres réglages : OMNIA_AI_<NOM>_API_KEY, _MODEL, _BASE_URL.
export function createAI(cfg = {}, env = {}) {
  const names = [...new Set(String(cfg.provider ?? 'local').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'local'))];
  const own = (name, key) => env[`OMNIA_AI_${name.toUpperCase()}_${key}`] ?? '';
  const chain = names.map((name) => ({
    name,
    impl: createProvider(name, names.length === 1
      ? { ...cfg, apiKey: own(name, 'API_KEY') || cfg.apiKey, model: own(name, 'MODEL') || cfg.model, baseUrl: own(name, 'BASE_URL') || cfg.baseUrl }
      : { apiKey: own(name, 'API_KEY'), model: own(name, 'MODEL'), baseUrl: own(name, 'BASE_URL') }),
  }));
  return {
    provider: names.join(' → ') || 'local',
    providers: names,
    model: chain.map((c) => c.impl.model).join(' → ') || null,
    generative: chain.length > 0,
    // Retourne { text, provider, model } ou lève une erreur ; les appelants basculent alors
    // sur le mode local et le signalent à l'utilisateur (transparence sur l'origine des résultats).
    async complete({ system, prompt, maxTokens = 4000 }) {
      if (!chain.length) throw new Error('Aucun fournisseur d\'IA générative configuré');
      const errors = [];
      for (const { name, impl } of chain) {
        try { return { text: await impl.complete({ system, prompt, maxTokens }), provider: name, model: impl.model, skipped: errors.length ? errors : undefined }; }
        catch (e) { errors.push(`${name} : ${e.message}`); }
      }
      throw new Error(errors.join(' ; '));
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
