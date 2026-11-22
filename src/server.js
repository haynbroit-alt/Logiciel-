#!/usr/bin/env node
// Serveur HTTP d'OMNIA Ω : API JSON + tableau de bord. Aucune dépendance externe.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, isLoopback } from './config.js';
import { openDb } from './core/db.js';
import { createAI } from './ai/index.js';
import { createKernel, OmniaError } from './core/kernel.js';
import { AuthError, roleAtLeast, requestContext } from './core/auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 5 * 1024 * 1024;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new OmniaError('Requête trop volumineuse', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(new OmniaError('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

// Table de routage : [méthode, motif, gestionnaire(kernel, params, corps, requête)].
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new OmniaError('Identifiant invalide'); return n; };
// Rôle minimal exigé dans un espace lorsque les comptes sont activés.
function requiredRole(method, pathname) {
  if (/\/(membres|canaux|acces)(\/\w+)?$/.test(pathname) && !(method === 'GET' && /\/canaux$/.test(pathname))) return 'proprietaire';
  if (/^\/api\/espaces\/\d+$/.test(pathname) && method !== 'GET') return 'proprietaire';
  if (/\/actions\/\d+\/(approuver|refuser)$/.test(pathname)) return 'proprietaire';
  if (/\/cinema\/projets\/\d+\/(valider|rouvrir)$/.test(pathname)) return 'proprietaire'; // les validations d'étape sont des décisions de propriétaire
  if (/\/automatisations(\/\d+)?$/.test(pathname) && method !== 'GET') return 'proprietaire';
  return method === 'GET' ? 'lecteur' : 'membre';
}
const studioWs = (k, p) => { const w = k.workspace(p.ws); if (!w.modules.includes('studio')) throw new OmniaError('Le module Studio n\'est pas activé pour cet espace', 409); return w.id; };
const cinemaWs = (k, p) => { const w = k.workspace(p.ws); if (!w.modules.includes('cinema')) throw new OmniaError('Le module Studio de cinéma n\'est pas activé pour cet espace', 409); return w.id; };
const own = (k, c, w) => { if (c.user) k.auth.setMember(w.id, { userId: c.user.id, role: 'proprietaire' }); return w; };

const ROUTES = [
  ['GET', '/api/etat', (k, p, b, c) => ({ comptes: c.accounts, utilisateur: c.user }), 'public'],
  ['POST', '/api/session', (k, p, b, c) => {
    if (!c.accounts) throw new OmniaError('Les comptes ne sont pas activés');
    const s = k.auth.login(b.email, b.password, c.clientKey);
    c.headers['set-cookie'] = c.cookie(s.token, s.maxAge);
    return { utilisateur: s.user };
  }, 'public'],
  ['DELETE', '/api/session', (k, p, b, c) => { k.auth.logout(c.sessionToken); c.headers['set-cookie'] = c.cookie('', 0); }, 'public'],
  ['GET', '/api/comptes', (k) => k.auth.listUsers(), 'admin'],
  // Le premier compte créé devient administrateur et active le régime des comptes.
  ['POST', '/api/comptes', (k, p, b, c) => k.auth.createUser(b, { admin: !c.accounts || b.admin === true }), 'admin'],
  ['DELETE', '/api/comptes/:id', (k, p, b, c) => k.auth.removeUser(p.id, c.user?.id), 'admin'],
  // Accès par jeton, sans session : entrée de données depuis un outil tiers et abonnement calendrier.
  ['POST', '/api/entrant/:jeton', (k, p, b) => k.hub.inbound(p.jeton, b), 'public'],
  ['GET', '/api/calendrier/:jeton', (k, p) => ({ __raw: { type: 'text/calendar; charset=utf-8', body: k.hub.calendar(p.jeton) } }), 'public'],
  ['GET', '/api/espaces/:ws/canaux', (k, p) => k.hub.listChannels(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/canaux', (k, p, b) => k.hub.createChannel(k.workspace(p.ws).id, b)],
  ['DELETE', '/api/espaces/:ws/canaux/:id', (k, p) => k.hub.deleteChannel(k.workspace(p.ws).id, p.id)],
  ['GET', '/api/espaces/:ws/acces', (k, p) => k.hub.listTokens(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/acces', (k, p, b) => k.hub.issueToken(k.workspace(p.ws).id, b.usage)],
  ['POST', '/api/espaces/:ws/acces/revoquer', (k, p, b) => k.hub.revokeToken(k.workspace(p.ws).id, b.usage)],
  ['GET', '/api/espaces/:ws/studio', (k, p) => k.studio.overview(studioWs(k, p))],
  ['POST', '/api/espaces/:ws/studio/projets', (k, p, b) => k.studio.createProject(studioWs(k, p), b)],
  ['PATCH', '/api/espaces/:ws/studio/projets/:id', (k, p, b) => k.studio.updateProject(studioWs(k, p), p.id, b)],
  ['DELETE', '/api/espaces/:ws/studio/projets/:id', (k, p) => k.studio.remove(studioWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/studio/projets/:id/preuves', (k, p, b) => k.studio.addEvidence(studioWs(k, p), p.id, b)],
  ['DELETE', '/api/espaces/:ws/studio/preuves/:id', (k, p) => k.studio.removeEvidence(studioWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/studio/projets/:id/avancer', (k, p) => k.studio.advance(studioWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/studio/projets/:id/encaissements', (k, p, b) => k.studio.recordSale(studioWs(k, p), p.id, b)],
  ['POST', '/api/espaces/:ws/studio/projets/:id/generer', (k, p, b) => k.generateForStudio(studioWs(k, p), p.id, b.template)],
  ['GET', '/api/espaces/:ws/cinema', (k, p) => ({ projects: k.cinema.list(cinemaWs(k, p)), reference: k.cinema.reference, production: k.renderer.info(), formats: k.renderer.formats })],
  ['POST', '/api/espaces/:ws/cinema/projets', (k, p, b) => k.cinema.createProject(cinemaWs(k, p), b)],
  ['GET', '/api/espaces/:ws/cinema/projets/:id', (k, p) => ({ ...k.cinema.get(cinemaWs(k, p), p.id, { frames: true }), dossier_apports: `${k.renderer.dirOf(p.ws, p.id)}/apports` })],
  ['PATCH', '/api/espaces/:ws/cinema/projets/:id', (k, p, b) => k.cinema.updateProject(cinemaWs(k, p), p.id, b)],
  ['DELETE', '/api/espaces/:ws/cinema/projets/:id', (k, p) => k.cinema.remove(cinemaWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/script', (k, p) => k.cinema.writeScript(cinemaWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/plans', (k, p, b) => k.cinema.saveShot(cinemaWs(k, p), p.id, null, b)],
  ['PATCH', '/api/espaces/:ws/cinema/projets/:id/plans/:sid', (k, p, b) => k.cinema.saveShot(cinemaWs(k, p), p.id, p.sid, b)],
  ['DELETE', '/api/espaces/:ws/cinema/projets/:id/plans/:sid', (k, p) => k.cinema.removeShot(cinemaWs(k, p), p.id, p.sid)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/bible', (k, p, b) => k.cinema.saveBible(cinemaWs(k, p), p.id, null, b)],
  ['PATCH', '/api/espaces/:ws/cinema/projets/:id/bible/:sid', (k, p, b) => k.cinema.saveBible(cinemaWs(k, p), p.id, p.sid, b)],
  ['DELETE', '/api/espaces/:ws/cinema/projets/:id/bible/:sid', (k, p) => k.cinema.removeBible(cinemaWs(k, p), p.id, p.sid)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/valider', (k, p, b, c) => k.cinema.approve(cinemaWs(k, p), p.id, b.etape, c.user?.name ?? 'utilisateur')],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/rouvrir', (k, p, b) => k.cinema.reopen(cinemaWs(k, p), p.id, b.etape)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/tourner', (k, p) => k.renderer.shoot(cinemaWs(k, p), p.id)],
  ['POST', '/api/espaces/:ws/cinema/projets/:id/assembler', (k, p, b) => k.renderer.assemble(cinemaWs(k, p), p.id, b.type)],
  ['GET', '/api/espaces/:ws/cinema/projets/:id/exports/:sid/fichier', (k, p) => ({ __file: k.renderer.exportFile(cinemaWs(k, p), p.id, p.sid) })],
  // Sauvegarde de toute l'instance : réservée aux administrateurs (ou au détenteur du jeton, sans comptes).
  ['POST', '/api/instance/sauvegarde', (k, p, b) => k.backup.seal(b.phrase), 'admin'],
  ['POST', '/api/instance/restauration', (k, p, b) => k.backup.restore(b.sauvegarde, b.phrase), 'admin'],
  ['GET', '/api/meta', (k) => k.meta()],
  ['GET', '/api/noyau', (k) => k.describe()],
  ['GET', '/api/espaces', (k, p, b, c) => {
    const all = k.listWorkspaces();
    if (!c.user) return all;
    const mine = new Set(k.auth.workspaceIds(c.user));
    return all.filter((w) => c.user.admin || mine.has(w.id)).map((w) => ({ ...w, role: k.auth.roleIn(c.user, w.id) }));
  }],
  // Coordination : uniquement les espaces auxquels la personne a droit (tous sans comptes ou pour un administrateur).
  ['GET', '/api/coordination', (k, p, b, c) => k.coordination(k.listWorkspaces().filter((w) => !c.user || c.user.admin || k.auth.roleIn(c.user, w.id)).map((w) => w.id))],
  ['POST', '/api/espaces', async (k, p, b, c) => own(k, c, await k.createWorkspace(b))],
  ['POST', '/api/espaces/import', (k, p, b, c) => own(k, c, k.importWorkspace(b))],
  ['GET', '/api/espaces/:ws/membres', (k, p) => k.auth.members(k.workspace(p.ws).id)],
  ['PUT', '/api/espaces/:ws/membres', (k, p, b) => k.auth.setMember(k.workspace(p.ws).id, { email: b.email, role: b.role })],
  ['DELETE', '/api/espaces/:ws/membres/:id', (k, p) => k.auth.removeMember(k.workspace(p.ws).id, p.id)],
  ['GET', '/api/espaces/:ws', (k, p) => k.workspace(p.ws)],
  ['GET', '/api/espaces/:ws/export', (k, p) => k.exportWorkspace(p.ws)],
  ['PATCH', '/api/espaces/:ws', (k, p, b) => k.updateWorkspace(p.ws, b)],
  ['DELETE', '/api/espaces/:ws', (k, p) => k.deleteWorkspace(p.ws)],
  ['GET', '/api/espaces/:ws/tableau-de-bord', (k, p) => k.dashboard(p.ws)],
  ['GET', '/api/espaces/:ws/donnees', (k, p) => k.data(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/analyse', (k, p) => k.runAnalysis(p.ws)],
  ['POST', '/api/espaces/:ws/assistant', (k, p, b) => k.ask(p.ws, b.question)],
  ['POST', '/api/espaces/:ws/projets', (k, p, b) => k.createProject(k.workspace(p.ws).id, b)],
  ['PATCH', '/api/espaces/:ws/projets/:id', (k, p, b) => k.updateProject(k.workspace(p.ws).id, p.id, b)],
  ['DELETE', '/api/espaces/:ws/projets/:id', (k, p) => k.deleteProject(k.workspace(p.ws).id, p.id)],
  ['POST', '/api/espaces/:ws/taches', (k, p, b) => k.createTask(k.workspace(p.ws).id, b)],
  ['PATCH', '/api/espaces/:ws/taches/:id', (k, p, b) => k.updateTask(k.workspace(p.ws).id, p.id, b)],
  ['DELETE', '/api/espaces/:ws/taches/:id', (k, p) => k.deleteTask(k.workspace(p.ws).id, p.id)],
  ['POST', '/api/espaces/:ws/taches-de-demarrage', (k, p, b) => k.addStarterTasks(p.ws, b.module)],
  ['POST', '/api/espaces/:ws/operations', (k, p, b) => k.createTransaction(k.workspace(p.ws).id, b)],
  ['POST', '/api/espaces/:ws/operations/import', (k, p, b) => k.importTransactions(k.workspace(p.ws).id, b.csv)],
  ['DELETE', '/api/espaces/:ws/operations/:id', (k, p) => k.deleteTransaction(k.workspace(p.ws).id, p.id)],
  ['POST', '/api/espaces/:ws/documents', (k, p, b) => k.createDocument(k.workspace(p.ws).id, b)],
  ['POST', '/api/espaces/:ws/documents/generer', (k, p, b) => k.generate(k.workspace(p.ws).id, b.template, b.brief)],
  ['DELETE', '/api/espaces/:ws/documents/:id', (k, p) => k.deleteDocument(k.workspace(p.ws).id, p.id)],
  // Partage explicite d'un document avec l'espace central (membre de l'espace d'origine) ; lecture depuis l'espace central.
  ['PUT', '/api/espaces/:ws/documents/:id/partage', (k, p, b) => k.shareDocument(k.workspace(p.ws).id, p.id, b.partage === true)],
  ['GET', '/api/espaces/:ws/partages', (k, p) => k.sharedDocuments(k.workspace(p.ws).id)],
  ['GET', '/api/espaces/:ws/recommandations', (k, p) => k.listRecommendations(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/recommandations/:id/accepter', (k, p, b) => k.acceptRecommendation(p.ws, p.id, b.option)],
  ['POST', '/api/espaces/:ws/recommandations/:id/rejeter', (k, p) => k.rejectRecommendation(k.workspace(p.ws).id, p.id)],
  ['POST', '/api/espaces/:ws/constats/:id/ignorer', (k, p) => k.dismissInsight(k.workspace(p.ws).id, p.id)],
  ['GET', '/api/espaces/:ws/actions', (k, p) => k.execution.list(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/actions', (k, p, b) => k.execution.request(k.workspace(p.ws), { type: b.type, params: b.params, requestedBy: 'utilisateur' })],
  ['POST', '/api/espaces/:ws/actions/:id/approuver', (k, p) => k.execution.approve(k.workspace(p.ws), p.id)],
  ['POST', '/api/espaces/:ws/actions/:id/refuser', (k, p) => k.execution.reject(k.workspace(p.ws), p.id)],
  ['GET', '/api/espaces/:ws/automatisations', (k, p) => k.listAutomations(k.workspace(p.ws).id)],
  ['POST', '/api/espaces/:ws/automatisations', (k, p, b) => k.createAutomation(p.ws, b)],
  ['PATCH', '/api/espaces/:ws/automatisations/:id', (k, p, b) => k.updateAutomation(k.workspace(p.ws).id, p.id, b)],
  ['DELETE', '/api/espaces/:ws/automatisations/:id', (k, p) => k.deleteAutomation(k.workspace(p.ws).id, p.id)],
  ['GET', '/api/espaces/:ws/journal', (k, p) => ({ entries: k.audit.list(k.workspace(p.ws).id), integrity: k.audit.verify() })],
].map(([method, pattern, handler, access]) => {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return n === 'jeton' ? '([A-Za-z0-9_-]{20,80})(?:\\.ics)?' : '(\\d+)'; })}$`);
  return { method, regex, names, handler, access };
});

export function createApp(config, kernel) {
  const tokenOk = (req) => {
    if (!config.token) return true;
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(config.token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(payload);
  };

  const sessionToken = (req) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([n]) => n === 'omnia_session')?.[1] ?? '';
  const cookie = (token, maxAge) => `omnia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  async function handleApi(req, res, url) {
    // Deux régimes : sans compte, accès local ou par jeton ; avec comptes, session et rôles.
    const accounts = kernel.auth.enabled();
    const user = accounts ? kernel.auth.userForToken(sessionToken(req)) : null;
    // Clé d'API d'un espace : un logiciel tiers s'adresse au noyau avec les droits d'un membre de cet
    // espace, et de lui seul. Il ne peut donc ni autoriser une action sensible, ni toucher aux réglages.
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const apiWs = !user && /^[A-Za-z0-9_-]{20,80}$/.test(bearer) ? kernel.hub.resolveToken(bearer, 'api') : null;
    const byAccessToken = /^\/api\/(entrant|calendrier)\//.test(url.pathname); // ces routes portent leur propre jeton
    if (!accounts && !byAccessToken && !apiWs && !tokenOk(req)) return send(res, 401, { error: 'Jeton d\'accès requis' });
    if (req.method !== 'GET') {
      // Protection CSRF : JSON obligatoire, et l'origine, si le navigateur en envoie une, doit être la nôtre.
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Content-Type application/json requis' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origine refusée' });
    }
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.regex);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, n === 'jeton' ? m[i + 1] : id(m[i + 1])]));
      if (apiWs) {
        const scoped = params.ws === apiWs || (!params.ws && ['/api/meta', '/api/noyau'].includes(url.pathname));
        if (!scoped) return send(res, 403, { error: 'Cette clé d\'API ne donne accès qu\'à son espace' });
        const needed = params.ws ? requiredRole(req.method, url.pathname) : 'lecteur';
        if (!roleAtLeast('membre', needed)) return send(res, 403, { error: `Une clé d'API agit comme « membre » : rôle « ${needed} » requis pour cette action` });
      } else if (accounts) {
        if (r.access !== 'public' && !user) return send(res, 401, { error: 'Connexion requise', comptes: true });
        if (r.access === 'admin' && !user.admin) return send(res, 403, { error: 'Réservé aux administrateurs' });
        if (params.ws) {
          const role = kernel.auth.roleIn(user, params.ws);
          if (!role) return send(res, 404, { error: 'Espace introuvable' }); // ne révèle pas l'existence d'un espace
          const needed = requiredRole(req.method, url.pathname);
          if (!roleAtLeast(role, needed)) return send(res, 403, { error: `Votre rôle (${role}) ne permet pas cette action : rôle « ${needed} » requis` });
        }
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const ctx = { accounts, user, headers: {}, sessionToken: sessionToken(req), clientKey: req.socket.remoteAddress ?? '', cookie };
      const out = await requestContext.run({ actor: apiWs ? 'api' : user?.name }, () => r.handler(kernel, params, body, ctx));
      // Les événements nés de cette requête sont traités ensuite, sans faire attendre la réponse.
      if (req.method !== 'GET') kernel.processEvents().catch((e) => console.error('[omnia] événements :', e.message));
      if (out?.__file) {
        // Lecture vidéo : les requêtes partielles permettent au lecteur d'avancer et de reculer dans le film.
        const size = fs.statSync(out.__file.path).size; const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        const head = { 'content-type': out.__file.type, 'accept-ranges': 'bytes', 'content-disposition': `inline; filename="${out.__file.name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS };
        if (m && (m[1] || m[2])) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY_HEADERS }); return res.end(); }
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
          return fs.createReadStream(out.__file.path, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...head, 'content-length': size });
        return fs.createReadStream(out.__file.path).pipe(res);
      }
      if (out?.__raw) { res.writeHead(200, { 'content-type': out.__raw.type, 'cache-control': 'no-store', ...SECURITY_HEADERS }); return res.end(out.__raw.body); }
      return send(res, out === undefined ? 204 : 200, out, ctx.headers);
    }
    return send(res, 404, { error: 'Ressource introuvable' });
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)] || !fs.existsSync(file)) return send(res, 404, { error: 'Introuvable' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    return fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      // Protection contre le DNS rebinding : en écoute locale, seul un nom d'hôte local est accepté.
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (isLoopback(config.host) && !isLoopback(hostName)) return send(res, 403, { error: 'Hôte refusé' });
      const url = new URL(req.url, 'http://omnia.local');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return handleStatic(req, res, url);
    } catch (e) {
      if (e instanceof OmniaError || e instanceof AuthError) return send(res, e.status, { error: e.message });
      if (e instanceof URIError || e instanceof TypeError && /Invalid URL/.test(e.message)) return send(res, 400, { error: 'Requête invalide' });
      console.error('[omnia] erreur interne :', e);
      return send(res, 500, { error: 'Erreur interne' });
    }
  });
}

// Modules externes : chaque fichier .js ou .mjs du dossier de modules exporte par défaut un module.
// C'est du code exécuté avec les droits d'OMNIA : n'y placez que des modules de confiance.
export async function loadExternalModules(kernel, dir) {
  if (!fs.existsSync(dir)) return [];
  const loaded = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).sort()) {
    try { const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default; loaded.push(kernel.registerModule(mod, 'externe').id); }
    catch (e) { kernel.registry.reportError(file, e.message); console.error(`[omnia] module « ${file} » ignoré : ${e.message}`); }
  }
  return loaded;
}

// Amorçage : sur une base sans aucun espace, crée ceux d'un fichier de sauvegardes OMNIA (un tableau).
// Sert aux hébergements dont le disque ne survit pas à un redémarrage ; ne touche jamais une base déjà peuplée.
export function seedWorkspaces(kernel, file) {
  if (!file || kernel.listWorkspaces().length) return 0;
  const payloads = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payloads)) throw new Error('Fichier d\'amorçage invalide : un tableau de sauvegardes est attendu');
  for (const payload of payloads) kernel.importWorkspace(payload);
  kernel.backup.markSeeded(payloads.length); // tant que rien d'autre n'arrive, l'instance reste restaurable
  return payloads.length;
}

export async function start(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const kernel = createKernel({ db, ai: createAI(config.ai, process.env), config });
  if (!isLoopback(config.host) && !config.token && !kernel.auth.enabled()) {
    db.close();
    throw new Error('Refus de démarrer : OMNIA_HOST expose le serveur au réseau sans protection. Définissez OMNIA_TOKEN, ou créez d\'abord un compte en accès local.');
  }
  const external = await loadExternalModules(kernel, config.modulesDir);
  const seeded = seedWorkspaces(kernel, config.seed);
  if (seeded) console.log(`[omnia] amorçage : ${seeded} espace(s) créé(s) depuis ${config.seed}`);
  const server = createApp(config, kernel);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await kernel.tick(); } catch (e) { console.error('[omnia] ordonnanceur :', e.message); } finally { busy = false; }
  }, config.schedulerSeconds * 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); db.close(); });
  return new Promise((resolve) => server.listen(config.port, config.host, () => resolve({ server, kernel, config, external, port: server.address().port })));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then(({ config, kernel, port, external }) => {
    if (external.length) console.log(`Modules externes chargés : ${external.join(', ')}`);
    console.log(`OMNIA Ω — http://${isLoopback(config.host) ? 'localhost' : config.host}:${port}`);
    console.log(`IA : ${kernel.ai.generative ? `${kernel.ai.provider} (${kernel.ai.model})` : 'mode local, sans IA générative'} · données : ${config.dbPath}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
