// Moteur d'analyse : il ne contient aucune règle. Il prépare le contexte, interroge les règles
// que les modules activés ont déclarées au noyau, et rassemble leurs constats.
// Chaque constat cite les éléments chiffrés qui le justifient (`evidence`) ; rien n'est inventé.
import { today as isoToday, daysAgo } from '../core/db.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (n) => Math.round(n * 100) / 100;
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const KINDS = ['probleme', 'risque', 'opportunite'];

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

// Contexte fourni à chaque règle : les données de l'espace, des périodes prêtes à l'emploi et des outils de calcul.
export function analysisContext({ tasks = [], projects = [], transactions = [], documents = [] }, date = new Date()) {
  const t0 = isoToday(date); const d30 = daysAgo(30, date); const d60 = daysAgo(60, date);
  return Object.freeze({
    tasks, projects, transactions, documents, date, t0, d30, d60,
    open: tasks.filter((t) => t.status !== 'fait'),
    cur: transactions.filter((x) => x.date > d30 && x.date <= t0),
    prev: transactions.filter((x) => x.date > d60 && x.date <= d30),
    incomeOf: (xs) => sum(xs.filter((x) => x.amount > 0).map((x) => x.amount)),
    expenseOf: (xs) => -sum(xs.filter((x) => x.amount < 0).map((x) => x.amount)),
    sum, round, dayDiff, norm,
  });
}

// `rules` : règles du registre pour les modules activés. Une règle défaillante n'interrompt
// pas l'analyse : son erreur est rapportée dans `errors` et les autres règles s'exécutent.
export function analyze(data, { date = new Date(), rules = [] } = {}) {
  const ctx = analysisContext(data, date); const findings = []; const errors = [];
  for (const rule of rules) {
    try {
      const out = rule.evaluate(ctx);
      for (const f of (Array.isArray(out) ? out : [out]).filter(Boolean)) {
        if (!KINDS.includes(f.kind) || typeof f.title !== 'string' || !f.title.trim()) throw new Error('constat mal formé (kind, title requis)');
        findings.push({
          rule: rule.id, fingerprint: f.key ? `${rule.id}:${String(f.key).slice(0, 120)}` : rule.id, kind: f.kind,
          severity: Math.max(1, Math.min(5, Math.round(Number(f.severity) || 1))), title: f.title.slice(0, 300), detail: String(f.detail ?? '').slice(0, 1000), evidence: f.evidence ?? {},
        });
      }
    } catch (e) { errors.push({ rule: rule.id, module: rule.module, message: String(e.message).slice(0, 300) }); }
  }
  return { findings, errors };
}

// Ce qui manque pour qu'une analyse soit possible : OMNIA le dit plutôt que de combler par des suppositions.
export function dataGaps({ tasks, transactions, documents }) {
  const gaps = [];
  if (!tasks.length) gaps.push('Aucune tâche : ajoutez vos activités en cours pour détecter retards et surcharges.');
  if (transactions.length < 3) gaps.push('Moins de 3 opérations financières : importez un relevé (CSV) pour analyser dépenses et revenus.');
  if (!documents.length) gaps.push('Aucun document en mémoire : ajoutez notes, offres ou procédures pour enrichir les réponses de l\'assistant.');
  return gaps;
}
