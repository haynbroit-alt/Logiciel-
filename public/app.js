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
const state = { meta: null, workspaces: [], wsId: Number(localStorage.getItem('omnia.ws')) || null, view: 'tableau', chat: [], openDoc: null, metric: 'solde_30j', studioProject: null, film: null };

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
    const info = await res.json().catch(() => ({}));
    if (info.comptes || path === '/session') { if (path !== '/session') state.user = null; throw new Error(info.error || 'Connexion requise'); }
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
  try { const out = await fn(ev); if (typeof done === 'string') toast(done); else if (done) done(out); await render(); } catch (e) { toast(e.message, true); if (state.accounts && !state.user && !document.getElementById('connexion')) await render(); } finally { if (btn) btn.disabled = false; }
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

// Courbe d'évolution d'un indicateur : une seule série, valeurs extrêmes et dernière valeur lisibles.
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.filter((c) => c != null).map((c) => (c.nodeType ? c : document.createTextNode(String(c)))));
  return el;
};
const METRICS = [
  ['solde_30j', 'Solde sur 30 jours', true], ['revenus_30j', 'Revenus sur 30 jours', true], ['depenses_30j', 'Dépenses sur 30 jours', true],
  ['taches_en_retard', 'Tâches en retard'], ['taches_terminees_30j', 'Tâches terminées sur 30 jours'], ['constats_ouverts', 'Constats ouverts'],
];
function progressChart(history, cur) {
  const [key, label, isMoney] = METRICS.find((m) => m[0] === state.metric) ?? METRICS[0];
  const pts = history.filter((r) => r.key === key);
  const fmtv = (v) => (isMoney ? money(v, cur) : new Intl.NumberFormat('fr-FR').format(v));
  const picker = h('select', { 'aria-label': 'Indicateur', onchange: (ev) => { state.metric = ev.target.value; render(); } }, METRICS.map(([k, l]) => h('option', { value: k, selected: k === key }, l)));
  const head = h('div', { class: 'row between' }, h('h2', {}, 'Évolution'), picker);
  if (pts.length < 2) return h('div', { class: 'card stack' }, head, empty(pts.length ? `Un seul relevé pour l'instant (${fmtv(pts[0].value)} le ${fdate(pts[0].day)}). La courbe apparaît dès la deuxième journée d'analyse.` : 'Aucun relevé : chaque analyse enregistre les indicateurs du jour.'));
  const W = 640; const H = 180; const P = { l: 8, r: 8, t: 14, b: 22 };
  const t0 = Date.parse(pts[0].day); const t1 = Date.parse(pts.at(-1).day);
  const vals = pts.map((p) => p.value); let lo = Math.min(...vals, 0); let hi = Math.max(...vals, 0); if (hi === lo) hi = lo + 1;
  const x = (d) => P.l + ((Date.parse(d) - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const last = pts.at(-1); const first = pts[0]; const delta = last.value - first.value;
  return h('div', { class: 'card stack' }, head,
    h('p', { class: 'small' }, h('strong', {}, fmtv(last.value)), h('span', { class: 'muted' }, ` au ${fdate(last.day)} · ${delta === 0 ? 'stable' : `${delta > 0 ? '+' : '−'}${fmtv(Math.abs(delta))}`} depuis le ${fdate(first.day)} · ${pts.length} relevés`)),
    svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${label} : de ${fmtv(first.value)} le ${fdate(first.day)} à ${fmtv(last.value)} le ${fdate(last.day)}, minimum ${fmtv(Math.min(...vals))}, maximum ${fmtv(Math.max(...vals))}` },
      svg('line', { x1: P.l, x2: W - P.r, y1: y(0), y2: y(0), class: 'axis' }),
      svg('path', { d: path, class: 'line' }),
      ...pts.map((p) => svg('circle', { cx: x(p.day), cy: y(p.value), r: pts.length > 40 ? 0 : 3, class: 'dot' }, svg('title', {}, `${fdate(p.day)} : ${fmtv(p.value)}`))),
      svg('text', { x: P.l, y: H - 5, class: 'tick' }, fdate(first.day)), svg('text', { x: W - P.r, y: H - 5, class: 'tick', 'text-anchor': 'end' }, fdate(last.day))),
    h('p', { class: 'muted small' }, `Minimum ${fmtv(Math.min(...vals))} · maximum ${fmtv(Math.max(...vals))}. Un relevé par jour d'analyse.`));
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const importBackup = act(async (ev) => {
  const file = ev.target.files[0]; if (!file) return null;
  let payload; try { payload = JSON.parse(await file.text()); } catch { throw new Error('Fichier illisible : ce n\'est pas du JSON'); }
  const w = await api('POST', '/espaces/import', payload);
  state.wsId = w.id; localStorage.setItem('omnia.ws', w.id); state.view = 'tableau'; state.chat = [];
  return w;
}, (w) => w && toast(`Espace restauré : ${w.imported.taches} tâche(s), ${w.imported.operations} opération(s), ${w.imported.documents} document(s)`));

// ---------- Vues ----------
const VIEWS = [
  ['tableau', 'Tableau de bord'], ['assistant', 'Assistant'], ['decisions', 'Décisions'], ['actions', 'Actions'],
  ['studio', 'Studio', 'studio'], ['cinema', 'Cinéma', 'cinema'], ['gestion', 'Gestion', 'gestion'], ['finances', 'Finances', 'finances'], ['memoire', 'Mémoire', 'memoire'],
  ['automatisations', 'Automatisations', 'automatisations'], ['connexions', 'Connexions', 'connecteurs'], ['journal', 'Journal'], ['noyau', 'Noyau'], ['reglages', 'Réglages'],
];
const page = (title, subtitle, actions, ...content) => [
  h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)), h('div', { class: 'row' }, actions)),
  ...content,
];
const empty = (text) => h('p', { class: 'muted' }, text);

// Actions comprises dans une demande : rien ne s'exécute sans un clic de validation.
function proposalList(m) {
  if (!m.proposals?.length) return null;
  const run = (p) => act(async () => {
    const a = await api('POST', ws('/actions'), { type: p.type, params: p.params });
    p.state = a.status; p.error = a.error;
    if (a.status === 'echouee') throw new Error(a.error);
  });
  const open = m.proposals.filter((p) => p.state === 'proposee');
  return h('div', { class: 'stack' },
    m.proposals.map((p) => h('div', { class: `item row between ${p.state === 'proposee' ? 'best' : ''}` }, h('span', {}, p.summary),
      p.state === 'proposee' ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: run(p) }, 'Valider'), h('button', { class: 'link', onclick: () => { p.state = 'ecartee'; render(); } }, 'Écarter'))
        : badge(p.state === 'ecartee' ? 'refusee' : p.state, p.state === 'ecartee' ? 'Écartée' : p.state === 'reussie' ? 'Fait' : L(p.state)))),
    open.length > 1 ? h('div', {}, h('button', { onclick: act(async () => { for (const p of open) { const a = await api('POST', ws('/actions'), { type: p.type, params: p.params }); p.state = a.status; p.error = a.error; } }, 'Actions validées') }, `Tout valider (${open.length})`)) : null);
}

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
    const coord = d.workspace.central ? await api('GET', '/coordination') : null;
    const openWs = (id) => () => { state.wsId = id; localStorage.setItem('omnia.ws', id); state.chat = []; state.openDoc = null; render(); };
    const kpi = (label, value, neg) => h('div', { class: 'card kpi' }, h('div', { class: 'muted small' }, label), h('div', { class: `v ${neg ? 'neg' : ''}` }, value));
    const maxCat = Math.max(1, ...d.expensesByCategory.map((c) => c.total));
    return page(d.workspace.name, `${d.workspace.kind} · secteur ${d.workspace.sector}${d.lastAnalysis ? ` · dernière analyse le ${fdatetime(d.lastAnalysis)}` : ' · aucune analyse lancée'}`,
      h('button', { class: 'primary', onclick: act(() => api('POST', ws('/analyse')), (r) => toast(`${r.insights.length} constat(s) ouvert(s) · ${r.created} nouveau(x) · ${r.resolved} résolu(s)`)) }, 'Analyser maintenant'),
      h('div', { class: 'grid kpis' },
        kpi('Revenus (30 j)', money(k.revenus_30j, cur)), kpi('Dépenses (30 j)', money(k.depenses_30j, cur)), kpi('Solde (30 j)', money(k.solde_30j, cur), k.solde_30j < 0),
        kpi('Tâches ouvertes', k.taches_ouvertes), kpi('En retard', k.taches_en_retard, k.taches_en_retard > 0), kpi('Terminées (30 j)', k.taches_terminees_30j)),
      coord ? h('div', { class: 'card stack' }, h('h2', {}, `Projets (${coord.totaux.espaces})`),
        h('p', { class: 'muted small' }, `Lu en direct dans chaque espace auquel vous avez droit ; rien n'est copié ici. ${coord.totaux.taches_ouvertes} tâche(s) ouverte(s), ${coord.totaux.taches_en_retard} en retard, ${coord.totaux.autorisations_en_attente} autorisation(s) en attente.`),
        coord.espaces.map((e) => h('div', { class: 'item' },
          h('div', { class: 'row between' }, h('button', { class: 'link', onclick: openWs(e.id) }, e.name),
            h('span', { class: 'small muted' }, `${e.taches_ouvertes} tâche(s)${e.taches_en_retard ? ` · ${e.taches_en_retard} en retard` : ''}${e.autorisations_en_attente ? ` · ${e.autorisations_en_attente} autorisation(s)` : ''} · ${money(e.revenus_30j, e.currency)} encaissés (30 j)`)),
          e.prochaine_tache ? h('p', { class: 'small muted' }, e.prochaine_tache.title) : null))) : null,
      d.priorities.length ? h('div', { class: 'card stack' }, h('h2', {}, 'Priorités du moment'),
        h('ol', { class: 'prio' }, d.priorities.map((x) => h('li', {}, h('strong', {}, x.title), ' ', badge(x.kind === 'autorisation' ? 'en_attente' : x.kind === 'recommandation' ? 'opportunite' : 'probleme', x.kind), h('div', { class: 'muted small' }, x.why))))) : null,
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
      progressChart(d.history, cur),
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
    const log = h('div', { class: 'chat' }, state.chat.length ? state.chat.map((m) => h('div', { class: `bubble ${m.role}` }, m.role === 'user' ? m.text : [md(m.text), sourceNote(m.source, m.fallbackReason), m.sources?.length ? h('p', { class: 'muted small' }, 'Documents consultés : ', m.sources.map((s) => s.title).join(', ')) : null, proposalList(m)])) : empty('Dites ce dont vous avez besoin, comme vous le diriez à un collègue : une chose à ne pas oublier, une dépense à noter, un document à préparer, une question sur vos chiffres ou vos priorités. OMNIA propose les actions ; vous validez.'));
    return page('Assistant', state.meta.ai.generative ? `Réponses rédigées par ${state.meta.ai.provider} (${state.meta.ai.model}) à partir de vos données.` : 'Mode local : demandes comprises par tournures reconnues, réponses construites à partir de vos données, sans IA générative.', null,
      log,
      h('form', { class: 'card inline', onsubmit: act(async (ev) => {
        const question = formData(ev.target).question.trim(); if (!question) return;
        state.chat.push({ role: 'user', text: question });
        const r = await api('POST', ws('/assistant'), { question });
        state.chat.push({ role: 'omnia', text: r.answer, source: r.source, sources: r.sources, fallbackReason: r.fallbackReason, proposals: (r.proposals ?? []).map((x) => ({ ...x, state: 'proposee' })) });
      }) }, h('label', { class: 'grow' }, 'Votre demande', h('input', { name: 'question', required: true, maxLength: 2000, autocomplete: 'off', placeholder: 'Ex. : Rappelle-moi de relancer Dupont vendredi · J\'ai payé 45 € chez Leroy hier · Quelles sont mes priorités ?' })), h('button', { class: 'primary' }, 'Demander')));
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
    const central = state.workspace.central; const shared = central ? await api('GET', ws('/partages')) : null;
    return page('Mémoire', 'La connaissance de votre activité : notes, documents produits, brouillons.', null,
      h('div', { class: 'grid cols-2' },
        h('form', { class: 'card stack', onsubmit: act((ev) => api('POST', ws('/documents/generer'), formData(ev.target)), (doc) => { state.openDoc = doc.id; toast(doc.fallbackReason ? 'IA indisponible : document produit en mode local' : 'Document créé'); }) },
          h('h2', {}, 'Créer un document'), h('label', {}, 'Modèle', h('select', { name: 'template' }, state.meta.templates.map((t) => h('option', { value: t.id }, t.title)))),
          h('label', {}, 'Sujet ou précision', h('input', { name: 'brief', maxLength: 500, placeholder: 'Ex. : lancement de l\'offre de printemps' })), h('div', {}, h('button', { class: 'primary' }, 'Générer'))),
        h('form', { class: 'card stack', onsubmit: act((ev) => api('POST', ws('/documents'), formData(ev.target)), 'Note enregistrée') },
          h('h2', {}, 'Ajouter une note'), h('label', {}, 'Titre', h('input', { name: 'title', required: true, maxLength: 200 })), h('label', {}, 'Contenu', h('textarea', { name: 'content' })), h('div', {}, h('button', {}, 'Enregistrer')),
          h('label', {}, 'Ou importer des fichiers texte (.txt, .md, .csv)', h('input', { type: 'file', multiple: true, accept: '.txt,.md,.csv,text/plain,text/markdown,text/csv', onchange: act(async (ev) => { const files = [...ev.target.files]; for (const f of files) { if (f.size > 200000) throw new Error(`« ${f.name} » dépasse 200 Ko`); await api('POST', ws('/documents'), { title: f.name, kind: 'fichier', content: await f.text() }); } return files.length; }, (n) => n && toast(`${n} fichier(s) ajouté(s) à la mémoire`)) })))),
      open ? h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, open.title), h('button', { onclick: () => { state.openDoc = null; render(); } }, 'Fermer')), open.origin === 'omnia' && open.kind !== 'brouillon_email' ? md(open.content) : h('pre', { class: 'doc' }, open.content)) : null,
      h('div', { class: 'card stack' }, h('h2', {}, `Documents (${d.documents.length})`),
        d.documents.length ? d.documents.map((doc) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, doc.title), h('p', { class: 'muted small' }, `${doc.kind} · ${doc.origin === 'omnia' ? 'produit par OMNIA' : 'ajouté par vous'} · ${fdate(doc.created_at)}${doc.shared ? ' · partagé avec l\'espace central' : ''}`)),
          h('div', { class: 'row' }, h('button', { onclick: () => { state.openDoc = doc.id; render(); } }, 'Ouvrir'), central ? null : h('button', { onclick: act(() => api('PUT', ws(`/documents/${doc.id}/partage`), { partage: !doc.shared }), doc.shared ? 'Partage retiré : le document redevient privé' : 'Document partagé avec l\'espace central') }, doc.shared ? 'Retirer le partage' : 'Partager'), h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/documents/${doc.id}`)), 'Document supprimé') }, 'Supprimer')))) : empty('Aucun document.')),
      shared ? h('div', { class: 'card stack' }, h('h2', {}, `Mémoire partagée (${shared.length})`),
        h('p', { class: 'muted small' }, 'Documents que les projets ont choisi de partager. Ils restent dans leur espace ; tout le reste demeure privé à chaque projet.'),
        shared.length ? shared.map((doc) => h('details', { class: 'item' }, h('summary', {}, h('strong', {}, doc.title), ` — ${doc.espace}`), h('pre', { class: 'doc' }, doc.content))) : empty('Aucun document partagé.')) : null);
  },

  async automatisations() {
    const [list, channels] = await Promise.all([api('GET', ws('/automatisations')), state.workspace.modules.includes('connecteurs') ? api('GET', ws('/canaux')) : []]);
    const every = (m) => (m % 1440 === 0 ? `tous les ${m / 1440} jour(s)` : m % 60 === 0 ? `toutes les ${m / 60} heure(s)` : `toutes les ${m} minutes`);
    return page('Automatisations', 'Les tâches répétitives, exécutées à intervalle régulier tant qu\'OMNIA est en marche.', null,
      h('form', { class: 'card inline', onsubmit: act((ev) => { const f = formData(ev.target); const presets = { ...Object.fromEntries(channels.map((c) => [`canal-${c.id}`, ['message.envoyer', { channelId: c.id, text: 'Point automatique', include: 'indicateurs' }]])), analyse: ['analyse.lancer', {}], rapport: ['document.generer', { template: 'rapport', brief: 'Point périodique' }], export: ['export.csv', { dataset: 'transactions' }] }; const [action_type, params] = presets[f.preset]; return api('POST', ws('/automatisations'), { name: f.name, ...(f.every.startsWith('evt:') ? { trigger_event: f.every.slice(4) } : { every_minutes: Number(f.every) }), action_type, params }); }, 'Automatisation créée') },
        h('label', { class: 'grow' }, 'Nom', h('input', { name: 'name', required: true, maxLength: 120, placeholder: 'Ex. : analyse quotidienne' })),
        h('label', {}, 'Action', h('select', { name: 'preset' }, h('option', { value: 'analyse' }, 'Lancer une analyse'), h('option', { value: 'rapport' }, 'Générer un rapport d\'activité'), h('option', { value: 'export' }, 'Exporter les opérations (CSV)'), channels.map((c) => h('option', { value: `canal-${c.id}` }, `Envoyer les indicateurs sur ${c.name} (sensible)`)))),
        h('label', {}, 'Déclencheur', h('select', { name: 'every' }, h('optgroup', { label: 'À intervalle régulier' }, h('option', { value: 60 }, 'Toutes les heures'), h('option', { value: 1440, selected: true }, 'Tous les jours'), h('option', { value: 10080 }, 'Toutes les semaines')), h('optgroup', { label: 'Quand…' }, Object.entries(state.meta.events).map(([k, v]) => h('option', { value: `evt:${k}` }, v))))),
        h('button', { class: 'primary' }, 'Créer')),
      h('div', { class: 'card stack' }, h('h2', {}, `Automatisations (${list.length})`),
        list.length ? list.map((a) => h('div', { class: 'item stack' },
          h('div', { class: 'row between' }, h('strong', {}, a.name), h('div', { class: 'row' }, badge(a.sensitivity), badge(a.enabled ? 'reussie' : 'refusee', a.enabled ? 'Active' : 'En pause'))),
          h('p', { class: 'muted small' }, `${state.meta.actionTypes.find((t) => t.type === a.action_type)?.label ?? a.action_type} · ${a.trigger_event ? `quand : ${(state.meta.events[a.trigger_event] ?? a.trigger_event).toLowerCase()}` : every(a.every_minutes)} · dernière exécution : ${fdatetime(a.last_run_at)}${a.last_status ? ` (${L(a.last_status)})` : ''}`),
          h('div', { class: 'row' },
            h('button', { onclick: act(() => api('PATCH', ws(`/automatisations/${a.id}`), { enabled: !a.enabled })) }, a.enabled ? 'Mettre en pause' : 'Réactiver'),
            a.sensitivity === 'sensible' ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: Boolean(a.preauthorized), onchange: act((ev) => { if (ev.target.checked && !window.confirm('Autoriser cette automatisation à exécuter son action sensible sans vous redemander à chaque fois ?')) { ev.target.checked = false; return null; } return api('PATCH', ws(`/automatisations/${a.id}`), { preauthorized: ev.target.checked }); }) }), 'Autorisation permanente') : null,
            h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/automatisations/${a.id}`)), 'Automatisation supprimée') }, 'Supprimer')))) : empty('Aucune automatisation.')));
  },

  async connexions() {
    const owner = !state.accounts || state.workspace.role === 'proprietaire';
    const [channels, tokens] = await Promise.all([api('GET', ws('/canaux')), owner ? api('GET', ws('/acces')) : []]);
    const origin = window.location.origin; const fresh = state.freshToken?.ws === state.wsId ? state.freshToken : null;
    const access = (usage, title, intro, show) => {
      const active = tokens.find((t) => t.purpose === usage); const mine = fresh?.purpose === usage ? fresh.token : null;
      return h('div', { class: 'card stack' }, h('h2', {}, title), h('p', { class: 'muted small' }, intro),
        mine ? h('div', { class: 'notice info stack' }, h('strong', {}, 'À copier maintenant : cette adresse ne sera plus affichée.'), show(mine)) : active ? h('p', { class: 'small' }, `Accès actif depuis le ${fdate(active.created_at)}. L'adresse n'est pas conservée en clair : régénérez-la si vous l'avez perdue.`) : empty('Aucun accès actif.'),
        owner ? h('div', { class: 'row' },
          h('button', { onclick: act(async () => { if (active && !window.confirm('Générer une nouvelle adresse désactive l\'ancienne. Continuer ?')) return; const t = await api('POST', ws('/acces'), { usage }); state.freshToken = { ...t, ws: state.wsId }; }) }, active ? 'Régénérer' : 'Activer'),
          active ? h('button', { class: 'link danger', onclick: act(async () => { await api('POST', ws('/acces/revoquer'), { usage }); state.freshToken = null; }, 'Accès révoqué') }, 'Révoquer') : null) : h('p', { class: 'muted small' }, 'Seul un propriétaire peut gérer cet accès.'));
    };
    return page('Connexions', 'Relier OMNIA à vos autres outils. Rien ne sort sans autorisation ; ce qui entre est tracé.', null,
      h('div', { class: 'card stack' }, h('h2', {}, `Canaux de messagerie (${channels.length})`),
        h('p', { class: 'muted small' }, 'Slack, Discord, Teams ou tout outil acceptant un webhook entrant. Chaque envoi est une action sensible soumise à autorisation.'),
        channels.map((c) => h('div', { class: 'item stack' },
          h('div', { class: 'row between' }, h('span', {}, h('strong', {}, c.name), h('span', { class: 'muted small' }, ` ${c.typeLabel} · ${c.destination}`)), owner ? h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/canaux/${c.id}`)), 'Canal supprimé') }, 'Supprimer') : null),
          h('form', { class: 'inline', onsubmit: act((ev) => { const f = formData(ev.target); return api('POST', ws('/actions'), { type: 'message.envoyer', params: { channelId: c.id, text: f.text, include: f.include } }); }, 'Message préparé — il attend une autorisation dans « Actions »') },
            h('label', { class: 'grow' }, 'Message', h('input', { name: 'text', required: true, maxLength: 3000 })),
            h('label', {}, 'Joindre', h('select', { name: 'include' }, h('option', { value: 'aucun' }, 'Rien'), h('option', { value: 'indicateurs' }, 'Indicateurs clés'))), h('button', {}, 'Préparer l\'envoi')))),
        owner ? h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws('/canaux'), formData(ev.target)), 'Canal ajouté') },
          h('label', {}, 'Nom', h('input', { name: 'name', required: true, maxLength: 80, placeholder: 'Ex. : #direction' })),
          h('label', {}, 'Type', h('select', { name: 'type' }, state.meta.channelTypes.map((t) => h('option', { value: t.id }, t.label)))),
          h('label', { class: 'grow' }, 'URL du webhook entrant (https)', h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://hooks.…' })), h('button', {}, 'Ajouter le canal')) : null),
      h('div', { class: 'grid cols-2' },
        access('entrant', 'Entrée de données', 'Une adresse à donner à Zapier, n8n, Make ou à vos propres scripts pour créer tâches, opérations et notes dans cet espace (60 requêtes par minute au maximum).',
          (t) => [h('code', {}, `${origin}/api/entrant/${t}`), h('p', { class: 'small' }, 'Exemple de corps JSON (POST) :'), h('code', {}, '{"type":"tache","titre":"Rappeler le client","echeance":"2027-01-15"}'), h('code', {}, '{"type":"operation","montant":-49.9,"libelle":"Abonnement","categorie":"abonnements"}'), h('code', {}, '{"type":"note","titre":"Compte rendu","contenu":"…"}')]),
        access('calendrier', 'Calendrier', 'Une adresse d\'abonnement (iCalendar) pour voir les échéances des tâches et projets dans Google Agenda, Outlook ou Apple Calendrier. Lecture seule.',
          (t) => [h('code', {}, `${origin}/api/calendrier/${t}.ics`)])),
      access('api', 'Clé d\'API', 'Pour qu\'un autre logiciel pilote cet espace à travers le noyau : lire les données, créer, analyser, demander des actions. La clé agit comme un membre : elle ne peut ni autoriser une action sensible, ni modifier les réglages, ni voir un autre espace.',
        (t) => [h('code', {}, t), h('p', { class: 'small' }, 'Exemple :'), h('code', {}, `curl -H "Authorization: Bearer ${t}" ${origin}/api/espaces/${state.wsId}/tableau-de-bord`)]),
      h('div', { class: 'card stack' }, h('h2', {}, 'Stripe'),
        state.meta.stripe ? [h('p', { class: 'muted small' }, 'Importe les mouvements de solde (montants nets, frais déduits) comme opérations financières. Lecture seule ; les mouvements déjà importés ne sont pas dupliqués.'),
          h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws('/actions'), { type: 'stripe.importer', params: { days: Number(formData(ev.target).days) } }), (a) => toast(a.status === 'reussie' ? `${a.result.importees} mouvement(s) importé(s), ${a.result.deja_presentes} déjà présent(s)${a.result.autre_devise ? `, ${a.result.autre_devise} ignoré(s) (autre devise)` : ''}` : `Échec : ${a.error}`, a.status !== 'reussie')) },
            h('label', {}, 'Période', h('select', { name: 'days' }, h('option', { value: 30 }, '30 derniers jours'), h('option', { value: 90 }, '90 derniers jours'), h('option', { value: 365 }, '12 derniers mois'))), h('button', {}, 'Importer depuis Stripe'))]
          : h('p', { class: 'muted small' }, 'Non configuré. Pour l\'activer, démarrez OMNIA avec OMNIA_STRIPE_KEY (clé restreinte, lecture des « balance transactions » uniquement).')));
  },

  async studio() {
    const o = await api('GET', ws('/studio')); const R = o.reference; const cur = state.workspace.currency; const k = o.indicateurs; const f = o.autofinancement;
    const pct = (v) => (v === null ? 'INCONNU' : `${Math.round(v * 100)} %`); const eur = (v) => (v === null ? 'INCONNU' : money(v, cur));
    const kpi = (label, value, cls = '') => h('div', { class: 'card kpi' }, h('div', { class: 'muted small' }, label), h('div', { class: `v ${cls}` }, value));
    const proof = (p) => (p.commercialProofs ? badge('reussie', `${p.commercialProofs} preuve(s) commerciale(s)`) : badge('echouee', 'aucune preuve commerciale'));
    const statusBadge = (st) => badge({ PROUVE: 'reussie', INCONNU: 'en_attente', CONFLIT: 'risque', ECHEC: 'echouee' }[st], R.statuses[st]);
    const sel = o.projects.find((x) => x.id === state.studioProject) ?? null;
    const patchProject = (body, msg) => act(() => api('PATCH', ws(`/studio/projets/${sel.id}`), typeof body === 'function' ? body() : body), msg);

    const detail = (p) => {
      const v = p.validation; const m = p.metrics; const last = p.stage === R.stages.length - 1;
      return h('div', { class: 'stack' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row between' }, h('h2', {}, p.name), h('div', { class: 'row' }, badge('gratuit', p.domainLabel), proof(p), h('button', { class: 'link', onclick: () => { state.studioProject = null; render(); } }, 'Fermer'))),
          h('ol', { class: 'steps' }, R.stages.map((st, i) => h('li', { class: i < p.stage ? 'past' : i === p.stage ? 'now' : '', title: R.stageHelp[i] }, st))),
          h('p', {}, h('strong', {}, `${p.stageName} — `), p.stageHelp),
          p.status !== 'actif' ? h('div', { class: 'notice' }, `Projet ${p.status === 'abandonne' ? 'abandonné' : 'terminé'}.`)
            : last ? h('div', { class: 'notice info' }, 'Dernière étape : améliorer, développer ou abandonner au vu des chiffres réels.')
              : p.blockers.length ? h('div', { class: 'notice stack' }, h('strong', {}, `Avant de passer à ${R.stages[p.stage + 1]} :`), p.blockers.map((b) => h('span', { class: 'small' }, `• ${b}`)))
                : h('div', { class: 'notice info' }, `Toutes les conditions sont réunies pour passer à ${R.stages[p.stage + 1]}.`),
          h('div', { class: 'row' },
            p.status === 'actif' && !last ? h('button', { class: 'primary', disabled: p.blockers.length > 0, onclick: act(() => api('POST', ws(`/studio/projets/${p.id}/avancer`)), 'Étape franchie') }, `Passer à ${R.stages[p.stage + 1]}`) : null,
            p.status === 'actif' ? h('button', { class: 'danger', onclick: act(async () => { if (window.confirm(`Abandonner « ${p.name} » ? Le projet et ses preuves restent consultables.`)) await api('PATCH', ws(`/studio/projets/${p.id}`), { status: 'abandonne' }); }) }, 'Abandonner') : h('button', { onclick: patchProject({ status: 'actif' }, 'Projet réactivé') }, 'Réactiver'))),

        h('div', { class: 'grid cols-2' },
          h('form', { class: 'card stack', onsubmit: patchProject(() => { const d = formData(document.getElementById('studio-validation')); return { concept: d.concept, validation: { public: d.public, besoin: d.besoin, proposition: d.proposition, distribution: d.distribution, modele: { prix: d.prix, cout_unitaire: d.cout_unitaire, couts_fixes: d.couts_fixes, ventes_cible: d.ventes_cible }, test: { mesure: d.mesure, seuil: d.seuil } } }; }, 'Validation enregistrée'), id: 'studio-validation' },
            h('h2', {}, 'Validation obligatoire'), h('p', { class: 'muted small' }, 'Aucune production importante tant que ces six points ne sont pas remplis.'),
            h('ul', { class: 'checks' }, p.validationState.map((x) => h('li', { class: x.ok ? 'ok' : 'ko' }, h('strong', {}, x.label), x.ok ? null : h('span', { class: 'muted small' }, ` — ${x.reason}`)))),
            h('label', {}, 'Concept', h('textarea', { name: 'concept', value: p.concept })),
            h('label', {}, 'Public visé', h('input', { name: 'public', value: v.public ?? '', maxLength: 1000 })),
            h('label', {}, 'Problème, désir ou besoin', h('input', { name: 'besoin', value: v.besoin ?? '', maxLength: 1000 })),
            h('label', {}, 'Proposition de valeur', h('input', { name: 'proposition', value: v.proposition ?? '', maxLength: 1000 })),
            h('label', {}, 'Stratégie de distribution', h('input', { name: 'distribution', value: v.distribution ?? '', maxLength: 1000 })),
            h('div', { class: 'row' }, [['prix', 'Prix de vente'], ['cout_unitaire', 'Coût par vente'], ['couts_fixes', 'Coûts fixes'], ['ventes_cible', 'Ventes visées']].map(([n, l]) => h('label', {}, l, h('input', { name: n, type: 'number', step: '0.01', min: '0', value: v.modele?.[n] ?? '', size: 8 })))),
            p.projection ? h('p', { class: 'small' }, h('strong', {}, 'Prévision (non prouvée) : '), `marge par vente ${money(p.projection.marge_unitaire, cur)} · rentable à partir de ${p.projection.seuil_rentabilite_ventes ?? '—'} vente(s)`, p.projection.benefice_vise !== null ? ` · bénéfice visé ${money(p.projection.benefice_vise, cur)}` : '') : null,
            h('div', { class: 'row' }, h('label', { class: 'grow' }, 'Test : ce qui sera mesuré', h('input', { name: 'mesure', value: v.test?.mesure ?? '', placeholder: 'Ex. : précommandes en 7 jours' })), h('label', {}, 'Seuil de succès', h('input', { name: 'seuil', value: v.test?.seuil ?? '', placeholder: 'Ex. : 10', size: 10 }))),
            h('div', {}, h('button', { class: 'primary' }, 'Enregistrer'))),

          h('div', { class: 'stack' },
            h('form', { class: 'card stack', id: 'studio-scores', onsubmit: patchProject(() => { const d = formData(document.getElementById('studio-scores')); return { scores: Object.fromEntries(R.criteria.map((c) => [c.key, { points: d[`p_${c.key}`], justification: d[`j_${c.key}`] }])) }; }, 'Arbitrage enregistré') },
              h('div', { class: 'row between' }, h('h2', {}, 'Arbitrage économique'), h('strong', {}, p.score === null ? `${p.scoredCriteria}/8 critères notés` : `${p.score} / 100`)),
              h('p', { class: 'muted small' }, 'Aucune note ne remplace les preuves commerciales.'),
              R.criteria.map((c) => h('div', { class: 'row' }, h('label', { class: 'grow' }, `${c.label} (sur ${c.max})`, h('input', { name: `j_${c.key}`, value: p.scores[c.key]?.justification ?? '', placeholder: 'Justification', maxLength: 500 })), h('label', {}, 'Points', h('input', { name: `p_${c.key}`, type: 'number', min: 0, max: c.max, step: 1, value: p.scores[c.key]?.points ?? '', size: 4 })))),
              h('div', {}, h('button', {}, 'Enregistrer la notation'))),
            h('form', { class: 'card stack', id: 'studio-rights', onsubmit: patchProject(() => { const d = formData(document.getElementById('studio-rights')); return { rights: { verifie: d.verifie === 'on', note: d.note } }; }, 'Vérification enregistrée') },
              h('h2', {}, 'Qualité et droits d\'exploitation'),
              h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'verifie', checked: p.rights.verifie === true }), 'Vérifiés : la création est originale ou ses contenus tiers sont sous licence'),
              h('label', {}, 'Sur quelle base', h('input', { name: 'note', value: p.rights.note ?? '', maxLength: 500, placeholder: 'Ex. : musique sous licence X, visuels créés en interne' })), h('div', {}, h('button', {}, 'Enregistrer'))))),

        h('div', { class: 'card stack' }, h('h2', {}, `Preuves (${p.evidence.length})`),
          h('p', { class: 'muted small' }, 'Chaque résultat est classé. PROUVÉ exige une source ; ce qui n\'est pas vérifié est INCONNU. Les vues et les likes sont un intérêt, pas un revenu.'),
          h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws(`/studio/projets/${p.id}/preuves`), formData(ev.target)), 'Résultat consigné') },
            h('label', { class: 'grow' }, `Résultat constaté à l'étape ${p.stageName}`, h('input', { name: 'statement', required: true, maxLength: 1000 })),
            h('label', {}, 'Classement', h('select', { name: 'status' }, Object.entries(R.statuses).map(([key, l]) => h('option', { value: key, selected: key === 'INCONNU' }, l)))),
            h('label', {}, 'Nature', h('select', { name: 'kind' }, Object.entries(R.kinds).map(([key, l]) => h('option', { value: key, selected: key === 'autre' }, l)))),
            h('label', {}, 'Concerne', h('select', { name: 'topic' }, h('option', { value: '' }, '—'), R.validation.map((x) => h('option', { value: x.key }, x.label)))),
            h('label', { class: 'grow' }, 'Source (lien, référence, protocole de test)', h('input', { name: 'source', maxLength: 500 })), h('button', {}, 'Consigner')),
          p.evidence.map((e) => h('div', { class: 'item row between' }, h('div', {}, h('div', { class: 'row' }, statusBadge(e.status), h('strong', {}, e.statement)),
            h('p', { class: 'muted small' }, `${R.stages[e.stage]} · ${R.kinds[e.kind]} · ${fdate(e.created_at)}`, e.source ? ` · source : ${e.source}` : ' · sans source')),
            h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/studio/preuves/${e.id}`)), 'Preuve retirée (trace conservée au journal)') }, 'Retirer')))),

        h('div', { class: 'grid cols-2' },
          h('div', { class: 'card stack' }, h('h2', {}, 'Résultats réels du projet'),
            h('table', {}, h('tbody', {}, [['Chiffre d\'affaires encaissé', eur(m.chiffre_affaires_encaisse)], ['Coûts', eur(m.couts)], ['Bénéfice net', eur(m.benefice_net)], ['Clients payants', m.clients_payants], ['Marge nette', pct(m.marge_nette)], ['Coût d\'acquisition par client', eur(m.cout_acquisition)], ['Clients ayant racheté', pct(m.recurrence)], ['Jours entre conception et premier encaissement', m.jours_avant_premier_encaissement ?? 'INCONNU']]
              .map(([l, val]) => h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, val))))),
            h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws(`/studio/projets/${p.id}/encaissements`), formData(ev.target)), 'Encaissement enregistré et consigné comme preuve') },
              h('label', {}, 'Montant encaissé', h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, size: 8 })), h('label', {}, 'Client', h('input', { name: 'counterparty', maxLength: 200 })),
              h('label', {}, 'Nature', h('select', { name: 'kind' }, h('option', { value: 'achat' }, 'Achat'), h('option', { value: 'precommande' }, 'Précommande'))),
              h('label', { class: 'grow' }, 'Référence du paiement (obligatoire)', h('input', { name: 'source', required: true, minLength: 5, maxLength: 500 })), h('button', {}, 'Enregistrer l\'encaissement'))),
          h('div', { class: 'stack' },
            h('form', { class: 'card stack', onsubmit: act((ev) => { const d = formData(ev.target); return api('POST', ws('/actions'), { type: 'studio.engager_depense', params: { projectId: p.id, amount: Number(d.amount), label: d.label, category: d.category } }); }, 'Demande de dépense enregistrée — elle attend une autorisation dans « Actions »') },
              h('h2', {}, 'Engager une dépense'), h('p', { class: 'muted small' }, `Toute dépense exige une autorisation. Bénéfices réellement disponibles : ${money(f.disponible, cur)}.`),
              h('div', { class: 'row' }, h('label', {}, 'Montant', h('input', { name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, size: 8 })), h('label', { class: 'grow' }, 'Objet', h('input', { name: 'label', required: true, maxLength: 300 })),
                h('label', {}, 'Poste', h('input', { name: 'category', maxLength: 80, placeholder: 'acquisition, outils…', size: 14 }))), h('div', {}, h('button', {}, 'Demander l\'autorisation'))),
            h('div', { class: 'card stack' }, h('h2', {}, 'Produire un document de travail'), h('p', { class: 'muted small' }, 'Texte uniquement, à partir de ce qui est saisi sur le projet ; ce qui manque y est marqué INCONNU ou « À compléter ».'),
              h('div', { class: 'row' }, [['concept', 'Fiche concept'], ['script_video', 'Script vidéo'], ['fiche_jeu', 'Fiche de jeu'], ['offre_tarif', 'Offre et prix'], ['campagne', 'Plan de campagne']].map(([t, l]) => h('button', { onclick: act(() => api('POST', ws(`/studio/projets/${p.id}/generer`), { template: t }), (doc) => { state.openDoc = doc.id; state.view = 'memoire'; toast('Document créé dans la Mémoire'); }) }, l)))))));
    };

    return page('Studio économique', 'Détecter ce que le public veut, créer ce qui apporte de la valeur, vendre ce qui fonctionne, développer ce qui rapporte.', null,
      h('div', { class: 'grid kpis' }, kpi('Bénéfice net conservé', eur(k.benefice_net_conserve), k.benefice_net_conserve < 0 ? 'neg' : ''), kpi('Clients payants', k.clients_payants), kpi('Chiffre d\'affaires encaissé', eur(k.chiffre_affaires_encaisse)),
        kpi('Marge nette', pct(k.marge_nette)), kpi('Coût d\'acquisition', eur(k.cout_acquisition)), kpi('Clients ayant racheté', pct(k.recurrence)), kpi('Jours avant 1er encaissement', k.delai_moyen_premier_encaissement ?? 'INCONNU')),
      h('div', { class: `notice ${f.depassement > 0 ? '' : 'info'}` }, h('strong', {}, 'Autofinancement — '), `budget initial 0 € · encaissé ${money(f.encaisse, cur)} · dépensé ${money(f.depense, cur)} · `,
        f.depassement > 0 ? `dépassement de ${money(f.depassement, cur)} : aucun réinvestissement possible tant qu'il n'est pas comblé par des ventes réelles.` : `disponible pour réinvestir : ${money(f.disponible, cur)}.`),
      sel ? detail(sel) : null,
      h('div', { class: 'card stack' }, h('h2', {}, `Opportunités (${o.projects.length})`),
        h('form', { class: 'inline', onsubmit: act((ev) => api('POST', ws('/studio/projets'), formData(ev.target)), (p) => { state.studioProject = p.id; toast('Projet créé à l\'étape EXPLORER'); }) },
          h('label', { class: 'grow' }, 'Nouvelle opportunité', h('input', { name: 'name', required: true, maxLength: 160, placeholder: 'Ex. : pack de transitions vidéo pour créateurs' })),
          h('label', {}, 'Domaine', h('select', { name: 'domain' }, Object.entries(R.domains).map(([key, l]) => h('option', { value: key }, l)))), h('button', { class: 'primary' }, 'Créer')),
        o.projects.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Projet'), h('th', {}, 'Étape'), h('th', { class: 'num' }, 'Note / 100'), h('th', {}, 'Preuve commerciale'), h('th', { class: 'num' }, 'Bénéfice net réel'), h('th', {}))),
          h('tbody', {}, [...o.ranking.map((id) => o.projects.find((x) => x.id === id)), ...o.projects.filter((x) => x.status !== 'actif')].map((p) => h('tr', {},
            h('td', {}, h('strong', { class: p.status !== 'actif' ? 'done' : '' }, p.name), h('div', { class: 'muted small' }, p.domainLabel)), h('td', {}, p.status === 'actif' ? p.stageName : p.status === 'abandonne' ? 'Abandonné' : 'Terminé'),
            h('td', { class: 'num' }, p.score ?? `${p.scoredCriteria}/8 notés`), h('td', {}, proof(p)), h('td', { class: `num ${p.metrics.benefice_net < 0 ? 'neg' : ''}` }, money(p.metrics.benefice_net, cur)),
            h('td', { class: 'right' }, h('button', { onclick: () => { state.studioProject = p.id; render().then(() => window.scrollTo(0, 0)); } }, 'Ouvrir'))))))) : empty('Aucune opportunité. Créez-en une : elle commence à l\'étape EXPLORER et n\'avance que sur preuves.')),
      h('p', { class: 'muted small' }, 'Le studio structure, contrôle et mesure. Il n\'observe pas les tendances et ne produit ni image, ni vidéo, ni prototype de jeu : ces résultats se consignent ici avec leur source. Il ne publie, ne vend et ne paie rien lui-même.'));
  },

  async cinema() {
    const o = await api('GET', ws('/cinema')); const R = o.reference; const P = o.production; const cur = state.workspace.currency;
    const f = state.film && o.projects.some((x) => x.id === state.film) ? await api('GET', ws(`/cinema/projets/${state.film}`)) : null;
    const base = f ? ws(`/cinema/projets/${f.id}`) : ''; const select = (name, list, value) => h('select', { name, 'aria-label': name }, list.map((x) => h('option', { value: x, selected: x === value }, x)));
    const brick = (label, b) => h('div', { class: 'row between small' }, h('span', {}, h('strong', {}, label), ` — ${b.nom}`), badge(b.type === 'commande' || b.type === 'ffmpeg' ? 'reussie' : 'en_attente', b.type === 'commande' ? `branchée · ${b.cout_par_seconde}/s` : b.type === 'ffmpeg' ? 'intégrée' : b.type === 'carton' ? 'maquette' : 'non branchée'));
    const mega = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} Ko` : `${(n / 1e6).toFixed(1)} Mo`);

    const film = () => {
      const gate = (key) => f.gates.find((g) => g.key === key); const done = (key) => Boolean(gate(key).approved);
      const gateBox = (key, intro, extra) => { const g = gate(key);
        return h('div', { class: `notice ${g.approved ? 'info' : ''} stack` },
          h('div', { class: 'row between' }, h('strong', {}, g.approved ? `✓ ${g.label} validé le ${fdatetime(g.approved.at)} par ${g.approved.by}` : `Validation : ${g.label}`),
            g.approved ? h('button', { class: 'link', onclick: act(async () => { if (window.confirm(`Rouvrir « ${g.label} » ? Les validations suivantes seront annulées.`)) await api('POST', `${base}/rouvrir`, { etape: key }); }) }, 'Rouvrir')
              : h('button', { class: 'primary', disabled: g.blockers.length > 0, onclick: act(() => api('POST', `${base}/valider`, { etape: key }), `${g.label} validé`) }, `Valider : ${g.label}`)),
          g.approved ? null : g.blockers.length ? g.blockers.map((b) => h('span', { class: 'small' }, `• ${b}`)) : h('span', { class: 'small' }, intro), extra); };
      const scenes = [...new Set(f.shots.map((x) => x.scene))];
      return h('div', { class: 'stack' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row between' }, h('h2', {}, f.title), h('div', { class: 'row' }, h('span', { class: 'muted small' }, `${f.shots.length} plan(s) · ${f.seconds} s · ${f.orientation === 'portrait' ? 'tourné en vertical' : 'tourné en large'}`), h('button', { class: 'link', onclick: () => { state.film = null; render(); } }, 'Fermer'))),
          h('ol', { class: 'steps' }, f.gates.map((g) => h('li', { class: g.approved ? 'past' : g.key === f.currentGate ? 'now' : '' }, g.label))),
          h('p', { class: 'muted small' }, f.idea || 'Aucune idée renseignée.')),

        h('div', { class: 'card stack' }, h('h2', {}, '1 · Scénario et découpage'),
          h('div', { class: 'row' }, h('button', { onclick: act(async () => { if (!f.shots.length || window.confirm('Réécrire le découpage ? Les plans actuels seront remplacés.')) return api('POST', `${base}/script`); return null; }, (r) => r && toast(r.scriptSource === 'local' ? `Trame en trois actes créée : ${r.shots.length} plans à écrire${r.fallbackReason ? ` (IA indisponible : ${r.fallbackReason})` : ''}` : `Découpage écrit par ${r.scriptSource} : ${r.shots.length} plans`)) }, state.meta.ai.generative ? 'Écrire le découpage à partir de l\'idée' : 'Créer une trame à remplir'),
            h('span', { class: 'muted small' }, state.meta.ai.generative ? 'Le modèle écrit scènes, dialogues et cadres ; vous corrigez.' : 'Sans IA générative, OMNIA ne rédige pas le scénario : il prépare la structure et vous écrivez chaque plan.')),
          scenes.map((sc) => { const shots = f.shots.filter((x) => x.scene === sc);
            return h('div', { class: 'stack' }, h('h3', {}, `Scène ${sc}${shots[0].scene_title ? ` — ${shots[0].scene_title}` : ''}`),
              shots.map((x) => h('form', { class: 'item stack', onsubmit: act((ev) => { const d = formData(ev.target); return api('PATCH', `${base}/plans/${x.id}`, { ...d, refs: [...ev.target.querySelectorAll('input[name=ref]:checked')].map((c) => Number(c.value)) }); }, 'Plan enregistré') },
                h('div', { class: 'row' }, h('strong', {}, `Plan ${x.number}`), select('size', R.sizes, x.size), select('angle', R.angles, x.angle), select('movement', R.moves, x.movement),
                  h('label', {}, 'Durée (s)', h('input', { name: 'duration', type: 'number', min: 1, max: 60, step: 0.5, value: x.duration, size: 4 })), x.clip ? badge('reussie', `tourné · ${x.clip_origin}`) : badge('en_attente', 'à tourner')),
                h('label', {}, 'Ce que l\'on voit', h('textarea', { name: 'description', value: x.description })),
                h('div', { class: 'row' }, h('label', {}, 'Qui parle', h('input', { name: 'speaker', value: x.speaker, size: 14 })), h('label', { class: 'grow' }, 'Réplique', h('input', { name: 'dialogue', value: x.dialogue, maxLength: 400 })), h('label', {}, 'Lumière', h('input', { name: 'lighting', value: x.lighting, size: 18 }))),
                f.bible.length ? h('div', { class: 'row small' }, 'Présents dans le plan :', f.bible.filter((b) => b.kind !== 'style').map((b) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'ref', value: b.id, checked: x.refs.includes(b.id) }), b.name))) : null,
                h('label', {}, 'Clip déjà réalisé (nom d\'un fichier déposé dans le dossier d\'apports)', h('input', { name: 'apport', value: x.apport ?? '', placeholder: 'ex. : plan-03.mp4' })),
                h('div', { class: 'row' }, h('button', {}, 'Enregistrer'), h('button', { type: 'button', class: 'link danger', onclick: act(() => api('DELETE', `${base}/plans/${x.id}`), 'Plan supprimé') }, 'Supprimer')))) ); }),
          h('form', { class: 'inline', onsubmit: act((ev) => api('POST', `${base}/plans`, formData(ev.target)), 'Plan ajouté') },
            h('label', { class: 'grow' }, 'Nouveau plan : ce que l\'on voit', h('input', { name: 'description', required: true, maxLength: 600 })), h('label', {}, 'Scène', h('input', { name: 'scene', type: 'number', min: 1, value: scenes.at(-1) ?? 1, size: 3 })), h('button', {}, 'Ajouter le plan')),
          gateBox('script', 'Le script est complet : validez-le pour ouvrir le storyboard.')),

        h('div', { class: 'card stack' }, h('h2', {}, '2 · Direction artistique et storyboard'),
          h('p', { class: 'muted small' }, 'La bible fixe personnages, décors, costumes et style. Une fois verrouillée, sa description est recopiée mot pour mot dans la consigne de chaque plan : c\'est ce qui tient la cohérence d\'une scène à l\'autre.'),
          f.bible.map((b) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, b.name), ' ', badge('gratuit', R.bibleKinds[b.kind]), h('p', { class: 'small' }, b.descriptor)),
            h('div', { class: 'row' }, h('button', { onclick: act(() => api('PATCH', `${base}/bible/${b.id}`, { locked: !b.locked }), b.locked ? 'Déverrouillé' : 'Verrouillé') }, b.locked ? '🔒 Verrouillé' : 'Verrouiller'),
              b.locked ? null : h('button', { class: 'link danger', onclick: act(() => api('DELETE', `${base}/bible/${b.id}`)) }, 'Supprimer')))),
          h('form', { class: 'inline', onsubmit: act((ev) => api('POST', `${base}/bible`, formData(ev.target)), 'Élément ajouté à la bible') },
            h('label', {}, 'Type', h('select', { name: 'kind' }, Object.entries(R.bibleKinds).map(([key, l]) => h('option', { value: key }, l)))), h('label', {}, 'Nom', h('input', { name: 'name', required: true, maxLength: 80 })),
            h('label', { class: 'grow' }, 'Description visuelle précise', h('input', { name: 'descriptor', required: true, maxLength: 600, placeholder: 'âge, traits, tenue, couleurs, matières…' })), h('button', {}, 'Ajouter')),
          done('script') ? h('div', { class: 'frames' }, f.shots.map((x) => h('figure', {}, h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(x.frame)}`, alt: `Plan ${x.number} : ${x.size}, ${x.movement}. ${x.description}`, loading: 'lazy' }),
            h('details', {}, h('summary', { class: 'small' }, 'Consigne pour le générateur'), h('pre', { class: 'doc small' }, x.prompt), h('button', { class: 'link', onclick: () => navigator.clipboard?.writeText(x.prompt).then(() => toast('Consigne copiée'), () => toast('Copie impossible', true)) }, 'Copier'))))) : empty('Le storyboard s\'affiche une fois le script validé.'),
          gateBox('storyboard', 'Cadres et bible sont prêts : validez pour autoriser le tournage.', h('span', { class: 'muted small' }, 'Ces vignettes sont des schémas de cadrage, pas des images du film.'))),

        h('div', { class: 'card stack' }, h('h2', {}, '3 · Tournage'),
          brick('Image', P.briques.video), brick('Voix', P.briques.voix), brick('Musique', P.briques.musique),
          h('p', { class: 'muted small' }, `Pour utiliser vos propres clips (produits par le générateur de votre choix), déposez-les dans `, h('code', {}, f.dossier_apports), ' et indiquez leur nom sur chaque plan. Les plans sans clip ni générateur branché sont remplacés par un carton d\'animatique.'),
          h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !done('storyboard') || f.shots.every((x) => x.clip), onclick: act(() => api('POST', `${base}/tourner`), (r) => { const ko = r.rapport.filter((x) => x.erreur); toast(ko.length ? `${ko.length} plan(s) en échec : ${ko[0].erreur}` : `${r.rapport.filter((x) => x.secondes).length} plan(s) tourné(s)`, ko.length > 0); }) }, `Tourner les plans (${f.shots.filter((x) => !x.clip).length} à faire)`),
            h('span', { class: 'muted small' }, done('storyboard') ? 'Le tournage peut prendre plusieurs minutes.' : 'Disponible après validation du storyboard.')),
          gateBox('plans', 'Tous les plans sont tournés : validez-les pour assembler le prémontage.')),

        h('div', { class: 'card stack' }, h('h2', {}, '4 · Montage et post-production'),
          h('form', { class: 'inline', onsubmit: act((ev) => { const d = formData(ev.target); return api('PATCH', base, { grade: d.grade, transition: d.transition, subtitles: d.subtitles === 'on' }); }, 'Réglages enregistrés') },
            h('label', {}, 'Étalonnage', h('select', { name: 'grade' }, Object.entries(R.grades).map(([key, l]) => h('option', { value: key, selected: key === f.grade }, l)))),
            h('label', {}, 'Transitions', h('select', { name: 'transition' }, Object.entries(R.transitions).map(([key, l]) => h('option', { value: key, selected: key === f.transition }, l)))),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'subtitles', checked: Boolean(f.subtitles) }), 'Incruster les sous-titres'), h('button', {}, 'Enregistrer')),
          h('div', { class: 'row' }, h('button', { disabled: !done('plans'), onclick: act(() => api('POST', `${base}/assembler`, { type: 'premontage' }), 'Prémontage assemblé') }, 'Assembler le prémontage'),
            h('button', { class: 'primary', disabled: !done('montage'), onclick: act(() => api('POST', `${base}/assembler`, { type: 'final' }), (r) => toast(`Export final : ${r.produit.map((x) => x.taille).join(' et ')}`)) }, 'Exporter le film (16:9 et 9:16)'),
            h('span', { class: 'muted small' }, 'L\'export final en pleine définition peut prendre plusieurs minutes.')),
          f.exports.map((e) => h('div', { class: 'item stack' }, h('div', { class: 'row between' }, h('strong', {}, e.kind === 'final' ? `Film — ${o.formats[e.format]?.label ?? e.format}` : 'Prémontage (aperçu basse définition)'),
            h('div', { class: 'row' }, e.stale ? badge('en_attente', 'périmé') : null, h('span', { class: 'muted small' }, `${e.width}×${e.height} · ${e.seconds} s · ${mega(e.bytes)}`), h('a', { class: 'btn', href: `/api${base}/exports/${e.id}/fichier`, download: '' }, 'Télécharger'))),
            h('video', { controls: true, preload: 'metadata', src: `/api${base}/exports/${e.id}/fichier`, class: e.height > e.width ? 'tall' : '' }))),
          gateBox('montage', 'Visionnez le prémontage : votre validation autorise l\'export final.')),

        h('div', { class: 'card stack' }, h('h2', {}, 'Coûts de production'),
          h('p', {}, h('strong', {}, f.costPerMinute === null ? '—' : `${money(f.costPerMinute, cur)} par minute produite`), h('span', { class: 'muted' }, ` · total ${money(f.costTotal, cur)} pour ${f.seconds} s`)),
          f.costs.length ? h('table', {}, h('tbody', {}, f.costs.slice(0, 30).map((c) => h('tr', {}, h('td', {}, c.label), h('td', { class: 'num' }, `${c.seconds} s`), h('td', { class: 'num' }, money(c.cost, cur)))))) : h('p', { class: 'muted small' }, 'Aucun coût : les briques utilisées jusqu\'ici sont gratuites ou vos clips ont été fournis.')));
    };

    return page('Studio de cinéma', 'De l\'idée au film, en quatre validations : script, storyboard, plans, montage final.', null,
      P.outils.ffmpeg ? null : h('div', { class: 'notice' }, 'ffmpeg est introuvable sur cette machine : le tournage et le montage sont indisponibles tant qu\'il n\'est pas installé (logiciel libre).'),
      P.erreur ? h('div', { class: 'notice' }, `Configuration des briques ignorée : ${P.erreur}`) : null,
      f ? film() : null,
      h('div', { class: 'card stack' }, h('h2', {}, `Films (${o.projects.length})`),
        h('form', { class: 'stack', onsubmit: act((ev) => api('POST', ws('/cinema/projets'), formData(ev.target)), (p) => { state.film = p.id; toast('Film créé'); }) },
          h('div', { class: 'row' }, h('label', { class: 'grow' }, 'Titre', h('input', { name: 'title', required: true, maxLength: 160 })), h('label', {}, 'Durée visée (s)', h('input', { name: 'target_seconds', type: 'number', min: 10, max: 1800, value: 60, size: 5 })),
            h('label', {}, 'Tourné en', h('select', { name: 'orientation' }, h('option', { value: 'paysage' }, 'Large (16:9)'), h('option', { value: 'portrait' }, 'Vertical (9:16)')))),
          h('label', {}, 'L\'idée', h('textarea', { name: 'idea', maxLength: 3000, placeholder: 'Ex. : un petit robot aspirateur découvre une miette de pain et hésite à l\'aspirer.' })),
          h('label', {}, 'Style visuel', h('input', { name: 'style', maxLength: 500, placeholder: 'Ex. : animation 3D, nuit, lumière bleutée, faible profondeur de champ' })), h('div', {}, h('button', { class: 'primary' }, 'Créer le film'))),
        o.projects.map((p) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, p.title), h('p', { class: 'muted small' }, `${p.shots.length} plan(s) · ${p.seconds} s · étape : ${p.currentGate ? p.gates.find((g) => g.key === p.currentGate).label : 'terminé'}`)),
          h('div', { class: 'row' }, h('button', { onclick: () => { state.film = p.id; render().then(() => window.scrollTo(0, 0)); } }, 'Ouvrir'), h('button', { class: 'link danger', onclick: act(async () => { if (window.confirm(`Supprimer le film « ${p.title} » ?`)) await api('DELETE', ws(`/cinema/projets/${p.id}`)); }) }, 'Supprimer'))))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Briques de production'), brick('Image', P.briques.video), brick('Voix', P.briques.voix), brick('Musique', P.briques.musique), brick('Montage', P.briques.montage),
        h('p', { class: 'muted small' }, 'OMNIA ne contient aucun générateur d\'images, de voix ou de musique. Il écrit, tient la cohérence, monte, étalonne, sous-titre et exporte ; la qualité de l\'image est celle des clips que vous fournissez ou du générateur que vous branchez. Pour brancher un générateur, décrivez sa commande dans ',
          h('code', {}, P.fichier_briques), '.')));
  },

  async noyau() {
    const n = await api('GET', '/noyau'); const active = state.workspace.modules;
    const sens = (a) => badge(a.sensitivity);
    return page('Noyau', `OMNIA Ω ${n.version ?? ''} — un noyau central ; tout le reste s'y branche.`, null,
      h('div', { class: 'card stack' }, h('h2', {}, 'Le cycle'), h('p', {}, n.cycle.map((c, i) => [i ? ' → ' : '', h('strong', {}, c)])),
        h('p', { class: 'muted small' }, 'Le noyau ne contient aucune règle métier : il orchestre ce que les modules lui déclarent, applique les autorisations, journalise et publie les événements.')),
      n.erreurs_de_chargement.length ? h('div', { class: 'notice stack' }, h('strong', {}, 'Modules externes non chargés'), n.erreurs_de_chargement.map((e) => h('span', { class: 'small' }, `${e.file} : ${e.message}`))) : null,
      h('div', { class: 'card stack' }, h('h2', {}, `Modules enregistrés (${n.modules.length})`),
        h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Module', 'Origine', 'Règles', 'Actions', 'Réagit à', 'Dans cet espace'].map((t) => h('th', {}, t)))),
          h('tbody', {}, n.modules.map((m) => h('tr', {}, h('td', {}, h('strong', {}, m.name), h('div', { class: 'muted small' }, m.description)),
            h('td', {}, badge(m.source === 'externe' ? 'pro' : 'gratuit', m.source === 'externe' ? 'externe' : m.core ? 'socle' : 'intégré')),
            h('td', { class: 'small' }, m.rules.length ? m.rules.map((r) => h('div', {}, r.label)) : '—'), h('td', { class: 'small' }, m.actions.length ? m.actions.map((a) => h('div', {}, a.label, ' ', sens(a))) : '—'),
            h('td', { class: 'small' }, m.events.length ? m.events.join(', ') : '—'), h('td', {}, active.includes(m.id) ? badge('reussie', 'activé') : h('span', { class: 'muted small' }, 'inactif')))))))),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card stack' }, h('h2', {}, `Types d'action (${n.actions.length})`), h('p', { class: 'muted small' }, 'Toute action passe par le noyau. « Sensible » : jamais exécutée sans autorisation.'),
          n.actions.map((a) => h('div', { class: 'row between small' }, h('span', {}, a.label, ' ', h('code', {}, a.type)), sens(a)))),
        h('div', { class: 'card stack' }, h('h2', {}, 'Événements'), h('p', { class: 'muted small' }, `Publiés par le noyau ; modules et automatisations y réagissent. ${n.file_evenements.emis} émis depuis le démarrage, ${n.file_evenements.en_file} en file.`),
          Object.entries(n.evenements).map(([k, v]) => h('div', { class: 'row between small' }, h('span', {}, v), h('code', {}, k))))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Étendre le noyau'),
        h('p', { class: 'small' }, 'Un module est un fichier JavaScript déposé dans le dossier de modules, chargé au démarrage. Il déclare règles, solutions, actions et réactions ; le noyau l\'appelle avec une interface limitée à l\'espace concerné. Exemple complet : ', h('code', {}, 'examples/module-exemple.js'), '.'),
        h('p', { class: 'small' }, 'Un logiciel tiers pilote le noyau par l\'API avec une clé propre à un espace (écran Connexions). Référence : ', h('code', {}, 'docs/API.md'), '.')));
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
      h('div', { class: 'card stack' }, h('h2', {}, 'Sauvegarde de toute l\'instance'),
        h('p', { class: 'muted small' }, 'Un fichier chiffré par votre phrase secrète (12 caractères au moins) : tous les espaces, les comptes, les droits et le journal. Sans la phrase, il est illisible ; elle n\'est enregistrée nulle part.'),
        h('form', { class: 'inline', onsubmit: act(async (ev) => download(`omnia-instance-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await api('POST', '/instance/sauvegarde', { phrase: formData(ev.target).phrase }))), 'Sauvegarde téléchargée') },
          h('label', {}, 'Phrase secrète', h('input', { name: 'phrase', type: 'password', required: true, minLength: 12, autocomplete: 'new-password' })), h('button', { class: 'primary' }, 'Télécharger la sauvegarde')),
        h('form', { class: 'inline', onsubmit: act(async (ev) => { const file = ev.target.querySelector('input[type=file]').files[0]; if (!file) throw new Error('Choisissez un fichier de sauvegarde'); await api('POST', '/instance/restauration', { phrase: formData(ev.target).phrase, sauvegarde: JSON.parse(await file.text()) }); window.location.reload(); }) },
          h('label', {}, 'Fichier de sauvegarde', h('input', { type: 'file', accept: 'application/json', required: true })), h('label', {}, 'Phrase secrète', h('input', { name: 'phrase', type: 'password', required: true })), h('button', {}, 'Restaurer')),
        h('p', { class: 'muted small' }, 'La restauration n\'est acceptée que sur une instance vide ou tout juste amorcée : elle n\'écrase jamais un travail en cours.')),
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
          h('span', {}, h('strong', {}, m.name), ' ', badge(m.tier, m.core ? 'socle' : m.tier), m.source === 'externe' ? [' ', badge('pro', 'externe')] : null, h('span', { class: 'muted small' }, ` ${m.description}`)))),
        h('p', { class: 'muted small' }, 'La mention « pro » indique le positionnement commercial prévu. Dans cette version, tous les modules sont utilisables sans licence.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Connecteurs'), state.meta.connectors.map((c) => h('div', { class: 'row between' }, h('span', {}, h('strong', {}, c.name), h('span', { class: 'muted small' }, ` — ${c.description}`)), badge(c.sensitivity)))),
      await accountsCards(w),
      h('div', { class: 'card stack' }, h('h2', {}, 'Sauvegarde'), h('p', { class: 'muted small' }, 'Le fichier contient le profil, les projets, tâches, opérations, documents et automatisations de cet espace. Il n\'est pas chiffré : conservez-le en lieu sûr.'),
        h('div', { class: 'row' }, h('button', { onclick: act(async () => { const data = await api('GET', ws('/export')); download(`omnia-${w.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2)); }, 'Sauvegarde téléchargée') }, 'Télécharger une sauvegarde'),
          h('label', {}, 'Restaurer une sauvegarde dans un nouvel espace', h('input', { type: 'file', accept: '.json,application/json', onchange: importBackup })))),
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
      h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Créer mon espace'), !first && h('button', { type: 'button', onclick: () => { state.view = 'tableau'; render(); } }, 'Annuler')),
      h('label', {}, 'Ou restaurer une sauvegarde OMNIA (.json)', h('input', { type: 'file', accept: '.json,application/json', onchange: importBackup }))));
}

function loginScreen() {
  return h('div', { class: 'hero' },
    h('h1', {}, 'OMNIA ', h('span', {}, 'Ω')), h('p', { class: 'muted' }, 'Comprendre. Décider. Agir. Progresser.'),
    h('form', { id: 'connexion', class: 'card stack', onsubmit: act((ev) => api('POST', '/session', formData(ev.target))) },
      h('h2', {}, 'Connexion'),
      h('label', {}, 'Adresse e-mail', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
      h('label', {}, 'Mot de passe', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      h('div', {}, h('button', { class: 'primary' }, 'Se connecter'))));
}

const ROLE_LABELS = { lecteur: 'Lecteur — consulte', membre: 'Membre — saisit et décide', proprietaire: 'Propriétaire — autorise et administre' };

// Comptes et membres : visibles selon le régime (sans compte / avec comptes) et le rôle.
async function accountsCards(w) {
  const cards = [];
  if (!state.accounts) {
    cards.push(h('form', { class: 'card stack', onsubmit: act(async (ev) => { const f = formData(ev.target); await api('POST', '/comptes', f); await api('POST', '/session', { email: f.email, password: f.password }); }, 'Comptes activés — vous êtes administrateur') },
      h('h2', {}, 'Travailler à plusieurs'),
      h('p', { class: 'muted small' }, 'OMNIA fonctionne aujourd\'hui sans compte : toute personne ayant accès à cette adresse peut tout faire. Créer un premier compte active la connexion obligatoire et les rôles par espace. Ce compte sera administrateur.'),
      h('div', { class: 'row' }, h('label', {}, 'Votre nom', h('input', { name: 'name', required: true, maxLength: 80, autocomplete: 'name' })), h('label', {}, 'Adresse e-mail', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
        h('label', {}, 'Mot de passe (10 caractères min.)', h('input', { name: 'password', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' }))),
      h('div', {}, h('button', {}, 'Activer les comptes'))));
    return cards;
  }
  if (w.role === 'proprietaire') {
    const members = await api('GET', ws('/membres'));
    cards.push(h('div', { class: 'card stack' }, h('h2', {}, 'Membres de cet espace'),
      h('p', { class: 'muted small' }, 'Lecteur : consulte. Membre : saisit, analyse, accepte des recommandations. Propriétaire : autorise les actions sensibles, gère automatisations, réglages et membres.'),
      members.length ? members.map((m) => h('div', { class: 'row between' }, h('span', {}, h('strong', {}, m.name), h('span', { class: 'muted small' }, ` ${m.email}`)),
        h('div', { class: 'row' }, h('select', { 'aria-label': `Rôle de ${m.name}`, onchange: act((ev) => api('PUT', ws('/membres'), { email: m.email, role: ev.target.value }), 'Rôle mis à jour') }, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === m.role }, l))),
          h('button', { class: 'link danger', onclick: act(() => api('DELETE', ws(`/membres/${m.id}`)), 'Membre retiré') }, 'Retirer')))) : empty('Aucun membre désigné : seuls les administrateurs y accèdent.'),
      h('form', { class: 'inline', onsubmit: act((ev) => api('PUT', ws('/membres'), formData(ev.target)), 'Membre ajouté') },
        h('label', { class: 'grow' }, 'Adresse e-mail d\'un compte existant', h('input', { name: 'email', type: 'email', required: true })),
        h('label', {}, 'Rôle', h('select', { name: 'role' }, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'membre' }, l)))), h('button', {}, 'Ajouter'))));
  }
  if (state.user.admin) {
    const users = await api('GET', '/comptes');
    cards.push(h('div', { class: 'card stack' }, h('h2', {}, `Comptes (${users.length})`),
      users.map((u) => h('div', { class: 'row between' }, h('span', {}, h('strong', {}, u.name), h('span', { class: 'muted small' }, ` ${u.email}`), u.admin ? [' ', badge('pro', 'administrateur')] : null),
        u.id !== state.user.id ? h('button', { class: 'link danger', onclick: act(async () => { if (window.confirm(`Supprimer le compte de ${u.name} ?`)) await api('DELETE', `/comptes/${u.id}`); }) }, 'Supprimer') : h('span', { class: 'muted small' }, 'vous'))),
      h('form', { class: 'inline', onsubmit: act((ev) => { const f = formData(ev.target); return api('POST', '/comptes', { ...f, admin: f.admin === 'on' }); }, 'Compte créé — transmettez le mot de passe par un canal sûr') },
        h('label', {}, 'Nom', h('input', { name: 'name', required: true, maxLength: 80 })), h('label', {}, 'Adresse e-mail', h('input', { name: 'email', type: 'email', required: true })),
        h('label', {}, 'Mot de passe initial', h('input', { name: 'password', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' })),
        h('label', { class: 'check' }, h('input', { name: 'admin', type: 'checkbox' }), 'Administrateur'), h('button', {}, 'Créer le compte'))));
  }
  return cards;
}

function go(view) { state.view = view; state.openDoc = null; render(); }

async function render() {
  try {
    const etat = await api('GET', '/etat');
    state.accounts = etat.comptes; state.user = etat.utilisateur;
    if (etat.comptes && !etat.utilisateur) return $app.replaceChildren(loginScreen());
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
      h('div', { class: 'foot muted small stack' },
        state.user ? h('div', {}, `${state.user.name} · ${state.user.admin ? 'administrateur' : state.workspace.role}`, ' ', h('button', { class: 'link', onclick: act(() => api('DELETE', '/session')) }, 'Se déconnecter')) : null,
        h('span', {}, state.meta.ai.generative ? `IA : ${state.meta.ai.provider}` : 'Mode local, sans IA générative')));
    const scroll = window.scrollY;
    $app.replaceChildren(h('div', { class: 'layout' }, side, h('main', {}, content)));
    window.scrollTo(0, scroll);
  } catch (e) {
    $app.replaceChildren(h('div', { class: 'hero' }, h('h1', {}, 'OMNIA ', h('span', {}, 'Ω')), h('div', { class: 'card stack' }, h('p', {}, `Impossible de charger l'interface : ${e.message}`), h('div', {}, h('button', { onclick: render }, 'Réessayer')))));
  }
}

render();
