#!/usr/bin/env node
// Jeu de données de démonstration : crée un espace d'exemple pour découvrir OMNIA.
// Usage : npm run demo   (puis npm start)
import { loadConfig } from './config.js';
import { openDb, today } from './core/db.js';
import { createAI } from './ai/index.js';
import { createKernel } from './core/kernel.js';

const config = loadConfig();
const k = createKernel({ db: openDb(config.dbPath), ai: createAI({ provider: 'local' }), config });
const d = (n) => today(new Date(Date.now() - n * 86400000));

const w = await k.createWorkspace({
  name: 'Atelier Martin (démonstration)',
  description: 'Je tiens un atelier de menuiserie artisanale de 3 personnes. Je veux réduire mes retards de chantier. J\'aimerais mieux suivre mes dépenses et trouver de nouveaux clients.',
});
const chantier = k.createProject(w.id, { name: 'Cuisine sur mesure — famille Durand', deadline: d(-10) });
k.createProject(w.id, { name: 'Refonte du site vitrine' });
[['Prendre les cotes définitives', 'fait', 20], ['Commander le chêne massif', 'a_faire', 6], ['Débit et assemblage des caissons', 'en_cours', 2], ['Pose et finitions', 'a_faire', -9]]
  .forEach(([title, status, ago]) => k.createTask(w.id, { title, status, due_date: d(ago), project_id: chantier.id }));
k.createTask(w.id, { title: 'Envoyer le devis à la mairie', due_date: d(12), priority: 1 });
k.createTask(w.id, { title: 'Déclarer la TVA du trimestre', due_date: d(-5) });

for (const m of [0, 1, 2, 3]) {
  k.createTransaction(w.id, { date: d(m * 30 + 4), amount: -89, label: 'Logiciel de devis', category: 'abonnements', counterparty: 'DevisPro' });
  k.createTransaction(w.id, { date: d(m * 30 + 6), amount: -240, label: 'Assurance décennale', category: 'assurances', counterparty: 'Assurances du Bâtiment' });
  k.createTransaction(w.id, { date: d(m * 30 + 2), amount: -1450, label: 'Loyer atelier', category: 'loyer', counterparty: 'SCI des Tilleuls' });
}
k.createTransaction(w.id, { date: d(40), amount: -900, label: 'Bois et quincaillerie', category: 'achats marchandises', counterparty: 'Scierie du Val' });
k.createTransaction(w.id, { date: d(12), amount: -2100, label: 'Bois et quincaillerie', category: 'achats marchandises', counterparty: 'Scierie du Val' });
k.createTransaction(w.id, { date: d(9), amount: -320, label: 'Location camion', category: 'déplacements', counterparty: 'LocaUtil' });
k.createTransaction(w.id, { date: d(9), amount: -320, label: 'Location camion', category: 'déplacements', counterparty: 'LocaUtil' });
k.createTransaction(w.id, { date: d(45), amount: 6800, label: 'Solde chantier escalier', category: 'ventes', counterparty: 'Promoteur Habitat Sud' });
k.createTransaction(w.id, { date: d(38), amount: 2400, label: 'Bibliothèque sur mesure', category: 'ventes', counterparty: 'M. Lefèvre' });
k.createTransaction(w.id, { date: d(20), amount: 3900, label: 'Acompte agencement bureaux', category: 'ventes', counterparty: 'Promoteur Habitat Sud' });
k.createTransaction(w.id, { date: d(7), amount: 1200, label: 'Réparation volets', category: 'ventes', counterparty: 'Mme Roche' });
k.createTransaction(w.id, { date: d(52), amount: 4100, label: 'Acompte résidence', category: 'ventes', counterparty: 'Promoteur Habitat Sud' });
k.createDocument(w.id, { title: 'Conditions de règlement', content: 'Acompte de 30 % à la commande, 40 % au début de la pose, solde à la réception. Pénalités de retard : 3 fois le taux légal.' });

const r = k.runAnalysis(w.id);
console.log(`Espace de démonstration créé (n° ${w.id}) : ${r.insights.length} constats détectés.`);
r.insights.forEach((i) => console.log(` - [${i.kind}] ${i.title}`));
console.log('Lancez « npm start » puis ouvrez http://localhost:4747');
