// Concentrateur de connexions : plusieurs canaux sortants, des entrées depuis des outils tiers,
// un calendrier à abonnement et l'import de Stripe. Tout envoi sortant reste une action sensible.
import crypto from 'node:crypto';
import { now, today } from '../core/db.js';
import { assertPublicUrl } from './index.js';

export const CHANNEL_TYPES = {
  slack: { label: 'Slack', body: (text) => ({ text }) },
  discord: { label: 'Discord', body: (text) => ({ content: text.slice(0, 2000) }) },
  teams: { label: 'Microsoft Teams', body: (text) => ({ text }) },
  generique: { label: 'Webhook générique (Zapier, n8n, Make…)', body: (text, extra) => ({ source: 'OMNIA', message: text, ...extra }) },
};
export const TOKEN_PURPOSES = { entrant: 'Entrée de données', calendrier: 'Calendrier', api: 'Clé d\'API' };
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}/…`; } catch { return '…'; } };
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
// Une ligne iCalendar ne dépasse pas 75 octets : les suivantes commencent par une espace.
const fold = (line) => { const out = []; let rest = line; while (Buffer.byteLength(rest) > 74) { let n = 74; while (Buffer.byteLength(rest.slice(0, n)) > 74) n -= 1; out.push(rest.slice(0, n)); rest = ` ${rest.slice(n)}`; } out.push(rest); return out.join('\r\n'); };

export function createHub({ db, audit, config, fail, services }) {
  const need = (cond, message, status = 400) => { if (!cond) fail(message, status); };

  // ---------- Canaux sortants ----------
  const channelRow = (c) => ({ id: c.id, name: c.name, type: c.type, typeLabel: CHANNEL_TYPES[c.type]?.label ?? c.type, destination: mask(c.url), created_at: c.created_at });
  function createChannel(wsId, input) {
    const name = String(input.name ?? '').trim().slice(0, 80); need(name, 'Nom du canal requis');
    need(CHANNEL_TYPES[input.type], 'Type de canal invalide');
    let url; try { url = new URL(String(input.url ?? '')); } catch { need(false, 'URL invalide'); }
    need(url.protocol === 'https:' || config.allowPrivateWebhooks, 'L\'URL du canal doit être en https');
    const id = db.insert('INSERT INTO channels (workspace_id, name, type, url, created_at) VALUES (?,?,?,?,?)', wsId, name, input.type, url.toString(), now());
    audit.record({ workspaceId: wsId, event: 'canal.cree', entity: 'canal', entityId: id, detail: { name, type: input.type, destination: mask(url.toString()) } });
    return channelRow(db.get('SELECT * FROM channels WHERE id = ?', id));
  }
  async function sendToChannel(wsId, { channelId, text, extra }) {
    const c = db.get('SELECT * FROM channels WHERE id = ? AND workspace_id = ?', channelId, wsId);
    if (!c) throw new Error('Ce canal n\'existe plus');
    const target = await assertPublicUrl(c.url, { allowPrivate: config.allowPrivateWebhooks });
    const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'OMNIA-Omega' }, body: JSON.stringify(CHANNEL_TYPES[c.type].body(text, extra)), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const body = (await res.text()).slice(0, 300);
    if (!res.ok) throw new Error(`${CHANNEL_TYPES[c.type].label} a répondu HTTP ${res.status} : ${body.slice(0, 150)}`);
    return { canal: c.name, type: c.type, status: res.status };
  }

  // ---------- Jetons d'accès (entrée de données, calendrier) ----------
  function issueToken(wsId, purpose) {
    need(TOKEN_PURPOSES[purpose], 'Usage de jeton invalide');
    const token = crypto.randomBytes(24).toString('base64url');
    db.tx(() => {
      db.run('DELETE FROM access_tokens WHERE workspace_id = ? AND purpose = ?', wsId, purpose);
      db.run('INSERT INTO access_tokens (token_hash, workspace_id, purpose, created_at) VALUES (?,?,?,?)', sha(token), wsId, purpose, now());
    });
    audit.record({ workspaceId: wsId, event: 'acces.jeton_cree', entity: 'acces', detail: { purpose } });
    return { purpose, token }; // affiché une seule fois : seule son empreinte est conservée
  }
  function revokeToken(wsId, purpose) {
    need(db.run('DELETE FROM access_tokens WHERE workspace_id = ? AND purpose = ?', wsId, purpose).changes, 'Aucun accès actif', 404);
    audit.record({ workspaceId: wsId, event: 'acces.jeton_revoque', entity: 'acces', detail: { purpose } });
  }
  const resolveToken = (token, purpose) => db.get('SELECT workspace_id FROM access_tokens WHERE token_hash = ? AND purpose = ?', sha(String(token)), purpose)?.workspace_id ?? null;

  // ---------- Entrée de données depuis un outil tiers ----------
  const hits = new Map();
  function inbound(token, body) {
    const wsId = resolveToken(token, 'entrant'); need(wsId, 'Accès inconnu ou révoqué', 404);
    const minute = Math.floor(Date.now() / 60000); const h = hits.get(wsId);
    if (!h || h.minute !== minute) hits.set(wsId, { minute, n: 1 }); else { h.n += 1; need(h.n <= 60, 'Trop de requêtes : 60 par minute au maximum', 429); }
    const items = Array.isArray(body.elements) ? body.elements : [body];
    need(items.length && items.length <= 100, 'Entre 1 et 100 éléments par requête');
    const created = db.tx(() => items.map((it) => {
      if (it?.type === 'tache') return { type: 'tache', id: services.createTask(wsId, { title: it.titre, notes: it.notes, due_date: it.echeance, priority: it.priorite }).id };
      if (it?.type === 'operation') return { type: 'operation', id: services.createTransaction(wsId, { date: it.date ?? today(), amount: it.montant, label: it.libelle, category: it.categorie, counterparty: it.tiers }).id };
      if (it?.type === 'note') return { type: 'note', id: services.createDocument(wsId, { title: it.titre, content: it.contenu, kind: 'note' }).id };
      return fail('Chaque élément doit avoir un type : « tache », « operation » ou « note »');
    }));
    audit.record({ workspaceId: wsId, actor: 'entree-externe', event: 'entree.recue', entity: 'acces', detail: { elements: created.length, types: [...new Set(created.map((c) => c.type))] } });
    return { recus: created.length, elements: created };
  }

  // ---------- Calendrier (iCalendar) ----------
  function calendar(token) {
    const wsId = resolveToken(token, 'calendrier'); need(wsId, 'Accès inconnu ou révoqué', 404);
    const w = db.get('SELECT name FROM workspaces WHERE id = ?', wsId);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const day = (iso, plus = 0) => today(new Date(Date.parse(`${iso}T00:00:00Z`) + plus * 86400000)).replace(/-/g, '');
    const events = [
      ...db.all("SELECT id, title, due_date, status FROM tasks WHERE workspace_id = ? AND due_date IS NOT NULL AND status != 'fait'", wsId).map((t) => ({ uid: `tache-${t.id}`, date: t.due_date, summary: t.title })),
      ...db.all("SELECT id, name, deadline FROM projects WHERE workspace_id = ? AND deadline IS NOT NULL AND status = 'actif'", wsId).map((p) => ({ uid: `projet-${p.id}`, date: p.deadline, summary: `Échéance du projet : ${p.name}` })),
    ];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OMNIA Omega//FR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(`OMNIA — ${w?.name ?? ''}`)}`];
    for (const e of events) lines.push('BEGIN:VEVENT', `UID:${e.uid}-espace${wsId}@omnia`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(e.date)}`, `DTEND;VALUE=DATE:${day(e.date, 1)}`, `SUMMARY:${icsText(e.summary)}`, 'END:VEVENT');
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
  }

  // ---------- Stripe : import des mouvements de solde (lecture seule) ----------
  async function importStripe(ws, days = 30) {
    if (!config.stripeKey) throw new Error('Stripe n\'est pas configuré : définissez OMNIA_STRIPE_KEY (clé restreinte en lecture) au démarrage');
    const since = Math.floor(Date.now() / 1000) - days * 86400; const cur = ws.currency.toLowerCase();
    let imported = 0; let known = 0; let otherCurrency = 0; let after = ''; let pages = 0; let more = true;
    while (more && pages < 20) {
      const res = await fetch(`https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${since}${after ? `&starting_after=${after}` : ''}`, { headers: { authorization: `Bearer ${config.stripeKey}` }, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Stripe a répondu HTTP ${res.status} : ${String(data?.error?.message ?? '').slice(0, 200)}`);
      const rows = Array.isArray(data.data) ? data.data : [];
      db.tx(() => {
        for (const t of rows) {
          if (String(t.currency).toLowerCase() !== cur) { otherCurrency += 1; continue; }
          const externalId = `stripe:${t.id}`;
          if (db.get('SELECT id FROM transactions WHERE workspace_id = ? AND external_id = ?', ws.id, externalId)) { known += 1; continue; }
          const amount = ZERO_DECIMAL.has(cur) ? t.net : t.net / 100;
          if (!amount) continue;
          const created = services.createTransaction(ws.id, { date: today(new Date(t.created * 1000)), amount, label: String(t.description || t.type || 'Stripe').slice(0, 300), category: `stripe : ${t.type ?? 'mouvement'}`, counterparty: 'Stripe' });
          db.run('UPDATE transactions SET external_id = ? WHERE id = ?', externalId, created.id);
          imported += 1;
        }
      });
      more = Boolean(data.has_more) && rows.length > 0; after = rows.at(-1)?.id ?? ''; pages += 1;
    }
    return { importees: imported, deja_presentes: known, autre_devise: otherCurrency, jours: days, incomplet: more, note: 'Montants nets, frais Stripe déduits.' };
  }

  return {
    listChannels: (wsId) => db.all('SELECT * FROM channels WHERE workspace_id = ? ORDER BY id', wsId).map(channelRow),
    createChannel,
    deleteChannel(wsId, id) {
      need(db.run('DELETE FROM channels WHERE id = ? AND workspace_id = ?', id, wsId).changes, 'Canal introuvable', 404);
      audit.record({ workspaceId: wsId, event: 'canal.supprime', entity: 'canal', entityId: id, detail: {} });
    },
    sendToChannel,
    listTokens: (wsId) => db.all('SELECT purpose, created_at FROM access_tokens WHERE workspace_id = ?', wsId),
    issueToken, revokeToken, resolveToken, inbound, calendar, importStripe,
    stripeConfigured: () => Boolean(config.stripeKey),
  };
}
