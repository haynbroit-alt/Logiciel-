// Moteur d'analyse : règles déterministes et explicables appliquées aux données réelles.
// Chaque constat cite les éléments chiffrés qui le justifient (`evidence`) ; rien n'est inventé.
import { today as isoToday, daysAgo } from '../core/db.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (n) => Math.round(n * 100) / 100;
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export const RULES = {
  'taches.en_retard': { module: 'gestion', label: 'Tâches en retard' },
  'taches.surcharge': { module: 'gestion', label: 'Trop de tâches en cours' },
  'taches.dormantes': { module: 'gestion', label: 'Tâches dormantes' },
  'projets.a_risque': { module: 'gestion', label: 'Projet à risque' },
  'projets.sans_taches': { module: 'gestion', label: 'Projet sans plan' },
  'finances.tresorerie_negative': { module: 'finances', label: 'Solde négatif sur 30 jours' },
  'finances.hausse_depenses': { module: 'finances', label: 'Hausse d\'un poste de dépense' },
  'finances.charges_recurrentes': { module: 'finances', label: 'Charges récurrentes' },
  'finances.doublons': { module: 'finances', label: 'Paiements en double possibles' },
  'finances.dependance_client': { module: 'finances', label: 'Dépendance à une source de revenus' },
  'finances.revenus_en_baisse': { module: 'finances', label: 'Revenus en baisse' },
  'finances.revenus_en_hausse': { module: 'finances', label: 'Revenus en hausse' },
};

export function computeKpis({ tasks, transactions, projects }, date = new Date()) {
  const t0 = isoToday(date); const d30 = daysAgo(30, date);
  const open = tasks.filter((t) => t.status !== 'fait');
  const done30 = tasks.filter((t) => t.status === 'fait' && t.done_at && t.done_at.slice(0, 10) >= d30);
  const last30 = transactions.filter((x) => x.date > d30 && x.date <= t0);
  const income = sum(last30.filter((x) => x.amount > 0).map((x) => x.amount));
  const expenses = -sum(last30.filter((x) => x.amount < 0).map((x) => x.amount));
  return {
    taches_ouvertes: open.length,
    taches_en_retard: open.filter((t) => t.due_date && t.due_date < t0).length,
    taches_terminees_30j: done30.length,
    projets_actifs: projects.filter((p) => p.status === 'actif').length,
    revenus_30j: round(income),
    depenses_30j: round(expenses),
    solde_30j: round(income - expenses),
  };
}

export function analyze({ tasks, projects, transactions }, { date = new Date(), enabledModules = null } = {}) {
  const t0 = isoToday(date);
  const d30 = daysAgo(30, date); const d60 = daysAgo(60, date);
  const findings = [];
  const add = (rule, key, kind, severity, title, detail, evidence) => {
    if (enabledModules && !enabledModules.includes(RULES[rule].module)) return;
    findings.push({ rule, fingerprint: key ? `${rule}:${key}` : rule, kind, severity, title, detail, evidence });
  };

  // ---------- Gestion ----------
  const open = tasks.filter((t) => t.status !== 'fait');
  const overdue = open.filter((t) => t.due_date && t.due_date < t0).sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (overdue.length) {
    const worst = dayDiff(t0, overdue[0].due_date);
    add('taches.en_retard', '', 'probleme', Math.min(5, 2 + Math.floor(overdue.length / 3) + (worst > 14 ? 1 : 0)),
      `${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard`,
      `La plus ancienne a ${worst} jour${worst > 1 ? 's' : ''} de retard (« ${overdue[0].title} »).`,
      { taskIds: overdue.map((t) => t.id), titles: overdue.slice(0, 5).map((t) => t.title), maxDaysLate: worst });
  }
  const doing = open.filter((t) => t.status === 'en_cours');
  if (doing.length > 5) {
    add('taches.surcharge', '', 'risque', 3, `${doing.length} tâches menées de front`,
      'Au-delà de 5 tâches en cours simultanément, le temps se disperse et les délais s\'allongent.',
      { taskIds: doing.map((t) => t.id), count: doing.length });
  }
  const stale = open.filter((t) => t.status === 'a_faire' && !t.due_date && t.created_at.slice(0, 10) < d30);
  if (stale.length >= 3) {
    add('taches.dormantes', '', 'probleme', 2, `${stale.length} tâches sans échéance depuis plus de 30 jours`,
      'Ces tâches encombrent la liste sans avancer : à planifier, déléguer ou supprimer.',
      { taskIds: stale.map((t) => t.id), titles: stale.slice(0, 5).map((t) => t.title) });
  }
  for (const p of projects.filter((x) => x.status === 'actif')) {
    const pt = tasks.filter((t) => t.project_id === p.id);
    if (!pt.length) {
      add('projets.sans_taches', String(p.id), 'probleme', 2, `Le projet « ${p.name} » n'a aucune tâche`,
        'Sans étapes concrètes, un projet ne peut être ni suivi ni mené à terme.', { projectId: p.id, projectName: p.name });
      continue;
    }
    if (!p.deadline) continue;
    const left = dayDiff(p.deadline, t0);
    const progress = pt.filter((t) => t.status === 'fait').length / pt.length;
    if (left <= 14 && progress < 0.6) {
      add('projets.a_risque', String(p.id), 'risque', left < 0 ? 5 : 4,
        `Le projet « ${p.name} » risque de manquer son échéance`,
        `${left < 0 ? `Échéance dépassée de ${-left} jour(s)` : `${left} jour(s) restant(s)`} pour ${Math.round(progress * 100)} % d'avancement (${pt.length} tâches).`,
        { projectId: p.id, projectName: p.name, daysLeft: left, progress: round(progress), remaining: pt.filter((t) => t.status !== 'fait').length });
    }
  }

  // ---------- Finances ----------
  const cur = transactions.filter((x) => x.date > d30 && x.date <= t0);
  const prev = transactions.filter((x) => x.date > d60 && x.date <= d30);
  const incomeOf = (xs) => sum(xs.filter((x) => x.amount > 0).map((x) => x.amount));
  const expenseOf = (xs) => -sum(xs.filter((x) => x.amount < 0).map((x) => x.amount));
  const inc = incomeOf(cur); const exp = expenseOf(cur); const incPrev = incomeOf(prev);

  if (cur.length >= 3 && exp > inc && exp > 0) {
    add('finances.tresorerie_negative', '', 'probleme', inc === 0 ? 3 : 4,
      'Les dépenses dépassent les revenus sur 30 jours',
      `Revenus ${round(inc)} · dépenses ${round(exp)} · solde ${round(inc - exp)}.`,
      { income: round(inc), expenses: round(exp), net: round(inc - exp) });
  }
  const byCat = (xs) => xs.filter((x) => x.amount < 0).reduce((m, x) => (m.set(x.category, (m.get(x.category) ?? 0) - x.amount), m), new Map());
  const catCur = byCat(cur); const catPrev = byCat(prev);
  for (const [cat, amount] of catCur) {
    const before = catPrev.get(cat) ?? 0;
    if (before > 0 && amount > before * 1.4 && amount - before >= Math.max(50, exp * 0.05)) {
      add('finances.hausse_depenses', norm(cat), 'risque', 3, `Le poste « ${cat} » a augmenté de ${Math.round((amount / before - 1) * 100)} %`,
        `${round(amount)} sur les 30 derniers jours contre ${round(before)} sur les 30 précédents (+${round(amount - before)}).`,
        { category: cat, current: round(amount), previous: round(before), delta: round(amount - before) });
    }
  }
  // Charges récurrentes : même libellé débité sur au moins 3 mois distincts.
  const groups = new Map();
  for (const x of transactions.filter((y) => y.amount < 0 && norm(y.label))) {
    const g = groups.get(norm(x.label)) ?? { label: x.label, months: new Set(), amounts: [] };
    g.months.add(x.date.slice(0, 7)); g.amounts.push(-x.amount); groups.set(norm(x.label), g);
  }
  const recurring = [...groups.values()].filter((g) => g.months.size >= 3)
    .map((g) => ({ label: g.label, months: g.months.size, monthly: round(sum(g.amounts) / g.months.size) }))
    .sort((a, b) => b.monthly - a.monthly);
  if (recurring.length) {
    const yearly = round(sum(recurring.map((r) => r.monthly)) * 12);
    add('finances.charges_recurrentes', '', 'opportunite', yearly > 5000 ? 3 : 2,
      `${recurring.length} charge${recurring.length > 1 ? 's' : ''} récurrente${recurring.length > 1 ? 's' : ''} à renégocier ou résilier`,
      `Environ ${yearly} par an au rythme actuel. Les plus lourdes : ${recurring.slice(0, 3).map((r) => `${r.label} (${r.monthly}/mois)`).join(', ')}.`,
      { recurring: recurring.slice(0, 10), yearlyEstimate: yearly });
  }
  // Doublons : même date, même montant, même libellé.
  const seen = new Map();
  for (const x of transactions.filter((y) => y.amount < 0 && y.date > d60)) {
    const k = `${x.date}|${x.amount}|${norm(x.label)}`;
    seen.set(k, [...(seen.get(k) ?? []), x]);
  }
  const dups = [...seen.values()].filter((g) => g.length > 1);
  if (dups.length) {
    const total = round(sum(dups.map((g) => -g[0].amount * (g.length - 1))));
    add('finances.doublons', '', 'probleme', 3, `${dups.length} paiement${dups.length > 1 ? 's' : ''} possiblement en double`,
      `Montant potentiellement payé en trop : ${total}. À vérifier avant toute réclamation.`,
      { duplicates: dups.slice(0, 10).map((g) => ({ date: g[0].date, label: g[0].label, amount: g[0].amount, count: g.length, ids: g.map((x) => x.id) })), total });
  }
  // Dépendance : une seule contrepartie pèse plus de la moitié des revenus sur 60 jours.
  const incomes = transactions.filter((x) => x.amount > 0 && x.date > d60 && norm(x.counterparty));
  const totalInc = sum(incomes.map((x) => x.amount));
  if (incomes.length >= 4 && totalInc > 0) {
    const byCp = incomes.reduce((m, x) => (m.set(x.counterparty, (m.get(x.counterparty) ?? 0) + x.amount), m), new Map());
    const [top, amount] = [...byCp.entries()].sort((a, b) => b[1] - a[1])[0];
    if (byCp.size > 1 && amount / totalInc > 0.5) {
      add('finances.dependance_client', '', 'risque', amount / totalInc > 0.7 ? 4 : 3,
        `${Math.round((amount / totalInc) * 100)} % des revenus dépendent de « ${top} »`,
        'La perte de cette source mettrait l\'activité en difficulté : diversifier réduit ce risque.',
        { counterparty: top, share: round(amount / totalInc), amount: round(amount), total: round(totalInc) });
    }
  }
  if (incPrev > 0 && cur.length >= 2) {
    const change = inc / incPrev - 1;
    if (change <= -0.2) {
      add('finances.revenus_en_baisse', '', 'risque', change <= -0.4 ? 4 : 3, `Revenus en baisse de ${Math.round(-change * 100)} % sur 30 jours`,
        `${round(inc)} contre ${round(incPrev)} sur la période précédente.`, { current: round(inc), previous: round(incPrev), change: round(change) });
    } else if (change >= 0.2) {
      add('finances.revenus_en_hausse', '', 'opportunite', 2, `Revenus en hausse de ${Math.round(change * 100)} % sur 30 jours`,
        `${round(inc)} contre ${round(incPrev)} : identifier ce qui a fonctionné pour le reproduire.`, { current: round(inc), previous: round(incPrev), change: round(change) });
    }
  }
  return findings;
}

// Ce qui manque pour qu'une analyse soit possible : OMNIA le dit plutôt que de combler par des suppositions.
export function dataGaps({ tasks, transactions, documents }) {
  const gaps = [];
  if (!tasks.length) gaps.push('Aucune tâche : ajoutez vos activités en cours pour détecter retards et surcharges.');
  if (transactions.length < 3) gaps.push('Moins de 3 opérations financières : importez un relevé (CSV) pour analyser dépenses et revenus.');
  if (!documents.length) gaps.push('Aucun document en mémoire : ajoutez notes, offres ou procédures pour enrichir les réponses de l\'assistant.');
  return gaps;
}
