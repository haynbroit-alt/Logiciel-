// Tournage et post-production. Chaque brique est interchangeable :
//   vidéo   : un clip fourni par vous (« apport »), un générateur branché (« commande »), ou à défaut un carton d'animatique ;
//   voix    : un générateur branché, sinon aucune ;
//   musique : un générateur branché, sinon aucune ;
//   montage : ffmpeg (assemblage, transitions, étalonnage, sous-titres, exports 16:9 et 9:16).
// Une brique « commande » est un programme lancé avec des arguments ; les textes y sont passés
// comme arguments séparés, jamais interprétés par un shell.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { now, parseJson } from '../core/db.js';
import { wrap } from './cinema.js';

const FPS = 24;
const MASTER = { paysage: [1920, 1080], portrait: [1080, 1920] };
const FORMATS = { '16x9': { label: '16:9 cinéma', size: [1920, 1080] }, '9x16': { label: '9:16 vertical', size: [1080, 1920] } };
const GRADE_FILTERS = {
  neutre: '', chaud: 'eq=contrast=1.08:saturation=1.1,colorbalance=rs=0.06:bs=-0.06:rh=0.04:bh=-0.05',
  froid: 'eq=contrast=1.1:saturation=0.9,colorbalance=rs=-0.05:bs=0.08:rm=-0.03:bm=0.04', delave: 'eq=contrast=0.92:saturation=0.72:brightness=0.03', noir_blanc: 'hue=s=0,eq=contrast=1.15',
};
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...opts },
  (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(cmd)} : ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`)) : resolve(stdout))));
const stamp = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };

export function createRenderer({ db, audit, config, cinema, fail }) {
  const need = (cond, message, status = 400) => { if (!cond) fail(message, status); };
  let tools = null;
  const detect = () => (tools ??= Object.fromEntries(['ffmpeg', 'ffprobe'].map((t) => [t, spawnSync(t, ['-version'], { timeout: 5000 }).status === 0])));

  // Briques branchées par l'exploitant : fichier JSON { "video": { "commande": ["prog", "--prompt", "{prompt}", "--sortie", "{sortie}"], "cout_par_seconde": 0.05 }, "voix": {…}, "musique": {…} }
  function bricks() {
    const file = path.join(config.dataDir, 'cinema', 'briques.json'); let custom = {};
    if (config.cinemaBricks) custom = config.cinemaBricks; else if (fs.existsSync(file)) { try { custom = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { custom = { erreur: 'briques.json illisible' }; } }
    const one = (key, fallback) => { const b = custom[key]; const ok = b && Array.isArray(b.commande) && b.commande.length && b.commande.every((a) => typeof a === 'string');
      return ok ? { type: 'commande', nom: String(b.nom ?? b.commande[0]).slice(0, 60), commande: b.commande, cout_par_seconde: Math.max(0, Number(b.cout_par_seconde) || 0) } : fallback; };
    return {
      video: one('video', { type: 'carton', nom: 'Carton d\'animatique (texte sur fond uni)', cout_par_seconde: 0 }),
      voix: one('voix', { type: 'aucune', nom: 'Aucune voix', cout_par_seconde: 0 }),
      musique: one('musique', { type: 'aucune', nom: 'Aucune musique', cout_par_seconde: 0 }),
      montage: { type: 'ffmpeg', nom: detect().ffmpeg ? 'ffmpeg' : 'ffmpeg (absent)', cout_par_seconde: 0 },
      fichier: file, erreur: custom.erreur ?? null,
    };
  }
  const fill = (args, vars) => args.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
  const dirOf = (p) => path.join(config.dataDir, 'cinema', `e${p.workspace_id}`, `p${p.id}`);
  const ensure = (p) => { const d = dirOf(p); for (const s of ['plans', 'apports', 'exports', 'tmp']) fs.mkdirSync(path.join(d, s), { recursive: true }); return d; };
  const probe = async (file, cwd) => { const out = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], cwd ? { cwd } : {}));
    return { seconds: Math.round(Number(out.format?.duration ?? 0) * 100) / 100, audio: (out.streams ?? []).some((s) => s.codec_type === 'audio'), video: (out.streams ?? []).find((s) => s.codec_type === 'video') ?? null }; };
  const cost = (p, brick, label, seconds, amount) => db.run('INSERT INTO cinema_costs (workspace_id, project_id, brick, label, seconds, cost, created_at) VALUES (?,?,?,?,?,?,?)', p.workspace_id, p.id, brick, label, Math.round(seconds * 10) / 10, Math.round(amount * 10000) / 10000, now());

  // Met n'importe quelle source au format de travail : même taille, même cadence, piste son présente.
  async function normalize(d, source, target, [W, H], seconds, { fade, voice }) {
    const info = await probe(source, d); const D = Math.max(0.5, Math.min(seconds, info.seconds || seconds));
    // Une source d'un autre format n'est ni déformée ni bordée de noir : elle est posée sur sa propre image agrandie et floutée.
    const tail = [`fps=${FPS}`, 'format=yuv420p', ...(fade ? [`fade=t=in:st=0:d=0.3`, `fade=t=out:st=${Math.max(0, D - 0.3).toFixed(2)}:d=0.3`] : [])].join(',');
    const vf = `[0:v]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}[v]`;
    const af = ['aresample=48000', 'apad', ...(fade ? ['afade=t=in:st=0:d=0.3', `afade=t=out:st=${Math.max(0, D - 0.3).toFixed(2)}:d=0.3`] : [])].join(',');
    const inputs = ['-i', source]; let amap = '0:a:0';
    if (voice) { inputs.push('-i', voice); amap = '1:a:0'; } else if (!info.audio) { inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); amap = '1:a:0'; }
    await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', vf, '-map', '[v]', '-map', amap, '-t', D.toFixed(2), '-af', af, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '12288', target], { cwd: d });
    return (await probe(target, d)).seconds;
  }

  async function carton(d, shot, [W, H], out) {
    const k = H / 1080; const width = W > H ? 52 : 28;
    fs.writeFileSync(path.join(d, 'tmp', 'c1.txt'), `PLAN ${shot.number}  ·  ${shot.scene_title || `Scène ${shot.scene}`}`);
    fs.writeFileSync(path.join(d, 'tmp', 'c2.txt'), `${shot.size} · ${shot.angle} · caméra ${shot.movement}`);
    fs.writeFileSync(path.join(d, 'tmp', 'c3.txt'), wrap(shot.description, width).slice(0, 9).join('\n'));
    fs.writeFileSync(path.join(d, 'tmp', 'c4.txt'), shot.dialogue ? wrap(`${shot.speaker ? `${shot.speaker} : ` : ''}« ${shot.dialogue} »`, width).slice(0, 4).join('\n') : ' ');
    const t = (file, size, y, color) => `drawtext=textfile=tmp/${file}:fontcolor=${color}:fontsize=${Math.round(size * k)}:x=${Math.round(90 * k)}:y=${y}:line_spacing=${Math.round(12 * k)}`;
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x16181d:s=${W}x${H}:r=${FPS}:d=${shot.duration}`, '-vf',
      [t('c1.txt', 44, Math.round(90 * k), '0xf2b84b'), t('c2.txt', 32, Math.round(160 * k), '0x9aa0ad'), t('c3.txt', 50, Math.round(300 * k), 'white'), t('c4.txt', 40, `h-${Math.round(300 * k)}`, '0xc9cdd6')].join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out], { cwd: d });
  }

  // Tourne les plans. Autorisé seulement une fois le storyboard validé : c'est le premier rendu lourd.
  async function shoot(wsId, id) {
    const p = cinema.get(wsId, id); need(p.approvals.storyboard, 'Le storyboard doit être validé avant de tourner les plans : aucun rendu lourd sans approbation.', 409);
    need(detect().ffmpeg && detect().ffprobe, 'ffmpeg est introuvable sur cette machine : le tournage et le montage en dépendent (logiciel libre, à installer).', 503);
    need(p.shots.length <= 150, 'Trop de plans pour un seul tournage (150 au maximum)');
    const d = ensure(p); const B = bricks(); const size = MASTER[p.orientation] ?? MASTER.paysage; const report = [];
    for (const shot of p.shots.filter((s) => !s.clip)) {
      const base = path.join('plans', `plan-${shot.id}`); const raw = path.join('tmp', `brut-${shot.id}.mp4`); let source = null; let origin; let voice = null;
      try {
        const apport = shot.apport ? path.join(d, 'apports', shot.apport) : null;
        if (apport && fs.existsSync(apport)) { source = apport; origin = 'apport'; }
        else if (B.video.type === 'commande') {
          const [cmd, ...args] = fill(B.video.commande, { prompt: shot.prompt, sortie: path.join(d, raw), duree: shot.duration, largeur: size[0], hauteur: size[1] });
          await run(cmd, args, { cwd: d }); need(fs.existsSync(path.join(d, raw)), `Le générateur vidéo n'a produit aucun fichier pour le plan ${shot.number}`);
          source = raw; origin = B.video.nom; cost(p, 'video', `Plan ${shot.number} — ${B.video.nom}`, shot.duration, shot.duration * B.video.cout_par_seconde);
        } else origin = 'carton';
        if (shot.dialogue && origin !== 'apport' && B.voix.type === 'commande') {
          const wav = path.join('tmp', `voix-${shot.id}.wav`); const [cmd, ...args] = fill(B.voix.commande, { texte: shot.dialogue, voix: shot.speaker, sortie: path.join(d, wav) });
          await run(cmd, args, { cwd: d });
          if (fs.existsSync(path.join(d, wav))) { voice = wav; cost(p, 'voix', `Plan ${shot.number} — ${B.voix.nom}`, shot.duration, shot.duration * B.voix.cout_par_seconde); }
        }
        // Chaque plan est préparé dans les deux formats de diffusion, directement depuis sa source.
        let seconds = 0;
        for (const [key, f] of Object.entries(FORMATS)) {
          if (origin === 'carton') await carton(d, shot, f.size, raw);
          seconds = await normalize(d, origin === 'carton' ? raw : source, `${base}-${key}.mp4`, f.size, shot.duration, { fade: p.transition === 'fondu', voice });
        }
        db.run('UPDATE cinema_shots SET clip = ?, clip_seconds = ?, clip_origin = ? WHERE id = ?', base, seconds, origin, shot.id);
        report.push({ plan: shot.number, origine: origin, secondes: seconds });
      } catch (e) { report.push({ plan: shot.number, erreur: e.message }); }
    }
    if (p.shots.some((s) => s.apport && !fs.existsSync(path.join(d, 'apports', s.apport)))) report.push({ avertissement: `Certains apports sont introuvables dans ${path.join(d, 'apports')}` });
    audit.record({ workspaceId: wsId, actor: 'omnia', event: 'cinema.plans_tournes', entity: 'cinema', entityId: id, detail: { plans: report.filter((r) => r.secondes).length, echecs: report.filter((r) => r.erreur).length } });
    return { ...cinema.get(wsId, id, { frames: true }), rapport: report, dossier_apports: path.join(d, 'apports') };
  }

  function writeSrt(d, shots) {
    let t = 0; let n = 0; const lines = [];
    for (const s of shots) { const D = s.clip_seconds ?? s.duration; if (s.dialogue) { n += 1; lines.push(String(n), `${stamp(t + 0.15)} --> ${stamp(t + Math.max(0.6, D - 0.15))}`, ...wrap(`${s.speaker ? `${s.speaker} : ` : ''}${s.dialogue}`, 42).slice(0, 3), ''); } t += D; }
    fs.writeFileSync(path.join(d, 'exports', 'sous-titres.srt'), lines.join('\n'));
    return { count: n, seconds: Math.round(t * 100) / 100 };
  }

  // Un film muet ne peut pas être normalisé en volume : on mesure d'abord s'il contient du son.
  async function hasSound(d, file) {
    const log = await new Promise((resolve) => execFile('ffmpeg', ['-v', 'info', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { cwd: d, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) => resolve(String(se))));
    const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(log);
    return Boolean(m) && m[1] !== '-inf' && Number(m[1]) > -70;
  }

  async function encode(d, master, out, [W, H], p, { subtitles, music, draft }) {
    const norm = music || await hasSound(d, master) ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : '';
    const land = W > H;
    const chain = [`scale=${W}:${H}`, GRADE_FILTERS[p.grade] ?? '', subtitles ? `subtitles=exports/sous-titres.srt:force_style='FontSize=${land ? 14 : 9},MarginV=${land ? 18 : 46},Outline=1,Shadow=0'` : ''].filter(Boolean).join(',');
    const audio = music ? `[1:a]volume=0.22,apad[m];[0:a][m]amix=inputs=2:duration=first:normalize=0${norm}[au]` : `[0:a]anull${norm}[au]`;
    await run('ffmpeg', ['-y', '-v', 'error', '-i', master, ...(music ? ['-i', music] : []), '-filter_complex', `[0:v]${chain}[v];${audio}`, '-map', '[v]', '-map', '[au]', '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '28' : '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', draft ? '96k' : '192k', '-ar', '48000', '-movflags', '+faststart', out], { cwd: d });
  }

  // Prémontage : après validation des plans. Export final : après validation du montage, en 16:9 et en 9:16.
  async function assemble(wsId, id, kind) {
    need(['premontage', 'final'].includes(kind), 'Type d\'assemblage inconnu');
    const p = cinema.get(wsId, id);
    need(kind === 'final' ? p.approvals.montage : p.approvals.plans, kind === 'final' ? 'Le montage final doit être validé avant l\'export : aucun export final sans approbation.' : 'Les plans doivent être validés avant d\'assembler le prémontage.', 409);
    need(detect().ffmpeg, 'ffmpeg est introuvable sur cette machine.', 503);
    const d = ensure(p); const B = bricks(); const missing = p.shots.filter((s) => !s.clip || Object.keys(FORMATS).some((k) => !fs.existsSync(path.join(d, `${s.clip}-${k}.mp4`))));
    need(!missing.length, `${missing.length} plan(s) n'ont plus de fichier : relancez le tournage.`, 409);
    const master = async (key) => {
      fs.writeFileSync(path.join(d, 'tmp', `liste-${key}.txt`), p.shots.map((s) => `file '../${s.clip}-${key}.mp4'`).join('\n'));
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `tmp/liste-${key}.txt`, '-c', 'copy', `tmp/master-${key}.mp4`], { cwd: d });
      return `tmp/master-${key}.mp4`;
    };
    const srt = writeSrt(d, p.shots); const total = srt.seconds; let music = null;
    if (kind === 'final' && B.musique.type === 'commande') {
      const [cmd, ...args] = fill(B.musique.commande, { prompt: `${p.style || ''} ${p.idea || p.title}`.trim(), duree: total, sortie: path.join(d, 'tmp', 'musique.wav') });
      await run(cmd, args, { cwd: d });
      if (fs.existsSync(path.join(d, 'tmp', 'musique.wav'))) { music = 'tmp/musique.wav'; cost(p, 'musique', B.musique.nom, total, total * B.musique.cout_par_seconde); }
    }
    const burn = Boolean(p.subtitles) && srt.count > 0; const made = []; const tag = Date.now().toString(36);
    const own = p.orientation === 'portrait' ? '9x16' : '16x9';
    const targets = kind === 'final' ? Object.entries(FORMATS).map(([k, f]) => [k, f.size, k]) : [['apercu', FORMATS[own].size.map((n) => Math.round(n / 3 / 2) * 2), own]];
    db.run("DELETE FROM cinema_exports WHERE project_id = ? AND kind = ?", id, kind);
    for (const [key, size, source] of targets) {
      const file = path.join('exports', `${kind}-${key}-${tag}.mp4`);
      await encode(d, await master(source), file, size, p, { subtitles: burn, music, draft: kind === 'premontage' });
      const info = await probe(file, d);
      db.run('INSERT INTO cinema_exports (workspace_id, project_id, kind, format, file, seconds, width, height, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', wsId, id, kind, key, file, info.seconds, info.video?.width ?? size[0], info.video?.height ?? size[1], fs.statSync(path.join(d, file)).size, now());
      made.push({ format: key, secondes: info.seconds, taille: `${info.video?.width}x${info.video?.height}` });
    }
    audit.record({ workspaceId: wsId, actor: 'omnia', event: kind === 'final' ? 'cinema.export_final' : 'cinema.premontage', entity: 'cinema', entityId: id, detail: { fichiers: made, sous_titres: srt.count, musique: Boolean(music) } });
    return { ...cinema.get(wsId, id, { frames: true }), produit: made, sous_titres: { repliques: srt.count, incrustes: burn } };
  }

  function exportFile(wsId, id, exportId) {
    const p = cinema.raw(wsId, id); const e = db.get('SELECT * FROM cinema_exports WHERE id = ? AND project_id = ?', exportId, id); need(e, 'Export introuvable', 404);
    const file = path.join(dirOf(p), e.file); need(fs.existsSync(file), 'Le fichier de cet export n\'existe plus', 410);
    return { path: file, type: 'video/mp4', name: `${p.title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').slice(0, 60)}-${e.kind}-${e.format}.mp4` };
  }

  return { shoot, assemble, exportFile, bricks, tools: detect, formats: FORMATS, dirOf: (wsId, id) => ensure(cinema.raw(wsId, id)),
    info: () => { const B = bricks(); return { outils: detect(), briques: { video: B.video, voix: B.voix, musique: B.musique, montage: B.montage }, fichier_briques: B.fichier, erreur: B.erreur }; } };
}
