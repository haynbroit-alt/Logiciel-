// Fournisseur Claude via le SDK officiel @anthropic-ai/sdk (dépendance optionnelle,
// chargée à la demande : le noyau d'OMNIA reste utilisable sans elle).
const DEFAULT_MODEL = 'claude-opus-5-5';

export function createAnthropicProvider(cfg) {
  const model = cfg.model || DEFAULT_MODEL;
  let clientPromise = null;
  const getClient = () => {
    clientPromise ??= import('@anthropic-ai/sdk').then(
      ({ default: Anthropic }) => (cfg.apiKey ? new Anthropic({ apiKey: cfg.apiKey }) : new Anthropic()),
      () => { throw new Error('Le SDK Anthropic n\'est pas installé : exécutez « npm install @anthropic-ai/sdk ».'); },
    );
    return clientPromise;
  };
  return {
    model,
    async complete({ system, prompt, maxTokens }) {
      const client = await getClient();
      // Repli côté serveur activé : si le modèle décline la requête, l'API la rejoue
      // sur un modèle de secours au sein du même appel.
      const response = await client.beta.messages.create({
        model,
        max_tokens: Math.min(maxTokens, 16000),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') throw new Error('Le modèle a décliné cette requête.');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) throw new Error('Réponse vide du modèle.');
      return text;
    },
  };
}
