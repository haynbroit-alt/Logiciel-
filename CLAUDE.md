# OMNIA — notes pour les agents de code

- Node.js 22.13 ou plus, aucune dépendance. Vérification avant commit :
  `.claude/bin/journal verif npm test`
- Rôle dans l'écosystème VELYX : la gestion, c'est-à-dire l'application où le propriétaire travaille (comptes,
  espaces, connecteurs, actions soumises à autorisation, journal d'audit). Le portail public est dans NOVARYS.
- Dépôt public : aucune donnée personnelle, aucun identifiant, aucune clé. Les secrets ne vivent que dans
  l'environnement du processus (`src/config.js`), jamais en base ni dans git.
- Un connecteur n'est « disponible » que s'il a été essayé contre le vrai service. Sinon son statut le dit.
- Tout envoi sortant, toute écriture chez un tiers et toute opération financière restent des actions sensibles :
  elles passent par `src/engines/execution.js` et l'autorisation du propriétaire.

## Fiabilité avant sobriété — la preuve prime sur le plafond de sortie
- Toute vérification passe par `.claude/bin/journal <étiquette> <commande>` : journal complet sur disque, résumé
  jamais tronqué, code de sortie exact en première et dernière ligne.
- Jamais `vérification | tail/head/grep` sans `pipefail` : le pipe renvoie le code du filtre et masque l'échec.
  Le crochet `.claude/hooks/garde_pipe.py` refuse ces commandes.
- « Réussi » exige : code 0 ET la ligne de bilan vue (`# fail 0`). Sinon écrire « non vérifié » et pourquoi.
- Fusion d'une PR seulement si tous les contrôles de la tête actuelle sont en `success` et les vérifications
  locales à 0.

## Sobriété — chaque session, sans exception
- Lire ciblé : Grep/Glob d'abord, puis Read avec `offset`/`limit`. Ne jamais relire un fichier déjà lu et inchangé.
- Ne jamais lire `data/` ni `node_modules/`. `src/core/kernel.js` et `public/app.js` sont longs : y chercher.
- Code minimal : le plus petit diff qui résout le problème ; pas d'abstraction, d'option ni de fichier « au cas où ».
- Carte : `src/server.js` (routes HTTP), `src/config.js` (environnement), `src/core/` (`kernel`, `auth`, `audit`,
  `backup` : sauvegarde chiffrée de l'instance, `persist` : envoi vers un dépôt GitHub privé et restauration au démarrage, `db`, `registry`, `events`), `src/connectors/` (`hub` : canaux, jetons, import Stripe ; `index` : exports,
  brouillons, webhooks), `src/engines/` (compréhension, analyse, décision, exécution), `src/modules/` (gestion,
  finances, studio), `src/ai/` (fournisseurs), `public/` (interface), `test/`, `docs/API.md`.
