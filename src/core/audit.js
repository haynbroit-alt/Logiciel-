// Journal d'audit en chaîne de hachage : chaque entrée scelle la précédente,
// toute modification a posteriori devient détectable (traçabilité des décisions et actions).
import crypto from 'node:crypto';
import { now } from './db.js';
import { requestContext } from './auth.js';

const digest = (e) => crypto.createHash('sha256')
  .update([e.prev_hash, e.ts, e.workspace_id ?? '', e.actor, e.event, e.entity, e.entity_id ?? '', e.detail].join('|'))
  .digest('hex');

export function createAudit(db) {
  return {
    record({ workspaceId = null, actor = 'utilisateur', event, entity = '', entityId = null, detail = {} }) {
      // Avec des comptes, « utilisateur » devient le nom de la personne connectée.
      if (actor === 'utilisateur') actor = requestContext.getStore()?.actor ?? actor;
      const last = db.get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
      const e = {
        workspace_id: workspaceId, ts: now(), actor, event, entity, entity_id: entityId,
        detail: JSON.stringify(detail), prev_hash: last?.hash ?? 'genesis',
      };
      e.hash = digest(e);
      db.run(
        'INSERT INTO audit_log (workspace_id, ts, actor, event, entity, entity_id, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
        e.workspace_id, e.ts, e.actor, e.event, e.entity, e.entity_id, e.detail, e.prev_hash, e.hash,
      );
    },
    list(workspaceId, limit = 200) {
      return db.all('SELECT * FROM audit_log WHERE workspace_id IS ? OR workspace_id IS NULL ORDER BY id DESC LIMIT ?', workspaceId, limit);
    },
    // Vérifie l'intégrité de toute la chaîne. Retourne la première entrée altérée le cas échéant.
    verify() {
      let prev = 'genesis';
      const rows = db.all('SELECT * FROM audit_log ORDER BY id ASC');
      for (const r of rows) {
        if (r.prev_hash !== prev || digest(r) !== r.hash) return { ok: false, entries: rows.length, brokenAt: r.id };
        prev = r.hash;
      }
      return { ok: true, entries: rows.length };
    },
  };
}
