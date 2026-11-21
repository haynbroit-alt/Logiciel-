// Module Gestion : règles d'analyse sur les tâches et les projets.
// Une règle reçoit le contexte d'analyse et retourne zéro, un ou plusieurs constats
// { key?, kind, severity, title, detail, evidence }. Le noyau ajoute l'identité de la règle.
import { PLAYBOOKS } from '../engines/decision.js';

const pick = (prefixes) => Object.fromEntries(Object.entries(PLAYBOOKS).filter(([k]) => prefixes.some((p) => k.startsWith(p))));

export default {
  id: 'gestion', name: 'Gestion', tier: 'gratuit', core: true,
  description: 'Projets, tâches, priorités et échéances.',
  playbooks: pick(['taches.', 'projets.']),
  rules: [
    {
      id: 'taches.en_retard', label: 'Tâches en retard',
      evaluate({ open, t0, dayDiff }) {
        const overdue = open.filter((t) => t.due_date && t.due_date < t0).sort((a, b) => a.due_date.localeCompare(b.due_date));
        if (!overdue.length) return null;
        const worst = dayDiff(t0, overdue[0].due_date);
        return {
          kind: 'probleme', severity: Math.min(5, 2 + Math.floor(overdue.length / 3) + (worst > 14 ? 1 : 0)),
          title: `${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard`,
          detail: `La plus ancienne a ${worst} jour${worst > 1 ? 's' : ''} de retard (« ${overdue[0].title} »).`,
          evidence: { taskIds: overdue.map((t) => t.id), titles: overdue.slice(0, 5).map((t) => t.title), maxDaysLate: worst },
        };
      },
    },
    {
      id: 'taches.surcharge', label: 'Trop de tâches en cours',
      evaluate({ open }) {
        const doing = open.filter((t) => t.status === 'en_cours');
        if (doing.length <= 5) return null;
        return {
          kind: 'risque', severity: 3, title: `${doing.length} tâches menées de front`,
          detail: 'Au-delà de 5 tâches en cours simultanément, le temps se disperse et les délais s\'allongent.',
          evidence: { taskIds: doing.map((t) => t.id), count: doing.length },
        };
      },
    },
    {
      id: 'taches.dormantes', label: 'Tâches dormantes',
      evaluate({ open, d30 }) {
        const stale = open.filter((t) => t.status === 'a_faire' && !t.due_date && t.created_at.slice(0, 10) < d30);
        if (stale.length < 3) return null;
        return {
          kind: 'probleme', severity: 2, title: `${stale.length} tâches sans échéance depuis plus de 30 jours`,
          detail: 'Ces tâches encombrent la liste sans avancer : à planifier, déléguer ou supprimer.',
          evidence: { taskIds: stale.map((t) => t.id), titles: stale.slice(0, 5).map((t) => t.title) },
        };
      },
    },
    {
      id: 'projets.sans_taches', label: 'Projet sans plan',
      evaluate: ({ projects, tasks }) => projects.filter((p) => p.status === 'actif' && !tasks.some((t) => t.project_id === p.id)).map((p) => ({
        key: String(p.id), kind: 'probleme', severity: 2, title: `Le projet « ${p.name} » n'a aucune tâche`,
        detail: 'Sans étapes concrètes, un projet ne peut être ni suivi ni mené à terme.', evidence: { projectId: p.id, projectName: p.name },
      })),
    },
    {
      id: 'projets.a_risque', label: 'Projet à risque',
      evaluate({ projects, tasks, t0, dayDiff, round }) {
        const out = [];
        for (const p of projects.filter((x) => x.status === 'actif' && x.deadline)) {
          const pt = tasks.filter((t) => t.project_id === p.id);
          if (!pt.length) continue;
          const left = dayDiff(p.deadline, t0);
          const progress = pt.filter((t) => t.status === 'fait').length / pt.length;
          if (left > 14 || progress >= 0.6) continue;
          out.push({
            key: String(p.id), kind: 'risque', severity: left < 0 ? 5 : 4,
            title: `Le projet « ${p.name} » risque de manquer son échéance`,
            detail: `${left < 0 ? `Échéance dépassée de ${-left} jour(s)` : `${left} jour(s) restant(s)`} pour ${Math.round(progress * 100)} % d'avancement (${pt.length} tâches).`,
            evidence: { projectId: p.id, projectName: p.name, daysLeft: left, progress: round(progress), remaining: pt.filter((t) => t.status !== 'fait').length },
          });
        }
        return out;
      },
    },
  ],
};
