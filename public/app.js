// Tableau de bord universel d'OMNIA Ω — JavaScript natif, sans dépendance.
// Tout le contenu est inséré via textContent : aucune donnée n'est interprétée comme du HTML.

// ---------- Outils ----------
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const $app = document.getElementById('app');
const state = { meta: null, workspaces: [], wsId: Number(localStorage.getItem('omnia.ws')) || null, view: 'tableau', chat: [], openDoc: null };

function toast(message, error = false) {
  const t = document.getElementById('toast');
  t.textContent = message; t.className = `show${error ? ' error' : ''}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = ''; }, error ? 6000 : 2600);
}

async function api(method, path, body) {
  const headers = {};
  const token = sessionStorage.getItem('omnia.token');
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  if (res.status === 401) {
    const given = window.prompt('Jeton d\'accès OMNIA :');
    if (!given) throw new Error('Jeton d\'accès requis');
    sessionStorage.setItem('omnia.token', given.trim());
    return api(method, path, body);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
const ws = (path = '') => `/espaces/${state.wsId}${path}`;

// Enveloppe une action utilisateur : désactive le bouton, affiche les erreurs, rafraîchit la vue.
const act = (fn, done) => async (ev) => {
  ev?.preventDefault?.();
  const btn = ev?.submitter ?? (ev?.currentTarget?.tagName === 'BUTTON' ? ev.currentTarget : null);
  if (btn) btn.disabled = true;
  try { const out = await fn(ev); if (typeof done === 'string') toast(done); else if (done) done(out); await render(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
};
const formData = (form) => Object.fromEntries(new FormData(form).entries());

const money = (n, cur) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 2 }).format(n);
const fdate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fdatetime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const LABELS = {
  probleme: 'Problème', risque: 'Risque', opportunite: 'Opportunité', a_faire: 'À faire', en_cours: 'En cours', fait: 'Fait',
  en_attente: 'En attente d\'autorisation', autorisee: 'Autorisée', reussie: 'Réussie', echouee: 'Échouée', refusee: 'Refusée',
  proposee: 'Proposée', acceptee: 'Acceptée', rejetee: 'Rejetée', interne: 'Interne', sensible: 'Sensible', manuel: 'Manuel', assiste: 'Assisté',
};
const L = (k) => LABELS[k] ?? k;
const badge = (k, text) => h('span', { class: `badge ${k}` }, text ?? L(k));
const sourceNote = (source, fallbackReason) => h('p', { class: 'muted small' },
  source === 'local' ? 'Produit en mode local, à partir de vos données, sans IA générative.' : `Rédigé avec ${source} à partir de vos données.`,
  fallbackReason ? ` Le fournisseur d'IA n'a pas répondu (${fallbackReason}) : repli sur le mode local.` : '');

// Rendu Markdown minimal et sûr (titres, listes, gras, italique) — construit des nœuds, jamais de HTML brut.
function inlineMd(text) {
  const out = []; const re = /\*\*(.+?)\*\*|_(.+?)_|`(.+?)`/g; let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? h('strong', {}, m[1]) : m[2] ? h('em', {}, m[2]) : h('code', {}, m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function md(text) {
  const root = h('div', { class: 'md' }); let list = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd(); let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { list = null; root.append(h(`h${m[1].length}`, {}, inlineMd(m[2]))); }
    else if ((m = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/))) {
      const tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); root.append(list); }
      list.append(h('li', {}, inlineMd(m[2])));
    } else if (!line.trim()) list = null;
    else { list = null; root.append(h('p', {}, inlineMd(line))); }
  }
  return root;
}

// ---------- Vues ----------
const VIEWS = [
  ['tableau', 'Tableau de bord'], ['assistant', 'Assistant'], ['decisions', 'Décisions'], ['actions', 'Actions'],
  ['gestion', 'Gestion', 'gestion'], ['finances', 'Finances', 'finances'], ['memoire', 'Mémoire', 'memoire'],
  ['automatisations', 'Automatisations', 'automatisations'], ['journal', 'Journal'], ['reglages', 'Réglages'],
];
const page = (title, subtitle, actions, ...content) => [
  h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)), h('div', { class: 'row' }, actions)),
  ...content,
];
const empty = (text) => h('p', { class: 'muted' }, text);

function recommendationCard(r, compact = false) {
  const options = r.options.map((o, i) => h('div', { class: `item ${i === r.best_option ? 'best' : ''}` },
    h('div', { class: 'row between' },
      h('strong', {}, o.label, i === r.best_option ? ' — conseillée' : ''),
      h('span', { class: 'muted small nowrap' }, `impact ${o.impact}/5 · effort ${o.effort}/5 · score ${o.score}`)),
    h('p', { class: 'small' }, o.detail),
    h('p', { class: 'muted small' }, 'Actions : ', o.actions.map((a) => state.meta.actionTypes.find((t) => t.type === a.type)?.label ?? a.type).join(', ')),
    r.status === 'proposee' && h('div', { class: 'row' }, h('button', { class: i === r.best_option ? 'primary' : '', onclick: act(() => api('POST', ws(`/recommandations/${r.id}/accepter`), { option: i }), (out) => {
      const failed = out.actions.filter((a) => a.status === 'echouee'); const waiting = out.actions.filter((a) => a.status === 'en_attente');
      toast(failed.length ? `${failed.length} action(s) en échec : ${failed[0].error}` : waiting.length ? `${waiting.length} action(s) en attente de votre autorisation` : `${out.actions.length} action(s) exécutée(s)`, failed.length > 0);
    }) }, 'Choisir cette option'))));
  return h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h3', {}, r.title), h('div', { class: 'row' }, r.status !== 'proposee' && badge(r.status), r.outcome === 'resolu' && badge('reussie', 'Suivie d\'effet'), h('span', { class: 'muted small' }, `priorité ${r.priority}`))),
    h('p', { class: 'muted small' }, r.rationale),
    compact ? options[r.best_option] : options,
    r.status === 'proposee' && h('div', { class: 'row' },
      compact && r.options.length > 1 && h('button', { class: 'link', onclick: () => go('decisions') }, `Comparer les ${r.options.length} options`),
      h('button', { class: 'link', onclick: act(() => api('POST', ws(`/recommandations/${r.id}/rejeter`)), 'Recommandation rejetée — OMNIA en tient compte') }, 'Rejeter')));
}

function actionCard(a) {
  const result = a.result ? Object.entries(a.result).map(([k, v]) => `${k} : ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
  return h('div', { class: 'item stack' },
    h('div', { class: 'row between' }, h('strong', {}, a.label), h('div', { class: 'row' }, badge(a.sensitivity), badge(a.status))),
    h('p', { class: 'small' }, h('code', {}, JSON.stringify(a.params))),
    h('p', { class: 'muted small' }, `Demandée par ${a.requested_by} le ${fdatetime(a.created_at)}`, a.executed_at ? ` · exécutée le ${fdatetime(a.executed_at)}` : ''),
    result && h('p', { class: 'small' }, 'Résultat constaté : ', result),
    a.error && h('p', { class: 'small neg' }, 'Erreur : ', a.error),
    a.status === 'en_attente' && h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: act(() => api('POST', ws(`/actions/${a.id}/approuver`)), (out) => toast(out.status === 'reussie' ? 'Action exécutée' : `Échec : ${out.error}`, out.status !== 'reussie')) }, 'Autoriser et exécuter'),
      h('button', { onclick: act(() => api('POST', ws(`/actions/${a.id}/refuser`)), 'Action refusée') }, 'Refuser')));
}

const views = {
  async tableau() {
    const d = await api('GET', ws('/tableau-de-bord')); const cur = d.workspace.currency; const k = d.kpis;
    const kpi = (label, value, neg) => h('div', { class: 'card kpi' }, h('div', { class: 'muted small' }, label), h('div', { class: `v ${neg ? 'neg' : ''}` }, value));
    const maxCat = Math.max(1, ...d.expensesByCategory.map((c) => c.total));
    return page(d.workspace.name, `${d.workspace.kind} · secteur ${d.workspace.sector}${d.lastAnalysis ? ` · dernière analyse le ${fdatetime(d.lastAnalysis)}` : ' · aucune analyse lancée'}`,
      h('button', { class: 'primary', onclick: act(() => api('POST', ws('/analyse')), (r) => toast(`${r.insights.length} constat(s) ouvert(s) · ${r.created} nouveau(x) · ${r.resolved} résolu(s)`)) }, 'Analyser maintenant'),
      h('div', { class: 'grid kpis' },
        kpi('Revenus (30 j)', money(k.revenus_30j, cur)), kpi('Dépenses (30 j)', money(k.depenses_30j, cur)), kpi('Solde (30 j)', money(k.solde_30j, cur), k.solde_30j < 0),
        kpi('Tâches ouvertes', k.taches_ouvertes), kpi('En retard', k.taches_en_retard, k.taches_en_retard > 0), kpi('Terminées (30 j)', k.taches_terminees_30j)),
      d.gaps.length ? h('div', { class: 'notice info stack', role: 'note' }, h('strong', {}, 'Pour une analyse plus complète'), d.gaps.map((g) => h('span', { class: 'small' }, g))) : null,
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card stack' }, h('h2', {}, `Constats (${d.insights.length})`),
          d.insights.length ? d.insights.map((i) => h('div', { class: 'item' },
            h('div', { class: 'row between' }, h('div', { class: 'row' }, badge(i.kind), h('strong', {}, i.title)), h('button', { class: 'link', title: 'Ne plus signaler ce constat', onclick: act(() => api('POST', ws(`/constats/${i.id}/ignorer`)), 'Constat ignoré') }, 'Ignorer')),
            h('p', { class: 'small muted' }, i.detail))) : empty(d.lastAnalysis ? 'Aucun problème, risque ou opportunité détecté dans les données actuelles.' : 'Lancez une analyse pour détecter problèmes, risques et opportunités.')),
        h('div', { class: 'stack' },
          d.pendingActions.length ? h('div', { class: 'card stack' }, h('h2', {}, `En attente de votre autorisation (${d.pendingActions.length})`), d.pendingActions.map(actionCard)) : null,
          h('h2', {}, 'Recommandations prioritaires'),
          d.recommendations.length ? d.recommendations.map((r) => recommendationCard(r, true)) : h('div', { class: 'card' }, empty('Aucune recommandation en attente.')))),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card stack' }, h('h2', {}, 'Dépenses par poste (30 j)'),
          d.expensesByCategory.length ? d.expensesByCategory.map((c) => { const fill = h('i'); fill.style.width = `${Math.round((c.total / maxCat) * 100)}%`; return h('div', {}, h('div', { class: 'row between small' }, h('span', {}, c.category), h('span', {}, money(c.total, cur))), h('div', { class: 'bar' }, fill)); }) : empty('Aucune dépense enregistrée sur la période.')),
        h('div', { class: 'card stack' }, h('h2', {}, 'Résultats réellement obtenus'),
          h('table', {}, h('tbody', {},
            [['Constats résolus', d.results.constats_resolus], ['Recommandations acceptées', d.results.recommandations_acceptees], ['… dont suivies d\'effet (constat disparu ensuite)', d.results.recommandations_suivies_d_effet], ['Actions réussies', d.results.actions_reussies], ['Actions en échec', d.results.actions_echouees]]
              .map(([l, v]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, v))))),
          d.learning.length ? h('p', { class: 'muted small' }, 'Apprentissage : ', d.learning.map((l) => `${l.label} ×${l.weight.toFixed(2)}`).join(' · ')) : h('p', { class: 'muted small' }, 'OMNIA ajuste ses priorités à mesure que vous acceptez ou rejetez ses recommandations.'))));
  },

  async assistant() {
    const log = h('div', { class: 'chat' }, state.chat.length ? state.chat.map((m) => h('div', { class: `bubble ${m.role}` }, m.role === 'user' ? m.text : [md(m.text), sourceNote(m.source, m.fallbackReason), m.sources?.length ? h('p', { class: 'muted small' }, 'Documents consultés : ', m.sources.map((s) => s.title).join(', ')) : null])) : empty('Posez une question sur votre activité : priorités, dépenses, risques, prochaines étapes…'));
    return page('Assistant', state.meta.ai.generative ? `Réponses rédigées par ${state.meta.ai.provider} (${state.meta.ai.model}) à partir de vos données.` : 'Mode local : synthèses construites à partir de vos données, sans IA générative.', null,
      log,
      h('form', { class: 'card inline', onsubmit: act(async (ev) => {
        const question = formData(ev.target).question.trim(); if (!question) return;
        state.chat.push({ role: 'user', text: question });
        const r = await api('POST', ws('/assistant'), { question });
        state.chat.push({ role: 'omnia', text: r.answer, source: r.source, sources: r.sources, fallbackReason: r.fallbackReason });
      }) }, h('label', { class: 'grow' }, 'Votre question', h('input', { name: 'question', required: true, maxLength: 2000, autocomplete: 'off', placeholder: 'Ex. : Quelles sont mes priorités cette semaine ?' })), h('button', { class: 'primary' }, 'Demander')));
  },

  async decisions() {
    const recs = await api('GET', ws('/recommandations'));
    const pending = recs.filter((r) => r.status === 'proposee'); const past = recs.filter((r) => r.status !== 'proposee');
    return page('Décisions', 'Pour chaque constat, OMNIA compare plusieurs solutions. Vous décidez ; il exécute ce que vous autorisez.', null,
      h('div', { class: 'stack' }, pending.length ? pending.map((r) => recommendationCard(r)) : h('div', { class: 'card' }, empty('Aucune recommandation en attente. Lancez une analyse depuis le tableau de bord.'))),
      past.length ? h('div', { class: 'stack' }, h('h2', {}, 'Historique des décisions'), past.map((r) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, r.chosen_option != null ? r.options[r.chosen_option]?.label : r.title), h('p', { class: 'muted small' }, r.rationale)), h('div', { class: 'row' }, r.outcome === 'resolu' && badge('reussie', 'Suivie d\'effet'), badge(r.status), h('span', { class: 'muted small' }, fdate(r.decided_at)))))) : null);
  },

  async actions() {
    const list = await api('GET', ws('/actions')); const pending = list.filter((a) => a.status === 'en_attente');
    const webhooks = state.workspace.modules.includes('connecteurs');
    return page('Actions', 'Tout ce qu\'OMNIA exécute passe par ici. Les actions sensibles attendent toujours votre autorisation.', null,
      h('div', { class: 'card stack' }, h('h2', {}, `En attente de votre autorisation (${pending.length})`), pending.length ? pending.map(actionCard) : empty('Rien à autoriser.')),
      h('div', { class: 'grid cols-2' },
        h('form', { class: 'card stack', onsubmit: act((ev) => api('POST', ws('/actions'), { type: 'export.csv', params: { dataset: formData(ev.target).dataset } }), (a) => toast(a.status === 'reussie' ? `Fichier écrit : ${a.result.file}` : `Échec : ${a.error}`, a.status !== 'reussie')) },
          h('h2', {}, 'Exporter des données'), h('label', {}, 'Jeu de données', h('select', { name: 'dataset' }, h('option', { value: 'transactions' }, 'Opérations financières'), h('option', { value: 'taches' }, 'Tâches'))), h('div', {}, h('button', {}, 'Exporter en CSV'))),
        webhooks ? h('form', { class: 'card stack', onsubmit: act((ev) => { const f = formData(ev.target); return api('POST', ws('/actions'), { type: 'webhook.envoyer', params: { url: f.url, message: f.message, include: f.include } }); }, 'Demande enregistrée — elle attend votre autorisation ci-dessus') },
          h('h2', {}, 'Envoyer vers un service externe'), h('p', { class: 'muted small' }, 'Webhook HTTP (Zapier, n8n, Make, API interne…). Action sensible : rien ne part sans votre autorisation.'),
          h('label', {}, 'URL du webhook', h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://…' })), h('label', {}, 'Message', h('input', { name: 'message', maxLength: 2000 })),
          h('label', {}, 'Données jointes', h('select', { name: 'include' }, h('option', { value: 'aucun' }, 'Aucune'), h('option', { value: 'indicateurs' }, 'Indicateurs clés (30 jours)'))), h('div', {}, h('button', {}, 'Préparer l\'envoi'))) : null),
      h('div', { class: 'card stack' }, h('h2', {}, 'Historique'), list.filter((a) => a.status !== 'en_attente').length ? list.filter((a) => a.status !== 'en_attente').map(actionCard) : empty('Aucune action exécutée pour le moment.')));
  },

  async gestion() {
    const d = await api('GET', ws('/donnees')); const today = new Date().toISOString().slice(0, 10);
    const projectName = (id) => d.projects.find((p) => p.id === id)?.name ?? '';
    const pack = state.meta.modules.find((m) => m.starterTasks && state.workspace.modules.includes(m.id));
    return page('Gestion', 'Projets, tâches, priorités et échéances.', null,
      h('form', { class: 'card inline', onsubmit: act((ev) => api('POST', ws('/taches'), formData(ev.target)), 'Tâche ajoutée') },
        h('label', { class: 'grow' }, 'Nouvelle tâche', h('input', { name: 'title', required: true, maxLength: 300 })),
        h('label', {}, 'Échéance', h('input', { name: 'due_date', type: 'date' })),
        h('label', {}, 'Priorité', h('select', { name: 'priority' }, h('option', { value: 1 }, 'Haute'), h('option', { value: 2, selected: true }, 'Normale'), h('option', { value: 3 }, 'Basse'))),
        h('label', {}, 'Projet', h('select', { name: 'project_id' }, h('option', { value: '' }, '—'), d.projects.map((p) => h('option', { value: p.id }, p.name)))),
        h('button', { class: 'primary' }, 'Ajouter')),
      !d.tasks.length && pack ? h('div', { class: 'notice info row between' }, h('span', {}, `Le ${pack.name} propose ${pack.starterTasks.length} tâches de démarrage.`), h('button', { onclick: act(() => api('POST', ws('/taches-de-demarrage'), { module: pack.id }), 'Tâches de démarrage ajoutées') }, 'Les ajouter')) : null,
      h('div', { class: 'card tablewrap' }, h('h2', {}, `Tâches (${d.tasks.length})`),
        d.tasks.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Tâche', 'Projet', 'Échéance', 'Priorité', 'État', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, d.tasks.map((t) => h('tr', {},
            h('td', { class: t.status === 'fait' ? 'done' : '' }, t.title, t.origin === 'omnia' ? h('span', { class: 'muted small' }, ' · créée par OMNIA') : null),
            h('td', { class: 'small' }, projectName(t.project_id)),
            h('td', { class: `nowrap ${t.status !== 'fait' && t.due_date && t.due_date < today ? 'neg' : ''}` }, fdate(t.due_date)),
            h('td', {}, ['', 'Haute', 'Normale', 'Basse'][t.priority]),
            h('td', {}, h('select', { 'aria-label': 'État', onchange: act((ev) => api('PATCH', ws(`/taches/${t.id}`), { status: ev.target.value })) }, ['a_faire', 'en_cours', 'fait'].map((s) => h('option', { value: s, selected: s === t.status }, L(s))))),
            h('td', { class: 'right' }, h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/taches/${t.id}`)), 'Tâche supprimée') }, 'Supprimer')))))) : empty('Aucune tâche.')),
      h('div', { class: 'card stack' }, h('h2', {}, `Projets (${d.projects.length})`),
        h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws('/projets'), formData(ev.target)), 'Projet créé') },
          h('label', { class: 'grow' }, 'Nouveau projet', h('input', { name: 'name', required: true, maxLength: 200 })), h('label', {}, 'Échéance', h('input', { name: 'deadline', type: 'date' })), h('button', {}, 'Créer')),
        d.projects.map((p) => { const pt = d.tasks.filter((t) => t.project_id === p.id); const pct = pt.length ? Math.round((pt.filter((t) => t.status === 'fait').length / pt.length) * 100) : 0; const fill = h('i'); fill.style.width = `${pct}%`;
          return h('div', { class: 'item stack' }, h('div', { class: 'row between' }, h('strong', {}, p.name), h('div', { class: 'row small muted' }, `${pt.length} tâche(s) · ${pct} % · échéance ${fdate(p.deadline)}`,
            h('select', { 'aria-label': 'Statut du projet', onchange: act((ev) => api('PATCH', ws(`/projets/${p.id}`), { status: ev.target.value })) }, [['actif', 'Actif'], ['en_pause', 'En pause'], ['termine', 'Terminé']].map(([v, l]) => h('option', { value: v, selected: v === p.status }, l))),
            h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/projets/${p.id}`)), 'Projet supprimé') }, 'Supprimer'))), h('div', { class: 'bar' }, fill)); })));
  },

  async finances() {
    const d = await api('GET', ws('/donnees')); const cur = state.workspace.currency;
    const categories = [...new Set([...(state.meta.modules.filter((m) => m.categories && state.workspace.modules.includes(m.id)).flatMap((m) => m.categories)), ...d.transactions.map((t) => t.category)])];
    return page('Finances', 'Dépenses et revenus. Montant positif = revenu, négatif = dépense.', null,
      h('form', { class: 'card inline', onsubmit: act((ev) => { const f = formData(ev.target); return api('POST', ws('/operations'), { ...f, amount: (f.sens === 'depense' ? -1 : 1) * Math.abs(Number(f.amount)) }); }, 'Opération enregistrée') },
        h('label', {}, 'Date', h('input', { name: 'date', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) })),
        h('label', {}, 'Sens', h('select', { name: 'sens' }, h('option', { value: 'depense' }, 'Dépense'), h('option', { value: 'revenu' }, 'Revenu'))),
        h('label', {}, `Montant (${cur})`, h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true })),
        h('label', { class: 'grow' }, 'Libellé', h('input', { name: 'label', maxLength: 300 })),
        h('label', {}, 'Poste', h('input', { name: 'category', list: 'cats', maxLength: 80 }), h('datalist', { id: 'cats' }, categories.map((c) => h('option', { value: c })))),
        h('label', {}, 'Tiers', h('input', { name: 'counterparty', maxLength: 200 })),
        h('button', { class: 'primary' }, 'Ajouter')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Importer un relevé (CSV)'),
        h('p', { class: 'muted small' }, 'Colonnes reconnues : date, montant (ou débit / crédit), libellé, catégorie, tiers. Séparateur « ; », « , » ou tabulation.'),
        h('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Fichier CSV', onchange: act(async (ev) => { const file = ev.target.files[0]; if (!file) return null; return api('POST', ws('/operations/import'), { csv: await file.text() }); }, (r) => r && toast(`${r.imported} opération(s) importée(s)${r.skippedCount ? ` · ${r.skippedCount} ligne(s) ignorée(s) (ligne ${r.skipped[0].line} : ${r.skipped[0].reason})` : ''}`, r.imported === 0)) })),
      h('div', { class: 'card tablewrap' }, h('h2', {}, `Opérations (${d.transactions.length})`),
        d.transactions.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Libellé'), h('th', {}, 'Poste'), h('th', {}, 'Tiers'), h('th', { class: 'num' }, 'Montant'), h('th', {}))),
          h('tbody', {}, d.transactions.slice(0, 300).map((t) => h('tr', {}, h('td', { class: 'nowrap' }, fdate(t.date)), h('td', {}, t.label), h('td', {}, t.category), h('td', {}, t.counterparty),
            h('td', { class: `num ${t.amount < 0 ? 'neg' : 'pos'}` }, money(t.amount, cur)), h('td', { class: 'right' }, h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/operations/${t.id}`))) }, 'Supprimer')))))) : empty('Aucune opération.'),
        d.transactions.length > 300 ? h('p', { class: 'muted small' }, `300 opérations affichées sur ${d.transactions.length}.`) : null));
  },

  async memoire() {
    const d = await api('GET', ws('/donnees')); const open = d.documents.find((x) => x.id === state.openDoc);
    return page('Mémoire', 'La connaissance de votre activité : notes, documents produits, brouillons.', null,
      h('div', { class: 'grid cols-2' },
        h('form', { class: 'card stack', onsubmit: act((ev) => api('POST', ws('/documents/generer'), formData(ev.target)), (doc) => { state.openDoc = doc.id; toast(doc.fallbackReason ? 'IA indisponible : document produit en mode local' : 'Document créé'); }) },
          h('h2', {}, 'Créer un document'), h('label', {}, 'Modèle', h('select', { name: 'template' }, state.meta.templates.map((t) => h('option', { value: t.id }, t.title)))),
          h('label', {}, 'Sujet ou précision', h('input', { name: 'brief', maxLength: 500, placeholder: 'Ex. : lancement de l\'offre de printemps' })), h('div', {}, h('button', { class: 'primary' }, 'Générer'))),
        h('form', { class: 'card stack', onsubmit: act((ev) => api('POST', ws('/documents'), formData(ev.target)), 'Note enregistrée') },
          h('h2', {}, 'Ajouter une note'), h('label', {}, 'Titre', h('input', { name: 'title', required: true, maxLength: 200 })), h('label', {}, 'Contenu', h('textarea', { name: 'content' })), h('div', {}, h('button', {}, 'Enregistrer')))),
      open ? h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, open.title), h('button', { onclick: () => { state.openDoc = null; render(); } }, 'Fermer')), open.origin === 'omnia' && open.kind !== 'brouillon_email' ? md(open.content) : h('pre', { class: 'doc' }, open.content)) : null,
      h('div', { class: 'card stack' }, h('h2', {}, `Documents (${d.documents.length})`),
        d.documents.length ? d.documents.map((doc) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, doc.title), h('p', { class: 'muted small' }, `${doc.kind} · ${doc.origin === 'omnia' ? 'produit par OMNIA' : 'ajouté par vous'} · ${fdate(doc.created_at)}`)),
          h('div', { class: 'row' }, h('button', { onclick: () => { state.openDoc = doc.id; render(); } }, 'Ouvrir'), h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/documents/${doc.id}`)), 'Document supprimé') }, 'Supprimer')))) : empty('Aucun document.')));
  },

  async automatisations() {
    const list = await api('GET', ws('/automatisations'));
    const every = (m) => (m % 1440 === 0 ? `tous les ${m / 1440} jour(s)` : m % 60 === 0 ? `toutes les ${m / 60} heure(s)` : `toutes les ${m} minutes`);
    return page('Automatisations', 'Les tâches répétitives, exécutées à intervalle régulier tant qu\'OMNIA est en marche.', null,
      h('form', { class: 'card inline', onsubmit: act((ev) => { const f = formData(ev.target); const presets = { analyse: ['analyse.lancer', {}], rapport: ['document.generer', { template: 'rapport', brief: 'Point périodique' }], export: ['export.csv', { dataset: 'transactions' }] }; const [action_type, params] = presets[f.preset]; return api('POST', ws('/automatisations'), { name: f.name, every_minutes: Number(f.every), action_type, params }); }, 'Automatisation créée') },
        h('label', { class: 'grow' }, 'Nom', h('input', { name: 'name', required: true, maxLength: 120, placeholder: 'Ex. : analyse quotidienne' })),
        h('label', {}, 'Action', h('select', { name: 'preset' }, h('option', { value: 'analyse' }, 'Lancer une analyse'), h('option', { value: 'rapport' }, 'Générer un rapport d\'activité'), h('option', { value: 'export' }, 'Exporter les opérations (CSV)'))),
        h('label', {}, 'Fréquence', h('select', { name: 'every' }, h('option', { value: 60 }, 'Toutes les heures'), h('option', { value: 1440, selected: true }, 'Tous les jours'), h('option', { value: 10080 }, 'Toutes les semaines'))),
        h('button', { class: 'primary' }, 'Créer')),
      h('div', { class: 'card stack' }, h('h2', {}, `Automatisations (${list.length})`),
        list.length ? list.map((a) => h('div', { class: 'item stack' },
          h('div', { class: 'row between' }, h('strong', {}, a.name), h('div', { class: 'row' }, badge(a.sensitivity), badge(a.enabled ? 'reussie' : 'refusee', a.enabled ? 'Active' : 'En pause'))),
          h('p', { class: 'muted small' }, `${state.meta.actionTypes.find((t) => t.type === a.action_type)?.label ?? a.action_type} · ${every(a.every_minutes)} · dernière exécution : ${fdatetime(a.last_run_at)}${a.last_status ? ` (${L(a.last_status)})` : ''}`),
          h('div', { class: 'row' },
            h('button', { onclick: act(() => api('PATCH', ws(`/automatisations/${a.id}`), { enabled: !a.enabled })) }, a.enabled ? 'Mettre en pause' : 'Réactiver'),
            a.sensitivity === 'sensible' ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: Boolean(a.preauthorized), onchange: act((ev) => { if (ev.target.checked && !window.confirm('Autoriser cette automatisation à exécuter son action sensible sans vous redemander à chaque fois ?')) { ev.target.checked = false; return null; } return api('PATCH', ws(`/automatisations/${a.id}`), { preauthorized: ev.target.checked }); }) }), 'Autorisation permanente') : null,
            h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/automatisations/${a.id}`)), 'Automatisation supprimée') }, 'Supprimer')))) : empty('Aucune automatisation.')));
  },

  async journal() {
    const j = await api('GET', ws('/journal'));
    return page('Journal', 'Trace de chaque décision et de chaque action. Chaque entrée scelle la précédente.', null,
      h('div', { class: `notice ${j.integrity.ok ? 'info' : ''}` }, j.integrity.ok ? `Intégrité vérifiée : ${j.integrity.entries} entrée(s), chaîne intacte.` : `Attention : le journal a été altéré à partir de l'entrée n° ${j.integrity.brokenAt}.`),
      h('div', { class: 'card tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Acteur', 'Événement', 'Détail'].map((t) => h('th', {}, t)))),
        h('tbody', {}, j.entries.map((e) => h('tr', {}, h('td', { class: 'nowrap small' }, fdatetime(e.ts)), h('td', {}, e.actor), h('td', {}, e.event, e.entity_id ? ` #${e.entity_id}` : ''), h('td', { class: 'small' }, h('code', {}, e.detail.length > 240 ? `${e.detail.slice(0, 240)}…` : e.detail))))))));
  },

  async reglages() {
    const w = state.workspace; const ai = state.meta.ai;
    return page('Réglages', 'Profil de l\'activité, modules, autonomie et confidentialité.', null,
      h('div', { class: 'grid cols-2' },
        h('form', { class: 'card stack', onsubmit: act((ev) => { const f = formData(ev.target); return api('PATCH', ws(), { ...f, goals: f.goals.split('\n') }); }, 'Profil enregistré') },
          h('h2', {}, 'Profil de l\'activité'),
          h('label', {}, 'Nom', h('input', { name: 'name', required: true, value: w.name, maxLength: 120 })),
          h('label', {}, 'Description', h('textarea', { name: 'description', value: w.description })),
          h('div', { class: 'row' }, h('label', {}, 'Type', h('select', { name: 'kind' }, state.meta.kinds.map((k) => h('option', { value: k, selected: k === w.kind }, k)))),
            h('label', {}, 'Secteur', h('select', { name: 'sector' }, state.meta.sectors.map((s) => h('option', { value: s, selected: s === w.sector }, s)))),
            h('label', {}, 'Devise', h('input', { name: 'currency', value: w.currency, maxLength: 3, size: 4, pattern: '[A-Za-z]{3}' }))),
          h('label', {}, 'Objectifs (un par ligne)', h('textarea', { name: 'goals', value: w.goals.join('\n') })),
          h('p', { class: 'muted small' }, w.profile_source === 'local' ? 'Profil initial déduit par mots-clés (mode local) : corrigez-le si besoin.' : `Profil initial déduit par ${w.profile_source} : corrigez-le si besoin.`),
          h('div', {}, h('button', { class: 'primary' }, 'Enregistrer'))),
        h('div', { class: 'stack' },
          h('div', { class: 'card stack' }, h('h2', {}, 'Autonomie'),
            h('label', {}, 'Niveau', h('select', { onchange: act((ev) => api('PATCH', ws(), { autonomy: ev.target.value }), 'Autonomie mise à jour') },
              h('option', { value: 'assiste', selected: w.autonomy === 'assiste' }, 'Assisté — les automatisations exécutent les actions internes'), h('option', { value: 'manuel', selected: w.autonomy === 'manuel' }, 'Manuel — toute action automatisée attend votre accord'))),
            h('p', { class: 'muted small' }, 'Dans tous les cas, une action sensible (envoi vers l\'extérieur) n\'est jamais exécutée sans autorisation explicite.')),
          h('div', { class: 'card stack' }, h('h2', {}, 'Intelligence artificielle'),
            h('p', {}, ai.generative ? `Fournisseur : ${ai.provider} · modèle : ${ai.model}` : 'Mode local : analyses et documents sans IA générative, gratuitement et hors ligne.'),
            h('p', { class: 'muted small' }, 'Se configure au démarrage par variables d\'environnement (OMNIA_AI_PROVIDER, OMNIA_AI_MODEL, OMNIA_AI_API_KEY). Les clés ne sont jamais enregistrées dans la base.', ai.generative && ai.provider !== 'ollama' ? ' Avec ce fournisseur, le contexte de vos questions et documents lui est transmis.' : '')))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Modules'),
        state.meta.modules.map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: w.modules.includes(m.id), disabled: Boolean(m.core), onchange: act((ev) => api('PATCH', ws(), { modules: ev.target.checked ? [...w.modules, m.id] : w.modules.filter((x) => x !== m.id) })) }),
          h('span', {}, h('strong', {}, m.name), ' ', badge(m.tier, m.core ? 'socle' : m.tier), h('span', { class: 'muted small' }, ` ${m.description}`)))),
        h('p', { class: 'muted small' }, 'La mention « pro » indique le positionnement commercial prévu. Dans cette version, tous les modules sont utilisables sans licence.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Connecteurs'), state.meta.connectors.map((c) => h('div', { class: 'row between' }, h('span', {}, h('strong', {}, c.name), h('span', { class: 'muted small' }, ` — ${c.description}`)), badge(c.sensitivity)))),
      h('div', { class: 'card row between' }, h('div', {}, h('h2', {}, 'Supprimer cet espace'), h('p', { class: 'muted small' }, 'Supprime définitivement ses tâches, opérations, documents et décisions. Le journal d\'audit est conservé.')),
        h('button', { class: 'danger', onclick: act(async () => { if (!window.confirm(`Supprimer définitivement l'espace « ${w.name} » et toutes ses données ?`)) return; await api('DELETE', ws()); state.wsId = null; localStorage.removeItem('omnia.ws'); }) }, 'Supprimer l\'espace')));
  },
};

function onboarding(first) {
  return h('div', { class: 'hero' },
    h('h1', {}, 'OMNIA ', h('span', {}, 'Ω')), h('p', { class: 'muted' }, 'Comprendre. Décider. Agir. Progresser.'),
    h('form', { class: 'card stack', onsubmit: act(async (ev) => { const w = await api('POST', '/espaces', formData(ev.target)); state.wsId = w.id; localStorage.setItem('omnia.ws', w.id); state.view = 'tableau'; state.chat = []; if (w.fallbackReason) toast(`IA indisponible (${w.fallbackReason}) : profil déduit en mode local`, true); }) },
      h('h2', {}, first ? 'Décrivez votre activité' : 'Nouvel espace'),
      h('p', { class: 'muted small' }, 'Entreprise, commerce, association, collectivité, activité indépendante ou projet personnel : OMNIA s\'adapte à partir de votre description.'),
      h('label', {}, 'Nom de l\'activité', h('input', { name: 'name', required: true, maxLength: 120, placeholder: 'Ex. : Atelier Martin' })),
      h('label', {}, 'Que faites-vous, et que cherchez-vous à améliorer ?', h('textarea', { name: 'description', maxLength: 5000, placeholder: 'Ex. : Je tiens une menuiserie de 3 personnes. Je veux réduire mes retards de chantier et mieux suivre mes dépenses.' })),
      h('label', {}, 'Devise', h('input', { name: 'currency', value: 'EUR', maxLength: 3, size: 4, pattern: '[A-Za-z]{3}' })),
      h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Créer mon espace'), !first && h('button', { type: 'button', onclick: () => { state.view = 'tableau'; render(); } }, 'Annuler'))));
}

function go(view) { state.view = view; state.openDoc = null; render(); }

async function render() {
  try {
    state.meta ??= await api('GET', '/meta');
    state.workspaces = await api('GET', '/espaces');
    if (!state.workspaces.some((w) => w.id === state.wsId)) state.wsId = state.workspaces[0]?.id ?? null;
    if (!state.wsId || state.view === 'nouveau') return $app.replaceChildren(onboarding(!state.workspaces.length));
    state.workspace = state.workspaces.find((w) => w.id === state.wsId);
    const allowed = VIEWS.filter(([, , mod]) => !mod || state.workspace.modules.includes(mod));
    if (!allowed.some(([id]) => id === state.view)) state.view = 'tableau';
    const [content, actions] = await Promise.all([views[state.view](), api('GET', ws('/actions'))]);
    const pending = actions.filter((a) => a.status === 'en_attente').length;
    const side = h('nav', { class: 'side', 'aria-label': 'Navigation principale' },
      h('div', { class: 'brand' }, 'OMNIA ', h('span', {}, 'Ω')), h('div', { class: 'tagline muted small' }, 'Comprendre. Décider. Agir. Progresser.'),
      h('select', { 'aria-label': 'Espace', onchange: (ev) => { if (ev.target.value === 'nouveau') state.view = 'nouveau'; else { state.wsId = Number(ev.target.value); localStorage.setItem('omnia.ws', state.wsId); state.chat = []; state.openDoc = null; } render(); } },
        state.workspaces.map((w) => h('option', { value: w.id, selected: w.id === state.wsId }, w.name)), h('option', { value: 'nouveau' }, '+ Nouvel espace…')),
      allowed.map(([id, label]) => h('button', { class: `nav ${id === state.view ? 'active' : ''}`, 'aria-current': id === state.view ? 'page' : null, onclick: () => go(id) }, label, id === 'actions' && pending ? h('span', { class: 'count', title: 'Actions en attente d\'autorisation' }, pending) : null)),
      h('div', { class: 'foot muted small' }, state.meta.ai.generative ? `IA : ${state.meta.ai.provider}` : 'Mode local, sans IA générative'));
    const scroll = window.scrollY;
    $app.replaceChildren(h('div', { class: 'layout' }, side, h('main', {}, content)));
    window.scrollTo(0, scroll);
  } catch (e) {
    $app.replaceChildren(h('div', { class: 'hero' }, h('h1', {}, 'OMNIA ', h('span', {}, 'Ω')), h('div', { class: 'card stack' }, h('p', {}, `Impossible de charger l'interface : ${e.message}`), h('div', {}, h('button', { onclick: render }, 'Réessayer')))));
  }
}

render();
