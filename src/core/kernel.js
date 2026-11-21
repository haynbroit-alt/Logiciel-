// Noyau central d'OMNIA Ω. Il relie mémoire, moteurs et connecteurs et porte le cycle :
// comprendre → analyser → décider → agir (avec autorisation) → mesurer → apprendre.
import { now, today, parseJson } from './db.js';
import { createAudit } from './audit.js';
import { transactionsFromCsv } from './csv.js';
import { understand, KINDS, SECTORS } from '../engines/understanding.js';
import { analyze, computeKpis, dataGaps, RULES } from '../engines/analysis.js';
import { decide, weightOf } from '../engines/decision.js';
import { createExecution } from '../engines/execution.js';
import { generateDocument, answer, TEMPLATES } from '../engines/creation.js';
import { MODULES, moduleById, suggestModules, sanitizeModules } from '../modules/index.js';
import { createConnectors } from '../connectors/index.js';

export class OmniaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const need = (cond, message, status = 400) => { if (!cond) throw new OmniaError(message, status); };
const text = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const TASK_STATUSES = ['a_faire', 'en_cours', 'fait'];

export function createKernel({ db, ai, config }) {
  const audit = createAudit(db);
  const connectors = createConnectors(config);
  const clock = () => (config.clock ? config.clock() : new Date());

  // ---------- Espaces ----------
  const wsRow = (w) => w && ({ ...w, goals: parseJson(w.goals, []), modules: parseJson(w.modules, []) });
  const workspace = (id) => {
    const w = wsRow(db.get('SELECT * FROM workspaces WHERE id = ?', Number(id)));
    need(w, 'Espace introuvable', 404);
    return w;
  };

  async function createWorkspace(input) {
    const name = text(input.name, 120); const description = text(input.description, 5000);
    need(name, 'Le nom de l\'activité est requis');
    const profile = await understand(ai, description || name);
    const id = db.insert(
      'INSERT INTO workspaces (name, description, kind, sector, goals, modules, currency, profile_source, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      name, description, profile.kind, profile.sector, JSON.stringify(profile.goals), JSON.stringify(suggestModules(profile.sector)),
      text(input.currency, 8, 'EUR') || 'EUR', profile.source, now(),
    );
    audit.record({ workspaceId: id, event: 'espace.cree', entity: 'espace', entityId: id, detail: { profile } });
    return { ...workspace(id), fallbackReason: profile.fallbackReason };
  }

  function updateWorkspace(id, patch) {
    const w = workspace(id); const next = {};
    if (patch.name !== undefined) { next.name = text(patch.name, 120); need(next.name, 'Nom requis'); }
    if (patch.description !== undefined) next.description = text(patch.description, 5000);
    if (patch.kind !== undefined) { need(KINDS.includes(patch.kind), 'Type d\'activité invalide'); next.kind = patch.kind; }
    if (patch.sector !== undefined) { need(SECTORS.includes(patch.sector), 'Secteur invalide'); next.sector = patch.sector; }
    if (patch.currency !== undefined) next.currency = text(patch.currency, 8) || 'EUR';
    if (patch.autonomy !== undefined) { need(['manuel', 'assiste'].includes(patch.autonomy), 'Niveau d\'autonomie invalide'); next.autonomy = patch.autonomy; }
    if (patch.goals !== undefined) { need(Array.isArray(patch.goals), 'Objectifs invalides'); next.goals = JSON.stringify(patch.goals.map((g) => text(g, 200)).filter(Boolean).slice(0, 10)); }
    if (patch.modules !== undefined) next.modules = JSON.stringify(sanitizeModules(patch.modules));
    const keys = Object.keys(next);
    if (keys.length) {
      db.run(`UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => next[k]), w.id);
      audit.record({ workspaceId: w.id, event: 'espace.modifie', entity: 'espace', entityId: w.id, detail: { champs: keys } });
    }
    return workspace(w.id);
  }

  function deleteWorkspace(id) {
    const w = workspace(id);
    db.tx(() => {
      for (const t of ['projects', 'tasks', 'transactions', 'documents', 'insights', 'recommendations', 'actions', 'automations', 'rule_weights', 'metrics']) {
        db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, w.id);
      }
      db.run('DELETE FROM workspaces WHERE id = ?', w.id);
    });
    // Le journal d'audit est conservé : la suppression elle-même y est tracée.
    audit.record({ workspaceId: w.id, event: 'espace.supprime', entity: 'espace', entityId: w.id, detail: { name: w.name } });
  }

  // ---------- Gestion : projets et tâches ----------
  const inDays = (n) => today(new Date(clock().getTime() + n * 86400000));

  function createProject(wsId, input) {
    const name = text(input.name, 200); need(name, 'Nom du projet requis');
    const id = db.insert('INSERT INTO projects (workspace_id, name, goal, deadline, created_at) VALUES (?,?,?,?,?)', wsId, name, text(input.goal, 1000), isoDate(input.deadline), now());
    return db.get('SELECT * FROM projects WHERE id = ?', id);
  }
  function updateProject(wsId, id, patch) {
    const p = db.get('SELECT * FROM projects WHERE id = ? AND workspace_id = ?', id, wsId); need(p, 'Projet introuvable', 404);
    const status = patch.status ?? p.status; need(['actif', 'termine', 'en_pause'].includes(status), 'Statut invalide');
    db.run('UPDATE projects SET name = ?, goal = ?, deadline = ?, status = ? WHERE id = ?',
      patch.name !== undefined ? text(patch.name, 200) || p.name : p.name, patch.goal !== undefined ? text(patch.goal, 1000) : p.goal,
      patch.deadline !== undefined ? isoDate(patch.deadline) : p.deadline, status, id);
    return db.get('SELECT * FROM projects WHERE id = ?', id);
  }
  function deleteProject(wsId, id) {
    db.run('UPDATE tasks SET project_id = NULL WHERE workspace_id = ? AND project_id = ?', wsId, id);
    need(db.run('DELETE FROM projects WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Projet introuvable', 404);
  }

  function createTask(wsId, input) {
    const title = text(input.title, 300); need(title, 'Titre de la tâche requis');
    const status = input.status ?? 'a_faire'; need(TASK_STATUSES.includes(status), 'Statut invalide');
    const priority = Number(input.priority ?? 2); need([1, 2, 3].includes(priority), 'Priorité invalide');
    let projectId = null;
    if (input.project_id != null && input.project_id !== '') {
      projectId = Number(input.project_id);
      need(db.get('SELECT id FROM projects WHERE id = ? AND workspace_id = ?', projectId, wsId), 'Projet introuvable', 404);
    }
    const id = db.insert('INSERT INTO tasks (workspace_id, project_id, title, notes, status, priority, due_date, origin, created_at, done_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      wsId, projectId, title, text(input.notes, 2000), status, priority, isoDate(input.due_date), input.origin === 'omnia' ? 'omnia' : 'utilisateur', now(), status === 'fait' ? now() : null);
    return db.get('SELECT * FROM tasks WHERE id = ?', id);
  }
  function updateTask(wsId, id, patch) {
    const t = db.get('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', id, wsId);
    if (!t) return null;
    const status = patch.status ?? t.status; need(TASK_STATUSES.includes(status), 'Statut invalide');
    const priority = Number(patch.priority ?? t.priority); need([1, 2, 3].includes(priority), 'Priorité invalide');
    const doneAt = status === 'fait' ? (t.done_at ?? now()) : null;
    db.run('UPDATE tasks SET title = ?, notes = ?, status = ?, priority = ?, due_date = ?, done_at = ? WHERE id = ?',
      patch.title !== undefined ? text(patch.title, 300) || t.title : t.title, patch.notes !== undefined ? text(patch.notes, 2000) : t.notes,
      status, priority, patch.due_date !== undefined ? isoDate(patch.due_date) : t.due_date, doneAt, id);
    return db.get('SELECT * FROM tasks WHERE id = ?', id);
  }
  const deleteTask = (wsId, id) => need(db.run('DELETE FROM tasks WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Tâche introuvable', 404);

  // ---------- Finances ----------
  function createTransaction(wsId, input) {
    const date = isoDate(input.date); need(date, 'Date invalide (AAAA-MM-JJ)');
    const amount = Number(input.amount); need(Number.isFinite(amount) && amount !== 0 && Math.abs(amount) < 1e12, 'Montant invalide');
    const id = db.insert('INSERT INTO transactions (workspace_id, date, amount, category, label, counterparty, created_at) VALUES (?,?,?,?,?,?,?)',
      wsId, date, Math.round(amount * 100) / 100, text(input.category, 80) || 'divers', text(input.label, 300), text(input.counterparty, 200), now());
    return db.get('SELECT * FROM transactions WHERE id = ?', id);
  }
  function importTransactions(wsId, csv) {
    need(typeof csv === 'string' && csv.trim(), 'Fichier CSV vide');
    let parsed; try { parsed = transactionsFromCsv(csv); } catch (e) { throw new OmniaError(e.message); }
    need(parsed.items.length <= 20000, 'Fichier trop volumineux (20 000 opérations au maximum par import)');
    db.tx(() => parsed.items.forEach((x) => createTransaction(wsId, x)));
    audit.record({ workspaceId: wsId, event: 'finances.import', entity: 'transactions', detail: { importees: parsed.items.length, ignorees: parsed.skipped.length } });
    return { imported: parsed.items.length, skipped: parsed.skipped.slice(0, 50), skippedCount: parsed.skipped.length };
  }
  const deleteTransaction = (wsId, id) => need(db.run('DELETE FROM transactions WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Opération introuvable', 404);

  // ---------- Mémoire ----------
  function createDocument(wsId, input) {
    const title = text(input.title, 200); need(title, 'Titre requis');
    const id = db.insert('INSERT INTO documents (workspace_id, title, kind, content, origin, created_at) VALUES (?,?,?,?,?,?)',
      wsId, title, text(input.kind, 40) || 'note', typeof input.content === 'string' ? input.content.slice(0, 200000) : '', input.origin === 'omnia' ? 'omnia' : 'utilisateur', now());
    return db.get('SELECT * FROM documents WHERE id = ?', id);
  }
  const deleteDocument = (wsId, id) => need(db.run('DELETE FROM documents WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Document introuvable', 404);

  // ---------- Lecture ----------
  const data = (wsId) => ({
    tasks: db.all('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY status = \'fait\', priority, due_date IS NULL, due_date, id DESC', wsId),
    projects: db.all('SELECT * FROM projects WHERE workspace_id = ? ORDER BY id DESC', wsId),
    transactions: db.all('SELECT * FROM transactions WHERE workspace_id = ? ORDER BY date DESC, id DESC', wsId),
    documents: db.all('SELECT * FROM documents WHERE workspace_id = ? ORDER BY id DESC', wsId),
  });
  const insightRow = (i) => ({ ...i, evidence: parseJson(i.evidence, {}), ruleLabel: RULES[i.rule]?.label ?? i.rule });
  const recRow = (r) => ({ ...r, options: parseJson(r.options, []) });
  const openInsights = (wsId) => db.all("SELECT * FROM insights WHERE workspace_id = ? AND status = 'ouvert' ORDER BY severity DESC, id DESC", wsId).map(insightRow);
  const listRecommendations = (wsId, status) => (status
    ? db.all('SELECT * FROM recommendations WHERE workspace_id = ? AND status = ? ORDER BY priority DESC, id DESC', wsId, status)
    : db.all("SELECT * FROM recommendations WHERE workspace_id = ? AND status != 'obsolete' ORDER BY status = 'proposee' DESC, priority DESC, id DESC LIMIT 200", wsId)).map(recRow);

  // ---------- Cycle d'analyse ----------
  const stats = (wsId, rule) => db.get('SELECT * FROM rule_weights WHERE workspace_id = ? AND rule = ?', wsId, rule);
  const bump = (wsId, rule, field) => db.run(
    `INSERT INTO rule_weights (workspace_id, rule, ${field}) VALUES (?, ?, 1) ON CONFLICT(workspace_id, rule) DO UPDATE SET ${field} = ${field} + 1`, wsId, rule);

  function propose(wsId, insight) {
    const d = decide(insight, stats(wsId, insight.rule));
    if (!d) return;
    const pending = db.get("SELECT id FROM recommendations WHERE insight_id = ? AND status = 'proposee'", insight.id);
    if (pending) {
      db.run('UPDATE recommendations SET title = ?, rationale = ?, options = ?, best_option = ?, priority = ? WHERE id = ?', d.title, d.rationale, JSON.stringify(d.options), d.best_option, d.priority, pending.id);
      return;
    }
    // Une recommandation déjà tranchée n'est reproposée que si le constat persiste après 14 jours.
    const decided = db.get("SELECT decided_at FROM recommendations WHERE insight_id = ? AND status IN ('acceptee','rejetee') ORDER BY id DESC LIMIT 1", insight.id);
    if (decided && Date.parse(decided.decided_at) > clock().getTime() - 14 * 86400000) return;
    db.run('INSERT INTO recommendations (workspace_id, insight_id, title, rationale, options, best_option, priority, created_at) VALUES (?,?,?,?,?,?,?,?)',
      wsId, insight.id, d.title, d.rationale, JSON.stringify(d.options), d.best_option, d.priority, now());
  }

  function runAnalysis(wsId, actor = 'utilisateur') {
    const w = workspace(wsId); const d = data(w.id); const date = clock();
    const findings = analyze(d, { date, enabledModules: w.modules });
    const seen = new Set(); let created = 0; let resolved = 0;
    db.tx(() => {
      for (const f of findings) {
        seen.add(f.fingerprint);
        const ex = db.get('SELECT * FROM insights WHERE workspace_id = ? AND fingerprint = ?', w.id, f.fingerprint);
        let id = ex?.id;
        if (!ex) {
          id = db.insert('INSERT INTO insights (workspace_id, rule, fingerprint, kind, severity, title, detail, evidence, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            w.id, f.rule, f.fingerprint, f.kind, f.severity, f.title, f.detail, JSON.stringify(f.evidence), now(), now());
          created += 1;
        } else {
          db.run(`UPDATE insights SET kind = ?, severity = ?, title = ?, detail = ?, evidence = ?, last_seen_at = ?${ex.status === 'resolu' ? ", status = 'ouvert', resolved_at = NULL" : ''} WHERE id = ?`,
            f.kind, f.severity, f.title, f.detail, JSON.stringify(f.evidence), now(), id);
          if (ex.status === 'ignore') continue;
        }
        propose(w.id, { ...f, id });
      }
      // Mesure des résultats : un constat qui ne se déclenche plus est résolu. Si une
      // recommandation avait été acceptée pour lui, la règle correspondante gagne en crédit.
      for (const i of db.all("SELECT * FROM insights WHERE workspace_id = ? AND status = 'ouvert'", w.id)) {
        if (seen.has(i.fingerprint)) continue;
        db.run("UPDATE insights SET status = 'resolu', resolved_at = ? WHERE id = ?", now(), i.id);
        db.run("UPDATE recommendations SET status = 'obsolete' WHERE insight_id = ? AND status = 'proposee'", i.id);
        const acted = db.get("SELECT id FROM recommendations WHERE insight_id = ? AND status = 'acceptee' AND outcome IS NULL ORDER BY id DESC LIMIT 1", i.id);
        if (acted && w.modules.includes(RULES[i.rule]?.module)) {
          db.run("UPDATE recommendations SET outcome = 'resolu' WHERE id = ?", acted.id);
          bump(w.id, i.rule, 'resolved');
        }
        resolved += 1;
      }
      const kpis = { ...computeKpis(d, date), constats_ouverts: db.get("SELECT COUNT(*) AS n FROM insights WHERE workspace_id = ? AND status = 'ouvert'", w.id).n };
      for (const [k, v] of Object.entries(kpis)) {
        db.run('INSERT INTO metrics (workspace_id, day, key, value) VALUES (?,?,?,?) ON CONFLICT(workspace_id, day, key) DO UPDATE SET value = excluded.value', w.id, today(date), k, v);
      }
    });
    const insights = openInsights(w.id);
    audit.record({ workspaceId: w.id, actor, event: 'analyse.executee', entity: 'espace', entityId: w.id, detail: { constats: insights.length, nouveaux: created, resolus: resolved } });
    return { insights, created, resolved, gaps: dataGaps(d) };
  }

  function dashboard(wsId) {
    const w = workspace(wsId); const d = data(w.id); const date = clock();
    const d30 = today(new Date(date.getTime() - 30 * 86400000));
    const byCat = db.all('SELECT category, ROUND(-SUM(amount), 2) AS total FROM transactions WHERE workspace_id = ? AND amount < 0 AND date > ? GROUP BY category ORDER BY total DESC LIMIT 8', w.id, d30);
    const lastAnalysis = db.get("SELECT ts FROM audit_log WHERE workspace_id = ? AND event = 'analyse.executee' ORDER BY id DESC LIMIT 1", w.id)?.ts ?? null;
    const learning = db.all('SELECT * FROM rule_weights WHERE workspace_id = ?', w.id).map((s) => ({ rule: s.rule, label: RULES[s.rule]?.label ?? s.rule, ...s, weight: weightOf(s) }));
    return {
      workspace: w,
      kpis: computeKpis(d, date),
      insights: openInsights(w.id),
      recommendations: listRecommendations(w.id, 'proposee').slice(0, 5),
      pendingActions: execution.list(w.id, 'en_attente'),
      expensesByCategory: byCat,
      history: db.all('SELECT day, key, value FROM metrics WHERE workspace_id = ? AND day > ? ORDER BY day', w.id, today(new Date(date.getTime() - 90 * 86400000))),
      results: {
        constats_resolus: db.get("SELECT COUNT(*) AS n FROM insights WHERE workspace_id = ? AND status = 'resolu'", w.id).n,
        recommandations_acceptees: db.get("SELECT COUNT(*) AS n FROM recommendations WHERE workspace_id = ? AND status = 'acceptee'", w.id).n,
        recommandations_suivies_d_effet: db.get("SELECT COUNT(*) AS n FROM recommendations WHERE workspace_id = ? AND outcome = 'resolu'", w.id).n,
        actions_reussies: db.get("SELECT COUNT(*) AS n FROM actions WHERE workspace_id = ? AND status = 'reussie'", w.id).n,
        actions_echouees: db.get("SELECT COUNT(*) AS n FROM actions WHERE workspace_id = ? AND status = 'echouee'", w.id).n,
      },
      learning,
      gaps: dataGaps(d),
      lastAnalysis,
      ai: { provider: ai.provider, model: ai.model, generative: ai.generative },
    };
  }

  // Contexte commun fourni aux moteurs de création et à l'assistant.
  function context(wsId) {
    const dash = dashboard(wsId);
    return { ...dash, recommendations: listRecommendations(wsId, 'proposee'), documents: data(wsId).documents,
      executedActions: db.all("SELECT type, status, executed_at FROM actions WHERE workspace_id = ? AND executed_at IS NOT NULL ORDER BY id DESC LIMIT 15", wsId) };
  }

  async function generate(wsId, template, brief) {
    const out = await generateDocument(ai, template, text(brief, 500), context(wsId)).catch((e) => { throw new OmniaError(e.message); });
    const doc = createDocument(wsId, { title: out.title, kind: template, content: out.content, origin: 'omnia' });
    audit.record({ workspaceId: wsId, actor: 'omnia', event: 'document.genere', entity: 'document', entityId: doc.id, detail: { template, source: out.source, fallbackReason: out.fallbackReason } });
    return { ...doc, source: out.source, fallbackReason: out.fallbackReason };
  }

  async function ask(wsId, question) {
    const q = text(question, 2000); need(q, 'Question requise');
    return answer(ai, q, context(wsId));
  }

  // ---------- Exécution ----------
  const execution = createExecution({
    db, audit,
    services: {
      inDays, createTask, updateTask, createDocument, runAnalysis,
      generateDocument: generate,
      exportCsv(wsId, dataset) {
        const d = data(wsId);
        return dataset === 'taches'
          ? connectors.exportCsv({ workspaceId: wsId, dataset, rows: d.tasks, columns: ['id', 'title', 'status', 'priority', 'due_date', 'project_id', 'created_at', 'done_at'] })
          : connectors.exportCsv({ workspaceId: wsId, dataset, rows: d.transactions, columns: ['id', 'date', 'amount', 'category', 'label', 'counterparty'] });
      },
      postWebhook(wsId, p) {
        const w = workspace(wsId);
        const payload = { source: 'OMNIA', espace: w.name, envoye_le: now(), message: p.message };
        if (p.include === 'indicateurs') payload.indicateurs = computeKpis(data(wsId), clock());
        return connectors.postWebhook({ url: p.url, payload });
      },
    },
  });

  async function acceptRecommendation(wsId, id, optionIndex) {
    const w = workspace(wsId);
    const r = recRow(db.get('SELECT * FROM recommendations WHERE id = ? AND workspace_id = ?', id, w.id)); need(r?.id, 'Recommandation introuvable', 404);
    need(r.status === 'proposee', 'Cette recommandation a déjà été traitée');
    const idx = optionIndex ?? r.best_option; const option = r.options[idx]; need(option, 'Option invalide');
    db.run("UPDATE recommendations SET status = 'acceptee', chosen_option = ?, decided_at = ? WHERE id = ?", idx, now(), id);
    const insight = db.get('SELECT rule FROM insights WHERE id = ?', r.insight_id);
    if (insight) bump(w.id, insight.rule, 'accepted');
    audit.record({ workspaceId: w.id, event: 'recommandation.acceptee', entity: 'recommandation', entityId: id, detail: { option: option.label } });
    const actions = [];
    for (const a of option.actions) {
      try { actions.push(await execution.request(w, { ...a, requestedBy: 'utilisateur', recommendationId: id })); } catch (e) { actions.push({ type: a.type, status: 'echouee', error: e.message }); }
    }
    return { recommendation: recRow(db.get('SELECT * FROM recommendations WHERE id = ?', id)), actions };
  }

  function rejectRecommendation(wsId, id) {
    const r = db.get('SELECT * FROM recommendations WHERE id = ? AND workspace_id = ?', id, wsId); need(r, 'Recommandation introuvable', 404);
    need(r.status === 'proposee', 'Cette recommandation a déjà été traitée');
    db.run("UPDATE recommendations SET status = 'rejetee', decided_at = ? WHERE id = ?", now(), id);
    const insight = db.get('SELECT rule FROM insights WHERE id = ?', r.insight_id);
    if (insight) bump(wsId, insight.rule, 'rejected');
    audit.record({ workspaceId: wsId, event: 'recommandation.rejetee', entity: 'recommandation', entityId: id, detail: {} });
  }

  function dismissInsight(wsId, id) {
    need(db.run("UPDATE insights SET status = 'ignore' WHERE id = ? AND workspace_id = ? AND status = 'ouvert'", id, wsId).changes, 'Constat introuvable', 404);
    db.run("UPDATE recommendations SET status = 'obsolete' WHERE insight_id = ? AND status = 'proposee'", id);
    audit.record({ workspaceId: wsId, event: 'constat.ignore', entity: 'constat', entityId: id, detail: {} });
  }

  // ---------- Automatisations ----------
  const listAutomations = (wsId) => db.all('SELECT * FROM automations WHERE workspace_id = ? ORDER BY id DESC', wsId).map((a) => ({ ...a, params: parseJson(a.params, {}), sensitivity: execution.sensitivityOf(a.action_type) }));
  function createAutomation(wsId, input) {
    const w = workspace(wsId);
    need(w.modules.includes('automatisations'), 'Le module Automatisations n\'est pas activé pour cet espace');
    const name = text(input.name, 120); need(name, 'Nom requis');
    const every = Number(input.every_minutes); need(Number.isInteger(every) && every >= 5 && every <= 525600, 'Intervalle invalide (5 minutes au minimum)');
    need(execution.sensitivityOf(input.action_type), 'Type d\'action inconnu');
    const id = db.insert('INSERT INTO automations (workspace_id, name, every_minutes, action_type, params, created_at) VALUES (?,?,?,?,?,?)', w.id, name, every, input.action_type, JSON.stringify(input.params ?? {}), now());
    audit.record({ workspaceId: w.id, event: 'automatisation.creee', entity: 'automatisation', entityId: id, detail: { name, every_minutes: every, action_type: input.action_type } });
    return listAutomations(w.id).find((a) => a.id === id);
  }
  function updateAutomation(wsId, id, patch) {
    const a = db.get('SELECT * FROM automations WHERE id = ? AND workspace_id = ?', id, wsId); need(a, 'Automatisation introuvable', 404);
    if (patch.enabled !== undefined) db.run('UPDATE automations SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
    if (patch.preauthorized !== undefined) {
      // Autorisation permanente : décision explicite de l'utilisateur, tracée, révocable à tout moment.
      db.run('UPDATE automations SET preauthorized = ? WHERE id = ?', patch.preauthorized ? 1 : 0, id);
      audit.record({ workspaceId: wsId, event: patch.preauthorized ? 'automatisation.autorisation_permanente_accordee' : 'automatisation.autorisation_permanente_revoquee', entity: 'automatisation', entityId: id, detail: { action_type: a.action_type } });
    }
    return listAutomations(wsId).find((x) => x.id === id);
  }
  const deleteAutomation = (wsId, id) => need(db.run('DELETE FROM automations WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Automatisation introuvable', 404);

  async function runAutomation(a) {
    const w = workspace(a.workspace_id);
    db.run('UPDATE automations SET last_run_at = ? WHERE id = ?', clock().toISOString(), a.id);
    let status;
    try {
      const action = await execution.request(w, { type: a.action_type, params: parseJson(a.params, {}), requestedBy: 'automatisation', automation: a });
      status = action.status;
    } catch (e) { status = `erreur : ${e.message}`.slice(0, 200); }
    db.run('UPDATE automations SET last_status = ? WHERE id = ?', status, a.id);
    return status;
  }
  // Appelé périodiquement par l'ordonnanceur : exécute les automatisations arrivées à échéance.
  async function tick() {
    const due = db.all('SELECT * FROM automations WHERE enabled = 1').filter((a) => !a.last_run_at || Date.parse(a.last_run_at) + a.every_minutes * 60000 <= clock().getTime());
    const ran = [];
    for (const a of due) {
      // Une action sensible encore en attente n'est pas redemandée à chaque passage.
      if (db.get("SELECT id FROM actions WHERE automation_id = ? AND status = 'en_attente'", a.id)) continue;
      if (!db.get('SELECT id FROM workspaces WHERE id = ?', a.workspace_id)) continue;
      ran.push({ id: a.id, status: await runAutomation(a) });
    }
    return ran;
  }

  function addStarterTasks(wsId, moduleId) {
    const w = workspace(wsId); const m = moduleById(moduleId);
    need(m?.starterTasks && w.modules.includes(m.id), 'Ce module ne propose pas de tâches de démarrage ou n\'est pas activé');
    return m.starterTasks.map((title) => createTask(w.id, { title, due_date: inDays(14), origin: 'omnia' }));
  }

  return {
    audit, execution, connectors, ai,
    meta: () => ({ modules: MODULES, kinds: KINDS, sectors: SECTORS, templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.title })), actionTypes: execution.types(), connectors: connectors.list(), ai: { provider: ai.provider, model: ai.model, generative: ai.generative } }),
    listWorkspaces: () => db.all('SELECT * FROM workspaces ORDER BY id').map(wsRow),
    workspace, createWorkspace, updateWorkspace, deleteWorkspace,
    data, createProject, updateProject, deleteProject, createTask, deleteTask,
    updateTask(wsId, id, patch) { const t = updateTask(wsId, id, patch); need(t, 'Tâche introuvable', 404); return t; },
    createTransaction, importTransactions, deleteTransaction, createDocument, deleteDocument,
    runAnalysis, dashboard, listRecommendations, acceptRecommendation, rejectRecommendation, dismissInsight,
    generate, ask,
    listAutomations, createAutomation, updateAutomation, deleteAutomation, tick, addStarterTasks,
  };
}
