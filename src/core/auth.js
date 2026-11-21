// Comptes utilisateurs et rôles. Tant qu'aucun compte n'existe, OMNIA reste en mode
// mono-utilisateur (accès local, ou jeton OMNIA_TOKEN). Dès le premier compte créé,
// chaque requête doit porter une session, et les droits se décident espace par espace.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { now } from './db.js';

export const ROLES = ['lecteur', 'membre', 'proprietaire'];
export const roleAtLeast = (role, needed) => ROLES.indexOf(role) >= ROLES.indexOf(needed);
// Porte le nom de la personne à l'origine de la requête jusqu'au journal d'audit.
export const requestContext = new AsyncLocalStorage();

const SESSION_DAYS = 7;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64, SCRYPT).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const given = crypto.scryptSync(password, salt, 64, SCRYPT);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
// Empreinte factice : la vérification coûte autant que le compte existe ou non.
const DUMMY = hashPassword('omnia-compte-inexistant');

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const need = (cond, message, status = 400) => { if (!cond) throw new AuthError(message, status); };

export function createAuth(db, audit) {
  const failures = new Map(); // clé → { count, until }
  const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, admin: Boolean(u.admin) });
  const normEmail = (v) => String(v ?? '').trim().toLowerCase();

  function validate({ name, email, password }) {
    const n = String(name ?? '').trim().slice(0, 80); const e = normEmail(email);
    need(n, 'Nom requis');
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200, 'Adresse e-mail invalide');
    need(typeof password === 'string' && password.length >= 10 && password.length <= 200, 'Le mot de passe doit contenir au moins 10 caractères');
    return { name: n, email: e, password };
  }

  return {
    enabled: () => db.get('SELECT COUNT(*) AS n FROM users').n > 0,
    publicUser,

    createUser(input, { admin = false } = {}) {
      const u = validate(input);
      need(!db.get('SELECT id FROM users WHERE email = ?', u.email), 'Un compte existe déjà avec cette adresse', 409);
      const id = db.insert('INSERT INTO users (name, email, password_hash, admin, created_at) VALUES (?,?,?,?,?)', u.name, u.email, hashPassword(u.password), admin ? 1 : 0, now());
      audit.record({ event: 'compte.cree', entity: 'compte', entityId: id, detail: { email: u.email, admin } });
      return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
    },
    listUsers: () => db.all('SELECT * FROM users ORDER BY id').map(publicUser),
    removeUser(id, actingUserId) {
      const u = db.get('SELECT * FROM users WHERE id = ?', id); need(u, 'Compte introuvable', 404);
      need(u.id !== actingUserId, 'Vous ne pouvez pas supprimer votre propre compte');
      const sole = db.all("SELECT workspace_id FROM memberships m WHERE user_id = ? AND role = 'proprietaire' AND (SELECT COUNT(*) FROM memberships o WHERE o.workspace_id = m.workspace_id AND o.role = 'proprietaire') = 1", id);
      need(!sole.length, 'Ce compte est le seul propriétaire d\'un espace : désignez d\'abord un autre propriétaire');
      db.tx(() => {
        db.run('DELETE FROM sessions WHERE user_id = ?', id);
        db.run('DELETE FROM memberships WHERE user_id = ?', id);
        db.run('DELETE FROM users WHERE id = ?', id);
      });
      audit.record({ event: 'compte.supprime', entity: 'compte', entityId: id, detail: { email: u.email } });
    },

    login(email, password, clientKey) {
      const e = normEmail(email); const key = `${e}|${clientKey}`; const f = failures.get(key);
      need(!(f && f.until > Date.now()), 'Trop de tentatives. Réessayez dans quelques minutes.', 429);
      const u = db.get('SELECT * FROM users WHERE email = ?', e);
      const ok = verifyPassword(String(password ?? ''), u?.password_hash ?? DUMMY) && Boolean(u);
      if (!ok) {
        const count = (f?.count ?? 0) + 1;
        failures.set(key, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
        if (failures.size > 10000) failures.clear();
        audit.record({ actor: 'anonyme', event: 'session.echec', entity: 'compte', detail: { email: e.slice(0, 200) } });
        throw new AuthError('Adresse e-mail ou mot de passe incorrect', 401);
      }
      failures.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      db.run('DELETE FROM sessions WHERE expires_at < ?', now());
      db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)', sha(token), u.id, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), now());
      audit.record({ actor: u.name, event: 'session.ouverte', entity: 'compte', entityId: u.id, detail: {} });
      return { token, user: publicUser(u), maxAge: SESSION_DAYS * 86400 };
    },
    logout(token) { if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token)); },
    userForToken(token) {
      if (!token) return null;
      const s = db.get('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', sha(token), now());
      return s ? publicUser(db.get('SELECT * FROM users WHERE id = ?', s.user_id)) : null;
    },

    // Rôle effectif d'une personne dans un espace ; un administrateur est propriétaire partout.
    roleIn(user, workspaceId) {
      if (user.admin) return 'proprietaire';
      return db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, user.id)?.role ?? null;
    },
    workspaceIds: (user) => db.all('SELECT workspace_id FROM memberships WHERE user_id = ?', user.id).map((m) => m.workspace_id),
    members: (workspaceId) => db.all('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name', workspaceId),
    setMember(workspaceId, { email, userId, role }) {
      need(ROLES.includes(role), 'Rôle invalide');
      const u = userId ? db.get('SELECT * FROM users WHERE id = ?', userId) : db.get('SELECT * FROM users WHERE email = ?', normEmail(email));
      need(u, 'Aucun compte ne correspond à cette adresse', 404);
      const owners = db.all("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'proprietaire'", workspaceId);
      need(!(role !== 'proprietaire' && owners.length === 1 && owners[0].user_id === u.id), 'Un espace doit garder au moins un propriétaire');
      db.run('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?,?,?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role', workspaceId, u.id, role);
      audit.record({ workspaceId, event: 'membre.defini', entity: 'compte', entityId: u.id, detail: { email: u.email, role } });
    },
    removeMember(workspaceId, userId) {
      const m = db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId); need(m, 'Membre introuvable', 404);
      const owners = db.get("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'proprietaire'", workspaceId).n;
      need(!(m.role === 'proprietaire' && owners === 1), 'Un espace doit garder au moins un propriétaire');
      db.run('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
      audit.record({ workspaceId, event: 'membre.retire', entity: 'compte', entityId: userId, detail: {} });
    },
  };
}
