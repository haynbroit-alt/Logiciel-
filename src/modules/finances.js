// Module Finances : règles d'analyse sur les dépenses et les revenus.
import { PLAYBOOKS } from '../engines/decision.js';

const playbooks = Object.fromEntries(Object.entries(PLAYBOOKS).filter(([k]) => k.startsWith('finances.')));

export default {
  id: 'finances', name: 'Finances', tier: 'gratuit', core: true,
  description: 'Suivi des dépenses et des revenus, détection des pertes.',
  playbooks,
  rules: [
    {
      id: 'finances.tresorerie_negative', label: 'Solde négatif sur 30 jours',
      evaluate({ cur, incomeOf, expenseOf, round }) {
        const inc = incomeOf(cur); const exp = expenseOf(cur);
        if (cur.length < 3 || exp <= inc || exp <= 0) return null;
        return {
          kind: 'probleme', severity: inc === 0 ? 3 : 4, title: 'Les dépenses dépassent les revenus sur 30 jours',
          detail: `Revenus ${round(inc)} · dépenses ${round(exp)} · solde ${round(inc - exp)}.`,
          evidence: { income: round(inc), expenses: round(exp), net: round(inc - exp) },
        };
      },
    },
    {
      id: 'finances.hausse_depenses', label: 'Hausse d\'un poste de dépense',
      evaluate({ cur, prev, expenseOf, round, norm }) {
        const byCat = (xs) => xs.filter((x) => x.amount < 0).reduce((m, x) => (m.set(x.category, (m.get(x.category) ?? 0) - x.amount), m), new Map());
        const catPrev = byCat(prev); const exp = expenseOf(cur); const out = [];
        for (const [cat, amount] of byCat(cur)) {
          const before = catPrev.get(cat) ?? 0;
          if (!(before > 0 && amount > before * 1.4 && amount - before >= Math.max(50, exp * 0.05))) continue;
          out.push({
            key: norm(cat), kind: 'risque', severity: 3, title: `Le poste « ${cat} » a augmenté de ${Math.round((amount / before - 1) * 100)} %`,
            detail: `${round(amount)} sur les 30 derniers jours contre ${round(before)} sur les 30 précédents (+${round(amount - before)}).`,
            evidence: { category: cat, current: round(amount), previous: round(before), delta: round(amount - before) },
          });
        }
        return out;
      },
    },
    {
      // Même libellé débité sur au moins 3 mois distincts.
      id: 'finances.charges_recurrentes', label: 'Charges récurrentes',
      evaluate({ transactions, sum, round, norm }) {
        const groups = new Map();
        for (const x of transactions.filter((y) => y.amount < 0 && norm(y.label))) {
          const g = groups.get(norm(x.label)) ?? { label: x.label, months: new Set(), amounts: [] };
          g.months.add(x.date.slice(0, 7)); g.amounts.push(-x.amount); groups.set(norm(x.label), g);
        }
        const recurring = [...groups.values()].filter((g) => g.months.size >= 3)
          .map((g) => ({ label: g.label, months: g.months.size, monthly: round(sum(g.amounts) / g.months.size) })).sort((a, b) => b.monthly - a.monthly);
        if (!recurring.length) return null;
        const yearly = round(sum(recurring.map((r) => r.monthly)) * 12); const s = recurring.length > 1 ? 's' : '';
        return {
          kind: 'opportunite', severity: yearly > 5000 ? 3 : 2, title: `${recurring.length} charge${s} récurrente${s} à renégocier ou résilier`,
          detail: `Environ ${yearly} par an au rythme actuel. Les plus lourdes : ${recurring.slice(0, 3).map((r) => `${r.label} (${r.monthly}/mois)`).join(', ')}.`,
          evidence: { recurring: recurring.slice(0, 10), yearlyEstimate: yearly },
        };
      },
    },
    {
      // Même date, même montant, même libellé.
      id: 'finances.doublons', label: 'Paiements en double possibles',
      evaluate({ transactions, d60, sum, round, norm }) {
        const seen = new Map();
        for (const x of transactions.filter((y) => y.amount < 0 && y.date > d60)) {
          const k = `${x.date}|${x.amount}|${norm(x.label)}`;
          seen.set(k, [...(seen.get(k) ?? []), x]);
        }
        const dups = [...seen.values()].filter((g) => g.length > 1);
        if (!dups.length) return null;
        const total = round(sum(dups.map((g) => -g[0].amount * (g.length - 1))));
        return {
          kind: 'probleme', severity: 3, title: `${dups.length} paiement${dups.length > 1 ? 's' : ''} possiblement en double`,
          detail: `Montant potentiellement payé en trop : ${total}. À vérifier avant toute réclamation.`,
          evidence: { duplicates: dups.slice(0, 10).map((g) => ({ date: g[0].date, label: g[0].label, amount: g[0].amount, count: g.length, ids: g.map((x) => x.id) })), total },
        };
      },
    },
    {
      // Une seule contrepartie pèse plus de la moitié des revenus sur 60 jours.
      id: 'finances.dependance_client', label: 'Dépendance à une source de revenus',
      evaluate({ transactions, d60, sum, round, norm }) {
        const incomes = transactions.filter((x) => x.amount > 0 && x.date > d60 && norm(x.counterparty));
        const total = sum(incomes.map((x) => x.amount));
        if (incomes.length < 4 || total <= 0) return null;
        const byCp = incomes.reduce((m, x) => (m.set(x.counterparty, (m.get(x.counterparty) ?? 0) + x.amount), m), new Map());
        const [top, amount] = [...byCp.entries()].sort((a, b) => b[1] - a[1])[0];
        if (byCp.size <= 1 || amount / total <= 0.5) return null;
        return {
          kind: 'risque', severity: amount / total > 0.7 ? 4 : 3, title: `${Math.round((amount / total) * 100)} % des revenus dépendent de « ${top} »`,
          detail: 'La perte de cette source mettrait l\'activité en difficulté : diversifier réduit ce risque.',
          evidence: { counterparty: top, share: round(amount / total), amount: round(amount), total: round(total) },
        };
      },
    },
    {
      id: 'finances.revenus_en_baisse', label: 'Revenus en baisse',
      evaluate({ cur, prev, incomeOf, round }) {
        const inc = incomeOf(cur); const before = incomeOf(prev);
        if (!(before > 0 && cur.length >= 2)) return null;
        const change = inc / before - 1;
        if (change > -0.2) return null;
        return {
          kind: 'risque', severity: change <= -0.4 ? 4 : 3, title: `Revenus en baisse de ${Math.round(-change * 100)} % sur 30 jours`,
          detail: `${round(inc)} contre ${round(before)} sur la période précédente.`, evidence: { current: round(inc), previous: round(before), change: round(change) },
        };
      },
    },
    {
      id: 'finances.revenus_en_hausse', label: 'Revenus en hausse',
      evaluate({ cur, prev, incomeOf, round }) {
        const inc = incomeOf(cur); const before = incomeOf(prev);
        if (!(before > 0 && cur.length >= 2)) return null;
        const change = inc / before - 1;
        if (change < 0.2) return null;
        return {
          kind: 'opportunite', severity: 2, title: `Revenus en hausse de ${Math.round(change * 100)} % sur 30 jours`,
          detail: `${round(inc)} contre ${round(before)} : identifier ce qui a fonctionné pour le reproduire.`, evidence: { current: round(inc), previous: round(before), change: round(change) },
        };
      },
    },
  ],
};
