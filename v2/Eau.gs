/**
 * Eau.gs – synthèse eau / détection de fuites (version Firebase).
 * Remplace le fichier Eau.gs de l'appli « Consommations Halls » (et peut remplacer celui de l'appli « Relevés compteurs »).
 *
 * getEauSynthese() lit les relevés dans Firebase (collection CptCompteurs du projet equipe-batiment), là où la
 * version Firebase de l'appli Relevés compteurs les enregistre. Si Firebase est illisible, il lit le classeur comme avant.
 * Résultat gardé 5 minutes en cache (limite les lectures Firebase).
 */
const EAU_RELEVES_ID = '13gBPkjOPmFZwi5pTvGytuIIrOpCpusVBNb9QgMli7Y8'; // classeur « Relevés compteurs Eurexpo » (secours)
const EAU_FB = { project: 'equipe-batiment', key: 'AIzaSyARtP0RMkulG6c53-bnazwpGTspl0LgAhk', coll: 'CptCompteurs' };

/** Point d'entrée pour l'appli Consommations Halls */
function getEauSynthese() {
  const cache = CacheService.getScriptCache();
  const c = cache.get('eauSynthese');
  if (c) { try { return JSON.parse(c); } catch (e) {} }
  let res;
  try { res = eauFirebase_(); }
  catch (e) {
    console.warn('Eau : Firebase illisible (' + e.message + '), lecture du classeur.');
    res = getEauData(EAU_RELEVES_ID ? SpreadsheetApp.openById(EAU_RELEVES_ID) : SpreadsheetApp.getActive());
  }
  try { cache.put('eauSynthese', JSON.stringify(res), 300); } catch (e) {}
  return res;
}

/** Lecture Firebase → même calcul */
function eauFirebase_() {
  const base = 'https://firestore.googleapis.com/v1/projects/' + EAU_FB.project + '/databases/(default)/documents/' + EAU_FB.coll;
  const docs = []; let page = '';
  do {
    const r = UrlFetchApp.fetch(base + '?pageSize=300&key=' + EAU_FB.key + (page ? '&pageToken=' + encodeURIComponent(page) : ''), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Firebase ' + r.getResponseCode());
    const j = JSON.parse(r.getContentText() || '{}');
    (j.documents || []).forEach(d => docs.push(eauObj_(d.fields)));
    page = j.nextPageToken || '';
  } while (page);
  if (!docs.length) throw new Error('aucun compteur dans Firebase');
  docs.sort((a, b) => (a.rang || 0) - (b.rang || 0));
  const cpt = docs.filter(d => d.type === 'EAU' && d.actif !== false)
    .map(d => ({ num: String(d.num).trim(), secteur: d.secteur || '', designation: d.designation || '', localisation: d.localisation || '', role: d.role || 'Divisionnaire' }));
  const rows = [];
  docs.forEach(d => Object.keys(d.r || {}).forEach(k => {
    const e = d.r[k], m = k.match(/^(\d{4})-(\d{2})$/);
    if (!e || !m) return;
    rows.push({ num: String(d.num).trim(), per: new Date(+m[1], +m[2] - 1, 1), avecIndex: e.index !== null && e.index !== undefined,
      conso: e.conso === null || e.conso === undefined ? null : Number(e.conso), ctrl: e.ctrl || '' });
  }));
  return eauCalcul_(cpt, rows);
}

/** Lecture du classeur (ancienne source) → même calcul */
function getEauData(ss) {
  const shC = ss.getSheetByName('Compteurs');
  const cpt = shC.getRange(5, 1, Math.max(shC.getLastRow() - 4, 1), 11).getDisplayValues()
    .filter(r => r[0] && r[3] === 'EAU' && r[9] !== 'Non')
    .map(r => ({ num: String(r[0]).trim(), secteur: r[1], designation: r[5], localisation: r[6], role: r[8] || 'Divisionnaire' }));
  const shR = ss.getSheetByName('Relevés');
  const rows = (shR.getLastRow() > 1 ? shR.getRange(2, 1, shR.getLastRow() - 1, 9).getValues() : [])
    .filter(r => r[1] instanceof Date)
    .map(r => ({ num: String(r[2]).trim(), per: r[1], avecIndex: r[5] !== '', conso: r[6] === '' ? null : Number(r[6]), ctrl: String(r[7] || '') }));
  return eauCalcul_(cpt, rows);
}

/** cpt : [{num, secteur, designation, localisation, role}] · rows : [{num, per:Date, avecIndex, conso|null, ctrl}] */
function eauCalcul_(cpt, rows) {
  const NB_MOIS = 13;
  const tz = Session.getScriptTimeZone();
  const iso = d => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const key = d => d.getFullYear() * 12 + d.getMonth();
  const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
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
    const ref = prec.length >= 3 ? med(prec) : null;
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
  const refEc = ec.length >= 3 ? med(ec) : null, eNow = ecartDe(dernier);
  if (refEc !== null && eNow !== null && eNow > 1.5 * refEc && eNow - refEc > 200) {
    res.alertes.push({ niveau: 'haute', num: '', titre: 'Eau non comptabilisée en hausse',
      detail: 'Écart arrivées générales – sous-compteurs : ' + fr(eNow) + ' m³ contre ~' + fr(refEc) + ' m³/mois habituellement. À rapprocher du planning des salons ; hors salon, chercher une fuite sur le réseau.' });
  }
  res.refEcart = r1(refEc);
  const rang = { haute: 0, moyenne: 1, info: 2 };
  res.alertes.sort((a, b) => rang[a.niveau] - rang[b.niveau]);
  return res;
}

function eauObj_(fields) { const o = {}; Object.keys(fields || {}).forEach(k => o[k] = eauDec_(fields[k])); return o; }
function eauDec_(v) {
  if (!v || 'nullValue' in v) return null;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return eauObj_(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(eauDec_);
  return null;
}
