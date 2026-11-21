// Import de relevés : CSV avec « ; », « , » ou tabulation, en-têtes en français ou en anglais.
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const key = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const COLUMNS = {
  date: ['date', 'dateoperation', 'datedoperation', 'datevaleur', 'jour'],
  amount: ['montant', 'amount', 'somme', 'valeur'],
  debit: ['debit', 'depense', 'sortie'],
  credit: ['credit', 'recette', 'entree'],
  label: ['libelle', 'label', 'description', 'intitule', 'objet', 'designation'],
  category: ['categorie', 'category', 'poste', 'type'],
  counterparty: ['tiers', 'contrepartie', 'client', 'fournisseur', 'beneficiaire', 'counterparty', 'payee'],
};

export function parseAmount(raw) {
  let s = String(raw ?? '').replace(/[\s  €$£]/g, '');
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-') || s.endsWith('-');
  s = s.replace(/[()+-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return (neg ? -1 : 1) * Number(s);
}

export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { const f = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (f) m = [null, f[3], f[2].padStart(2, '0'), f[1].padStart(2, '0')]; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function transactionsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Le fichier doit contenir une ligne d\'en-têtes et au moins une opération.');
  const header = rows[0].map(key);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.date < 0) throw new Error('Colonne « date » introuvable.');
  if (col.amount < 0 && col.debit < 0 && col.credit < 0) throw new Error('Colonne « montant » (ou « débit » / « crédit ») introuvable.');
  const items = []; const skipped = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(r[col.date]);
    if (!date) return skipped.push({ line, reason: 'date illisible' });
    let amount = col.amount >= 0 ? parseAmount(r[col.amount]) : NaN;
    if (Number.isNaN(amount)) {
      const debit = col.debit >= 0 ? parseAmount(r[col.debit]) : NaN;
      const credit = col.credit >= 0 ? parseAmount(r[col.credit]) : NaN;
      if (!Number.isNaN(credit) && credit !== 0) amount = Math.abs(credit);
      else if (!Number.isNaN(debit) && debit !== 0) amount = -Math.abs(debit);
    }
    if (Number.isNaN(amount) || amount === 0) return skipped.push({ line, reason: 'montant illisible ou nul' });
    const at = (c) => (c >= 0 ? String(r[c] ?? '').trim().slice(0, 300) : '');
    return items.push({ date, amount, label: at(col.label), category: at(col.category) || 'divers', counterparty: at(col.counterparty) });
  });
  return { items, skipped };
}
