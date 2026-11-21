# OMNIA Ω

**Comprendre. Décider. Agir. Progresser.**

Un seul logiciel, tous les secteurs : OMNIA transforme les besoins, problèmes et objectifs d'une activité
(entreprise, commerce, indépendant, association, collectivité, particulier) en constats chiffrés,
en recommandations comparées et en actions concrètes — exécutées uniquement avec votre accord.

> Version 0.4 — socle fonctionnel. La section [État réel](#état-réel-de-cette-version) dit précisément ce qui est fait et ce qui ne l'est pas.

## Démarrer

Prérequis : Node.js ≥ 22.13. Aucune dépendance à installer, aucun compte, aucune clé.

```bash
npm run demo    # facultatif : crée un espace d'exemple (atelier de menuiserie)
npm start       # http://localhost:4747
npm test        # 18 tests
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
  core/        noyau (kernel.js), mémoire SQLite (db.js), journal d'audit chaîné (audit.js), comptes et rôles (auth.js), import CSV
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

**Plusieurs fournisseurs à la fois** : `OMNIA_AI_PROVIDER=ollama,mistral` les essaie dans l'ordre et passe au suivant
en cas d'échec. Chacun lit alors ses propres réglages (`OMNIA_AI_MISTRAL_API_KEY`, `OMNIA_AI_OLLAMA_MODEL`…) ; la clé
de l'un n'est jamais envoyée à l'autre.

## Connexions

| Connexion | Sens | Détail |
|---|---|---|
| Slack, Discord, Microsoft Teams, webhook générique | sortant | Canaux nommés par espace ; chaque envoi est une action sensible soumise à autorisation |
| Entrée de données | entrant | Une adresse à jeton pour créer tâches, opérations et notes depuis Zapier, n8n, Make ou un script |
| Calendrier | sortant, lecture seule | Abonnement iCalendar aux échéances (Google Agenda, Outlook, Apple) |
| Stripe | entrant, lecture seule | Import des mouvements de solde ; nécessite `OMNIA_STRIPE_KEY` (clé restreinte) |
| Export CSV, brouillon d'e-mail | local | Fichiers et brouillons, rien n'est envoyé |

Les adresses à jeton ne sont affichées qu'une fois ; seule leur empreinte est conservée, et elles se régénèrent ou se
révoquent depuis l'écran Connexions. Quiconque détient l'adresse d'entrée peut écrire dans l'espace : traitez-la
comme un mot de passe.

## Sécurité et contrôle

- **Aucune action sensible sans autorisation.** Tout envoi hors d'OMNIA (webhook) attend une approbation explicite,
  y compris lorsqu'il vient d'une automatisation — sauf autorisation permanente accordée par vous, tracée et révocable.
- **Mode « manuel »** : même les actions internes des automatisations attendent votre accord.
- **Traçabilité** : chaque décision et action est inscrite dans un journal dont chaque entrée scelle la précédente ;
  l'écran Journal vérifie l'intégrité de la chaîne.
- **Résultats réels** : une action échouée est affichée comme échouée, avec l'erreur. Les brouillons d'e-mail ne sont jamais envoyés.
- **Serveur** : écoute sur `127.0.0.1` par défaut ; refuse de s'exposer au réseau (`OMNIA_HOST`) sans `OMNIA_TOKEN` ;
  protections CSRF, DNS rebinding, CSP stricte ; webhooks refusés vers les adresses privées.

### Travailler à plusieurs

Sans compte, OMNIA est mono-utilisateur. Créer un premier compte (Réglages → « Travailler à plusieurs ») rend la
connexion obligatoire ; ce compte est administrateur. Les droits se règlent ensuite espace par espace :

| Rôle | Peut |
|---|---|
| Lecteur | consulter |
| Membre | saisir, analyser, accepter des recommandations, demander une action |
| Propriétaire | autoriser ou refuser les actions, gérer automatisations, réglages, membres, suppression |

Un administrateur gère les comptes et accède à tous les espaces. Un espace garde toujours au moins un propriétaire.
Le journal enregistre le nom de la personne à l'origine de chaque décision. Mots de passe hachés (scrypt), sessions
de 7 jours en cookie `HttpOnly` / `SameSite=Strict`, verrouillage de 15 minutes après 5 échecs.

Pour un accès hors de la machine, placez OMNIA derrière un proxy HTTPS et définissez `OMNIA_COOKIE_SECURE=1` :
le serveur lui-même ne parle que HTTP.

Autres variables : `OMNIA_PORT` (4747), `OMNIA_DATA_DIR` (`./data`), `OMNIA_SCHEDULER_SECONDS` (60).

## État réel de cette version

**Fait et vérifié** (tests automatisés + parcours complet dans un navigateur) : espaces multiples cloisonnés, comptes
utilisateurs avec rôles par espace, gestion
des tâches et projets, finances avec import CSV, mémoire documentaire, analyse, recommandations, exécution avec
autorisations, automatisations périodiques, journal d'audit, génération de documents et assistant en mode local,
courbe d'évolution des indicateurs, sauvegarde et restauration d'un espace (JSON), import de fichiers texte dans la
mémoire, tableau de bord responsive clair/sombre. Un fichier d'intégration continue est fourni, mais GitHub Actions n'a encore
déclenché aucune exécution sur ce dépôt : les tests sont lancés à la main.

**Écrit mais non vérifié en conditions réelles** : les fournisseurs d'IA externes, l'import Stripe et les envois
vers Slack, Discord et Teams. Ils sont testés contre des réponses simulées, pas contre les vrais services
(aucune clé ni canal réel utilisé lors du développement). Les webhooks Teams de type « Workflows » attendent un
autre format que celui envoyé ici.

**Pas encore fait** :
- changement ou réinitialisation de mot de passe en libre-service, double authentification, HTTPS intégré ;
- gestion des licences : la mention « pro » des modules décrit le positionnement prévu, rien n'est restreint ;
- connecteurs demandant une connexion OAuth (banque, messagerie électronique, CRM, agenda en écriture) ;
- lecture de documents PDF/bureautiques, API publique documentée, sauvegarde planifiée (la sauvegarde manuelle existe,
  son fichier n'est pas chiffré) ;
- chiffrement de la base au repos (à assurer par le système hôte).

Limite connue : la vérification d'adresse des webhooks précède l'envoi ; un DNS malveillant qui changerait de
réponse entre les deux pourrait la contourner. L'approbation manuelle de chaque URL reste la protection principale.

## Modèle économique prévu

Socle gratuit (gestion, finances, mémoire, création) ; modules professionnels (automatisations, connecteurs,
packs sectoriels), licence professionnelle, API et intégrations. Aucune licence n'est encore attachée au dépôt :
c'est une décision à prendre avant toute diffusion.
