import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, today } from '../src/core/db.js';
import { createAI } from '../src/ai/index.js';
import { createKernel } from '../src/core/kernel.js';
import { analyze } from '../src/engines/analysis.js';
import { decide, weightOf } from '../src/engines/decision.js';
import { understandLocally } from '../src/engines/understanding.js';
import { transactionsFromCsv, parseAmount, parseDate } from '../src/core/csv.js';
import { assertPublicUrl, toCsv } from '../src/connectors/index.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const d = (n) => today(new Date(NOW.getTime() - n * 86400000));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-'));
function setup(extra = {}) {
  const config = loadConfig({ dataDir: tmp(), dbPath: ':memory:', clock: () => NOW, token: '', host: '127.0.0.1', ...extra });
  const db = openDb(':memory:');
  return { db, config, k: createKernel({ db, ai: createAI({ provider: 'local' }), config }) };
}
const tx = (date, amount, label = '', category = 'divers', counterparty = '') => ({ id: Math.random(), date, amount, label, category, counterparty });

test('compréhension locale : secteur, type et objectifs', () => {
  const p = understandLocally('Nous sommes une association de bénévoles. Nous voulons trouver des subventions.');
  assert.equal(p.kind, 'association'); assert.equal(p.sector, 'association'); assert.equal(p.goals.length, 1);
  assert.equal(understandLocally('').sector, 'general');
});

test('analyse : aucune donnée, aucun constat inventé', () => {
  assert.deepEqual(analyze({ tasks: [], projects: [], transactions: [] }, { date: NOW }), []);
});

test('analyse : retards, doublons, récurrences, dépendance, baisse', () => {
  const tasks = [{ id: 1, title: 'A', status: 'a_faire', due_date: d(3), created_at: d(5) }, { id: 2, title: 'B', status: 'fait', due_date: d(3), created_at: d(5) }];
  const transactions = [
    tx(d(5), -50, 'Camion'), tx(d(5), -50, 'Camion'),
    tx(d(2), -30, 'Abo'), tx(d(32), -30, 'Abo'), tx(d(62), -30, 'Abo'),
    tx(d(40), 5000, 'v', 'ventes', 'Gros'), tx(d(45), 3000, 'v', 'ventes', 'Gros'), tx(d(10), 500, 'v', 'ventes', 'Petit'), tx(d(8), 400, 'v', 'ventes', 'Gros'),
  ];
  const rules = analyze({ tasks, projects: [], transactions }, { date: NOW }).map((f) => f.rule);
  for (const r of ['taches.en_retard', 'finances.doublons', 'finances.charges_recurrentes', 'finances.dependance_client', 'finances.revenus_en_baisse']) assert.ok(rules.includes(r), r);
  const overdue = analyze({ tasks, projects: [], transactions: [] }, { date: NOW })[0];
  assert.deepEqual(overdue.evidence.taskIds, [1]);
  assert.deepEqual(analyze({ tasks, projects: [], transactions }, { date: NOW, enabledModules: ['finances'] }).filter((f) => f.rule.startsWith('taches')), []);
});

test('décision : meilleure option = meilleur rapport impact/effort ; l\'apprentissage module la priorité', () => {
  const insight = { rule: 'taches.en_retard', kind: 'probleme', severity: 3, title: 't', detail: 'd', evidence: { taskIds: [1, 2, 3, 4] } };
  const r = decide(insight, null);
  assert.equal(r.options[r.best_option].score, Math.max(...r.options.map((o) => o.score)));
  assert.ok(decide(insight, { accepted: 3, rejected: 0, resolved: 2 }).priority > r.priority);
  assert.ok(decide(insight, { accepted: 0, rejected: 3, resolved: 0 }).priority < r.priority);
  assert.equal(weightOf({ accepted: 0, rejected: 99, resolved: 0 }), 0.4);
});

test('CSV : montants et dates français, débit/crédit, lignes illisibles signalées', () => {
  assert.equal(parseAmount('1 234,56 €'), 1234.56); assert.equal(parseAmount('-1.234,5'), -1234.5); assert.equal(parseAmount('(12.50)'), -12.5); assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal(parseDate('05/03/2026'), '2026-03-05'); assert.equal(parseDate('31/02/2026'), null);
  const r = transactionsFromCsv('Date;Libellé;Débit;Crédit\n01/06/2026;"Loyer; atelier";1 450,00;\n02/06/2026;Vente;;300\nn\'importe;x;1;\n');
  assert.deepEqual(r.items.map((x) => x.amount), [-1450, 300]); assert.equal(r.items[0].label, 'Loyer; atelier'); assert.equal(r.skipped.length, 1);
  assert.throws(() => transactionsFromCsv('a;b\n1;2'), /date/);
  assert.ok(toCsv([{ a: '=SOMME(A1)' }], ['a']).includes("'=SOMME"));
});

test('cycle complet : analyser → décider → agir → mesurer → apprendre', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Test', description: 'Boutique de vélos' });
  const t = k.createTask(w.id, { title: 'En retard', due_date: d(4) });
  let r = k.runAnalysis(w.id);
  assert.equal(r.insights.length, 1);
  assert.equal(k.runAnalysis(w.id).created, 0, 'une seconde analyse ne duplique pas le constat');
  const [rec] = k.listRecommendations(w.id);
  const out = await k.acceptRecommendation(w.id, rec.id);
  assert.ok(out.actions.every((a) => a.status === 'reussie'));
  await assert.rejects(k.acceptRecommendation(w.id, rec.id), /déjà été traitée/);
  for (const x of k.data(w.id).tasks) k.updateTask(w.id, x.id, { status: 'fait' });
  r = k.runAnalysis(w.id);
  assert.equal(r.resolved, 1);
  const dash = k.dashboard(w.id);
  assert.equal(dash.results.recommandations_suivies_d_effet, 1);
  assert.ok(dash.learning[0].weight > 1);
  assert.equal(dash.kpis.taches_en_retard, 0);
  assert.ok(t.id);
});

test('sécurité : une action sensible n\'est jamais exécutée sans autorisation', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Test' });
  let called = 0; const real = globalThis.fetch; globalThis.fetch = async () => { called += 1; return new Response('ok'); };
  try {
    const a = await k.execution.request(w, { type: 'webhook.envoyer', params: { url: 'https://93.184.216.34/hook' } });
    assert.equal(a.status, 'en_attente'); assert.equal(called, 0);
    const auto = k.createAutomation(w.id, { name: 'auto', every_minutes: 5, action_type: 'webhook.envoyer', params: { url: 'https://93.184.216.34/hook' } });
    await k.tick(); await k.tick();
    assert.equal(called, 0, 'une automatisation sensible attend aussi');
    assert.equal(k.execution.list(w.id, 'en_attente').length, 2, 'pas de demande dupliquée à chaque passage');
    const refused = k.execution.reject(w, a.id); assert.equal(refused.status, 'refusee');
    await assert.rejects(k.execution.approve(w, a.id), /pas en attente/);
    const pending = k.execution.list(w.id, 'en_attente')[0];
    assert.equal((await k.execution.approve(w, pending.id)).status, 'reussie'); assert.equal(called, 1);
    assert.ok(auto.id);
  } finally { globalThis.fetch = real; }
  await assert.rejects(k.execution.request(w, { type: 'webhook.envoyer', params: { url: 'file:///etc/passwd' } }), /http/);
  await assert.rejects(k.execution.request(w, { type: 'inconnu' }), /inconnu/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/x'), /privées/);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/'), /privées/);
  const failed = await k.execution.approve(w, (await k.execution.request(w, { type: 'webhook.envoyer', params: { url: 'http://10.0.0.1/x' } })).id);
  assert.equal(failed.status, 'echouee', 'un échec est rapporté comme un échec');
});

test('autonomie « manuel » : les automatisations attendent même pour une action interne', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Test' });
  k.updateWorkspace(w.id, { autonomy: 'manuel' });
  k.createAutomation(w.id, { name: 'analyse', every_minutes: 60, action_type: 'analyse.lancer' });
  const [ran] = await k.tick();
  assert.equal(ran.status, 'en_attente');
  k.updateWorkspace(w.id, { autonomy: 'assiste' });
  k.createAutomation(w.id, { name: 'analyse 2', every_minutes: 60, action_type: 'analyse.lancer' });
  assert.ok((await k.tick()).some((x) => x.status === 'reussie'));
});

test('journal d\'audit : chaîne intègre, altération détectée', async () => {
  const { k, db } = setup();
  const w = await k.createWorkspace({ name: 'Test' });
  k.runAnalysis(w.id);
  assert.equal(k.audit.verify().ok, true);
  db.run("UPDATE audit_log SET detail = '{}' WHERE id = 1");
  assert.deepEqual(k.audit.verify().brokenAt, 1);
});

test('création et assistant en mode local : chiffres réels, origine déclarée', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Test' });
  k.createTransaction(w.id, { date: d(3), amount: -120.5, category: 'loyer' });
  k.createDocument(w.id, { title: 'Procédure fournisseurs', content: 'Toujours demander deux devis.' });
  const doc = await k.generate(w.id, 'budget', '');
  assert.equal(doc.source, 'local'); assert.match(doc.content, /loyer : 120,5/);
  await assert.rejects(k.generate(w.id, 'nimporte', ''), /inconnu/);
  const a = await k.ask(w.id, 'Quelle est la procédure pour les fournisseurs ?');
  assert.equal(a.source, 'local'); assert.equal(a.sources[0].title, 'Procédure fournisseurs');
});

test('cloisonnement entre espaces', async () => {
  const { k } = setup();
  const a = await k.createWorkspace({ name: 'A' }); const b = await k.createWorkspace({ name: 'B' });
  const t = k.createTask(a.id, { title: 'privée' });
  assert.throws(() => k.updateTask(b.id, t.id, { status: 'fait' }), /introuvable/);
  assert.throws(() => k.deleteTask(b.id, t.id), /introuvable/);
  assert.equal(k.data(b.id).tasks.length, 0);
});

test('API HTTP : routes, jeton, CSRF, hôte, fichiers statiques', async () => {
  const { k, config } = setup({ token: 'secret' });
  const server = createApp(config, k); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { authorization: 'Bearer secret', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(`${base}/api/meta`)).status, 401);
    assert.equal((await call('GET', '/api/meta', null, { authorization: 'Bearer faux' })).status, 401);
    const w = await (await call('POST', '/api/espaces', { name: 'Via API' })).json(); assert.ok(w.id);
    assert.equal((await call('POST', `/api/espaces/${w.id}/taches`, { title: '' })).status, 400);
    assert.equal((await call('POST', `/api/espaces/${w.id}/taches`, { title: 'ok' })).status, 200);
    assert.equal((await call('GET', '/api/espaces/999/tableau-de-bord')).status, 404);
    assert.equal((await call('POST', `/api/espaces/${w.id}/analyse`, {}, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/espaces/${w.id}/analyse`, { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 415);
    const home = await fetch(`${base}/`); assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await call('DELETE', `/api/espaces/${w.id}`, {})).status, 204);
  } finally { server.close(); }
});

test('sauvegarde : export puis restauration fidèle, automatisations remises en pause', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Origine', description: 'Association de quartier' });
  const p = k.createProject(w.id, { name: 'Fête', deadline: d(-20) });
  k.createTask(w.id, { title: 'Réserver la salle', project_id: p.id, status: 'fait' });
  k.createTask(w.id, { title: 'Sans projet', due_date: d(2) });
  k.createTransaction(w.id, { date: d(1), amount: -42.5, label: 'Affiches' });
  k.createDocument(w.id, { title: 'Statuts', content: 'Article 1' });
  const auto = k.createAutomation(w.id, { name: 'envoi', every_minutes: 60, action_type: 'webhook.envoyer', params: { url: 'https://93.184.216.34/h' } });
  k.updateAutomation(w.id, auto.id, { preauthorized: true });
  const backup = JSON.parse(JSON.stringify(k.exportWorkspace(w.id)));
  const r = k.importWorkspace(backup);
  assert.notEqual(r.id, w.id); assert.equal(r.kind, 'association');
  const data = k.data(r.id);
  assert.equal(data.tasks.length, 2); assert.equal(data.transactions[0].amount, -42.5); assert.equal(data.documents[0].content, 'Article 1');
  assert.equal(data.tasks.find((t) => t.title === 'Réserver la salle').project_id, data.projects[0].id);
  const [restored] = k.listAutomations(r.id);
  assert.equal(restored.enabled, 0); assert.equal(restored.preauthorized, 0);
  assert.throws(() => k.importWorkspace({ format: 'autre' }), /sauvegarde OMNIA/);
  const before = k.listWorkspaces().length;
  assert.throws(() => k.importWorkspace({ ...backup, transactions: [{ date: 'x', amount: 1 }] }), /Date invalide/);
  assert.equal(k.listWorkspaces().length, before, 'un import invalide ne laisse aucun espace partiel');
});

test('comptes et rôles : connexion, cloisonnement, droits par rôle, journal nominatif', async () => {
  const { k, config } = setup();
  const server = createApp(config, k); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let jar = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(jar ? { cookie: jar } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie'); if (set) jar = set.split(';')[0];
      return { status: res.status, body: res.status === 204 ? null : await res.json(), cookie: set };
    };
  };
  const anon = client(); const admin = client(); const alice = client(); const bob = client();
  try {
    // Régime sans compte : tout est ouvert en local.
    const legacy = (await anon('POST', '/api/espaces', { name: 'Avant les comptes' })).body;
    assert.equal((await anon('GET', '/api/etat')).body.comptes, false);
    assert.equal((await anon('POST', '/api/comptes', { name: 'Chef', email: 'chef@ex.fr', password: 'court' })).status, 400);
    assert.equal((await anon('POST', '/api/comptes', { name: 'Chef', email: 'Chef@Ex.fr', password: 'motdepasse-long' })).body.admin, true);
    // Dès le premier compte : plus rien sans session.
    assert.equal((await anon('GET', '/api/espaces')).status, 401);
    assert.equal((await anon('POST', '/api/comptes', { name: 'Intrus', email: 'i@ex.fr', password: 'motdepasse-long' })).status, 401);
    assert.equal((await anon('POST', '/api/session', { email: 'chef@ex.fr', password: 'mauvais' })).status, 401);
    const login = await admin('POST', '/api/session', { email: 'chef@ex.fr', password: 'motdepasse-long' });
    assert.equal(login.status, 200); assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
    for (const [n, e] of [['Alice', 'alice@ex.fr'], ['Bob', 'bob@ex.fr']]) assert.equal((await admin('POST', '/api/comptes', { name: n, email: e, password: 'motdepasse-long' })).body.admin, false);
    assert.equal((await admin('POST', '/api/comptes', { name: 'Double', email: 'alice@ex.fr', password: 'motdepasse-long' })).status, 409);
    await alice('POST', '/api/session', { email: 'alice@ex.fr', password: 'motdepasse-long' });
    await bob('POST', '/api/session', { email: 'bob@ex.fr', password: 'motdepasse-long' });
    assert.equal((await alice('GET', '/api/comptes')).status, 403);
    // Alice crée son espace : elle en est propriétaire, Bob ne le voit pas.
    const w = (await alice('POST', '/api/espaces', { name: 'Espace d\'Alice' })).body;
    assert.deepEqual((await alice('GET', '/api/espaces')).body.map((x) => [x.name, x.role]), [['Espace d\'Alice', 'proprietaire']]);
    assert.deepEqual((await bob('GET', '/api/espaces')).body, []);
    assert.equal((await bob('GET', `/api/espaces/${w.id}/tableau-de-bord`)).status, 404);
    assert.equal((await alice('GET', `/api/espaces/${legacy.id}/donnees`)).status, 404);
    assert.equal((await admin('GET', '/api/espaces')).body.length, 2, 'l\'administrateur voit tout');
    // Lecteur : consulte seulement.
    assert.equal((await alice('PUT', `/api/espaces/${w.id}/membres`, { email: 'bob@ex.fr', role: 'lecteur' })).status, 204);
    assert.equal((await bob('GET', `/api/espaces/${w.id}/donnees`)).status, 200);
    assert.equal((await bob('POST', `/api/espaces/${w.id}/taches`, { title: 'non' })).status, 403);
    // Membre : saisit et demande, mais n'autorise pas une action sensible.
    await alice('PUT', `/api/espaces/${w.id}/membres`, { email: 'bob@ex.fr', role: 'membre' });
    assert.equal((await bob('POST', `/api/espaces/${w.id}/taches`, { title: 'oui' })).status, 200);
    const pending = (await bob('POST', `/api/espaces/${w.id}/actions`, { type: 'webhook.envoyer', params: { url: 'http://10.0.0.1/x' } })).body;
    assert.equal(pending.status, 'en_attente');
    assert.equal((await bob('POST', `/api/espaces/${w.id}/actions/${pending.id}/approuver`)).status, 403);
    assert.equal((await bob('PATCH', `/api/espaces/${w.id}`, { autonomy: 'manuel' })).status, 403);
    assert.equal((await bob('PUT', `/api/espaces/${w.id}/membres`, { email: 'bob@ex.fr', role: 'proprietaire' })).status, 403);
    assert.equal((await bob('DELETE', `/api/espaces/${w.id}`)).status, 403);
    assert.equal((await alice('POST', `/api/espaces/${w.id}/actions/${pending.id}/refuser`)).body.status, 'refusee');
    // Garde-fous : dernier propriétaire, journal nominatif, déconnexion.
    assert.equal((await alice('PUT', `/api/espaces/${w.id}/membres`, { email: 'alice@ex.fr', role: 'lecteur' })).status, 400);
    const journal = (await alice('GET', `/api/espaces/${w.id}/journal`)).body;
    assert.ok(journal.entries.some((e) => e.actor === 'Alice' && e.event === 'action.refusee')); assert.equal(journal.integrity.ok, true);
    assert.equal((await bob('DELETE', '/api/session')).status, 204);
    assert.equal((await bob('GET', '/api/espaces')).status, 401);
    // Verrouillage après échecs répétés.
    for (let i = 0; i < 5; i += 1) await anon('POST', '/api/session', { email: 'alice@ex.fr', password: 'faux' });
    assert.equal((await anon('POST', '/api/session', { email: 'alice@ex.fr', password: 'motdepasse-long' })).status, 429);
  } finally { server.close(); }
});

test('canaux : format propre à chaque outil, envoi soumis à autorisation, URL masquée', async () => {
  const { k } = setup();
  const w = await k.createWorkspace({ name: 'Test' });
  const sent = []; const real = globalThis.fetch; globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('ok'); };
  try {
    const slack = k.hub.createChannel(w.id, { name: '#direction', type: 'slack', url: 'https://93.184.216.34/services/SECRET' });
    const discord = k.hub.createChannel(w.id, { name: 'équipe', type: 'discord', url: 'https://93.184.216.34/api/webhooks/SECRET' });
    assert.ok(!JSON.stringify(k.hub.listChannels(w.id)).includes('SECRET'), 'l\'URL complète n\'est jamais renvoyée');
    assert.throws(() => k.hub.createChannel(w.id, { name: 'x', type: 'slack', url: 'http://93.184.216.34/x' }), /https/);
    assert.throws(() => k.hub.createChannel(w.id, { name: 'x', type: 'fax', url: 'https://a.example/x' }), /Type/);
    const a = await k.execution.request(w, { type: 'message.envoyer', params: { channelId: slack.id, text: 'Bonjour', include: 'indicateurs' } });
    assert.equal(a.status, 'en_attente'); assert.equal(sent.length, 0);
    assert.equal((await k.execution.approve(w, a.id)).status, 'reussie');
    assert.match(sent[0].body.text, /^Bonjour\n• taches ouvertes : 0/);
    const b = await k.execution.request(w, { type: 'message.envoyer', params: { channelId: discord.id, text: 'Salut' } });
    await k.execution.approve(w, b.id); assert.deepEqual(sent[1].body, { content: 'Salut' });
    const c = await k.execution.request(w, { type: 'message.envoyer', params: { channelId: slack.id, text: 'Trop tard' } });
    k.hub.deleteChannel(w.id, slack.id);
    assert.equal((await k.execution.approve(w, c.id)).status, 'echouee', 'canal supprimé entre la demande et l\'autorisation');
  } finally { globalThis.fetch = real; }
});

test('entrée de données et calendrier : accès par jeton, régénération, révocation', async () => {
  const { k, config } = setup({ token: 'secret' });
  const server = createApp(config, k); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const w = await k.createWorkspace({ name: 'Test' }); const other = await k.createWorkspace({ name: 'Autre' });
    const { token } = k.hub.issueToken(w.id, 'entrant');
    assert.equal((await post(`/api/entrant/${'x'.repeat(32)}`, { type: 'tache', titre: 'non' })).status, 404);
    const r = await post(`/api/entrant/${token}`, { elements: [{ type: 'tache', titre: 'Rappeler; le client', echeance: d(-3) }, { type: 'operation', montant: -49.9, libelle: 'Abo', date: d(1) }, { type: 'note', titre: 'CR', contenu: 'texte' }] });
    assert.equal(r.status, 200, 'fonctionne sans le jeton global ni session'); assert.equal((await r.json()).recus, 3);
    assert.equal((await post(`/api/entrant/${token}`, { elements: [{ type: 'tache', titre: 'ok' }, { type: 'inconnu' }] })).status, 400);
    const data = k.data(w.id);
    assert.equal(data.tasks.length, 1, 'un lot invalide n\'est pas enregistré à moitié'); assert.equal(data.transactions[0].amount, -49.9); assert.equal(k.data(other.id).tasks.length, 0);
    assert.ok(k.audit.list(w.id).some((e) => e.event === 'entree.recue' && e.actor === 'entree-externe'));
    // Calendrier : jeton distinct, format iCalendar, lecture seule.
    assert.equal((await fetch(`${base}/api/calendrier/${token}.ics`)).status, 404, 'un jeton d\'entrée n\'ouvre pas le calendrier');
    const cal = k.hub.issueToken(w.id, 'calendrier').token;
    const ics = await fetch(`${base}/api/calendrier/${cal}.ics`);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    const text = await ics.text();
    assert.match(text, /BEGIN:VEVENT\r\n/); assert.ok(text.includes(String.raw`SUMMARY:Rappeler\; le client`), 'le point-virgule est échappé'); assert.match(text, new RegExp(`DTSTART;VALUE=DATE:${d(-3).replace(/-/g, '')}`));
    // Régénérer invalide l'ancienne adresse ; révoquer ferme l'accès.
    const next = k.hub.issueToken(w.id, 'entrant').token;
    assert.equal((await post(`/api/entrant/${token}`, { type: 'note', titre: 'vieux' })).status, 404);
    assert.equal((await post(`/api/entrant/${next}`, { type: 'note', titre: 'neuf' })).status, 200);
    k.hub.revokeToken(w.id, 'entrant');
    assert.equal((await post(`/api/entrant/${next}`, { type: 'note', titre: 'fermé' })).status, 404);
    assert.equal((await fetch(`${base}/api/espaces/${w.id}/acces`)).status, 401, 'la gestion des accès reste protégée');
  } finally { server.close(); }
});

test('Stripe : import en lecture seule, montants nets, sans doublon, devise respectée', async () => {
  const { k } = setup({ stripeKey: 'rk_test_x' });
  const w = await k.createWorkspace({ name: 'Test' });
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), auth: init.headers.authorization, method: init.method ?? 'GET' }); return Response.json({ has_more: false, data: [
    { id: 'txn_1', net: 9710, currency: 'eur', created: Math.floor(Date.now() / 1000) - 86400, type: 'charge', description: 'Commande 12' },
    { id: 'txn_2', net: -2500, currency: 'eur', created: Math.floor(Date.now() / 1000) - 86400, type: 'refund', description: null },
    { id: 'txn_3', net: 5000, currency: 'usd', created: Math.floor(Date.now() / 1000), type: 'charge' }] }); };
  try {
    const a = await k.execution.request(w, { type: 'stripe.importer', params: { days: 30 } });
    assert.equal(a.status, 'reussie'); assert.deepEqual([a.result.importees, a.result.autre_devise], [2, 1]);
    assert.deepEqual(k.data(w.id).transactions.map((t) => t.amount).sort((x, y) => x - y), [-25, 97.1]);
    assert.equal((await k.execution.request(w, { type: 'stripe.importer', params: {} })).result.deja_presentes, 2);
    assert.equal(k.data(w.id).transactions.length, 2);
    assert.ok(calls.every((c) => c.method === 'GET' && c.auth === 'Bearer rk_test_x' && c.url.startsWith('https://api.stripe.com/v1/balance_transactions')));
  } finally { globalThis.fetch = real; }
  const none = setup(); const w2 = await none.k.createWorkspace({ name: 'Sans clé' });
  assert.match((await none.k.execution.request(w2, { type: 'stripe.importer', params: {} })).error, /OMNIA_STRIPE_KEY/);
});

test('IA : plusieurs fournisseurs essayés dans l\'ordre, chacun avec ses réglages', async () => {
  const seen = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), auth: init.headers.authorization }); return String(url).includes('11434') ? new Response('en panne', { status: 500 }) : Response.json({ choices: [{ message: { content: 'réponse' } }] }); };
  try {
    const ai = createAI({ provider: 'ollama, mistral' }, { OMNIA_AI_MISTRAL_API_KEY: 'cle-mistral' });
    assert.equal(ai.provider, 'ollama → mistral');
    const r = await ai.complete({ system: 's', prompt: 'p' });
    assert.equal(r.provider, 'mistral'); assert.match(r.skipped[0], /ollama : .*500/);
    assert.equal(seen[0].auth, undefined, 'la clé d\'un fournisseur n\'est pas envoyée à un autre'); assert.equal(seen[1].auth, 'Bearer cle-mistral');
  } finally { globalThis.fetch = real; }
  assert.throws(() => createAI({ provider: 'ollama,inconnu' }), /inconnu/);
  assert.throws(() => createAI({ provider: 'ollama,mistral' }, {}), /OMNIA_AI_API_KEY|requis/);
  assert.equal(createAI({ provider: 'local' }).generative, false);
});
