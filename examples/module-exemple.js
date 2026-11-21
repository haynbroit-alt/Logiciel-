// Exemple de module externe pour OMNIA Ω.
// Pour l'essayer : copiez ce fichier dans le dossier `data/modules/` (ou celui désigné par
// OMNIA_MODULES_DIR), redémarrez, puis activez « Suivi des priorités » dans Réglages → Modules.
//
// Un module ne touche jamais la base directement : il déclare ce qu'il sait faire, et le noyau
// l'appelle avec une interface limitée à l'espace concerné (`api`).
export default {
  id: 'suivi-priorites',
  name: 'Suivi des priorités',
  description: 'Signale les tâches prioritaires sans échéance et consigne les tâches terminées.',
  tier: 'gratuit',

  // 1. Une règle d'analyse : reçoit le contexte, retourne un constat (ou rien).
  rules: [{
    id: 'suivi-priorites.sans_echeance',
    label: 'Tâches prioritaires sans échéance',
    evaluate({ open }) {
      const flous = open.filter((t) => t.priority === 1 && !t.due_date);
      if (!flous.length) return null;
      return {
        kind: 'risque', severity: 3,
        title: `${flous.length} tâche(s) prioritaire(s) sans échéance`,
        detail: 'Une priorité haute sans date n\'est pas réellement planifiée.',
        evidence: { taskIds: flous.map((t) => t.id), titles: flous.slice(0, 5).map((t) => t.title) },
      };
    },
  }],

  // 2. Les solutions proposées pour ce constat : le noyau les compare et désigne la meilleure.
  playbooks: {
    'suivi-priorites.sans_echeance': (e) => [
      { label: 'Fixer une échéance à 3 jours', detail: 'Donne une date butoir à chaque tâche prioritaire.', impact: 4, effort: 1,
        actions: [{ type: 'tache.modifier_lot', params: { taskIds: e.taskIds, due_in_days: 3 } }] },
      { label: 'Consigner un point de situation', detail: 'Crée une note listant ces tâches pour en discuter.', impact: 2, effort: 1,
        actions: [{ type: 'suivi-priorites.consigner', params: { titles: e.titles } }] },
    ],
  },

  // 3. Un type d'action. La sensibilité est obligatoire : « interne » reste dans OMNIA,
  //    « sensible » (tout ce qui sort) attendra toujours une autorisation.
  actions: {
    'suivi-priorites.consigner': {
      label: 'Consigner les tâches prioritaires',
      sensitivity: 'interne',
      validate(params) {
        if (!Array.isArray(params.titles) || !params.titles.length) throw new Error('Paramètre « titles » requis');
        return { titles: params.titles.slice(0, 20).map((t) => String(t).slice(0, 300)) };
      },
      run(ws, params, api) {
        const doc = api.createDocument({ title: 'Tâches prioritaires à planifier', kind: 'note', content: params.titles.map((t) => `- ${t}`).join('\n') });
        return { documentId: doc.id };
      },
    },
  },

  // 4. Des réactions aux événements du noyau.
  on: {
    'tache.terminee': (event, api) => {
      if (api.kpis().taches_ouvertes === 0) api.createDocument({ title: 'Toutes les tâches sont terminées', kind: 'note', content: `Dernière tâche soldée : ${event.title}` });
    },
  },
};
