// Module Studio de cinéma : règles de vigilance sur les films en cours.
const task = (title, extra = {}) => ({ type: 'tache.creer', params: { title, due_in_days: 3, priority: 2, ...extra } });

export default {
  id: 'cinema', name: 'Studio de cinéma', tier: 'pro', sectors: ['creatif'],
  description: 'De l\'idée au film : scénario et découpage, bible de cohérence, storyboard, tournage par briques interchangeables, montage, étalonnage et exports.',
  rules: [
    {
      id: 'cinema.validation_en_attente', label: 'Film en attente de validation',
      evaluate: ({ cinema }) => cinema.projects.filter((p) => p.currentGate && !p.gates.find((g) => g.key === p.currentGate).blockers.length).map((p) => ({
        key: `${p.id}:${p.currentGate}`, kind: 'probleme', severity: 2, title: `« ${p.title} » attend votre validation : ${p.gates.find((g) => g.key === p.currentGate).label}`,
        detail: 'Tout est prêt pour cette étape. La production ne reprend qu\'après votre accord.', evidence: { projectId: p.id, title: p.title, gate: p.gates.find((g) => g.key === p.currentGate).label },
      })),
    },
    {
      id: 'cinema.cout_eleve', label: 'Coût de production élevé',
      evaluate: ({ cinema }) => cinema.projects.filter((p) => p.costPerMinute !== null && p.costPerMinute > 50).map((p) => ({
        key: String(p.id), kind: 'risque', severity: 3, title: `« ${p.title} » coûte ${p.costPerMinute} par minute produite`,
        detail: `Total engagé : ${p.costTotal} pour ${p.seconds} secondes de film.`, evidence: { projectId: p.id, title: p.title, costPerMinute: p.costPerMinute },
      })),
    },
  ],
  playbooks: {
    'cinema.validation_en_attente': (e) => [{ label: 'Visionner et trancher', detail: 'Planifie la relecture de l\'étape pour la valider ou demander des retouches.', impact: 4, effort: 1, actions: [task(`Relire et valider « ${e.gate} » pour le film « ${e.title} »`, { priority: 1, due_in_days: 2 })] }],
    'cinema.cout_eleve': (e) => [
      { label: 'Réduire les plans générés', detail: 'Planifie la revue du découpage : plans à raccourcir, à fusionner ou à remplacer par des apports existants.', impact: 4, effort: 2, actions: [task(`Revoir le découpage de « ${e.title} » pour réduire le coût par minute`)] },
      { label: 'Comparer une autre brique vidéo', detail: 'Planifie un essai sur trois plans avec un générateur moins coûteux.', impact: 3, effort: 3, actions: [task(`Tester un autre générateur vidéo sur 3 plans de « ${e.title} »`, { due_in_days: 7 })] },
    ],
  },
};
