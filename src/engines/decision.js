// Moteur de décision : pour chaque constat, compare plusieurs solutions (impact / effort),
// désigne la meilleure et prépare les actions concrètes correspondantes.
// La priorité tient compte de l'apprentissage : les règles dont les recommandations sont
// acceptées et suivies d'effet remontent, celles qui sont rejetées descendent.

const opt = (label, detail, impact, effort, actions) => ({ label, detail, impact, effort, score: Math.round((impact / effort) * 100) / 100, actions });
const task = (title, extra = {}) => ({ type: 'tache.creer', params: { title, due_in_days: 7, priority: 2, ...extra } });

const PLAYBOOKS = {
  'taches.en_retard': (e) => [
    opt('Traiter d\'abord les 3 plus anciennes', 'Passe les trois tâches les plus en retard en priorité haute pour les solder cette semaine.', 4, 2,
      [{ type: 'tache.modifier_lot', params: { taskIds: e.taskIds.slice(0, 3), priority: 1 } }]),
    opt('Faire une revue de tri (30 min)', 'Planifie une revue pour décider, tâche par tâche : terminer, replanifier, déléguer ou abandonner.', 3, 1,
      [task('Revue des tâches en retard : terminer, replanifier, déléguer ou abandonner', { due_in_days: 1, priority: 1 })]),
    opt('Replanifier toutes les tâches à 7 jours', 'Repousse les échéances dépassées. Rapide, mais ne traite pas la cause du retard.', 2, 1,
      [{ type: 'tache.modifier_lot', params: { taskIds: e.taskIds, due_in_days: 7 } }]),
  ],
  'taches.surcharge': (e) => [
    opt('Limiter à 3 tâches en cours', 'Remet en attente les tâches les moins prioritaires pour concentrer l\'effort.', 4, 1,
      [{ type: 'tache.modifier_lot', params: { taskIds: e.taskIds.slice(3), status: 'a_faire' } }]),
    opt('Planifier un point de priorisation', 'Crée une tâche pour arbitrer les priorités avec les personnes concernées.', 3, 2,
      [task('Arbitrer les priorités : 3 tâches en cours au maximum', { due_in_days: 2 })]),
  ],
  'taches.dormantes': (e) => [
    opt('Trier les tâches dormantes', 'Planifie une revue : chaque tâche reçoit une échéance, un responsable, ou est supprimée.', 3, 1,
      [task('Trier les tâches dormantes : dater, déléguer ou supprimer', { due_in_days: 3 })]),
    opt('Fixer une échéance à 14 jours pour toutes', 'Donne une date butoir à chaque tâche dormante pour la faire réapparaître dans le suivi.', 2, 1,
      [{ type: 'tache.modifier_lot', params: { taskIds: e.taskIds, due_in_days: 14 } }]),
  ],
  'projets.sans_taches': (e) => [
    opt('Créer un plan de démarrage en 3 étapes', 'Ajoute au projet trois premières tâches : cadrer, lister les étapes, fixer le premier jalon.', 4, 1, [
      task(`Cadrer le projet « ${e.projectName} » : résultat attendu, budget, échéance`, { project_id: e.projectId, due_in_days: 3, priority: 1 }),
      task(`Lister les étapes du projet « ${e.projectName} »`, { project_id: e.projectId, due_in_days: 5 }),
      task(`Fixer le premier jalon du projet « ${e.projectName} »`, { project_id: e.projectId, due_in_days: 7 }),
    ]),
    opt('Rédiger un plan d\'action complet', 'Génère un document de plan d\'action à compléter et à valider.', 3, 2,
      [{ type: 'document.generer', params: { template: 'plan_action', brief: `Projet : ${e.projectName}` } }]),
  ],
  'projets.a_risque': (e) => [
    opt('Concentrer l\'effort sur ce projet', `Passe les ${e.remaining} tâche(s) restante(s) en priorité haute.`, 4, 2,
      [{ type: 'tache.prioriser_projet', params: { projectId: e.projectId } }]),
    opt('Réduire le périmètre ou renégocier l\'échéance', 'Planifie la décision : que peut-on retirer, ou de combien décaler la date ?', 4, 3,
      [task(`Décider pour « ${e.projectName} » : réduire le périmètre ou décaler l'échéance`, { project_id: e.projectId, due_in_days: 2, priority: 1 })]),
  ],
  'finances.tresorerie_negative': () => [
    opt('Passer en revue les 5 plus grosses dépenses', 'Planifie l\'examen des cinq premiers postes : réduire, reporter ou supprimer.', 4, 2,
      [task('Examiner les 5 plus grosses dépenses du mois : réduire, reporter ou supprimer', { due_in_days: 3, priority: 1 })]),
    opt('Accélérer les encaissements', 'Planifie la relance des sommes dues et la facturation de ce qui ne l\'est pas encore.', 4, 2,
      [task('Relancer les encaissements en attente et facturer le travail livré', { due_in_days: 2, priority: 1 })]),
    opt('Établir un budget prévisionnel', 'Génère un document de budget à partir des opérations enregistrées.', 3, 2,
      [{ type: 'document.generer', params: { template: 'budget', brief: 'Retour à l\'équilibre' } }]),
  ],
  'finances.hausse_depenses': (e) => [
    opt(`Analyser le poste « ${e.category} »`, 'Planifie l\'examen des opérations du poste pour distinguer hausse ponctuelle et dérive.', 3, 1,
      [task(`Analyser la hausse du poste « ${e.category} » (+${e.delta})`, { due_in_days: 5 })]),
    opt('Demander des devis concurrents', 'Planifie une mise en concurrence des fournisseurs de ce poste.', 3, 3,
      [task(`Obtenir 2 devis concurrents pour le poste « ${e.category} »`, { due_in_days: 14 })]),
  ],
  'finances.charges_recurrentes': (e) => [
    opt('Renégocier ou résilier les 3 plus lourdes', 'Crée une tâche par charge parmi les trois plus coûteuses.', 4, 2,
      e.recurring.slice(0, 3).map((r) => task(`Renégocier ou résilier : ${r.label} (${r.monthly}/mois)`, { due_in_days: 10 }))),
    opt('Exporter la liste pour revue', 'Produit un fichier CSV des opérations à passer en revue.', 2, 1,
      [{ type: 'export.csv', params: { dataset: 'transactions' } }]),
  ],
  'finances.doublons': (e) => [
    opt('Vérifier chaque paiement suspect', 'Crée une tâche de vérification par doublon détecté.', 4, 1,
      e.duplicates.slice(0, 5).map((d) => task(`Vérifier un possible double paiement : ${d.label} (${-d.amount}) le ${d.date}`, { due_in_days: 3, priority: 1 }))),
    opt('Préparer une demande de remboursement', 'Rédige un brouillon d\'e-mail de réclamation, à relire et à envoyer vous-même.', 3, 2, [{
      type: 'email.brouillon',
      params: {
        subject: 'Demande de vérification — paiement en double',
        body: `Bonjour,\n\nNous constatons ${e.duplicates.length} opération(s) qui semblent avoir été débitées deux fois :\n${e.duplicates.slice(0, 5).map((d) => `- ${d.date} · ${d.label} · ${-d.amount}`).join('\n')}\n\nPouvez-vous vérifier et, le cas échéant, procéder au remboursement ?\n\nCordialement,`,
      },
    }]),
  ],
  'finances.dependance_client': (e) => [
    opt('Lancer une action de diversification', 'Planifie la prospection de nouvelles sources de revenus.', 4, 3,
      [task(`Identifier et contacter 5 nouveaux clients ou financeurs (dépendance à ${e.counterparty})`, { due_in_days: 14 })]),
    opt('Formaliser une stratégie de diversification', 'Génère un document de stratégie à compléter.', 3, 2,
      [{ type: 'document.generer', params: { template: 'strategie', brief: `Réduire la dépendance à ${e.counterparty}` } }]),
  ],
  'finances.revenus_en_baisse': () => [
    opt('Comprendre la baisse', 'Planifie l\'analyse : quels clients, produits ou périodes expliquent le recul ?', 4, 2,
      [task('Analyser la baisse des revenus : clients, offres et périodes concernés', { due_in_days: 3, priority: 1 })]),
    opt('Bâtir un plan de relance', 'Génère un plan d\'action de relance commerciale à compléter.', 4, 3,
      [{ type: 'document.generer', params: { template: 'plan_action', brief: 'Relance des revenus' } }]),
  ],
  'finances.revenus_en_hausse': () => [
    opt('Identifier ce qui a fonctionné', 'Planifie un court bilan pour reproduire les causes de la hausse.', 3, 1,
      [task('Bilan : ce qui explique la hausse des revenus et comment le reproduire', { due_in_days: 7 })]),
  ],
};

export function weightOf(stats) {
  if (!stats) return 1;
  return Math.max(0.4, Math.min(1.6, 1 + 0.1 * (stats.accepted + stats.resolved) - 0.15 * stats.rejected));
}

const KIND_FACTOR = { probleme: 1.1, risque: 1, opportunite: 0.8 };

export function decide(insight, stats) {
  const build = PLAYBOOKS[insight.rule];
  if (!build) return null;
  const options = build(insight.evidence).filter((o) => o.actions.length);
  if (!options.length) return null;
  const best = options.reduce((bi, o, i) => (o.score > options[bi].score ? i : bi), 0);
  const weight = weightOf(stats);
  return {
    title: options[best].label,
    rationale: `${insight.title}. ${insight.detail}`,
    options,
    best_option: best,
    priority: Math.round(insight.severity * (KIND_FACTOR[insight.kind] ?? 1) * weight * 100) / 100,
    weight,
  };
}
