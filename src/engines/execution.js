// Moteur d'exécution : toute action passe par ce registre.
// Règle intangible : une action « sensible » (effet hors d'OMNIA) n'est jamais exécutée
// sans autorisation explicite de l'utilisateur. Chaque demande, décision et résultat est journalisé,
// et l'état rapporté est celui réellement constaté (réussie / échouée, avec le détail).
import { now, parseJson } from '../core/db.js';

const str = (v, name, max = 500) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Paramètre « ${name} » requis`);
  return v.trim().slice(0, max);
};
const int = (v, name, min, max, fallback) => {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new Error(`Paramètre « ${name} » requis`); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Paramètre « ${name} » invalide`);
  return n;
};
const ids = (v, name) => {
  if (!Array.isArray(v) || !v.length || v.length > 500 || !v.every((x) => Number.isInteger(x) && x > 0)) throw new Error(`Paramètre « ${name} » invalide`);
  return v;
};
const STATUSES = ['a_faire', 'en_cours', 'fait'];
const day = (v, name) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new Error(`Paramètre « ${name} » invalide (AAAA-MM-JJ)`);
  return v;
};

export const BUILTIN_ACTION_TYPES = ['studio.engager_depense', 'operation.enregistrer', 'tache.creer', 'tache.modifier_lot', 'tache.prioriser_projet', 'document.generer', 'email.brouillon', 'export.csv', 'analyse.lancer', 'message.envoyer', 'stripe.importer', 'webhook.envoyer'];

export function createExecution({ db, audit, services, registry, events, moduleApi }) {
  const TYPES = {
    'tache.creer': {
      label: 'Créer une tâche', sensitivity: 'interne',
      // Échéance : une date précise (due_date), un délai en jours (due_in_days, 7 par défaut) ou aucune (sans_echeance).
      validate: (p) => {
        const out = { title: str(p.title, 'title', 300), notes: typeof p.notes === 'string' ? p.notes.slice(0, 2000) : '', priority: int(p.priority, 'priority', 1, 3, 2),
          project_id: p.project_id == null ? null : int(p.project_id, 'project_id', 1, Number.MAX_SAFE_INTEGER) };
        if (p.due_date != null) out.due_date = day(p.due_date, 'due_date');
        else if (p.sans_echeance === true) out.sans_echeance = true;
        else out.due_in_days = int(p.due_in_days, 'due_in_days', 0, 3650, 7);
        return out;
      },
      run: (ws, { due_in_days, sans_echeance, ...p }) => ({ taskId: services.createTask(ws.id, { ...p, due_date: p.due_date ?? (sans_echeance ? null : services.inDays(due_in_days)), origin: 'omnia' }).id }),
    },
    // Tout engagement financier du studio exige une autorisation humaine, même couvert par les bénéfices.
    'studio.engager_depense': {
      label: 'Engager une dépense du studio', sensitivity: 'sensible',
      validate: (p) => {
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e9) throw new Error('Paramètre « amount » invalide');
        return { projectId: int(p.projectId, 'projectId', 1, Number.MAX_SAFE_INTEGER), amount: Math.round(amount * 100) / 100, label: str(p.label, 'label', 300), category: typeof p.category === 'string' ? p.category.trim().slice(0, 80) : '' };
      },
      run: (ws, p) => services.studioSpend(ws.id, p),
    },
    'operation.enregistrer': {
      label: 'Enregistrer une opération financière', sensitivity: 'interne',
      validate: (p) => {
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) >= 1e12) throw new Error('Paramètre « amount » invalide');
        const opt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        return { amount: Math.round(amount * 100) / 100, date: day(p.date, 'date'), label: opt(p.label, 300), category: opt(p.category, 80), counterparty: opt(p.counterparty, 200) };
      },
      run: (ws, p) => ({ transactionId: services.createTransaction(ws.id, p).id }),
    },
    'tache.modifier_lot': {
      label: 'Modifier plusieurs tâches', sensitivity: 'interne',
      validate: (p) => {
        const patch = {};
        if (p.priority != null) patch.priority = int(p.priority, 'priority', 1, 3);
        if (p.due_in_days != null) patch.due_in_days = int(p.due_in_days, 'due_in_days', 0, 3650);
        if (p.status != null) { if (!STATUSES.includes(p.status)) throw new Error('Paramètre « status » invalide'); patch.status = p.status; }
        if (!Object.keys(patch).length) throw new Error('Aucune modification demandée');
        return { taskIds: ids(p.taskIds, 'taskIds'), ...patch };
      },
      run: (ws, { taskIds, due_in_days, ...patch }) => {
        if (due_in_days != null) patch.due_date = services.inDays(due_in_days);
        let updated = 0;
        for (const id of taskIds) if (services.updateTask(ws.id, id, patch)) updated += 1;
        return { requested: taskIds.length, updated };
      },
    },
    'tache.prioriser_projet': {
      label: 'Prioriser les tâches d\'un projet', sensitivity: 'interne',
      validate: (p) => ({ projectId: int(p.projectId, 'projectId', 1, Number.MAX_SAFE_INTEGER) }),
      run: (ws, { projectId }) => ({
        updated: Number(db.run("UPDATE tasks SET priority = 1 WHERE workspace_id = ? AND project_id = ? AND status != 'fait'", ws.id, projectId).changes),
      }),
    },
    'document.generer': {
      label: 'Générer un document', sensitivity: 'interne',
      validate: (p) => ({ template: str(p.template, 'template', 40), brief: typeof p.brief === 'string' ? p.brief.slice(0, 500) : '' }),
      run: async (ws, p) => { const d = await services.generateDocument(ws.id, p.template, p.brief); return { documentId: d.id, title: d.title, source: d.source }; },
    },
    'email.brouillon': {
      label: 'Préparer un brouillon d\'e-mail', sensitivity: 'interne',
      validate: (p) => ({ subject: str(p.subject, 'subject', 200), body: str(p.body, 'body', 10000), to: typeof p.to === 'string' ? p.to.slice(0, 200) : '' }),
      run: (ws, p) => {
        const d = services.createDocument(ws.id, { title: `Brouillon — ${p.subject}`, kind: 'brouillon_email', origin: 'omnia', content: `${p.to ? `À : ${p.to}\n` : ''}Objet : ${p.subject}\n\n${p.body}` });
        return { documentId: d.id, sent: false, note: 'Brouillon enregistré dans la Mémoire. OMNIA n\'a rien envoyé.' };
      },
    },
    'export.csv': {
      label: 'Exporter en CSV', sensitivity: 'interne',
      validate: (p) => { if (!['transactions', 'taches'].includes(p.dataset)) throw new Error('Paramètre « dataset » invalide'); return { dataset: p.dataset }; },
      run: (ws, p) => services.exportCsv(ws.id, p.dataset),
    },
    'analyse.lancer': {
      label: 'Lancer une analyse', sensitivity: 'interne', validate: () => ({}),
      run: (ws, _p, actor) => { const r = services.runAnalysis(ws.id, actor); return { constats: r.insights.length, nouveaux: r.created, resolus: r.resolved }; },
    },
    'message.envoyer': {
      label: 'Envoyer un message sur un canal', sensitivity: 'sensible',
      validate: (p) => {
        const include = p.include ?? 'aucun';
        if (!['aucun', 'indicateurs'].includes(include)) throw new Error('Paramètre « include » invalide');
        return { channelId: int(p.channelId, 'channelId', 1, Number.MAX_SAFE_INTEGER), text: str(p.text, 'text', 3000), include };
      },
      run: (ws, p) => services.sendMessage(ws.id, p),
    },
    'stripe.importer': {
      label: 'Importer les mouvements Stripe', sensitivity: 'interne',
      validate: (p) => ({ days: int(p.days, 'days', 1, 365, 30) }),
      run: (ws, p) => services.importStripe(ws.id, p.days),
    },
    'webhook.envoyer': {
      label: 'Envoyer des données à un service externe', sensitivity: 'sensible',
      validate: (p) => {
        const url = str(p.url, 'url', 2000);
        let u; try { u = new URL(url); } catch { throw new Error('URL invalide'); }
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Seules les URL http(s) sont acceptées');
        const include = p.include ?? 'aucun';
        if (!['aucun', 'indicateurs'].includes(include)) throw new Error('Paramètre « include » invalide');
        const message = typeof p.message === 'string' ? p.message.slice(0, 2000) : '';
        return { url, include, message };
      },
      run: (ws, p) => services.postWebhook(ws.id, p),
    },
  };

  // Un type d'action vient du socle ou d'un module enregistré auprès du noyau.
  const typeDef = (type) => TYPES[type] ?? registry?.action(type);
  const emit = (event, ws, action, extra = {}) => events?.emit(event, ws.id, { actionId: action.id, type: action.type, ...extra });
  const row = (a) => a && ({ ...a, params: parseJson(a.params, {}), result: parseJson(a.result, null), label: typeDef(a.type)?.label ?? a.type });
  const get = (wsId, id) => row(db.get('SELECT * FROM actions WHERE id = ? AND workspace_id = ?', id, wsId));

  async function execute(ws, action, actor) {
    db.run("UPDATE actions SET status = 'en_cours' WHERE id = ?", action.id);
    try {
      const def = typeDef(action.type);
      if (!def) throw new Error('Le module qui fournissait cette action n\'est plus chargé');
      if (def.module && !ws.modules.includes(def.module)) throw new Error(`Le module « ${def.module} » n'est pas activé pour cet espace`);
      const result = def.module ? await def.run(ws, action.params, moduleApi(ws.id)) : await def.run(ws, action.params, actor);
      db.run("UPDATE actions SET status = 'reussie', result = ?, executed_at = ? WHERE id = ?", JSON.stringify(result ?? {}), now(), action.id);
      audit.record({ workspaceId: ws.id, actor: 'omnia', event: 'action.reussie', entity: 'action', entityId: action.id, detail: { type: action.type, result } });
      emit('action.reussie', ws, action);
    } catch (e) {
      db.run("UPDATE actions SET status = 'echouee', error = ?, executed_at = ? WHERE id = ?", String(e.message).slice(0, 1000), now(), action.id);
      audit.record({ workspaceId: ws.id, actor: 'omnia', event: 'action.echouee', entity: 'action', entityId: action.id, detail: { type: action.type, error: e.message } });
      emit('action.echouee', ws, action, { error: String(e.message).slice(0, 300) });
    }
    return get(ws.id, action.id);
  }

  return {
    types: () => [...Object.entries(TYPES).map(([type, t]) => ({ type, label: t.label, sensitivity: t.sensitivity, module: null })), ...(registry?.actions() ?? [])],
    sensitivityOf: (type) => typeDef(type)?.sensitivity,
    // Vérifie des paramètres sans rien exécuter (utilisé pour valider un plan proposé).
    validate(type, params) { const def = typeDef(type); if (!def) throw new Error(`Type d'action inconnu : ${type}`); return def.validate(params ?? {}); },
    list: (wsId, status) => (status
      ? db.all('SELECT * FROM actions WHERE workspace_id = ? AND status = ? ORDER BY id DESC LIMIT 200', wsId, status)
      : db.all('SELECT * FROM actions WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', wsId)).map(row),
    get,
    // requestedBy : 'utilisateur' (demande directe ou recommandation acceptée) ou 'automatisation'.
    async request(ws, { type, params = {}, requestedBy = 'utilisateur', recommendationId = null, automation = null }) {
      const def = typeDef(type);
      if (!def) throw new Error(`Type d'action inconnu : ${type}`);
      if (def.module && !ws.modules.includes(def.module)) throw new Error(`Le module « ${def.module} » n'est pas activé pour cet espace`);
      const clean = def.validate(params ?? {});
      const sensitive = def.sensitivity === 'sensible';
      const standing = Boolean(automation?.preauthorized); // autorisation permanente accordée explicitement par l'utilisateur
      const needsApproval = sensitive ? !(requestedBy === 'automatisation' && standing)
        : (requestedBy !== 'utilisateur' && ws.autonomy === 'manuel');
      const id = db.insert(
        'INSERT INTO actions (workspace_id, recommendation_id, automation_id, type, params, sensitivity, status, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ws.id, recommendationId, automation?.id ?? null, type, JSON.stringify(clean), def.sensitivity, needsApproval ? 'en_attente' : 'autorisee', requestedBy, now(),
      );
      audit.record({ workspaceId: ws.id, actor: requestedBy, event: needsApproval ? 'action.demandee' : 'action.autorisee', entity: 'action', entityId: id,
        detail: { type, params: clean, sensitivity: def.sensitivity, ...(sensitive && standing ? { autorisationPermanente: automation.id } : {}) } });
      const action = get(ws.id, id);
      if (needsApproval) emit('action.en_attente', ws, action, { requestedBy });
      return needsApproval ? action : execute(ws, action, requestedBy);
    },
    async approve(ws, id) {
      const action = get(ws.id, id);
      if (!action) throw new Error('Action introuvable');
      if (action.status !== 'en_attente') throw new Error('Cette action n\'est pas en attente d\'autorisation');
      db.run("UPDATE actions SET status = 'autorisee', decided_at = ? WHERE id = ?", now(), id);
      audit.record({ workspaceId: ws.id, actor: 'utilisateur', event: 'action.approuvee', entity: 'action', entityId: id, detail: { type: action.type } });
      return execute(ws, action, 'utilisateur');
    },
    reject(ws, id) {
      const action = get(ws.id, id);
      if (!action) throw new Error('Action introuvable');
      if (action.status !== 'en_attente') throw new Error('Cette action n\'est pas en attente d\'autorisation');
      db.run("UPDATE actions SET status = 'refusee', decided_at = ? WHERE id = ?", now(), id);
      audit.record({ workspaceId: ws.id, actor: 'utilisateur', event: 'action.refusee', entity: 'action', entityId: id, detail: { type: action.type } });
      return get(ws.id, id);
    },
  };
}
