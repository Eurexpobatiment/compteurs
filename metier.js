/* Relevés compteurs – Eurexpo · version Firebase
 * Calculs de l'appli (repris à l'identique du script Google : Code.gs, Eau.gs, Devis.gs).
 * Aucune dépendance : utilisé par la page (window.Metier) et par les tests (Node).
 *
 * Données (Firestore) :
 *   CptCompteurs/{id} : { num, rang, secteur, ordre, type, usage, designation, localisation, unite, role, actif, remarque,
 *                         r: { 'AAAA-MM': { date, index, conso, ctrl, statut, qui, com, ancien, ts, src } } }
 *   CptConfig/devis    : { tarifs: { client: { elec, eau, … } }, compteurs: [ { num, lieu, client, cat, coef, facture, remarque } ] }
 *   CptConfig/registre : { liste: [ { numero, edite, client, periode, totalHT, tva, totalTTC, tarifs } ] }
 */
(function (root) {
'use strict';

const CFG = {
  SAUT_FACTEUR: 3,                                  // alerte si conso > 3 × conso habituelle du compteur
  SAUT_MINI: { EAU: 5, GAZ: 50, ELC: 200, FUEL: 100 }, // … et au moins cet écart (unités du compteur)
  RECUL_JOURS_PERIODE: 10,                          // relevé du 2 février → période janvier
};

// ───────────────────────── Dates / formats
const pad = n => String(n).padStart(2, '0');
function asDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1) : null;
}
const iso = d => d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : '';
const cle = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);          // clé de période 'AAAA-MM'
const moisDebut = d => new Date(d.getFullYear(), d.getMonth(), 1);
function periodeDe(date) { const d = new Date(date); d.setDate(d.getDate() - CFG.RECUL_JOURS_PERIODE); return moisDebut(d); }
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function nombre(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const arrondi = x => Math.round(x * 1000) / 1000;
const fmt = x => x === null || x === undefined ? '–' : Number(x).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const frDate = d => d ? pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() : '';
const numOuNull = v => v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v);

// ───────────────────────── Lecture des documents
function lireCompteurs(docs) {
  return docs.slice().sort((a, b) => (a.rang || 0) - (b.rang || 0)).map(d => ({
    num: String(d.num).trim(), secteur: d.secteur || '', ordre: Number(d.ordre) || 999, type: d.type || '', usage: d.usage || '',
    designation: d.designation || '', localisation: d.localisation || '', unite: d.unite || '', role: d.role || '',
    actif: d.actif !== false, remarque: d.remarque || '',
  }));
}
function releveDe(num, k, e) {
  return { date: asDate(e.date), per: asDate(k), num: num, index: numOuNull(e.index), conso: numOuNull(e.conso),
    ctrl: e.ctrl || '', statut: e.statut || '', qui: e.qui || '', com: e.com || '', ancien: numOuNull(e.ancien), ts: e.ts || '', cle: k };
}
function lireReleves(docs) {
  const out = [];
  docs.slice().sort((a, b) => (a.rang || 0) - (b.rang || 0)).forEach(d => {
    const r = d.r || {};
    Object.keys(r).sort().forEach(k => { if (/^\d{4}-\d{2}$/.test(k) && r[k]) out.push(releveDe(String(d.num).trim(), k, r[k])); });
  });
  return out;
}
function parCompteur(rel) {
  const m = {};
  rel.forEach(r => (m[r.num] = m[r.num] || []).push(r));
  Object.keys(m).forEach(k => m[k].sort((a, b) => a.per - b.per));
  return m;
}
/** Dernier index valide strictement avant la période donnée. */
function indexPrecedent(liste, per) {
  for (let i = liste.length - 1; i >= 0; i--) {
    const r = liste[i];
    if (r.per < per && r.index !== null && r.ctrl !== 'Valeur suspecte') return r;
  }
  return null;
}
/** Conso mensuelle « normale » : médiane des 12 dernières consos ≥ 0 (null si moins de 3). */
function consoRef(liste, per) {
  const c = liste.filter(r => r.per < per && r.conso !== null && r.conso >= 0 && !/suspect|Saut|baisse/i.test(r.ctrl || ''))
    .slice(-12).map(r => r.conso);
  return c.length >= 3 ? median(c) : null;
}

// ───────────────────────── Saisie
function etatCompteur(c, liste, per) {
  const prev = indexPrecedent(liste, per);
  const ref = consoRef(liste, per);
  const cur = liste.find(r => +r.per === +per);
  const hist = liste.filter(r => r.conso !== null).slice(-6).map(r => r.conso);
  return Object.assign({}, c, {
    prevIndex: prev ? prev.index : null, prevDate: prev ? iso(prev.date) : '', prevPer: prev ? iso(prev.per) : '',
    ref, hist,
    cur: cur ? { index: cur.index, conso: cur.conso, statut: cur.statut, com: cur.com, qui: cur.qui, ctrl: cur.ctrl,
      date: iso(cur.date), ancien: cur.ancien } : null,
  });
}
function getInit(docs, now) {
  now = now || new Date();
  const cpt = lireCompteurs(docs).filter(c => c.actif);
  const pc = parCompteur(lireReleves(docs));
  const per = periodeDe(now);
  const secteurs = [];
  cpt.forEach(c => { if (secteurs.indexOf(c.secteur) < 0) secteurs.push(c.secteur); });
  return { periode: iso(per), aujourdhui: iso(now), secteurs, compteurs: cpt.map(c => etatCompteur(c, pc[c.num] || [], per)) };
}
function getPeriode(docs, perIso) {
  const per = asDate(perIso);
  const pc = parCompteur(lireReleves(docs));
  return lireCompteurs(docs).filter(c => c.actif).map(c => etatCompteur(c, pc[c.num] || [], per));
}

/** Recalcule les consos d'un compteur (garde « Saut confirmé » / « Changement compteur »).
 *  map : { 'AAAA-MM': entrée } — renvoie les clés modifiées { clé: nouvelle entrée }. */
function recalculer(cpt, map) {
  const out = {};
  if (!cpt || cpt.unite === '%' || cpt.unite === '—') return out;
  let prev = null;
  Object.keys(map).sort().forEach(k => {
    const e = map[k];
    if (!e) return;
    const index = numOuNull(e.index), ancien = numOuNull(e.ancien), consoAv = numOuNull(e.conso), ctrlAv = e.ctrl || '';
    if (index === null || ctrlAv === 'Valeur suspecte') return;
    let conso = null, ctrl = ctrlAv;
    if (e.statut === 'Changement compteur') {
      conso = (prev !== null && ancien !== null ? Math.max(0, ancien - prev) : 0) + index;
    } else if (prev !== null) {
      const d = arrondi(index - prev);
      if (d < 0) ctrl = 'Index en baisse';
      else { conso = d; if (ctrl === 'Index en baisse') ctrl = ''; }
    }
    if (conso !== consoAv || ctrl !== ctrlAv) out[k] = Object.assign({}, e, { conso, ctrl });
    prev = index;
  });
  return out;
}

/**
 * Prépare l'enregistrement d'un relevé (mêmes contrôles que le script).
 * p = { num, date, periode, index, statut, commentaire, releveur, confirme, ancien }
 * Retour : { ok:false, code, message } ou { ok:true, id, maj:{clé: entrée}, compteur }
 */
function preparerReleve(docs, p, now) {
  now = now || new Date();
  const doc = docs.find(d => String(d.num).trim() === String(p.num));
  const cpt = doc && lireCompteurs([doc])[0];
  if (!cpt) return { ok: false, code: 'INCONNU', message: 'Compteur ' + p.num + ' introuvable.' };
  const date = asDate(p.date), per = asDate(p.periode) || (date && periodeDe(date));
  if (!date) return { ok: false, code: 'DATE', message: 'Date du relevé manquante.' };
  if (date > now) return { ok: false, code: 'DATE', message: 'La date du relevé est dans le futur.' };
  const statut = p.statut || 'OK';
  const releveur = String(p.releveur || '').trim();
  if (!releveur) return { ok: false, code: 'QUI', message: 'Indiquez le nom du releveur (en haut de l\'écran).' };

  const liste = lireReleves([doc]).sort((a, b) => a.per - b.per);
  const prev = indexPrecedent(liste, per);
  const ref = consoRef(liste, per);

  let index = null, conso = null, ancien = null, ctrl = '';
  const avecIndex = statut === 'OK' || statut === 'Changement compteur';
  if (avecIndex) {
    index = nombre(p.index);
    if (index === null || index < 0) return { ok: false, code: 'FORMAT', message: 'Index invalide : saisir uniquement des chiffres.' };
    if (statut === 'Changement compteur') {
      ancien = nombre(p.ancien);
      if (ancien === null) return { ok: false, code: 'ANCIEN', message: 'Saisir l\'index final de l\'ancien compteur.' };
      conso = (prev && cpt.unite !== '%' ? Math.max(0, ancien - prev.index) : 0) + index;
      ctrl = 'Changement compteur';
    } else if (prev && cpt.unite !== '%') {
      conso = arrondi(index - prev.index);
      if (conso < 0) {
        return { ok: false, code: 'BAISSE',
          message: 'Index inférieur au précédent (' + fmt(prev.index) + ' le ' + frDate(prev.date) + '). '
            + 'Vérifier la saisie ; si le compteur a été remplacé, choisir le statut « Changement compteur ».' };
      }
      const mini = CFG.SAUT_MINI[cpt.type] || 0;
      if (ref !== null && conso > CFG.SAUT_FACTEUR * ref && conso - ref > mini) {
        if (!p.confirme) {
          return { ok: false, code: 'SAUT',
            message: 'Conso de ' + fmt(conso) + ' ' + cpt.unite + ' alors que ce compteur consomme d\'habitude ~'
              + fmt(ref) + ' ' + cpt.unite + '/mois. Vérifier l\'index, puis confirmer si c\'est bien la valeur affichée.' };
        }
        ctrl = 'Saut confirmé';
      }
    }
  }
  if (!avecIndex && !String(p.commentaire || '').trim() && statut !== 'HS') {
    return { ok: false, code: 'COM', message: 'Ajouter un commentaire (pourquoi le compteur n\'est pas relevé).' };
  }

  const k = cle(per);
  const entree = { date: iso(date), index, conso, ctrl, statut, qui: releveur, com: String(p.commentaire || '').trim(),
    ancien, ts: now.toISOString(), src: 'Appli' };
  const map = Object.assign({}, doc.r || {});
  map[k] = entree;
  const maj = { [k]: entree };
  const rec = recalculer(cpt, map);       // l'index suivant éventuel (saisie d'un mois passé) est recalculé
  Object.keys(rec).forEach(x => { maj[x] = rec[x]; map[x] = rec[x]; });
  const apres = Object.assign({}, doc, { r: map });
  return { ok: true, id: doc.id, maj, compteur: etatCompteur(cpt, lireReleves([apres]).sort((a, b) => a.per - b.per), per) };
}

// ───────────────────────── Contrôles et historique
function getControles(docs, perIso, now) {
  const per = asDate(perIso) || periodeDe(now || new Date());
  const cpt = lireCompteurs(docs);
  const cm = {}; cpt.forEach(c => cm[c.num] = c);
  const rel = lireReleves(docs);
  const signales = rel.filter(r => r.ctrl && r.ctrl !== 'Changement compteur' && cm[r.num])
    .sort((a, b) => (b.per - a.per) || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || a.num.localeCompare(b.num, 'fr', { numeric: true }))
    .slice(0, 150)
    .map(r => ({ num: r.num, designation: cm[r.num].designation, localisation: cm[r.num].localisation, type: cm[r.num].type,
      unite: cm[r.num].unite, per: iso(r.per), date: iso(r.date), index: r.index, conso: r.conso, ctrl: r.ctrl, com: r.com }));
  const faits = {}; rel.filter(r => +r.per === +per).forEach(r => faits[r.num] = r);
  const manquants = cpt.filter(c => c.actif && !faits[c.num]).map(c => ({ num: c.num, designation: c.designation, secteur: c.secteur, type: c.type }));
  const nonReleves = cpt.filter(c => c.actif && faits[c.num] && faits[c.num].index === null)
    .map(c => ({ num: c.num, designation: c.designation, type: c.type, statut: faits[c.num].statut, com: faits[c.num].com }));
  return { periode: iso(per), signales, manquants, nonReleves };
}
function getHistorique(docs, num) {
  const doc = docs.find(d => String(d.num).trim() === String(num));
  const c = doc ? lireCompteurs([doc])[0] : null;
  const l = doc ? lireReleves([doc]).sort((a, b) => a.per - b.per).slice(-25) : [];
  return { compteur: c, releves: l.map(r => ({ per: iso(r.per), date: iso(r.date), index: r.index, conso: r.conso,
    statut: r.statut, ctrl: r.ctrl, qui: r.qui, com: r.com })) };
}

// ───────────────────────── Synthèse eau / détection de fuites (Eau.gs)
function getEau(docs) {
  const cpt = lireCompteurs(docs).filter(c => c.type === 'EAU' && c.actif)
    .map(c => ({ num: c.num, secteur: c.secteur, designation: c.designation, localisation: c.localisation, role: c.role || 'Divisionnaire' }));
  const rows = lireReleves(docs).map(r => ({ num: r.num, per: r.per, avecIndex: r.index !== null, conso: r.conso, ctrl: r.ctrl }));
  return calculEau(cpt, rows);
}
/** cpt : [{num, secteur, designation, localisation, role}] · rows : [{num, per:Date, avecIndex, conso|null, ctrl}] */
function calculEau(cpt, rows) {
  const NB_MOIS = 13;
  const key = d => d.getFullYear() * 12 + d.getMonth();
  const r1 = x => x === null ? null : Math.round(x * 10) / 10;
  const fr = x => Number(x).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const cm = {}; cpt.forEach(c => cm[c.num] = c);
  const conso = {}, lus = {};
  let maxKey = 0;
  rows.forEach(r => {
    if (!cm[r.num] || !(r.per instanceof Date)) return;
    const k = key(r.per);
    if (r.avecIndex) { (lus[r.num] = lus[r.num] || {})[k] = true; maxKey = Math.max(maxKey, k); }
    if (r.conso !== null && r.conso !== undefined && !/suspect|baisse/i.test(String(r.ctrl || ''))) (conso[r.num] = conso[r.num] || {})[k] = Number(r.conso);
  });
  if (!maxKey) return { mois: [], gen: [], div: [], nappe: [], ecart: [], compteurs: [], alertes: [] };

  const keys = []; for (let k = maxKey - NB_MOIS + 1; k <= maxKey; k++) keys.push(k);
  const toDate = k => new Date(Math.floor(k / 12), k % 12, 1);
  const somme = (role, k) => cpt.filter(c => c.role === role).reduce((s, c) => s + ((conso[c.num] || {})[k] || 0), 0);
  const ecartDe = k => { const g = somme('Arrivée générale', k); return g ? g - somme('Divisionnaire', k) : null; };
  const res = {
    mois: keys.map(k => iso(toDate(k))),
    gen: keys.map(k => r1(somme('Arrivée générale', k))),
    div: keys.map(k => r1(somme('Divisionnaire', k))),
    nappe: keys.map(k => r1(somme('Nappe', k))),
    ecart: keys.map(k => r1(ecartDe(k))),
    compteurs: [], alertes: [],
  };
  const dernier = maxKey;
  const ordreRole = { 'Arrivée générale': 0, 'Nappe': 1, 'Divisionnaire': 2, 'Aval adoucisseur': 3 };
  cpt.forEach(c => {
    const h = conso[c.num] || {};
    const prec = []; for (let k = dernier - 12; k < dernier; k++) if (h[k] !== undefined) prec.push(h[k]);
    const ref = prec.length >= 3 ? median(prec) : null;
    const v = h[dernier] !== undefined ? h[dernier] : null;
    const item = { num: c.num, designation: c.designation, localisation: c.localisation, role: c.role, secteur: c.secteur,
      conso: keys.map(k => h[k] !== undefined ? r1(h[k]) : null), ref: r1(ref), dernier: r1(v),
      ratio: ref && v !== null ? Math.round(v / ref * 10) / 10 : null, alerte: '' };
    if (!(lus[c.num] || {})[dernier] && c.role === 'Arrivée générale') {
      res.alertes.push({ niveau: 'info', num: c.num, titre: 'Arrivée générale non relevée', detail: c.designation + ' : pas d\'index pour le dernier mois, le bilan est incomplet.' });
    }
    if (v !== null && ref !== null) {
      if (ref <= 0.5 && v >= 2) {
        item.alerte = 'Débit inhabituel';
        res.alertes.push({ niveau: 'haute', num: c.num, titre: 'Débit sur un compteur habituellement à l\'arrêt',
          detail: c.designation + ' – ' + c.localisation + ' : ' + fr(v) + ' m³ le mois dernier (habituellement ~0). Fuite possible (robinet, chasse, ballon ECS).' });
      } else if (v > 2 * ref && v - ref > 5) {
        item.alerte = 'Hausse';
        res.alertes.push({ niveau: v > 4 * ref ? 'haute' : 'moyenne', num: c.num, titre: 'Consommation en forte hausse',
          detail: c.designation + ' – ' + c.localisation + ' : ' + fr(v) + ' m³ contre ~' + fr(ref) + ' m³/mois habituellement (×' + item.ratio + ').' });
      }
    }
    const trois = [dernier - 2, dernier - 1, dernier].map(k => h[k]);
    if (!item.alerte && ref !== null && ref <= 0.5 && trois.every(x => x !== undefined && x > 0)) {
      item.alerte = 'Continu';
      res.alertes.push({ niveau: 'moyenne', num: c.num, titre: 'Petit débit continu', detail: c.designation + ' consomme un peu chaque mois depuis 3 mois.' });
    }
    res.compteurs.push(item);
  });
  res.compteurs.sort((a, b) => (ordreRole[a.role] ?? 9) - (ordreRole[b.role] ?? 9) || (b.ratio || 0) - (a.ratio || 0));
  const ec = []; for (let k = dernier - 12; k < dernier; k++) { const e = ecartDe(k); if (e !== null) ec.push(e); }
  const refEc = ec.length >= 3 ? median(ec) : null, eNow = ecartDe(dernier);
  if (refEc !== null && eNow !== null && eNow > 1.5 * refEc && eNow - refEc > 200) {
    res.alertes.push({ niveau: 'haute', num: '', titre: 'Eau non comptabilisée en hausse',
      detail: 'Écart arrivées générales – sous-compteurs : ' + fr(eNow) + ' m³ contre ~' + fr(refEc) + ' m³/mois habituellement. À rapprocher du planning des salons ; hors salon, chercher une fuite sur le réseau.' });
  }
  res.refEcart = r1(refEc);
  const rang = { haute: 0, moyenne: 1, info: 2 };
  res.alertes.sort((a, b) => rang[a.niveau] - rang[b.niveau]);
  return res;
}

// ───────────────────────── Devis (Devis.gs)
const DV = {
  PREFIXE: 'DEV-CH',
  CLIENTS: ['FOODEXPO', 'CELLERIER EVENTS'],
  CATS: ['ELECTRICITE', 'EAU FROIDE BRUTE', 'EAU FROIDE ADOUCIE', 'EAU CHAUDE ADOUCIE', 'GAZ'],
  TARIFS: [
    ['elec', 'Électricité', '€ HT / kWh', 0.163],
    ['eau', 'Eau froide brute', '€ HT / m³', 3.67],
    ['coefAdoucie', 'Coefficient eau froide adoucie', '× eau brute', 1.2],
    ['coefChaude', 'Coefficient eau chaude adoucie', '× eau brute', 1.5],
    ['gaz', 'Gaz', '€ HT / kWh', 0.147],
    ['convGaz', 'Conversion gaz', 'kWh / m³', 11.2],
    ['tva', 'TVA', '%', 20],
  ],
  LIEUX: [
    [/CANUTS|BELLECOUR/i, 'FOODEXPO'], [/ONLY/i, 'FOODEXPO'], [/ZONE\s*23/i, 'FOODEXPO'], [/ZONE\s*56/i, 'FOODEXPO'], [/CARRE/i, 'FOODEXPO'],
    [/SANDWICH/i, 'CELLERIER EVENTS'], [/BAR\s*1\b/i, 'CELLERIER EVENTS'], [/BAR\s*2/i, 'CELLERIER EVENTS'], [/BAR\s*3/i, 'CELLERIER EVENTS'],
    [/BAR\s*4/i, 'CELLERIER EVENTS'], [/BAR\s*5/i, 'CELLERIER EVENTS'], [/BAR\s*6/i, 'CELLERIER EVENTS'],
  ],
  MOIS: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
const dvR = (x, d) => { const p = Math.pow(10, d); return Math.round((Number(x) || 0) * p) / p; };
function dvMoisLbl(isoS) { const m = String(isoS).match(/^(\d{4})-(\d{2})/); return m ? DV.MOIS[+m[2] - 1] + ' ' + m[1] : String(isoS); }

function dvTousTarifs(config) {
  const out = {};
  DV.CLIENTS.forEach(c => {
    const t = {};
    DV.TARIFS.forEach(d => t[d[0]] = d[3]);
    const s = (config && config.tarifs && config.tarifs[c]) || {};
    DV.TARIFS.forEach(d => { const v = s[d[0]]; if (v !== '' && v !== null && v !== undefined && !isNaN(Number(v))) t[d[0]] = Number(v); });
    out[c] = t;
  });
  return out;
}
function dvTarifsFusion(config, client, tarifs) {
  const all = dvTousTarifs(config);
  const t = Object.assign({}, all[client] || all[DV.CLIENTS[0]]);
  Object.keys(tarifs || {}).forEach(k => { if (tarifs[k] !== '' && tarifs[k] !== null && !isNaN(Number(tarifs[k]))) t[k] = Number(tarifs[k]); });
  return t;
}
/** Nouveaux tarifs d'un client (renvoie la config modifiée). */
function dvSaveTarifs(config, client, t) {
  if (DV.CLIENTS.indexOf(client) < 0) throw new Error('Client inconnu : ' + client);
  const tarifs = dvTousTarifs(config);
  DV.TARIFS.forEach(d => { const k = d[0]; if (t && t[k] !== undefined && t[k] !== '' && t[k] !== null && !isNaN(Number(t[k]))) tarifs[client][k] = Number(t[k]); });
  return Object.assign({}, config, { tarifs });
}
function dvCategorie(c) {
  if (c.type === 'ELC') return 'ELECTRICITE';
  if (c.type === 'GAZ') return 'GAZ';
  const loc = (c.localisation || '') + ' ' + (c.designation || '');
  if (/chaude|ECS/i.test(loc)) return 'EAU CHAUDE ADOUCIE';
  if (/adouci/i.test(loc)) return 'EAU FROIDE ADOUCIE';
  return 'EAU FROIDE BRUTE';
}
function dvClientDefaut(des) { for (const l of DV.LIEUX) if (l[0].test(des)) return l[1]; return DV.CLIENTS[0]; }
function dvOrdreLieu(des) { for (let i = 0; i < DV.LIEUX.length; i++) if (DV.LIEUX[i][0].test(des)) return i; return 99; }

/** Liste des compteurs facturés, complétée des nouveaux compteurs « Restauration ». → { liste, ajoutes } */
function dvListe(docs, config) {
  const liste = ((config && config.compteurs) || []).filter(x => String(x.num || '').trim() !== '').map(x => Object.assign({}, x, { num: String(x.num).trim() }));
  const deja = {}; liste.forEach(x => deja[x.num] = 1);
  const ajout = [];
  lireCompteurs(docs).filter(c => /restauration/i.test(c.usage) && !deja[c.num]).forEach(c => {
    const cat = dvCategorie(c);
    let coef = 1, facture = true, remarque = '';
    if (/SANDWICH/i.test(c.designation) && c.type === 'EAU') { facture = false; remarque = 'Eau sandwicherie comprise dans ONLY LYON'; }
    if (/BAR\s*1\b/i.test(c.designation) && c.type === 'ELC') { coef = 0.6; remarque = 'Coefficient 0,6 sur la consommation'; }
    ajout.push({ num: c.num, lieu: c.designation, client: dvClientDefaut(c.designation), cat, coef, facture, remarque });
  });
  ajout.sort((a, b) => dvOrdreLieu(a.lieu) - dvOrdreLieu(b.lieu) || DV.CATS.indexOf(a.cat) - DV.CATS.indexOf(b.cat));
  return { liste: liste.concat(ajout), ajoutes: ajout.length };
}
function dvCompteurs(docs, config) {
  const ref = {}; lireCompteurs(docs).forEach(c => ref[c.num] = c);
  return dvListe(docs, config).liste.map((r, i) => {
    const c = ref[r.num] || {};
    return { num: r.num, lieu: String(r.lieu || c.designation || ''), client: String(r.client || ''), cat: String(r.cat || ''),
      coef: r.coef === '' || r.coef === null || r.coef === undefined ? 1 : Number(r.coef), facture: r.facture !== false,
      remarque: String(r.remarque || ''), localisation: c.localisation || '', unite: c.unite || '', ordre: i };
  });
}
function dvSaveCompteurs(docs, config, lignes) {
  const liste = dvListe(docs, config).liste;
  const parNum = {}; (lignes || []).forEach(l => parNum[String(l.num)] = l);
  liste.forEach(r => {
    const l = parNum[r.num]; if (!l) return;
    if (DV.CLIENTS.indexOf(l.client) >= 0) r.client = l.client;
    if (DV.CATS.indexOf(l.cat) >= 0) r.cat = l.cat;
    if (l.coef !== '' && l.coef !== null && !isNaN(Number(l.coef))) r.coef = Number(l.coef);
    r.facture = !!l.facture;
  });
  return Object.assign({}, config, { compteurs: liste.map(r => ({ num: r.num, lieu: r.lieu || '', client: r.client || '', cat: r.cat || '',
    coef: r.coef === undefined ? 1 : r.coef, facture: r.facture !== false, remarque: r.remarque || '' })) });
}
function dvHistorique(registre) {
  return ((registre && registre.liste) || []).map(r => {
    const d = r.edite ? new Date(r.edite) : null;
    return { numero: String(r.numero), date: d && !isNaN(d) ? frDate(d) : String(r.edite || ''), client: String(r.client || ''),
      periode: String(r.periode || ''), totalHT: Number(r.totalHT) || 0, totalTTC: Number(r.totalTTC) || 0, pdf: '', xlsx: '' };
  }).reverse().slice(0, 30);
}
function getDevisInit(docs, config, registre) {
  const cfg = dvCompteurs(docs, config);
  const nums = {}; cfg.forEach(c => nums[c.num] = 1);
  const pers = {};
  lireReleves(docs).forEach(r => { if (nums[r.num] && r.per) pers[iso(r.per)] = 1; });
  return {
    tarifs: dvTousTarifs(config),
    tarifsDef: DV.TARIFS.map(t => ({ k: t[0], lbl: t[1], unite: t[2] })),
    clients: DV.CLIENTS.slice(), cats: DV.CATS.slice(), compteurs: cfg,
    periodes: Object.keys(pers).sort().reverse().map(p => ({ iso: p, lbl: dvMoisLbl(p) })),
    historique: dvHistorique(registre),
  };
}
function dvCalcul(docs, config, perIso, client, t) {
  const cfg = dvCompteurs(docs, config).filter(c => c.facture && c.client === client);
  const byNum = parCompteur(lireReleves(docs));
  const m = String(perIso).match(/^(\d{4})-(\d{2})/);
  if (!m) throw new Error('Période invalide.');
  const per = new Date(+m[1], +m[2] - 1, 1);
  const pu = {
    'ELECTRICITE': t.elec, 'EAU FROIDE BRUTE': t.eau,
    'EAU FROIDE ADOUCIE': dvR(t.eau * t.coefAdoucie, 4), 'EAU CHAUDE ADOUCIE': dvR(t.eau * t.coefChaude, 4), 'GAZ': t.gaz,
  };
  let dateReleve = null;
  const alertes = [], lieux = [], idx = {};
  let n = 0;
  cfg.forEach(c => {
    const liste = byNum[c.num] || [];
    const cur = liste.filter(r => r.per && r.per.getTime() === per.getTime()).pop() || null;
    const prev = indexPrecedent(liste, per);
    const iPrev = prev ? prev.index : null, iCur = cur ? cur.index : null;
    const notes = [];
    let alerte = '', conso = null;
    if (cur && cur.conso !== null && !isNaN(cur.conso)) conso = cur.conso;
    else if (cur && cur.ctrl) alerte = cur.ctrl + ' (index ' + cur.index + ') – conso non comptée, à corriger dans « À vérifier »';
    else if (iCur !== null && iPrev !== null) conso = iCur - iPrev;
    if (!cur) notes.push('Non relevé');
    else if (cur.statut && cur.statut !== 'OK') notes.push(cur.statut);
    if (cur && cur.ctrl && !alerte) alerte = cur.ctrl + ' – à vérifier';
    if (alerte) notes.unshift('⚠ ' + alerte);
    if (conso !== null && conso < 0) { notes.push('Conso négative ramenée à 0'); conso = 0; }
    if (c.remarque) notes.push(c.remarque);
    if (cur && cur.date && (!dateReleve || cur.date > dateReleve)) dateReleve = cur.date;
    const brut = conso === null ? 0 : conso;
    const gaz = c.cat === 'GAZ';
    const qte = dvR(brut * (c.coef || 1) * (gaz ? t.convGaz : 1), 2);
    const prix = pu[c.cat] || 0;
    const ligne = { num: c.num, cat: c.cat, iPrev, iCur, conso, coef: c.coef || 1, qte,
      unite: c.cat === 'ELECTRICITE' || gaz ? 'kWh' : 'm³', uniteIdx: gaz ? 'm³' : (c.cat === 'ELECTRICITE' ? 'kWh' : 'm³'),
      pu: prix, total: dvR(qte * prix, 2), notes: notes.join(' · '), alerte };
    if (alerte) alertes.push(c.lieu + ' – ' + c.cat + ' : ' + alerte);
    if (!(c.lieu in idx)) { idx[c.lieu] = lieux.length; lieux.push({ lieu: c.lieu, lignes: [], sousTotal: 0 }); }
    const L = lieux[idx[c.lieu]];
    L.lignes.push(ligne);
    L.sousTotal = dvR(L.sousTotal + ligne.total, 2);
    n++;
  });
  lieux.forEach(L => L.lignes.sort((a, b) => DV.CATS.indexOf(a.cat) - DV.CATS.indexOf(b.cat)));
  const totalHT = dvR(lieux.reduce((s, L) => s + L.sousTotal, 0), 2);
  const tva = dvR(totalHT * (t.tva || 0) / 100, 2);
  return { perIso: iso(per), perLbl: dvMoisLbl(perIso), client, lieux, lignesCount: n, pu, tarifs: t, alertes,
    dateReleve: dateReleve ? frDate(dateReleve) : '', totalHT, tva, totalTTC: dvR(totalHT + tva, 2) };
}
function getDevisApercu(docs, config, perIso, client, tarifs) { return dvCalcul(docs, config, perIso, client, dvTarifsFusion(config, client, tarifs)); }
/** Numéro suivant d'après le registre (DEV-CH-AAAA-001…) */
function dvNumero(registre, now) {
  const pre = DV.PREFIXE + '-' + (now || new Date()).getFullYear() + '-';
  let max = 0;
  ((registre && registre.liste) || []).forEach(r => { const s = String(r.numero); if (s.indexOf(pre) === 0) max = Math.max(max, parseInt(s.slice(pre.length), 10) || 0); });
  return pre + ('00' + (max + 1)).slice(-3);
}

// ───────────────────────── Export Excel (données envoyées au script Google qui fabrique le fichier)
function donneesExport(docs) {
  return {
    compteurs: lireCompteurs(docs),
    releves: lireReleves(docs).map(r => ({ num: r.num, per: iso(r.per), date: iso(r.date), index: r.index, conso: r.conso,
      ctrl: r.ctrl, statut: r.statut, qui: r.qui, com: r.com, ancien: r.ancien })),
  };
}

const Metier = { CFG, DV, asDate, iso, cle, periodeDe, nombre, lireCompteurs, lireReleves, parCompteur, indexPrecedent, consoRef,
  etatCompteur, getInit, getPeriode, recalculer, preparerReleve, getControles, getHistorique, getEau, calculEau,
  dvTousTarifs, dvTarifsFusion, dvSaveTarifs, dvListe, dvCompteurs, dvSaveCompteurs, dvHistorique, getDevisInit, dvCalcul,
  getDevisApercu, dvNumero, dvMoisLbl, donneesExport };
if (typeof module !== 'undefined' && module.exports) module.exports = Metier; else root.Metier = Metier;
})(typeof window !== 'undefined' ? window : this);
