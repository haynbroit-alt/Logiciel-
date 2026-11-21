// Registre du noyau : tout ce qu'OMNIA sait faire lui est déclaré ici par des modules.
// Un module est un simple objet ; il peut apporter des règles d'analyse, des solutions
// (playbooks), des types d'action, des réactions à des événements, des modèles et des données de démarrage.
//
//   export default {
//     id: 'mon-module', name: 'Mon module', description: '…', tier: 'gratuit',
//     rules:     [{ id: 'mon-module.ma_regle', label: '…', evaluate(ctx) { … } }],
//     playbooks: { 'mon-module.ma_regle': (evidence) => [{ label, detail, impact, effort, actions: [{ type, params }] }] },
//     actions:   { 'mon-module.mon_action': { label, sensitivity: 'interne' | 'sensible', validate(params), run(ws, params, api) } },
//     on:        { 'tache.creee': (payload, api) => { … } },
//   };
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const NAME = /^[a-z][a-z0-9-]*\.[a-z0-9_]+$/;

export class ModuleError extends Error {}

export function createRegistry({ builtinActionTypes = [] } = {}) {
  const modules = new Map();
  const rules = new Map(); const playbooks = new Map(); const actions = new Map(); const listeners = [];
  const errors = [];
  const check = (cond, message) => { if (!cond) throw new ModuleError(message); };

  function register(mod, { source = 'integre' } = {}) {
    check(mod && typeof mod === 'object', 'Un module doit être un objet');
    check(typeof mod.id === 'string' && ID.test(mod.id), `Identifiant de module invalide : ${mod.id}`);
    check(!modules.has(mod.id), `Le module « ${mod.id} » est déjà enregistré`);
    check(typeof mod.name === 'string' && mod.name.trim(), `Le module « ${mod.id} » doit avoir un nom`);
    const own = (name) => source === 'integre' || name.startsWith(`${mod.id}.`);
    const staged = { rules: [], playbooks: [], actions: [], listeners: [] };

    for (const r of mod.rules ?? []) {
      check(typeof r.id === 'string' && NAME.test(r.id) && typeof r.evaluate === 'function' && typeof r.label === 'string', `Règle invalide dans « ${mod.id} »`);
      check(own(r.id), `La règle « ${r.id} » doit être préfixée par « ${mod.id}. »`);
      check(!rules.has(r.id), `La règle « ${r.id} » existe déjà`);
      staged.rules.push([r.id, { id: r.id, label: r.label, module: mod.id, evaluate: r.evaluate }]);
    }
    for (const [rule, fn] of Object.entries(mod.playbooks ?? {})) {
      check(typeof fn === 'function', `Solution invalide pour « ${rule} »`);
      check(!playbooks.has(rule), `Des solutions existent déjà pour « ${rule} »`);
      staged.playbooks.push([rule, fn]);
    }
    for (const [type, def] of Object.entries(mod.actions ?? {})) {
      check(NAME.test(type) && own(type), `Le type d'action « ${type} » doit être préfixé par « ${mod.id}. »`);
      check(!actions.has(type) && !builtinActionTypes.includes(type), `Le type d'action « ${type} » existe déjà`);
      check(typeof def?.label === 'string' && typeof def.validate === 'function' && typeof def.run === 'function', `Action « ${type} » incomplète (label, validate, run)`);
      // La sensibilité est obligatoire : un module ne peut pas faire sortir des données sans le déclarer.
      check(['interne', 'sensible'].includes(def.sensitivity), `L'action « ${type} » doit déclarer sa sensibilité : « interne » ou « sensible »`);
      staged.actions.push([type, { ...def, module: mod.id }]);
    }
    for (const [event, fn] of Object.entries(mod.on ?? {})) {
      check(typeof fn === 'function', `Réaction invalide à « ${event} »`);
      staged.listeners.push({ event, fn, module: mod.id });
    }
    // Rien n'est enregistré tant que tout le module n'est pas valide.
    staged.rules.forEach(([k, v]) => rules.set(k, v)); staged.playbooks.forEach(([k, v]) => playbooks.set(k, v));
    staged.actions.forEach(([k, v]) => actions.set(k, v)); listeners.push(...staged.listeners);
    modules.set(mod.id, {
      id: mod.id, name: mod.name.trim().slice(0, 80), description: String(mod.description ?? '').slice(0, 300), tier: mod.tier === 'pro' ? 'pro' : 'gratuit',
      core: source === 'integre' && Boolean(mod.core), source, sectors: mod.sectors, categories: mod.categories, starterTasks: mod.starterTasks, templates: mod.templates,
      rules: staged.rules.map(([id, r]) => ({ id, label: r.label })), actions: staged.actions.map(([type, a]) => ({ type, label: a.label, sensitivity: a.sensitivity })),
      events: staged.listeners.map((l) => l.event),
    });
    return modules.get(mod.id);
  }

  const list = () => [...modules.values()];
  const coreIds = () => list().filter((m) => m.core).map((m) => m.id);
  return {
    register,
    reportError: (file, message) => errors.push({ file, message: String(message).slice(0, 300) }),
    errors: () => errors,
    modules: list,
    module: (id) => modules.get(id),
    rule: (id) => rules.get(id),
    rulesFor: (enabled) => [...rules.values()].filter((r) => !enabled || enabled.includes(r.module)),
    playbook: (rule) => playbooks.get(rule),
    action: (type) => actions.get(type),
    actions: () => [...actions.entries()].map(([type, a]) => ({ type, label: a.label, sensitivity: a.sensitivity, module: a.module })),
    listeners: (event, enabled) => listeners.filter((l) => l.event === event && enabled.includes(l.module)),
    // Modules proposés pour un secteur : le socle, les modules transverses et le pack adapté.
    suggest(sector) {
      const packs = list().filter((m) => m.source === 'integre' && m.sectors?.includes(sector)).map((m) => m.id);
      return [...coreIds(), 'automatisations', 'connecteurs', ...packs].filter((id) => modules.has(id));
    },
    sanitize: (ids) => [...new Set([...coreIds(), ...(Array.isArray(ids) ? ids.filter((i) => modules.has(i)) : [])])],
  };
}
