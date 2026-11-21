# API du noyau OMNIA Ω

Tout passe par le noyau : l'interface web n'utilise rien d'autre que cette API. Un logiciel tiers s'y branche de la
même façon.

## S'authentifier

| Qui | Comment | Portée |
|---|---|---|
| Un logiciel tiers | `Authorization: Bearer <clé d'API>` — clé créée dans l'écran Connexions | **un seul espace**, droits d'un membre |
| Une personne (comptes activés) | cookie de session obtenu par `POST /api/session` | selon son rôle dans chaque espace |
| Instance sans compte, exposée au réseau | `Authorization: Bearer <OMNIA_TOKEN>` | tout |

Une clé d'API ne peut **ni autoriser une action sensible, ni modifier réglages, membres, automatisations ou
connexions, ni atteindre un autre espace**. Une machine demande ; une personne propriétaire autorise.

Les requêtes d'écriture exigent `Content-Type: application/json`. Les erreurs ont la forme `{"error": "…"}`.

## Découvrir le noyau

- `GET /api/noyau` — modules enregistrés (règles, actions, réactions), types d'action, événements, état de la file.
- `GET /api/meta` — listes de référence : secteurs, modèles de documents, types de canaux.

## Travailler dans un espace

Remplacez `:ws` par l'identifiant de l'espace.

| Méthode et chemin | Effet | Rôle minimal |
|---|---|---|
| `GET /api/espaces/:ws/tableau-de-bord` | indicateurs, constats, recommandations, résultats | lecteur |
| `GET /api/espaces/:ws/donnees` | tâches, projets, opérations, documents | lecteur |
| `POST /api/espaces/:ws/taches` `{title, due_date?, priority?, project_id?}` | crée une tâche | membre |
| `PATCH /api/espaces/:ws/taches/:id` `{status?, priority?, due_date?, title?}` | modifie une tâche | membre |
| `POST /api/espaces/:ws/projets` `{name, deadline?, goal?}` | crée un projet | membre |
| `POST /api/espaces/:ws/operations` `{date, amount, label?, category?, counterparty?}` | enregistre une opération (négatif = dépense) | membre |
| `POST /api/espaces/:ws/operations/import` `{csv}` | importe un relevé | membre |
| `POST /api/espaces/:ws/documents` `{title, content, kind?}` | ajoute un document à la mémoire | membre |
| `POST /api/espaces/:ws/documents/generer` `{template, brief?}` | produit un document | membre |
| `POST /api/espaces/:ws/analyse` | lance une analyse ; retourne constats et règles en erreur | membre |
| `POST /api/espaces/:ws/assistant` `{question}` | comprend une demande : retourne `answer`, `proposals` (actions à valider, non exécutées) et `priorities` | membre |
| `GET /api/espaces/:ws/recommandations` | recommandations et leurs options | lecteur |
| `POST /api/espaces/:ws/recommandations/:id/accepter` `{option?}` | accepte une option et lance ses actions | membre |
| `POST /api/espaces/:ws/recommandations/:id/rejeter` | rejette | membre |
| `GET /api/espaces/:ws/actions` | actions et leur état réel | lecteur |
| `POST /api/espaces/:ws/actions` `{type, params}` | demande une action ; une action sensible reste `en_attente` | membre |
| `POST /api/espaces/:ws/actions/:id/approuver` · `/refuser` | autorise ou refuse | **propriétaire** |
| `GET /api/espaces/:ws/journal` | journal d'audit et vérification d'intégrité | lecteur |
| `GET /api/espaces/:ws/export` | sauvegarde JSON de l'espace | lecteur |

États d'une action : `en_attente` → `autorisee` → `reussie` ou `echouee` ; ou `refusee`. Le champ `result` contient
ce qui a réellement été constaté, `error` le motif d'un échec.

### Exemple

```bash
CLE=…   # clé d'API de l'espace 1
curl -s -H "Authorization: Bearer $CLE" -H "Content-Type: application/json" \
     -d '{"title":"Relancer le fournisseur","due_date":"2027-01-15"}' \
     http://localhost:4747/api/espaces/1/taches
curl -s -X POST -H "Authorization: Bearer $CLE" -H "Content-Type: application/json" -d '{}' \
     http://localhost:4747/api/espaces/1/analyse
```

## Accès à jeton, sans clé d'API

- `POST /api/entrant/<jeton>` — crée tâches, opérations et notes (`{"type":"tache","titre":"…"}`, ou un lot dans `{"elements":[…]}`).
- `GET /api/calendrier/<jeton>.ics` — échéances au format iCalendar.

## Écrire un module

Un module étend le noyau de l'intérieur. Voir `examples/module-exemple.js`, commenté ligne à ligne.

- **Règle** : `evaluate(ctx)` retourne `{kind, severity, title, detail, evidence, key?}` ou rien. `ctx` fournit
  `tasks`, `projects`, `transactions`, `documents`, `open`, `cur` et `prev` (opérations des 30 derniers jours et des
  30 précédents), `t0`, `d30`, `d60`, et les outils `sum`, `round`, `dayDiff`, `norm`, `incomeOf`, `expenseOf`.
- **Solutions** : pour une règle, une fonction `(evidence) => [{label, detail, impact, effort, actions}]`.
- **Action** : `{label, sensitivity, validate(params), run(ws, params, api)}`. `sensitivity` est obligatoire.
- **Réaction** : `on: {'tache.terminee': (evenement, api) => …}`. Une réaction ne déclenche pas d'autres réactions.

`api` est limité à l'espace concerné : `workspace`, `data()`, `kpis()`, `inDays(n)`, `createTask`, `createDocument`,
`createTransaction`. Règles et actions d'un module externe doivent être préfixées par son identifiant.

Un module est du code exécuté avec les droits d'OMNIA, sans bac à sable : ne chargez que des modules de confiance.
Une règle qui échoue est signalée dans le résultat de l'analyse et n'interrompt pas les autres.
