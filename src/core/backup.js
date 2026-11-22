// Sauvegarde de toute l'instance : un seul fichier, chiffré par une phrase secrète (AES-256-GCM, clé dérivée
// par scrypt) et scellé par l'empreinte SHA-256 de son contenu. La restauration n'écrase jamais un travail :
// elle n'est acceptée que sur une instance vide ou restée intacte depuis son amorçage.
import crypto from 'node:crypto';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SKIPPED = new Set(['sessions']); // les sessions ouvertes ne se sauvegardent pas : on se reconnecte
const SEEDED = 'instance.amorcee';
const USED = 'instance.utilisee';
const SYSTEM = ['automatisation', 'omnia']; // ce que le système fait seul se refait : cela ne compte pas comme un travail
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const keyOf = (phrase, salt) => crypto.scryptSync(phrase, salt, 32, SCRYPT);

export function createBackup({ db, audit, fail, now }) {
  const tables = () => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
  const dump = () => Object.fromEntries(tables().filter((t) => !SKIPPED.has(t)).map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]));
  // Intacte : aucune donnée ; ou bien, depuis l'amorçage, rien d'autre que ce que le système a fait seul
  // (analyses, imports périodiques), que l'amorçage et ses automatisations savent refaire. Toute écriture venue
  // d'une personne ou d'une clé d'API, journalisée ou non, passe par `markUsed` et lève cet état.
  const pristine = () => {
    const seed = db.get('SELECT MAX(id) AS id FROM audit_log WHERE event = ?', SEEDED)?.id;
    if (!seed) return !db.get('SELECT 1 AS x FROM audit_log LIMIT 1') && tables().every((t) => !db.get(`SELECT 1 AS x FROM ${t} LIMIT 1`));
    return !db.get(`SELECT 1 AS x FROM audit_log WHERE id > ? AND actor NOT IN (${SYSTEM.map(() => '?').join(', ')}) LIMIT 1`, seed, ...SYSTEM);
  };
  const markUsed = () => { if (pristine() && db.get('SELECT 1 AS x FROM workspaces LIMIT 1')) audit.record({ event: USED, entity: 'instance', detail: {} }); };

  function seal(phrase) {
    if (typeof phrase !== 'string' || phrase.length < 12) fail('Phrase secrète requise : 12 caractères au moins');
    audit.record({ event: 'instance.sauvegardee', entity: 'instance', detail: {} });
    const plain = Buffer.from(JSON.stringify(dump()), 'utf8');
    const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(phrase, salt), iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      format: 'omnia-instance', version: 1, created_at: now(), kdf: 'scrypt', cipher: 'aes-256-gcm', sha256: sha(plain),
      salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64'),
    };
  }

  function open(payload, phrase) {
    if (payload?.format !== 'omnia-instance' || payload.version !== 1) fail('Ce fichier n\'est pas une sauvegarde d\'instance OMNIA reconnue');
    let plain;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(String(phrase ?? ''), Buffer.from(payload.salt, 'hex')), Buffer.from(payload.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
      plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
    } catch { fail('Phrase secrète incorrecte ou fichier altéré'); }
    if (sha(plain) !== payload.sha256) fail('Empreinte incorrecte : le fichier a été altéré');
    return JSON.parse(plain.toString('utf8'));
  }

  function restore(payload, phrase) {
    const rows = open(payload, phrase);
    if (!pristine()) fail('Restauration refusée : cette instance contient déjà du travail. Restaurez sur une instance vide ou tout juste amorcée.', 409);
    const known = new Set(tables());
    for (const table of Object.keys(rows)) if (!known.has(table)) fail(`Sauvegarde incompatible : table « ${table} » inconnue de cette version`);
    db.tx(() => {
      for (const table of known) db.run(`DELETE FROM ${table}`);
      for (const [table, list] of Object.entries(rows)) {
        const columns = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
        for (const row of list) {
          const keys = Object.keys(row);
          if (!keys.every((k) => columns.has(k))) fail(`Sauvegarde incompatible : colonne inconnue dans « ${table} »`);
          db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
        }
      }
      const integrity = audit.verify();
      if (!integrity.ok) fail('Sauvegarde refusée : son journal d\'audit n\'est pas intègre');
    });
    audit.record({ event: 'instance.restauree', entity: 'instance', detail: { sauvegarde_du: payload.created_at } });
    return { restauree: true, sauvegarde_du: payload.created_at, espaces: db.get('SELECT COUNT(*) AS n FROM workspaces').n };
  }

  return { seal, open, restore, dump, pristine, markUsed, markSeeded: (count) => audit.record({ event: SEEDED, entity: 'instance', detail: { espaces: count } }) };
}
