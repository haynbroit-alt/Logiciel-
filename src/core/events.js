// Bus d'événements du noyau. Chaque fait marquant (tâche créée, constat détecté, action
// exécutée…) est publié ici ; les modules et les automatisations y réagissent.
// Les réactions ne déclenchent pas d'autres réactions : un événement émis pendant le
// traitement d'un autre est journalisé mais n'est pas remis en file (pas de boucle possible).
import { AsyncLocalStorage } from 'node:async_hooks';

export const EVENTS = {
  'tache.creee': 'Une tâche est créée',
  'tache.terminee': 'Une tâche est terminée',
  'operation.creee': 'Une opération financière est enregistrée',
  'document.cree': 'Un document est ajouté à la mémoire',
  'analyse.executee': 'Une analyse vient de s\'exécuter',
  'constat.detecte': 'Un nouveau constat est détecté',
  'constat.resolu': 'Un constat est résolu',
  'recommandation.acceptee': 'Une recommandation est acceptée',
  'recommandation.rejetee': 'Une recommandation est rejetée',
  'action.en_attente': 'Une action attend une autorisation',
  'action.reussie': 'Une action a réussi',
  'action.echouee': 'Une action a échoué',
};

const MAX_QUEUE = 2000;

export function createEvents() {
  const queue = []; const reacting = new AsyncLocalStorage();
  let dropped = 0; let emitted = 0; let draining = null;
  return {
    emit(event, workspaceId, payload = {}) {
      if (!EVENTS[event]) throw new Error(`Événement inconnu : ${event}`);
      emitted += 1;
      if (reacting.getStore()) return; // émis par une réaction : pas de réaction en chaîne
      if (queue.length >= MAX_QUEUE) { dropped += 1; return; }
      queue.push({ event, workspaceId, payload, at: new Date().toISOString() });
    },
    // Traite la file : `handle` reçoit chaque événement. Un seul traitement à la fois.
    drain(handle) {
      if (draining) return draining;
      const run = (async () => {
        await null; // rend la main : `draining` est posé avant que le traitement ne commence
        let n = 0;
        try {
          while (queue.length) { const e = queue.shift(); await reacting.run(true, () => handle(e)); n += 1; }
        } finally { draining = null; }
        return n;
      })();
      draining = run;
      return run;
    },
    stats: () => ({ emis: emitted, en_file: queue.length, abandonnes: dropped }),
  };
}
