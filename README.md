# OMNIA Ω

**Comprendre. Décider. Agir. Progresser.**

Un seul logiciel, tous les secteurs : OMNIA transforme les besoins, problèmes et objectifs d'une activité
(entreprise, commerce, indépendant, association, collectivité, particulier) en constats chiffrés,
en recommandations comparées et en actions concrètes — exécutées uniquement avec votre accord.

> Version 0.2 — socle fonctionnel. La section [État réel](#état-réel-de-cette-version) dit précisément ce qui est fait et ce qui ne l'est pas.

## Démarrer

Prérequis : Node.js ≥ 22.13. Aucune dépendance à installer, aucun compte, aucune clé.

```bash
npm run demo    # facultatif : crée un espace d'exemple (atelier de menuiserie)
npm start       # http://localhost:4747
npm test        # 13 tests
```

Les données restent sur votre machine, dans `data/omnia.db` (SQLite).

## Le cycle

| Étape | Ce que fait OMNIA | Où |
|---|---|---|
| 1. Décrire | Vous décrivez l'activité en langage libre | écran d'accueil |
| 2. Comprendre | Type, secteur, objectifs, modules adaptés | `src/engines/understanding.js` |
| 3. Analyser | 12 règles explicables sur les tâches, projets et finances ; chaque constat cite ses chiffres | `src/engines/analysis.js` |
| 4. Décider | Plusieurs options par constat, notées impact / effort ; la meilleure est désignée | `src/engines/decision.js` |
| 5. Agir | Actions exécutées par un registre unique, avec contrôle d'autorisation | `src/engines/execution.js` |
| 6. Mesurer | Un constat qui disparaît est marqué résolu ; indicateurs archivés chaque jour | `src/core/kernel.js` |
| 7. Apprendre | Les règles dont les recommandations sont acceptées et suivies d'effet gagnent en priorité, les rejetées en perdent | `weightOf()` |

Constats détectés aujourd'hui : tâches en retard, surcharge, tâches dormantes, projets à risque ou sans plan,
solde négatif, hausse d'un poste de dépense, charges récurrentes, paiements en double, dépendance à un client,
revenus en baisse ou en hausse.

## Architecture

```
src/
  core/        noyau (kernel.js), mémoire SQLite (db.js), journal d'audit chaîné (audit.js), import CSV
  engines/     compréhension · analyse · décision · exécution · création (documents + assistant)
  ai/          abstraction multi-fournisseurs
  modules/     registre des modules activables et packs sectoriels
  connectors/  export CSV, brouillon d'e-mail, webhook sortant
  server.js    API JSON + fichiers statiques
public/        tableau de bord (JavaScript natif)
```

## Intelligence artificielle : au choix, ou sans

OMNIA fonctionne **sans aucune IA générative** (mode local, gratuit, hors ligne) : analyses, recommandations et
trames de documents reposent sur des règles déterministes. Un modèle n'ajoute que la rédaction
(profil initial, documents, réponses de l'assistant). Chaque résultat indique son origine, et tout échec du
fournisseur entraîne un repli signalé sur le mode local.

| `OMNIA_AI_PROVIDER` | Détail |
|---|---|
| `local` (défaut) | aucun modèle |
| `ollama` | modèles open source sur votre machine, gratuit |
| `mistral`, `openai`, `groq`, `openrouter` | nécessite `OMNIA_AI_API_KEY` |
| `compatible` | toute API « chat completions » : `OMNIA_AI_BASE_URL` + `OMNIA_AI_MODEL` |
| `anthropic` | Claude ; nécessite `npm install @anthropic-ai/sdk` et `ANTHROPIC_API_KEY` |

`OMNIA_AI_MODEL` remplace le modèle par défaut. Les clés ne sont lues que dans l'environnement, jamais stockées.

## Sécurité et contrôle

- **Aucune action sensible sans autorisation.** Tout envoi hors d'OMNIA (webhook) attend une approbation explicite,
  y compris lorsqu'il vient d'une automatisation — sauf autorisation permanente accordée par vous, tracée et révocable.
- **Mode « manuel »** : même les actions internes des automatisations attendent votre accord.
- **Traçabilité** : chaque décision et action est inscrite dans un journal dont chaque entrée scelle la précédente ;
  l'écran Journal vérifie l'intégrité de la chaîne.
- **Résultats réels** : une action échouée est affichée comme échouée, avec l'erreur. Les brouillons d'e-mail ne sont jamais envoyés.
- **Serveur** : écoute sur `127.0.0.1` par défaut ; refuse de s'exposer au réseau (`OMNIA_HOST`) sans `OMNIA_TOKEN` ;
  protections CSRF, DNS rebinding, CSP stricte ; webhooks refusés vers les adresses privées.

Autres variables : `OMNIA_PORT` (4747), `OMNIA_DATA_DIR` (`./data`), `OMNIA_SCHEDULER_SECONDS` (60).

## État réel de cette version

**Fait et vérifié** (tests automatisés + parcours complet dans un navigateur) : espaces multiples cloisonnés, gestion
des tâches et projets, finances avec import CSV, mémoire documentaire, analyse, recommandations, exécution avec
autorisations, automatisations périodiques, journal d'audit, génération de documents et assistant en mode local,
courbe d'évolution des indicateurs, sauvegarde et restauration d'un espace (JSON), import de fichiers texte dans la
mémoire, tableau de bord responsive clair/sombre. Les tests s'exécutent à chaque proposition de modification (GitHub Actions).

**Écrit mais non vérifié en conditions réelles** : les fournisseurs d'IA externes (aucune clé disponible lors du
développement). Le repli en cas d'échec est en place.

**Pas encore fait** :
- comptes utilisateurs et rôles (un jeton unique protège l'instance) ;
- gestion des licences : la mention « pro » des modules décrit le positionnement prévu, rien n'est restreint ;
- connecteurs vers des services précis (banque, messagerie, CRM, agenda) — seul le webhook générique existe ;
- lecture de documents PDF/bureautiques, API publique documentée, sauvegarde planifiée (la sauvegarde manuelle existe,
  son fichier n'est pas chiffré) ;
- chiffrement de la base au repos (à assurer par le système hôte).

Limite connue : la vérification d'adresse des webhooks précède l'envoi ; un DNS malveillant qui changerait de
réponse entre les deux pourrait la contourner. L'approbation manuelle de chaque URL reste la protection principale.

## Modèle économique prévu

Socle gratuit (gestion, finances, mémoire, création) ; modules professionnels (automatisations, connecteurs,
packs sectoriels), licence professionnelle, API et intégrations. Aucune licence n'est encore attachée au dépôt :
c'est une décision à prendre avant toute diffusion.
