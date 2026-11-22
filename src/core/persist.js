// Persistance : la sauvegarde chiffrée de l'instance (backup.js) est poussée dans un dépôt GitHub privé, et restaurée
// au démarrage quand la base locale est vide ou tout juste amorcée. Sert aux hébergements dont le disque s'efface.
// Ne jamais écraser une sauvegarde qu'on n'a pas su lire : au moindre doute, les envois sont suspendus et le disent.
import crypto from 'node:crypto';

const SAVED = 'instance.sauvegardee';

export function createPersistence({ kernel, config, log = console }) {
  const { repo, token, phrase, path: file = 'omnia/instance.json', api = 'https://api.github.com', minutes = 5 } = config.persistence ?? {};
  const state = { configured: Boolean(repo && token && phrase), depot: repo || null, last_push: null, last_error: null, restored_from: null, blocked: null, pushes: 0 };
  const url = `${api}/repos/${repo}/contents/${file}`;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'omnia' };
  const signal = () => AbortSignal.timeout(30000);
  let sha = null; let lastHash = null;
  // Empreinte du contenu, sans les lignes que l'envoi lui-même ajoute au journal : rien de neuf, rien à envoyer.
  const fingerprint = () => {
    const d = kernel.backup.dump(); d.audit_log = d.audit_log.filter((e) => e.event !== SAVED);
    return crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex');
  };
  const block = (why) => { state.blocked = why; state.last_error = why; log.error(`[omnia] persistance suspendue : ${why}`); };

  async function load() {
    const res = await fetch(url, { headers, signal: signal() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub a répondu HTTP ${res.status} à la lecture de la sauvegarde`);
    const meta = await res.json(); sha = meta.sha;
    let text = meta.content ? Buffer.from(meta.content, 'base64').toString('utf8') : '';
    if (!text) { // au-delà d'un mégaoctet, GitHub ne renvoie le contenu que sur demande explicite
      const raw = await fetch(url, { headers: { ...headers, accept: 'application/vnd.github.raw+json' }, signal: signal() });
      if (!raw.ok) throw new Error(`GitHub a répondu HTTP ${raw.status} au téléchargement de la sauvegarde`);
      text = await raw.text();
    }
    return JSON.parse(text);
  }

  // Au démarrage, avant l'amorçage. Retourne vrai si l'instance a été restaurée.
  async function restoreAtStart() {
    if (!state.configured) return false;
    let payload;
    try { payload = await load(); } catch (e) { block(`sauvegarde illisible au démarrage (${e.message}) : rien ne sera envoyé, pour ne pas l'écraser`); return false; }
    if (!payload) return false; // première mise en service : rien à restaurer
    if (!kernel.backup.pristine()) { log.log('[omnia] persistance : la base locale porte déjà du travail, elle est conservée'); return false; }
    try { kernel.backup.restore(payload, phrase); } catch (e) { block(`restauration impossible (${e.message}) : rien ne sera envoyé, pour ne pas écraser la sauvegarde`); return false; }
    state.restored_from = payload.created_at; lastHash = fingerprint();
    log.log(`[omnia] persistance : instance restaurée depuis la sauvegarde du ${payload.created_at}`);
    return true;
  }

  async function push(force = false) {
    if (!state.configured || state.blocked) return false;
    if (!force && fingerprint() === lastHash) return false;
    const payload = kernel.backup.seal(phrase);
    const body = { message: `Sauvegarde OMNIA du ${payload.created_at}`, content: Buffer.from(JSON.stringify(payload)).toString('base64'), ...(sha ? { sha } : {}) };
    const res = await fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal() });
    if (!res.ok) {
      if ([409, 422].includes(res.status)) block('la sauvegarde distante a changé ailleurs : envois suspendus, pour ne rien écraser');
      else state.last_error = `GitHub a refusé la sauvegarde : HTTP ${res.status}`;
      throw new Error(state.last_error);
    }
    sha = (await res.json()).content.sha; lastHash = fingerprint();
    Object.assign(state, { last_push: payload.created_at, last_error: null, pushes: state.pushes + 1 });
    return true;
  }

  function schedule() {
    if (!state.configured) return null;
    const timer = setInterval(() => push().catch((e) => log.error(`[omnia] persistance : ${e.message}`)), Math.max(1, minutes) * 60000);
    timer.unref();
    return timer;
  }

  return { restoreAtStart, push, schedule, status: () => ({ ...state }) };
}
