// Connecteurs externes : chaque connecteur déclare ce qu'il fait et sa sensibilité.
// Tout ce qui sort d'OMNIA vers l'extérieur est « sensible » et exige une autorisation.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise les formules à l'ouverture dans un tableur
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows, columns) => [columns.join(';'), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(';'))].join('\n');

const isPrivateAddress = (ip) => {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

export async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL invalide'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Seules les URL http(s) sont acceptées');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw new Error('Les adresses locales ou privées sont refusées pour les webhooks');
  return url;
}

export function createConnectors(config) {
  return {
    list: () => [
      { id: 'export-fichier', name: 'Export de fichiers (CSV)', sensitivity: 'interne', status: 'disponible', description: `Écrit dans ${config.exportDir}` },
      { id: 'email-brouillon', name: 'Brouillons d\'e-mail', sensitivity: 'interne', status: 'disponible', description: 'Prépare un message dans la Mémoire ; OMNIA n\'envoie rien.' },
      { id: 'webhook', name: 'Webhook sortant (HTTP POST)', sensitivity: 'sensible', status: 'disponible', description: 'Envoie des données à un service tiers (Zapier, n8n, Make, API interne…) après autorisation.' },
    ],
    exportCsv({ workspaceId, dataset, rows, columns }) {
      fs.mkdirSync(config.exportDir, { recursive: true });
      const file = path.join(config.exportDir, `espace${workspaceId}-${dataset}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
      fs.writeFileSync(file, toCsv(rows, columns), 'utf8');
      return { file, rows: rows.length };
    },
    async postWebhook({ url, payload }) {
      const target = await assertPublicUrl(url, { allowPrivate: config.allowPrivateWebhooks });
      const res = await fetch(target, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'OMNIA-Omega' },
        body: JSON.stringify(payload ?? {}), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const body = (await res.text()).slice(0, 500);
      if (!res.ok) throw new Error(`Le service distant a répondu HTTP ${res.status} : ${body.slice(0, 200)}`);
      return { status: res.status, response: body };
    },
  };
}
