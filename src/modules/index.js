// Modules intégrés. Le noyau est commun ; chaque espace n'active que ce dont il a besoin.
// `tier` décrit le positionnement commercial prévu (gratuit / pro). Aucune restriction
// de licence n'est appliquée dans cette version : tous les modules sont utilisables.
import gestion from './gestion.js';
import finances from './finances.js';
import studio from './studio.js';

export const BUILTIN_MODULES = [
  gestion,
  finances,
  studio,
  { id: 'memoire', name: 'Mémoire', tier: 'gratuit', core: true, description: 'Documents, notes et connaissance de l\'activité.' },
  { id: 'creation', name: 'Création', tier: 'gratuit', core: true, description: 'Plans d\'action, offres, stratégies et rapports.' },
  { id: 'automatisations', name: 'Automatisations', tier: 'pro', description: 'Tâches répétitives exécutées à intervalle régulier.' },
  { id: 'connecteurs', name: 'Connecteurs', tier: 'pro', description: 'Webhooks sortants, exports, brouillons d\'e-mail.' },
  {
    id: 'pack-commerce', name: 'Pack Commerce & artisanat', tier: 'pro', sectors: ['commerce', 'artisanat', 'restauration'],
    description: 'Catégories, modèles et tâches de démarrage pour la vente et la production.',
    categories: ['ventes', 'achats marchandises', 'loyer', 'salaires', 'énergie', 'marketing', 'assurances', 'abonnements'],
    starterTasks: ['Lister les 10 produits ou services les plus rentables', 'Relever les prix de 3 fournisseurs concurrents', 'Mettre à jour la fiche d\'établissement en ligne'],
    templates: ['offre', 'plan_action', 'rapport'],
  },
  {
    id: 'pack-services', name: 'Pack Indépendants & services', tier: 'pro', sectors: ['services', 'tech', 'creatif', 'sante', 'immobilier'],
    description: 'Suivi des clients, des missions et de la facturation.',
    categories: ['honoraires', 'sous-traitance', 'logiciels', 'déplacements', 'formation', 'cotisations', 'abonnements'],
    starterTasks: ['Relancer les factures impayées de plus de 30 jours', 'Formaliser l\'offre principale et son tarif', 'Demander un témoignage aux 3 derniers clients'],
    templates: ['offre', 'plan_action', 'strategie'],
  },
  {
    id: 'pack-association', name: 'Pack Associations', tier: 'gratuit', sectors: ['association', 'education'],
    description: 'Adhésions, subventions, bénévoles et comptes rendus.',
    categories: ['cotisations', 'dons', 'subventions', 'événements', 'fournitures', 'assurances', 'locaux'],
    starterTasks: ['Mettre à jour la liste des adhérents', 'Recenser les subventions accessibles cette année', 'Planifier la prochaine assemblée générale'],
    templates: ['compte_rendu', 'plan_action', 'rapport'],
  },
  {
    id: 'pack-administration', name: 'Pack Administrations & collectivités', tier: 'pro', sectors: ['administration'],
    description: 'Suivi de dossiers, budgets et comptes rendus.',
    categories: ['dotations', 'fonctionnement', 'investissement', 'personnel', 'prestations', 'subventions versées'],
    starterTasks: ['Cartographier les démarches les plus demandées', 'Identifier les 3 délais de traitement les plus longs', 'Planifier le prochain point budgétaire'],
    templates: ['compte_rendu', 'plan_action', 'rapport'],
  },
  {
    id: 'pack-personnel', name: 'Pack Particuliers & projets', tier: 'gratuit', sectors: ['personnel'],
    description: 'Budget personnel et projets de vie.',
    categories: ['salaire', 'logement', 'alimentation', 'transport', 'loisirs', 'santé', 'épargne', 'abonnements'],
    starterTasks: ['Lister les abonnements actifs', 'Fixer un objectif d\'épargne mensuel', 'Découper le projet principal en étapes'],
    templates: ['plan_action', 'budget'],
  },
];
