/**
 * Relevés compteurs – passage à Firebase
 * Fichier à ajouter au projet Apps Script « Relevés compteurs Eurexpo » (à côté de Code.gs, sans rien y changer),
 * puis Déployer › Gérer les déploiements › modifier › Nouvelle version (même adresse /exec).
 *
 *  1. copierVersFirebase() : à lancer une fois (et après chaque modification de l'onglet « Compteurs »).
 *     Copie le référentiel des compteurs, tous les relevés, les tarifs, les compteurs facturés et le registre des devis.
 *     Peut être relancée sans risque : un relevé déjà dans Firebase n'est remplacé que par une saisie plus récente.
 *  2. installerFirebase() : à lancer une fois. Toutes les 10 minutes, les relevés encore saisis dans l'ancienne
 *     version (classeur) sont copiés dans Firebase (pendant la transition). desinstallerFirebase() arrête cette copie.
 *  3. La version Firebase de l'appli appelle ce script pour fabriquer les fichiers :
 *     fbDevisFichiers (PDF + Excel d'un devis) et fbExportIndex (export Excel de tous les index), avec les données qu'elle envoie.
 *
 * Le script se connecte à Firebase comme l'appli (connexion anonyme).
 */

const FBC = {
  PROJECT: 'equipe-batiment',
  KEY: 'AIzaSyARtP0RMkulG6c53-bnazwpGTspl0LgAhk',
  COLL: 'CptCompteurs',
};
FBC.DOCS = 'projects/' + FBC.PROJECT + '/databases/(default)/documents';
FBC.URL = 'https://firestore.googleapis.com/v1/' + FBC.DOCS;

// Fonctions ouvertes à l'appli (s'ajoutent à la liste API_FNS de Code.gs)
try { ['fbDevisFichiers', 'fbExportIndex'].forEach(f => { if (API_FNS.indexOf(f) < 0) API_FNS.push(f); }); }
catch (e) { console.warn('Firebase.gs : ajouter fbDevisFichiers et fbExportIndex à API_FNS dans Code.gs'); }

// ───────────────────────── Copie classeur → Firebase

function copierVersFirebase() {
  const r = fbSyncReleves_(null);
  const tok = fbToken_();
  const ss = ss_();
  // Devis : écrits seulement s'ils ne sont pas déjà dans Firebase (pour ne rien écraser en relançant)
  const cfg = dvCompteurs_(ss).map(c => ({ num: c.num, lieu: c.lieu, client: c.client, cat: c.cat, coef: c.coef, facture: c.facture, remarque: c.remarque }));
  const log = ss.getSheetByName(DV.SH_LOG);
  const reg = log && log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 11).getValues().filter(x => String(x[0]).trim()).map(x => {
    let t = {}; try { t = JSON.parse(x[10] || '{}'); } catch (e) {}
    return { numero: String(x[0]), edite: x[1] instanceof Date ? x[1].toISOString() : String(x[1]), client: String(x[2]), periode: String(x[3]),
      totalHT: Number(x[4]) || 0, tva: Number(x[5]) || 0, totalTTC: Number(x[6]) || 0, tarifs: t, par: String(x[9] || '') };
  }) : [];
  const res = [];
  [['CptConfig/devis', { tarifs: dvTousTarifs_(ss), compteurs: cfg }, 'tarifs et ' + cfg.length + ' compteurs facturés'],
   ['CptConfig/registre', { liste: reg }, reg.length + ' devis au registre']].forEach(x => {
    const w = fbUpdate_(x[0], x[1]); w.currentDocument = { exists: false };
    try { fbWrite_(tok, [w]); res.push(x[2] + ' copiés'); } catch (e) { res.push(x[2] + ' : déjà dans Firebase, laissés tels quels'); }
  });
  console.log(r.compteurs + ' compteurs, ' + r.releves + ' relevés écrits dans Firebase' + (r.inconnus ? ' (' + r.inconnus + ' relevés de compteurs absents du référentiel ignorés)' : '') + ' · ' + res.join(' · '));
}

function installerFirebase() {
  desinstallerFirebase();
  ScriptApp.newTrigger('majFirebase').timeBased().everyMinutes(10).create();
  PropertiesService.getScriptProperties().setProperty('FB_DERNIER', String(Date.now() - 2 * 86400000));
  majFirebase();
  console.log('Copie des relevés de l\'ancienne version programmée toutes les 10 minutes.');
}

function desinstallerFirebase() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'majFirebase') ScriptApp.deleteTrigger(t); });
}

/** Lancée toutes les 10 minutes : relevés saisis ou modifiés dans l'ancienne version depuis la dernière copie. */
function majFirebase() {
  const props = PropertiesService.getScriptProperties();
  const depuis = Number(props.getProperty('FB_DERNIER')) || (Date.now() - 2 * 86400000);
  const r = fbSyncReleves_(depuis);
  props.setProperty('FB_DERNIER', String(r.dernier || depuis));
  if (r.releves) console.log(r.releves + ' relevé(s) copiés dans Firebase.');
}

/**
 * Relevés du classeur → Firebase.
 * depuis = null : tous les compteurs (référentiel compris) ; sinon seulement les lignes « Saisi le » postérieures (ms).
 * Un relevé déjà dans Firebase n'est remplacé que si la ligne du classeur a été saisie plus récemment.
 */
function fbSyncReleves_(depuis) {
  const complet = depuis === null;
  const cpt = lireCompteurs_();
  const cm = {}; cpt.forEach((c, i) => { c.rang = i + 1; cm[c.num] = c; });
  const sh = ss_().getSheetByName(SH_REL);
  const last = sh.getLastRow();
  const vals = last > 1 ? sh.getRange(2, 1, last - 1, NB_COL_REL).getValues() : [];
  const tz = Session.getScriptTimeZone();
  const parNum = {}; let inconnus = 0, dernier = depuis || 0;
  vals.forEach(v => {
    const num = String(v[RC.NUM]).trim(), per = asDate_(v[RC.PER]);
    if (!num || !per) return;
    const ts = v[RC.TS] instanceof Date ? v[RC.TS].getTime() : 0;
    if (!complet && !(ts > depuis)) return;
    if (!cm[num]) { inconnus++; return; }
    dernier = Math.max(dernier, ts);
    const k = Utilities.formatDate(per, tz, 'yyyy-MM');
    const n = x => x === '' || x === null || isNaN(Number(x)) ? null : Number(x);
    const e = { date: v[RC.DATE] instanceof Date ? Utilities.formatDate(v[RC.DATE], tz, 'yyyy-MM-dd') : '', index: n(v[RC.IDX]), conso: n(v[RC.CONSO]),
      ctrl: String(v[RC.CTRL] || ''), statut: String(v[RC.STATUT] || ''), qui: String(v[RC.QUI] || ''), com: String(v[RC.COM] || ''),
      ancien: n(v[RC.ANCIEN]), ts: ts ? new Date(ts).toISOString() : '', src: String(v[RC.SRC] || 'Classeur') };
    const m = (parNum[num] = parNum[num] || {});
    if (!m[k] || e.index !== null || m[k].index === null) m[k] = e; // doublon : la ligne avec index l'emporte, sinon la dernière
  });

  const nums = complet ? cpt.map(c => c.num) : Object.keys(parNum);
  if (!nums.length) return { compteurs: 0, releves: 0, inconnus, dernier };
  const tok = fbToken_();
  const existants = complet ? fbTousLesDocs_(tok) : fbDocs_(tok, nums.map(fbId_));
  const writes = []; let nRel = 0;
  nums.forEach(num => {
    const c = cm[num], id = fbId_(num), doc = existants[id];
    const fb = (doc && doc.r) || {};
    const neuf = parNum[num] || {};
    const map = Object.assign({}, fb), cles = {};
    Object.keys(neuf).forEach(k => {
      const a = fb[k], e = neuf[k];
      if (!a || (e.ts && (!a.ts || e.ts > a.ts))) { map[k] = e; cles[k] = 1; }
    });
    const rec = fbRecalc_(c, map);
    Object.keys(rec).forEach(k => { map[k] = rec[k]; cles[k] = 1; });
    const ref = { num: c.num, rang: c.rang, secteur: c.secteur, ordre: c.ordre, type: c.type, usage: c.usage, designation: c.designation,
      localisation: c.localisation, unite: c.unite, role: c.role, actif: c.actif, remarque: c.remarque };
    const k2 = Object.keys(cles);
    nRel += k2.length;
    if (!doc) { ref.r = map; writes.push(fbUpdate_(FBC.COLL + '/' + id, ref)); return; }
    const champs = complet ? Object.assign({}, ref) : {};
    const mask = Object.keys(champs);
    if (k2.length) { champs.r = {}; k2.forEach(k => { champs.r[k] = map[k]; mask.push('r.`' + k + '`'); }); }
    if (!mask.length) return;
    writes.push({ update: { name: FBC.DOCS + '/' + FBC.COLL + '/' + id, fields: fbFields_(champs) }, updateMask: { fieldPaths: mask } });
  });
  for (let i = 0; i < writes.length; i += 200) fbWrite_(tok, writes.slice(i, i + 200));
  return { compteurs: writes.length, releves: nRel, inconnus, dernier };
}

/** Même recalcul que recalculerCompteur_ (Code.gs), sur les relevés d'un compteur { 'AAAA-MM': entrée } → clés modifiées */
function fbRecalc_(cpt, map) {
  const out = {};
  if (!cpt || cpt.unite === '%' || cpt.unite === '—') return out;
  let prev = null;
  Object.keys(map).sort().forEach(k => {
    const e = map[k];
    if (!e || e.index === null || e.index === undefined || e.ctrl === 'Valeur suspecte') return;
    let conso = null, ctrl = e.ctrl || '';
    if (e.statut === 'Changement compteur') {
      conso = (prev !== null && e.ancien !== null && e.ancien !== undefined ? Math.max(0, e.ancien - prev) : 0) + e.index;
    } else if (prev !== null) {
      const d = arrondi_(e.index - prev);
      if (d < 0) ctrl = 'Index en baisse';
      else { conso = d; if (ctrl === 'Index en baisse') ctrl = ''; }
    }
    const av = e.conso === undefined ? null : e.conso;
    if (conso !== av || ctrl !== (e.ctrl || '')) out[k] = Object.assign({}, e, { conso: conso, ctrl: ctrl });
    prev = e.index;
  });
  return out;
}

function fbId_(num) { return String(num).trim().replace(/[\/\s]/g, '_').slice(0, 100) || '_'; }

function fbTousLesDocs_(tok) {
  const out = {}; let page = '';
  do {
    const r = UrlFetchApp.fetch(FBC.URL + '/' + FBC.COLL + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''),
      { headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Firebase ' + r.getResponseCode() + ' : lecture des compteurs');
    const j = JSON.parse(r.getContentText() || '{}');
    (j.documents || []).forEach(d => out[d.name.split('/').pop()] = fbObj_(d.fields));
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

function fbDocs_(tok, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const res = fbFetch_('post', FBC.URL + ':batchGet', tok, { documents: ids.slice(i, i + 100).map(id => FBC.DOCS + '/' + FBC.COLL + '/' + id) });
    (res || []).forEach(x => { if (x.found) out[x.found.name.split('/').pop()] = fbObj_(x.found.fields); });
  }
  return out;
}

// ───────────────────────── Fichiers demandés par la version Firebase de l'appli

/** d : devis calculé par l'appli (même contenu que dvCalcul_ + numero, objet, dateDevis) → PDF et Excel, rien dans Drive */
function fbDevisFichiers(d) {
  if (!d || !d.numero || !Array.isArray(d.lieux)) throw new Error('Devis incomplet.');
  const base = d.numero + ' – ' + d.client + ' – ' + d.perLbl;
  const pdf = dvPdf_(d).setName(base + '.pdf');
  const xls = dvXlsx_(d).setName(base + '.xlsx');
  return {
    pdf: { name: pdf.getName(), mime: 'application/pdf', b64: Utilities.base64Encode(pdf.getBytes()) },
    xlsx: { name: xls.getName(), mime: MimeType.MICROSOFT_EXCEL, b64: Utilities.base64Encode(xls.getBytes()) },
  };
}

/** data = { compteurs:[…], releves:[{num, per, date, index, conso, ctrl, statut, qui, com, ancien}] } → même fichier que exporterIndex */
function fbExportIndex(data) {
  const cpt = (data && data.compteurs || []).map(c => Object.assign({}, c, { num: String(c.num), actif: c.actif !== false }));
  const rel = (data && data.releves || []).map(r => ({ num: String(r.num), per: asDate_(r.per), date: asDate_(r.date),
    index: r.index === null || r.index === undefined ? null : Number(r.index), conso: r.conso === null || r.conso === undefined ? null : Number(r.conso),
    ctrl: r.ctrl || '', statut: r.statut || '', qui: r.qui || '', com: r.com || '', ancien: r.ancien === null || r.ancien === undefined ? null : Number(r.ancien) }))
    .filter(r => r.num && r.per);
  return fbExporterIndex_(cpt, rel);
}

/** Copie de exporterIndex (Export.gs) qui travaille sur les données reçues au lieu du classeur. */
function fbExporterIndex_(cpt, rel) {
  const tz = Session.getScriptTimeZone();
  const MOISX = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const lblMois = d => MOISX[d.getMonth()] + ' ' + d.getFullYear();
  const cm = {};
  cpt.forEach(c => (cm[c.num] = c));
  const perKeys = {};
  rel.forEach(r => (perKeys[iso_(r.per)] = r.per));
  const pers = Object.keys(perKeys).sort();
  const grille = {};
  rel.forEach(r => {
    const g = (grille[r.num] = grille[r.num] || {});
    const k = iso_(r.per);
    if (r.index !== null || !g[k] || g[k].index === null) g[k] = r;
  });

  const tmp = SpreadsheetApp.create('tmp export index ' + Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss'));
  try {
    const sh = tmp.getSheets()[0];
    sh.setName('Index');
    const FIX = ['N°', 'Secteur', 'Type', 'Désignation', 'Localisation', 'Unité', 'Actif'];
    const HDR = 4;
    sh.setRowHeight(1, 46);
    try {
      const b64 = String(CFG.LOGO_SRC).split(',')[1];
      if (b64) {
        const img = sh.insertImage(Utilities.newBlob(Utilities.base64Decode(b64), 'image/png', 'logo.png'), 1, 1);
        const ratio = img.getHeight() ? img.getWidth() / img.getHeight() : 6.4;
        img.setHeight(36).setWidth(Math.round(36 * ratio));
      }
    } catch (e) { /* logo facultatif */ }
    sh.getRange(2, 1).setValue('Index de tous les compteurs').setFontSize(14).setFontWeight('bold');
    sh.getRange(3, 1).setValue('Export du ' + Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm')
      + ' · ' + cpt.length + ' compteurs · ' + pers.length + ' mois · cases orange = relevé signalé (voir commentaire)')
      .setFontColor('#6b6b70').setFontSize(9);

    const entete = FIX.concat(pers.map(k => lblMois(perKeys[k])));
    const lignes = [], fonds = [], notes = [];
    cpt.forEach(c => {
      const g = grille[c.num] || {};
      const l = [c.num, c.secteur, c.type, c.designation, c.localisation, c.unite, c.actif ? 'Oui' : 'Non'];
      const f = FIX.map(() => null), n = FIX.map(() => '');
      pers.forEach(k => {
        const r = g[k];
        if (!r) { l.push(''); f.push(null); n.push(''); return; }
        l.push(r.index !== null ? r.index : (r.statut || ''));
        const ctrl = String(r.ctrl || '');
        const signale = ctrl && !/Changement|confirmé/i.test(ctrl);
        f.push(signale ? '#fbf0d9' : (r.index === null ? '#eeeeee' : null));
        n.push([ctrl, r.statut && r.statut !== 'OK' ? 'Statut : ' + r.statut : '', r.com ? 'Commentaire : ' + r.com : '',
          r.qui ? 'Relevé par ' + r.qui + (r.date ? ' le ' + Utilities.formatDate(r.date, tz, 'dd/MM/yyyy') : '') : '']
          .filter(String).join('\n'));
      });
      lignes.push(l); fonds.push(f); notes.push(n);
    });

    const nc = entete.length;
    sh.getRange(HDR, 1, 1, nc).setValues([entete]).setFontWeight('bold').setBackground('#e8f0fb').setWrap(true).setVerticalAlignment('middle');
    if (lignes.length) {
      const rg = sh.getRange(HDR + 1, 1, lignes.length, nc);
      rg.setValues(lignes).setBackgrounds(fonds).setNotes(notes).setFontSize(9);
      if (pers.length) sh.getRange(HDR + 1, FIX.length + 1, lignes.length, pers.length).setHorizontalAlignment('right');
      sh.getRange(HDR, 1, lignes.length + 1, nc).setBorder(true, true, true, true, true, true, '#e4e4e0', SpreadsheetApp.BorderStyle.SOLID);
    }
    sh.setFrozenRows(HDR);
    sh.setFrozenColumns(4);
    [55, 130, 45, 220, 220, 45, 45].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    for (let j = FIX.length + 1; j <= nc; j++) sh.setColumnWidth(j, 78);

    const sj = tmp.insertSheet('Relevés');
    const jh = ['Date relevé', 'Période', 'N°', 'Désignation', 'Localisation', 'Type', 'Index', 'Unité', 'Conso', 'Contrôle', 'Statut', 'Releveur', 'Commentaire', 'Index final ancien compteur'];
    const jl = rel.slice().sort((a, b) => (a.per - b.per) || String(a.num).localeCompare(String(b.num), 'fr', { numeric: true }))
      .map(r => {
        const c = cm[r.num] || {};
        return [r.date || '', lblMois(r.per), r.num, c.designation || '', c.localisation || '', c.type || '',
          r.index === null ? '' : r.index, c.unite || '', r.conso === null ? '' : r.conso, r.ctrl || '', r.statut || '',
          r.qui || '', r.com || '', r.ancien === null ? '' : r.ancien];
      });
    sj.getRange(1, 1, 1, jh.length).setValues([jh]).setFontWeight('bold').setBackground('#e8f0fb');
    if (jl.length) {
      sj.getRange(2, 1, jl.length, jh.length).setValues(jl).setFontSize(9);
      sj.getRange(2, 1, jl.length, 1).setNumberFormat('dd/MM/yyyy');
      sj.getRange(2, 3, jl.length, 1).setNumberFormat('@');
    }
    sj.setFrozenRows(1);
    [80, 80, 55, 220, 220, 45, 80, 45, 70, 160, 90, 110, 220, 90].forEach((w, i) => sj.setColumnWidth(i + 1, w));
    SpreadsheetApp.flush();

    const url = 'https://docs.google.com/spreadsheets/d/' + tmp.getId() + '/export?format=xlsx';
    const blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
    return { mime: MimeType.MICROSOFT_EXCEL, b64: Utilities.base64Encode(blob.getBytes()), compteurs: cpt.length, mois: pers.length };
  } finally {
    try { Drive.Files.remove(tmp.getId()); } catch (e) { DriveApp.getFileById(tmp.getId()).setTrashed(true); }
  }
}

// ───────────────────────── Accès Firebase (REST)

/** Connexion anonyme (gardée dans les propriétés du script) */
function fbToken_() {
  const props = PropertiesService.getScriptProperties();
  const refresh = props.getProperty('FB_REFRESH');
  if (refresh) {
    const r = UrlFetchApp.fetch('https://securetoken.googleapis.com/v1/token?key=' + FBC.KEY,
      { method: 'post', payload: { grant_type: 'refresh_token', refresh_token: refresh }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const j = JSON.parse(r.getContentText());
      props.setProperty('FB_REFRESH', j.refresh_token);
      return j.id_token;
    }
  }
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FBC.KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ returnSecureToken: true }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Connexion à Firebase refusée (activer « Anonyme » dans Authentication › Mode de connexion) : ' + r.getContentText());
  const j = JSON.parse(r.getContentText());
  props.setProperty('FB_REFRESH', j.refreshToken);
  return j.idToken;
}

function fbUpdate_(path, obj) { return { update: { name: FBC.DOCS + '/' + path, fields: fbFields_(obj) } }; }
function fbWrite_(tok, writes) { return fbFetch_('post', FBC.URL + ':commit', tok, { writes: writes }); }

function fbFetch_(method, url, tok, body) {
  const r = UrlFetchApp.fetch(url, { method: method, contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true });
  const c = r.getResponseCode();
  if (c < 200 || c >= 300) {
    let msg = r.getContentText();
    try { msg = JSON.parse(msg).error.message; } catch (e) {}
    throw new Error('Firebase ' + c + ' : ' + msg);
  }
  return JSON.parse(r.getContentText() || 'null');
}

function fbFields_(obj) { const f = {}; Object.keys(obj).forEach(k => f[k] = fbVal_(obj[k])); return f; }
function fbVal_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'number') return isFinite(v) ? { doubleValue: v } : { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fbVal_) } };
  if (v instanceof Date) return { stringValue: v.toISOString() };
  if (typeof v === 'object') return { mapValue: { fields: fbFields_(v) } };
  return { stringValue: String(v) };
}
function fbObj_(fields) { const o = {}; Object.keys(fields || {}).forEach(k => o[k] = fbDec_(fields[k])); return o; }
function fbDec_(v) {
  if (!v || 'nullValue' in v) return null;
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fbObj_(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fbDec_);
  return null;
}
