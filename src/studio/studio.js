// Studio économique : de l'opportunité à l'encaissement, avec des garde-fous inscrits dans le code.
// - une boucle en dix étapes, chacune devant laisser une preuve ;
// - une validation obligatoire en six points avant toute production ;
// - un arbitrage économique noté sur 100, qui ne remplace jamais une preuve commerciale ;
// - des résultats classés PROUVÉ / INCONNU / CONFLIT / ÉCHEC ;
// - un autofinancement : on ne dépense que des bénéfices réellement encaissés, et sur autorisation.
// Le studio ne produit aucun chiffre de marché, d'audience ou de vente : ce qui n'est pas saisi avec une source est INCONNU.
import { now, today, parseJson } from '../core/db.js';

export const STAGES = ['EXPLORER', 'DÉTECTER', 'ÉVALUER', 'CONCEVOIR', 'PROTOTYPER', 'TESTER', 'VENDRE', 'ENCAISSER', 'MESURER', 'OPTIMISER'];
export const STAGE_HELP = [
  'Observer un marché, une tendance, un public.', 'Formuler le besoin, le désir ou la niche repérés.', 'Noter l\'opportunité sur les huit critères.',
  'Définir le produit et valider les six points obligatoires.', 'Construire un prototype minimal, vérifier qualité et droits.', 'Le présenter à son public et mesurer l\'intérêt réel.',
  'Tester la commercialisation : achats, précommandes, engagements.', 'Constater les encaissements réels.', 'Mesurer ventes, coûts et marge.', 'Améliorer, développer ou abandonner.',
];
export const DOMAINS = { reseaux: 'Réseaux sociaux et créateurs', audiovisuel: 'Audiovisuel', jeux: 'Jeux vidéo', outils: 'Outils logiciels', autre: 'Autre secteur' };
// Ordre de priorité opérationnelle fixé par la stratégie.
const DOMAIN_ORDER = ['reseaux', 'audiovisuel', 'jeux', 'outils', 'autre'];
export const CRITERIA = [
  ['demande', 'Demande vérifiable', 20], ['benefice', 'Bénéfice net potentiel', 20], ['encaissement', 'Rapidité d\'encaissement', 15], ['cout', 'Coût initial (faible = plus de points)', 15],
  ['recurrence', 'Récurrence des revenus', 10], ['production', 'Facilité de production', 10], ['differenciation', 'Différenciation', 5], ['croissance', 'Potentiel de croissance', 5],
].map(([key, label, max]) => ({ key, label, max }));
export const STATUSES = { PROUVE: 'PROUVÉ', INCONNU: 'INCONNU', CONFLIT: 'CONFLIT', ECHEC: 'ÉCHEC' };
export const KINDS = {
  achat: 'Achat', precommande: 'Précommande', engagement: 'Engagement vérifiable', interet: 'Intérêt (vues, likes, commentaires, inscriptions)',
  etude: 'Étude de marché ou de tendance', concurrent: 'Analyse d\'un concurrent', test: 'Test', autre: 'Autre',
};
const COMMERCIAL = ['achat', 'precommande', 'engagement'];
export const VALIDATION = [
  ['public', 'Un public clairement identifié'], ['besoin', 'Un problème, désir ou besoin documenté'], ['proposition', 'Une proposition de valeur compréhensible'],
  ['distribution', 'Une stratégie de distribution'], ['modele', 'Un modèle économique chiffré'], ['test', 'Un test mesurant l\'intérêt réel'],
].map(([key, label]) => ({ key, label }));

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const round = (n) => Math.round(n * 100) / 100 + 0; // « + 0 » : jamais de zéro négatif
const ACQUISITION = /acquisition|publicit|marketing|pub\b|ads?\b|campagne|promotion/i;

export function createStudio({ db, audit, fail, services }) {
  const need = (cond, message, status = 400) => { if (!cond) fail(message, status); };
  const raw = (wsId, id) => { const p = db.get('SELECT * FROM studio_projects WHERE id = ? AND workspace_id = ?', id, wsId); need(p, 'Projet de studio introuvable', 404); return p; };
  const evidenceOf = (wsId, projectId) => db.all('SELECT * FROM studio_evidence WHERE workspace_id = ? AND project_id = ? ORDER BY id DESC', wsId, projectId);
  const txOf = (wsId, projectId) => db.all('SELECT * FROM transactions WHERE workspace_id = ? AND studio_project_id = ? ORDER BY date, id', wsId, projectId);

  // Indicateurs réels d'un projet : uniquement ce qui a été encaissé ou dépensé.
  function metrics(p, tx) {
    const sales = tx.filter((t) => t.amount > 0); const costs = tx.filter((t) => t.amount < 0);
    const revenue = round(sales.reduce((s, t) => s + t.amount, 0)); const cost = round(-costs.reduce((s, t) => s + t.amount, 0));
    const buyers = new Map(); for (const t of sales) { const k = t.counterparty.trim().toLowerCase() || `anonyme-${t.id}`; buyers.set(k, (buyers.get(k) ?? 0) + 1); }
    const acquisition = round(-costs.filter((t) => ACQUISITION.test(`${t.category} ${t.label}`)).reduce((s, t) => s + t.amount, 0));
    const first = sales[0]?.date ?? null;
    return {
      chiffre_affaires_encaisse: revenue, couts: cost, benefice_net: round(revenue - cost), clients_payants: buyers.size,
      marge_nette: revenue > 0 ? round((revenue - cost) / revenue) : null,
      cout_acquisition: buyers.size && acquisition > 0 ? round(acquisition / buyers.size) : null,
      recurrence: buyers.size ? round([...buyers.values()].filter((n) => n > 1).length / buyers.size) : null,
      jours_avant_premier_encaissement: first ? Math.max(0, Math.round((Date.parse(first) - Date.parse(p.created_at.slice(0, 10))) / 86400000)) : null,
    };
  }

  // Modèle économique : des projections calculées à partir des hypothèses saisies — jamais des résultats.
  function projection(m = {}) {
    const prix = num(m.prix); const cout = num(m.cout_unitaire) ?? 0; const fixes = num(m.couts_fixes) ?? 0; const cible = num(m.ventes_cible);
    if (prix === null || prix <= 0) return null;
    const marge = round(prix - cout);
    return { marge_unitaire: marge, seuil_rentabilite_ventes: marge > 0 ? Math.ceil(fixes / marge) || 0 : null, benefice_vise: cible === null ? null : round(cible * marge - fixes) };
  }

  function validationState(p, evidence) {
    const v = p.validation; const proven = (topic) => evidence.some((e) => e.topic === topic && e.status === 'PROUVE');
    const proj = projection(v.modele);
    return VALIDATION.map(({ key, label }) => {
      let ok; let reason = '';
      if (key === 'besoin') { ok = Boolean(v.besoin) && proven('besoin'); reason = !v.besoin ? 'À décrire.' : ok ? '' : 'Décrit, mais aucune preuve PROUVÉE rattachée à ce point : il n\'est pas encore documenté.'; }
      else if (key === 'modele') { ok = Boolean(proj) && num(v.modele?.ventes_cible) !== null && proj.marge_unitaire > 0; reason = ok ? '' : !proj ? 'Prix de vente à renseigner.' : proj.marge_unitaire <= 0 ? 'La marge unitaire est nulle ou négative.' : 'Objectif de ventes à renseigner.'; }
      else if (key === 'test') { ok = Boolean(v.test?.mesure) && Boolean(v.test?.seuil); reason = ok ? '' : 'Indiquer ce qui sera mesuré et le seuil qui vaudra succès.'; }
      else { ok = Boolean(v[key]); reason = ok ? '' : 'À décrire.'; }
      return { key, label, ok, reason };
    });
  }

  // Ce qui manque pour quitter l'étape en cours. Une liste vide signifie que le passage est permis.
  function blockers(p, evidence, m) {
    const out = []; const stage = p.stage;
    if (!evidence.some((e) => e.stage === stage)) out.push(`L'étape ${STAGES[stage]} n'a laissé aucune preuve : consignez au moins un résultat (même INCONNU ou ÉCHEC).`);
    if (stage === 2 && CRITERIA.some((c) => p.scores[c.key]?.points == null)) out.push('L\'arbitrage économique est incomplet : notez les huit critères.');
    if (stage === 3) for (const v of validationState(p, evidence).filter((x) => !x.ok)) out.push(`Validation obligatoire — ${v.label} : ${v.reason}`);
    if (stage === 4 && !(p.rights.verifie === true && text(p.rights.note, 500))) out.push('Qualité et droits d\'exploitation non vérifiés : confirmez-les et précisez sur quelle base (licences, auteurs, contenus tiers).');
    if (stage === 5 && !evidence.some((e) => e.stage === 5 && e.kind === 'test' && ['PROUVE', 'ECHEC'].includes(e.status))) out.push('Le test n\'a pas de résultat : consignez-le en PROUVÉ (seuil atteint, avec sa source) ou en ÉCHEC.');
    if (stage === 6 && !evidence.some((e) => COMMERCIAL.includes(e.kind) && e.status === 'PROUVE')) out.push('Aucune preuve commerciale PROUVÉE (achat, précommande ou engagement vérifiable). Vues, likes et commentaires ne suffisent pas.');
    if (stage === 7 && m.chiffre_affaires_encaisse <= 0) out.push('Aucun encaissement réel enregistré sur ce projet.');
    return out;
  }

  function view(p0) {
    const p = { ...p0, validation: parseJson(p0.validation, {}), scores: parseJson(p0.scores, {}), rights: parseJson(p0.rights, {}) };
    const evidence = evidenceOf(p.workspace_id, p.id); const tx = txOf(p.workspace_id, p.id); const m = metrics(p, tx);
    const scored = CRITERIA.filter((c) => p.scores[c.key]?.points != null);
    const commercial = evidence.filter((e) => COMMERCIAL.includes(e.kind) && e.status === 'PROUVE').length;
    return {
      ...p, stageName: STAGES[p.stage], stageHelp: STAGE_HELP[p.stage], domainLabel: DOMAINS[p.domain],
      score: scored.length === CRITERIA.length ? scored.reduce((s, c) => s + p.scores[c.key].points, 0) : null, scoredCriteria: scored.length,
      validationState: validationState(p, evidence), projection: projection(p.validation.modele),
      commercialProofs: commercial, interestSignals: evidence.filter((e) => e.kind === 'interet' && e.status === 'PROUVE').length,
      evidence, transactions: tx, metrics: m, blockers: p.status === 'actif' && p.stage < STAGES.length - 1 ? blockers(p, evidence, m) : [],
    };
  }

  const list = (wsId) => db.all('SELECT * FROM studio_projects WHERE workspace_id = ? ORDER BY id DESC', wsId).map(view);

  // Bénéfices réellement disponibles pour réinvestir : encaissé moins dépensé, tous projets confondus. Jamais négatif, jamais prévisionnel.
  function selfFunding(projects) {
    const revenue = round(projects.reduce((s, p) => s + p.metrics.chiffre_affaires_encaisse, 0)); const cost = round(projects.reduce((s, p) => s + p.metrics.couts, 0));
    return { budget_initial: 0, encaisse: revenue, depense: cost, disponible: Math.max(0, round(revenue - cost)), depassement: Math.max(0, round(cost - revenue)) };
  }

  function overview(wsId) {
    const projects = list(wsId); const buyers = new Set(); let repeat = 0; const perBuyer = new Map();
    for (const p of projects) for (const t of p.transactions.filter((x) => x.amount > 0)) { const k = t.counterparty.trim().toLowerCase() || `anonyme-${t.id}`; buyers.add(k); perBuyer.set(k, (perBuyer.get(k) ?? 0) + 1); }
    for (const n of perBuyer.values()) if (n > 1) repeat += 1;
    const fund = selfFunding(projects); const delays = projects.map((p) => p.metrics.jours_avant_premier_encaissement).filter((d) => d !== null);
    const acquisition = round(projects.reduce((s, p) => s + (p.metrics.cout_acquisition ?? 0) * p.metrics.clients_payants, 0));
    // Classement : la note d'arbitrage ordonne, la priorité stratégique départage ; la preuve commerciale est affichée à part.
    const ranking = projects.filter((p) => p.status === 'actif').sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain));
    return {
      indicateurs: {
        benefice_net_conserve: round(fund.encaisse - fund.depense), clients_payants: buyers.size, chiffre_affaires_encaisse: fund.encaisse,
        marge_nette: fund.encaisse > 0 ? round((fund.encaisse - fund.depense) / fund.encaisse) : null,
        cout_acquisition: buyers.size && acquisition > 0 ? round(acquisition / buyers.size) : null,
        recurrence: buyers.size ? round(repeat / buyers.size) : null,
        delai_moyen_premier_encaissement: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
      },
      autofinancement: fund, projects, ranking: ranking.map((p) => p.id),
      reference: { stages: STAGES, stageHelp: STAGE_HELP, domains: DOMAINS, criteria: CRITERIA, statuses: STATUSES, kinds: KINDS, validation: VALIDATION, commercialKinds: COMMERCIAL },
    };
  }

  function createProject(wsId, input) {
    const name = text(input.name, 160); need(name, 'Nom du projet requis');
    const domain = DOMAINS[input.domain] ? input.domain : 'reseaux';
    const id = db.insert('INSERT INTO studio_projects (workspace_id, name, domain, concept, created_at, updated_at) VALUES (?,?,?,?,?,?)', wsId, name, domain, text(input.concept, 2000), now(), now());
    audit.record({ workspaceId: wsId, event: 'studio.projet_cree', entity: 'studio', entityId: id, detail: { name, domain } });
    return view(raw(wsId, id));
  }

  function updateProject(wsId, id, patch) {
    const p = raw(wsId, id); const next = {};
    if (patch.name !== undefined) { next.name = text(patch.name, 160); need(next.name, 'Nom requis'); }
    if (patch.domain !== undefined) { need(DOMAINS[patch.domain], 'Domaine invalide'); next.domain = patch.domain; }
    if (patch.concept !== undefined) next.concept = text(patch.concept, 2000);
    if (patch.status !== undefined) { need(['actif', 'abandonne', 'termine'].includes(patch.status), 'Statut invalide'); next.status = patch.status; }
    if (patch.validation !== undefined) {
      const v = patch.validation ?? {}; const cur = parseJson(p.validation, {});
      next.validation = JSON.stringify({
        public: text(v.public ?? cur.public, 1000), besoin: text(v.besoin ?? cur.besoin, 1000), proposition: text(v.proposition ?? cur.proposition, 1000), distribution: text(v.distribution ?? cur.distribution, 1000),
        modele: { prix: num(v.modele?.prix ?? cur.modele?.prix), cout_unitaire: num(v.modele?.cout_unitaire ?? cur.modele?.cout_unitaire), couts_fixes: num(v.modele?.couts_fixes ?? cur.modele?.couts_fixes), ventes_cible: num(v.modele?.ventes_cible ?? cur.modele?.ventes_cible) },
        test: { mesure: text(v.test?.mesure ?? cur.test?.mesure, 500), seuil: text(v.test?.seuil ?? cur.test?.seuil, 200) },
      });
    }
    if (patch.scores !== undefined) {
      const cur = parseJson(p.scores, {});
      for (const c of CRITERIA) {
        const s = patch.scores?.[c.key]; if (s === undefined) continue;
        const points = num(s.points); need(points === null || (Number.isInteger(points) && points >= 0 && points <= c.max), `« ${c.label} » se note de 0 à ${c.max}`);
        cur[c.key] = { points, justification: text(s.justification, 500) };
      }
      next.scores = JSON.stringify(cur);
    }
    if (patch.rights !== undefined) next.rights = JSON.stringify({ verifie: patch.rights?.verifie === true, note: text(patch.rights?.note, 500) });
    const keys = Object.keys(next);
    if (keys.length) {
      db.run(`UPDATE studio_projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => next[k]), now(), id);
      audit.record({ workspaceId: wsId, event: next.status === 'abandonne' ? 'studio.projet_abandonne' : 'studio.projet_modifie', entity: 'studio', entityId: id, detail: { champs: keys } });
    }
    return view(raw(wsId, id));
  }

  function addEvidence(wsId, projectId, input) {
    const p = raw(wsId, projectId);
    const statement = text(input.statement, 1000); need(statement, 'Décrivez le résultat constaté');
    const status = STATUSES[input.status] ? input.status : 'INCONNU'; const kind = KINDS[input.kind] ? input.kind : 'autre';
    const source = text(input.source, 500);
    // Un résultat n'est PROUVÉ que s'il renvoie à une source ou à un test que l'on peut refaire.
    need(status !== 'PROUVE' || source.length >= 5, 'Un résultat PROUVÉ exige sa source (lien, référence de paiement, document, protocole de test). Sans source, classez-le INCONNU.');
    need(status !== 'CONFLIT' || source.length >= 5, 'Un CONFLIT doit citer les sources qui se contredisent.');
    const topic = [...VALIDATION.map((v) => v.key), ...CRITERIA.map((c) => c.key)].includes(input.topic) ? input.topic : '';
    const id = db.insert('INSERT INTO studio_evidence (workspace_id, project_id, stage, topic, statement, status, kind, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)', wsId, p.id, p.stage, topic, statement, status, kind, source, now());
    db.run('UPDATE studio_projects SET updated_at = ? WHERE id = ?', now(), p.id);
    audit.record({ workspaceId: wsId, event: 'studio.preuve_consignee', entity: 'studio', entityId: p.id, detail: { preuve: id, etape: STAGES[p.stage], status, kind } });
    return view(raw(wsId, p.id));
  }
  function removeEvidence(wsId, id) {
    const e = db.get('SELECT * FROM studio_evidence WHERE id = ? AND workspace_id = ?', id, wsId); need(e, 'Preuve introuvable', 404);
    db.run('DELETE FROM studio_evidence WHERE id = ?', id);
    audit.record({ workspaceId: wsId, event: 'studio.preuve_retiree', entity: 'studio', entityId: e.project_id, detail: { preuve: id, status: e.status, kind: e.kind, statement: e.statement.slice(0, 120) } });
    return view(raw(wsId, e.project_id));
  }

  function advance(wsId, id) {
    const p = view(raw(wsId, id));
    need(p.status === 'actif', 'Ce projet n\'est plus actif');
    need(p.stage < STAGES.length - 1, 'Le projet est déjà à la dernière étape');
    need(!p.blockers.length, `Impossible de passer à ${STAGES[p.stage + 1]} : ${p.blockers.join(' ')}`, 409);
    db.run('UPDATE studio_projects SET stage = ?, updated_at = ? WHERE id = ?', p.stage + 1, now(), id);
    audit.record({ workspaceId: wsId, event: 'studio.etape_franchie', entity: 'studio', entityId: id, detail: { de: STAGES[p.stage], vers: STAGES[p.stage + 1] } });
    return view(raw(wsId, id));
  }

  // Un encaissement n'est enregistré que s'il renvoie à une référence vérifiable ; il devient une preuve d'achat.
  function recordSale(wsId, id, input) {
    const p = raw(wsId, id); const amount = num(input.amount); const source = text(input.source, 500);
    need(amount !== null && amount > 0, 'Montant encaissé invalide');
    need(source.length >= 5, 'Référence de l\'encaissement requise (numéro de paiement, facture, relevé) : une vente sans trace n\'est pas enregistrée.');
    const kind = input.kind === 'precommande' ? 'precommande' : 'achat';
    return db.tx(() => {
      const t = services.createTransaction(wsId, { date: input.date ?? today(), amount, label: text(input.label, 300) || `${kind === 'achat' ? 'Vente' : 'Précommande'} — ${p.name}`, category: 'ventes studio', counterparty: text(input.counterparty, 200) });
      db.run('UPDATE transactions SET studio_project_id = ? WHERE id = ?', p.id, t.id);
      db.run('INSERT INTO studio_evidence (workspace_id, project_id, stage, topic, statement, status, kind, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)', wsId, p.id, p.stage, 'demande',
        `${kind === 'achat' ? 'Achat' : 'Précommande'} encaissé${kind === 'achat' ? '' : 'e'} : ${amount} ${text(input.counterparty, 200) ? `— ${text(input.counterparty, 200)}` : ''}`.trim(), 'PROUVE', kind, source, now());
      db.run('UPDATE studio_projects SET updated_at = ? WHERE id = ?', now(), p.id);
      audit.record({ workspaceId: wsId, event: 'studio.encaissement', entity: 'studio', entityId: p.id, detail: { amount, kind, source } });
      return view(raw(wsId, p.id));
    });
  }

  // Engagement d'une dépense : appelé par le moteur d'exécution après autorisation humaine.
  function spend(wsId, { projectId, amount, label, category }) {
    const p = raw(wsId, projectId); const before = selfFunding(list(wsId));
    const t = services.createTransaction(wsId, { date: today(), amount: -Math.abs(amount), label, category: category || 'studio', counterparty: '' });
    db.run('UPDATE transactions SET studio_project_id = ? WHERE id = ?', p.id, t.id);
    const covered = before.disponible >= Math.abs(amount);
    return { transactionId: t.id, projet: p.name, disponible_avant: before.disponible, autofinance: covered,
      note: covered ? 'Dépense couverte par des bénéfices réellement encaissés.' : `Dépense non couverte par les bénéfices encaissés (disponible : ${before.disponible}). Elle a été autorisée explicitement.` };
  }

  // Brief transmis au moteur de création : uniquement ce qui a été saisi, les inconnues nommées comme telles.
  function brief(wsId, id) {
    const p = view(raw(wsId, id)); const v = p.validation; const u = '(INCONNU)';
    return { name: p.name, text: [`Projet : ${p.name} (${p.domainLabel})`, `Concept : ${p.concept || u}`, `Public : ${v.public || u}`, `Besoin : ${v.besoin || u}`, `Proposition de valeur : ${v.proposition || u}`,
      `Distribution : ${v.distribution || u}`, `Prix envisagé : ${v.modele?.prix ?? u}`, `Preuves commerciales PROUVÉES : ${p.commercialProofs}`].join('\n') };
  }

  return { overview, list, get: (wsId, id) => view(raw(wsId, id)), createProject, updateProject, addEvidence, removeEvidence, advance, recordSale, spend, brief, selfFunding,
    remove(wsId, id) { const p = raw(wsId, id); db.tx(() => { db.run('DELETE FROM studio_evidence WHERE project_id = ?', id); db.run('UPDATE transactions SET studio_project_id = NULL WHERE studio_project_id = ?', id); db.run('DELETE FROM studio_projects WHERE id = ?', id); }); audit.record({ workspaceId: wsId, event: 'studio.projet_supprime', entity: 'studio', entityId: id, detail: { name: p.name } }); },
  };
}
