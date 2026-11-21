// Module Studio économique : règles de vigilance sur les projets de création et de commercialisation.
// Elles rappellent le principe fondateur : ne pas confondre popularité et rentabilité,
// ne pas dépenser ce qui n'a pas été encaissé, ne pas avancer sans preuve.
const task = (title, extra = {}) => ({ type: 'tache.creer', params: { title, due_in_days: 5, priority: 2, ...extra } });
const opt = (label, detail, impact, effort, actions) => ({ label, detail, impact, effort, actions });
const COMMERCIAL = ['achat', 'precommande', 'engagement'];

export default {
  id: 'studio', name: 'Studio économique', tier: 'pro', sectors: ['creatif'],
  description: 'Détecter, évaluer, prototyper, tester et vendre des créations — réseaux sociaux, audiovisuel, jeux vidéo, outils — avec preuves et autofinancement.',
  rules: [
    {
      id: 'studio.depenses_sans_encaissement', label: 'Dépenses sans encaissement',
      evaluate: ({ studio, round }) => studio.projects.filter((p) => p.status === 'actif' && p.metrics.couts > 0 && p.metrics.chiffre_affaires_encaisse === 0).map((p) => ({
        key: String(p.id), kind: 'risque', severity: 4, title: `« ${p.name} » : ${round(p.metrics.couts)} dépensés, rien d'encaissé`,
        detail: 'Le budget initial est de 0 € : chaque dépense devrait être financée par un encaissement réel, pas par des revenus espérés.',
        evidence: { projectId: p.id, projectName: p.name, couts: p.metrics.couts },
      })),
    },
    {
      id: 'studio.autofinancement_depasse', label: 'Autofinancement dépassé',
      evaluate({ studio }) {
        const f = studio.autofinancement;
        if (!(f.depassement > 0)) return null;
        return { kind: 'probleme', severity: 4, title: `Le studio a dépensé ${f.depassement} de plus qu'il n'a encaissé`,
          detail: `Encaissé ${f.encaisse} · dépensé ${f.depense}. Aucun bénéfice n'est disponible pour réinvestir tant que cet écart n'est pas comblé par des ventes réelles.`, evidence: { ...f } };
      },
    },
    {
      id: 'studio.avance_sans_preuve_commerciale', label: 'Projet avancé sans preuve commerciale',
      evaluate: ({ studio }) => studio.projects.filter((p) => p.status === 'actif' && p.stage >= 5 && p.commercialProofs === 0).map((p) => ({
        key: String(p.id), kind: 'risque', severity: p.stage >= 6 ? 4 : 3, title: `« ${p.name} » est à l'étape ${p.stageName} sans aucune preuve commerciale`,
        detail: 'Ni achat, ni précommande, ni engagement vérifiable. La validation commerciale repose sur ces preuves, pas sur une note ou une intuition.',
        evidence: { projectId: p.id, projectName: p.name, stage: p.stageName },
      })),
    },
    {
      id: 'studio.popularite_sans_revenu', label: 'Popularité sans revenu',
      evaluate: ({ studio }) => studio.projects.filter((p) => p.status === 'actif' && p.interestSignals > 0 && p.commercialProofs === 0).map((p) => ({
        key: String(p.id), kind: 'opportunite', severity: 3, title: `« ${p.name} » suscite de l'intérêt mais n'a encore rien vendu`,
        detail: `${p.interestSignals} signal(aux) d'intérêt prouvé(s). Vues, likes et commentaires indiquent un intérêt, pas un revenu : c'est le moment de proposer quelque chose à acheter.`,
        evidence: { projectId: p.id, projectName: p.name, interestSignals: p.interestSignals },
      })),
    },
    {
      id: 'studio.projet_sans_preuve_recente', label: 'Projet de studio à l\'arrêt',
      evaluate: ({ studio, t0, dayDiff }) => studio.projects.filter((p) => p.status === 'actif' && dayDiff(t0, p.updated_at.slice(0, 10)) > 21).map((p) => ({
        key: String(p.id), kind: 'probleme', severity: 2, title: `« ${p.name} » n'a produit aucune preuve depuis ${dayDiff(t0, p.updated_at.slice(0, 10))} jours`,
        detail: `Bloqué à l'étape ${p.stageName}. Un projet qui n'avance pas doit être relancé ou abandonné.`, evidence: { projectId: p.id, projectName: p.name, stage: p.stageName },
      })),
    },
    {
      id: 'studio.preuves_contradictoires', label: 'Sources contradictoires',
      evaluate: ({ studio }) => studio.projects.filter((p) => p.status === 'actif' && p.evidence.some((e) => e.status === 'CONFLIT')).map((p) => ({
        key: String(p.id), kind: 'risque', severity: 3, title: `« ${p.name} » repose sur des sources qui se contredisent`,
        detail: `${p.evidence.filter((e) => e.status === 'CONFLIT').length} résultat(s) classé(s) CONFLIT. Une décision prise sur une information contestée est fragile.`, evidence: { projectId: p.id, projectName: p.name },
      })),
    },
  ],
  playbooks: {
    'studio.depenses_sans_encaissement': (e) => [
      opt('Suspendre les dépenses et tester la vente', 'Planifie un test de commercialisation avant tout nouvel engagement.', 5, 2, [task(`Geler les dépenses de « ${e.projectName} » et proposer une précommande ou une première vente`, { priority: 1, due_in_days: 3 })]),
      opt('Décider : poursuivre ou abandonner', 'Planifie la décision au vu des coûts engagés et des preuves disponibles.', 4, 1, [task(`Décider pour « ${e.projectName} » : poursuivre, réduire ou abandonner`, { due_in_days: 2 })]),
    ],
    'studio.autofinancement_depasse': () => [
      opt('Concentrer l\'effort sur ce qui peut encaisser vite', 'Planifie l\'identification de l\'offre la plus proche d\'un encaissement.', 5, 2, [task('Identifier l\'offre du studio la plus proche d\'un encaissement et la mettre en vente', { priority: 1, due_in_days: 3 })]),
      opt('Geler toute nouvelle dépense', 'Planifie le gel jusqu\'au retour à l\'équilibre.', 4, 1, [task('Geler les dépenses du studio jusqu\'au retour à l\'équilibre', { priority: 1, due_in_days: 1 })]),
    ],
    'studio.avance_sans_preuve_commerciale': (e) => [
      opt('Mettre en vente une version minimale', 'Planifie une offre réelle : précommande, acompte ou première vente.', 5, 2, [task(`Ouvrir une précommande ou une première vente pour « ${e.projectName} »`, { priority: 1, due_in_days: 5 })]),
      opt('Obtenir trois engagements vérifiables', 'Planifie la prise de contact avec trois acheteurs potentiels.', 4, 2, [task(`Obtenir 3 engagements écrits d'acheteurs pour « ${e.projectName} »`, { due_in_days: 7 })]),
    ],
    'studio.popularite_sans_revenu': (e) => [
      opt('Proposer une offre payante à cette audience', 'Planifie la conception d\'une offre simple à acheter et sa présentation au public déjà intéressé.', 5, 2, [task(`Concevoir et présenter une offre payante à l'audience de « ${e.projectName} »`, { priority: 1, due_in_days: 5 })]),
    ],
    'studio.projet_sans_preuve_recente': (e) => [
      opt('Trancher : relancer ou abandonner', 'Planifie la décision.', 3, 1, [task(`Relancer ou abandonner « ${e.projectName} » (étape ${e.stage})`, { due_in_days: 3 })]),
    ],
    'studio.preuves_contradictoires': (e) => [
      opt('Départager les sources par un test', 'Planifie un test direct auprès du public cible plutôt que de choisir une source.', 4, 2, [task(`Concevoir un test qui départage les sources contradictoires de « ${e.projectName} »`, { due_in_days: 5 })]),
    ],
  },
};
export { COMMERCIAL };
