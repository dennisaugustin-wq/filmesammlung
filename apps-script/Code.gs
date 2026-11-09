/**
 * Filmsammlung – Brücke zwischen Web-App und Google Tabelle  (Version 3 – mit Covern)
 * ---------------------------------------------------------------------
 * Einmalig einrichten:
 *  1. In der Google Tabelle: Erweiterungen → Apps Script → diesen Code einfügen.
 *  2. Funktion "einrichten" ausführen (legt Mappen/Spalten an, auch die neue Spalte "Weitere EANs").
 *  3. Projekteinstellungen (Zahnrad) → Skripteigenschaften:
 *       PIN               = eure PIN (Pflicht)
 *       TMDB_API_KEY      = API-Schlüssel von themoviedb.org (dringend empfohlen)
 *       EBAY_CLIENT_ID    = App ID (Client ID) aus dem eBay-Entwicklerkonto (empfohlen)
 *       EBAY_CLIENT_SECRET= Cert ID (Client Secret) aus dem eBay-Entwicklerkonto (empfohlen)
 *       OPENGTINDB_ID     = Query-ID von opengtindb.org (optional)
 *  4. Bereitstellen → Bereitstellungen verwalten → Bearbeiten (Stift) → Version: "Neue Version" → Bereitstellen.
 *     So bleibt die URL gleich.
 *
 *  Zum Testen ohne App: Funktion "testScan" ausführen (EAN unten eintragen) und unter "Ausführungen" das Protokoll ansehen.
 */

const LISTEN = ['Sammlung', 'Wunschliste'];
const SPALTEN = ['EAN', 'Titel', 'Jahr', 'Format', 'Hinzugefügt am', 'Notiz', 'Weitere EANs'];
const FORMATE = ['DVD', 'Blu-ray', '4K UHD', 'Sonstiges'];
const AEHNLICHKEIT = 0.85;
const POSTER_BASIS = 'https://image.tmdb.org/t/p/w342';

/* ------------------------------------------------------------------ */
/* Einrichtung und Test                                               */
/* ------------------------------------------------------------------ */

function einrichten() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  LISTEN.forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SPALTEN.length).setValues([SPALTEN]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('G:G').setNumberFormat('@');
    sh.getRange('C:C').setNumberFormat('0');
    sh.getRange('E:E').setNumberFormat('dd.mm.yyyy');
    sh.setColumnWidth(1, 130);
    sh.setColumnWidth(2, 320);
    sh.setColumnWidth(4, 140);
    sh.setColumnWidth(6, 200);
    sh.setColumnWidth(7, 260);
  });
  const leer = ss.getSheetByName('Tabellenblatt1') || ss.getSheetByName('Sheet1');
  if (leer && leer.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(leer);
}

function testScan() {
  const ean = '4010884250879'; // ← hier eine EAN zum Testen eintragen
  Logger.log(JSON.stringify(scan_({ ean: ean }), null, 2));
}

/* ------------------------------------------------------------------ */
/* Web-Schnittstelle                                                  */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, info: 'Filmsammlung-API läuft. Bitte per POST aufrufen.' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    pinPruefen_(req.pin);
    const a = req.action;
    if (a === 'login') return json_({ ok: true, formate: FORMATE });
    if (a === 'scan') return json_(scan_(req));
    if (a === 'searchTitle') return json_(titelSuche_(req));
    if (a === 'check') return json_({ ok: true, treffer: abgleich_(req.ean, [req.titel], req.jahr) });
    if (a === 'add') return json_(hinzufuegen_(req));
    if (a === 'buy') return json_(kaufen_(req));
    if (a === 'rememberEan') return json_(eanMerken_(req));
    if (a === 'list') return json_(liste_(req));
    if (a === 'posters') return json_(poster_(req));
    return json_({ ok: false, fehler: 'Unbekannte Aktion' });
  } catch (err) {
    return json_({ ok: false, fehler: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* PIN mit Schutz gegen Durchprobieren                                */
/* ------------------------------------------------------------------ */

function pinPruefen_(pin) {
  const cache = CacheService.getScriptCache();
  const fehlversuche = Number(cache.get('pinFehler') || 0);
  if (fehlversuche >= 10) throw new Error('Zu viele Fehlversuche. Bitte 15 Minuten warten.');
  const richtig = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!richtig) throw new Error('Keine PIN in den Skripteigenschaften hinterlegt.');
  if (String(pin || '') !== String(richtig)) {
    cache.put('pinFehler', String(fehlversuche + 1), 900);
    throw new Error('Falsche PIN');
  }
}

/* ------------------------------------------------------------------ */
/* Scan: EAN → Film → Abgleich                                        */
/* ------------------------------------------------------------------ */

function scan_(req) {
  const ean = eanBereinigen_(req.ean);
  if (!ean) throw new Error('Ungültige EAN/ISBN');

  // 1. EAN schon bekannt (Haupt-EAN oder "Weitere EANs")? Dann sofort fertig.
  const eigene = alleEintraege_().filter(function (x) { return eanPasst_(x, ean); });
  if (eigene.length) {
    const p = { titel: eigene[0].titel, jahr: eigene[0].jahr, format: eigene[0].format, quelle: 'Eigene Liste' };
    return { ok: true, ean: ean, produkt: p, treffer: abgleich_(ean, [p.titel], p.jahr) };
  }

  // 2. Online suchen und mit ALLEN gefundenen Titel-Varianten abgleichen
  const produkt = eanOnlineSuchen_(ean);
  if (!produkt) return { ok: true, ean: ean, produkt: null, treffer: [] };
  const treffer = abgleich_(ean, produkt.varianten, produkt.jahr);
  delete produkt.varianten;
  return { ok: true, ean: ean, produkt: produkt, treffer: treffer };
}

function eanBereinigen_(s) {
  const d = String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return d.length >= 8 && d.length <= 14 ? d : '';
}

function eanPasst_(x, ean) {
  return !!ean && (x.ean === ean || x.weitereEans.indexOf(ean) >= 0);
}

/** Liefert {titel, jahr, format, quelle, rohname, originaltitel, varianten[]} oder null */
function eanOnlineSuchen_(ean) {
  const rohnamen = [];
  let quelle = '';

  // a) eBay.de – beste Abdeckung für deutsche DVD/Blu-ray-Ausgaben
  const ebay = ebaySuche_(ean);
  if (ebay.length) { Array.prototype.push.apply(rohnamen, ebay); quelle = 'eBay'; }

  // b) Open EAN/GTIN Database (deutsch)
  if (!rohnamen.length) {
    const id = PropertiesService.getScriptProperties().getProperty('OPENGTINDB_ID');
    if (id) {
      try {
        const r = UrlFetchApp.fetch('http://opengtindb.org/?ean=' + ean + '&cmd=query&queryid=' + id,
          { muteHttpExceptions: true });
        const txt = r.getContentText('ISO-8859-1');
        if (/error=0/.test(txt)) {
          const name = (txt.match(/^name=(.*)$/m) || [])[1] || '';
          const detail = (txt.match(/^detailname=(.*)$/m) || [])[1] || '';
          const roh = (name + ' ' + detail).trim();
          if (roh) { rohnamen.push(roh); quelle = 'opengtindb'; }
        }
      } catch (e) { /* weiter */ }
    }
  }

  // c) UPCitemdb (kostenlos, ca. 100 Abfragen/Tag, eher englische Titel)
  if (!rohnamen.length) {
    try {
      const r = UrlFetchApp.fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + ean,
        { muteHttpExceptions: true });
      const j = JSON.parse(r.getContentText() || '{}');
      (j.items || []).forEach(function (it) { if (it.title) rohnamen.push(it.title); });
      if (rohnamen.length) quelle = 'upcitemdb';
    } catch (e) { /* nichts gefunden */ }
  }

  if (!rohnamen.length) return null;

  // Häufigsten bereinigten Titel wählen (eBay liefert mehrere Angebote)
  const sauberListe = rohnamen.map(titelAusProduktname_).filter(String);
  const sauber = haeufigster_(sauberListe) || sauberListe[0] || rohnamen[0];
  let format = '';
  for (let i = 0; i < rohnamen.length && !format; i++) format = formatErkennen_(rohnamen[i]);
  const yearHint = (rohnamen.join(' ').match(/\b(19[0-9]{2}|20[0-9]{2})\b/) || [])[1] || '';

  const varianten = [sauber];
  sauberListe.forEach(function (s) { if (varianten.indexOf(s) < 0) varianten.push(s); });
  rohnamen.forEach(function (r) { varianten.push(r); });

  // d) TMDB: sauberer deutscher Titel + Jahr + Originaltitel
  const tmdb = tmdbSuche_(sauber, yearHint);
  if (tmdb.length) {
    varianten.unshift(tmdb[0].titel, tmdb[0].originaltitel);
    return {
      titel: tmdb[0].titel, jahr: tmdb[0].jahr, format: format, quelle: quelle + ' + TMDB', poster: tmdb[0].poster,
      rohname: rohnamen[0], originaltitel: tmdb[0].originaltitel, varianten: varianten
    };
  }
  return {
    titel: titelSchreibweise_(sauber), jahr: yearHint, format: format, quelle: quelle,
    rohname: rohnamen[0], originaltitel: '', varianten: varianten
  };
}

function haeufigster_(liste) {
  const z = {};
  liste.forEach(function (s) { const k = normalisieren_(s); if (k) z[k] = (z[k] || 0) + 1; });
  let best = '', n = 0;
  liste.forEach(function (s) {
    const k = normalisieren_(s);
    if (z[k] > n || (z[k] === n && s.length < best.length)) { best = s; n = z[k]; }
  });
  return best;
}

/* ---------- eBay Browse API ---------- */

function ebayToken_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('EBAY_CLIENT_ID');
  const secret = props.getProperty('EBAY_CLIENT_SECRET');
  if (!id || !secret) return '';
  const cache = CacheService.getScriptCache();
  const vorhanden = cache.get('ebayToken');
  if (vorhanden) return vorhanden;
  const r = UrlFetchApp.fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    payload: { grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }
  });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.access_token) return '';
  cache.put('ebayToken', j.access_token, Math.min(21000, Math.max(60, (j.expires_in || 7200) - 300)));
  return j.access_token;
}

function ebaySuche_(ean) {
  try {
    const token = ebayToken_();
    if (!token) return [];
    const r = UrlFetchApp.fetch(
      'https://api.ebay.com/buy/browse/v1/item_summary/search?gtin=' + ean + '&limit=20',
      { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE' } });
    const j = JSON.parse(r.getContentText() || '{}');
    return (j.itemSummaries || []).map(function (it) { return it.title || ''; }).filter(String);
  } catch (e) { return []; }
}

/* ---------- Format und Titel aus Produktnamen ---------- */

function formatErkennen_(name) {
  const n = String(name || '').toLowerCase();
  if (/\b(4k|uhd|ultra ?hd)\b/.test(n)) return '4K UHD';
  if (/hd[ -]?dvd|\bvhs\b|laser ?disc|\bv(ideo)? ?cd\b/.test(n)) return 'Sonstiges';
  if (/blu[ -]?ray|\bbd\b/.test(n)) return 'Blu-ray';
  if (/\bdvd\b/.test(n)) return 'DVD';
  return '';
}

function titelAusProduktname_(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(4k|uhd|ultra ?hd|blu[ -]?ray|3d|hd[ -]?dvd|dvd|vhs|steel ?book|bd|disc|discs|digital|edition|limited|collector'?s|special|deluxe|uncut|extended|remastered|neuwertig|neu|ovp|wie neu|gebraucht|film|movie|fsk ?\d+|\d+ ?-?disc|\d+ ?dvds?)\b/gi, ' ')
    .replace(/[+|\/!*]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s\-–:,.]+$/g, '')
    .replace(/^[\s\-–:,.]+/g, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Titelsuche (manuell)                                               */
/* ------------------------------------------------------------------ */

function titelSuche_(req) {
  const q = String(req.titel || '').trim();
  if (!q) throw new Error('Bitte einen Titel eingeben');
  const k = tmdbSuche_(q, req.jahr);
  if (!k.length) return { ok: true, kandidaten: [{ titel: titelSchreibweise_(q), jahr: String(req.jahr || ''), originaltitel: '' }] };
  return { ok: true, kandidaten: k.slice(0, 10) };
}

function tmdbSuche_(titel, jahr) {
  const key = PropertiesService.getScriptProperties().getProperty('TMDB_API_KEY');
  if (!key || !titel) return [];
  const basis = 'https://api.themoviedb.org/3/search/movie?api_key=' + encodeURIComponent(key) +
    '&language=de-DE&region=DE&include_adult=false&query=' + encodeURIComponent(titel);
  let res = tmdbHolen_(basis + (jahr ? '&year=' + encodeURIComponent(jahr) : ''));
  if (!res.length && jahr) res = tmdbHolen_(basis);
  return res;
}

function tmdbHolen_(url) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const j = JSON.parse(r.getContentText() || '{}');
    return (j.results || []).map(function (m) {
      return {
        titel: titelSchreibweise_(m.title || m.original_title || ''),
        jahr: (m.release_date || '').slice(0, 4),
        originaltitel: m.original_title || '',
        poster: m.poster_path ? POSTER_BASIS + m.poster_path : ''
      };
    });
  } catch (e) { return []; }
}

/** Bevorzugt Bindestrich statt Doppelpunkt */
function titelSchreibweise_(t) {
  return String(t || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/\s*[–—]\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Abgleich                                                           */
/* ------------------------------------------------------------------ */

/** titelListe: alle bekannten Schreibweisen des gescannten Films (deutsch, original, Produktname …) */
function abgleich_(ean, titelListe, jahr) {
  ean = eanBereinigen_(ean);
  const titel = (titelListe || []).map(normalisieren_).filter(String);
  const j = parseInt(jahr, 10);
  const treffer = [];
  alleEintraege_().forEach(function (x) {
    if (eanPasst_(x, ean)) { x.art = 'ean'; treffer.push(x); return; }
    if (!titel.length) return;
    const xt = normalisieren_(x.titel);
    const passt = titel.some(function (t) { return titelGleich_(t, xt) || titelEnthalten_(xt, t); });
    if (passt) {
      const xj = parseInt(x.jahr, 10);
      x.art = (j && xj && Math.abs(j - xj) > 1) ? 'titel_anderes_jahr' : 'titel';
      treffer.push(x);
    }
  });
  const rang = { ean: 0, titel: 1, titel_anderes_jahr: 2 };
  treffer.sort(function (a, b) { return rang[a.art] - rang[b.art]; });
  treffer.forEach(function (x) { delete x.weitereEans; });
  return treffer;
}

function normalisieren_(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teilnummern (Fortsetzungen) – Jahreszahlen zählen nicht */
function zahlen_(s) {
  const romisch = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
  return s.split(' ').map(function (w) { return romisch[w] || w; })
    .filter(function (w) { return /^\d{1,2}$/.test(w); }).sort().join(',');
}

function roemisch_(s) {
  const r = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9' };
  return s.split(' ').map(function (w) { return r[w] || w; }).join(' ');
}

function titelGleich_(a, b) {
  if (!a || !b) return false;
  a = roemisch_(a); b = roemisch_(b);
  if (a === b) return true;
  if (zahlen_(a) !== zahlen_(b)) return false; // Rocky 2 ≠ Rocky 3
  return dice_(a, b) >= AEHNLICHKEIT;
}

/** Listentitel steckt komplett im gescannten Produktnamen ("der pate" in "der pate trilogie 1972 kinofassung") */
function titelEnthalten_(listenTitel, produkt) {
  if (!listenTitel || !produkt || listenTitel.length < 4) return false;
  if ((' ' + produkt + ' ').indexOf(' ' + listenTitel + ' ') < 0) return false;
  return zahlen_(listenTitel) === zahlen_(produkt);
}

function dice_(a, b) {
  const bi = function (s) { const m = {}; for (let i = 0; i < s.length - 1; i++) { const k = s.substr(i, 2); m[k] = (m[k] || 0) + 1; } return m; };
  const A = bi(a), B = bi(b);
  let gemeinsam = 0, na = 0, nb = 0;
  Object.keys(A).forEach(function (k) { na += A[k]; if (B[k]) gemeinsam += Math.min(A[k], B[k]); });
  Object.keys(B).forEach(function (k) { nb += B[k]; });
  return na + nb ? (2 * gemeinsam) / (na + nb) : 0;
}

/* ------------------------------------------------------------------ */
/* Lesen und Schreiben                                                */
/* ------------------------------------------------------------------ */

function blatt_(name) {
  if (LISTEN.indexOf(name) < 0) throw new Error('Unbekannte Liste: ' + name);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Mappe "' + name + '" fehlt. Bitte "einrichten" ausführen.');
  return sh;
}

function eintraege_(name) {
  const sh = blatt_(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, n, SPALTEN.length).getValues().map(function (r, i) {
    const datum = r[4] instanceof Date ? Utilities.formatDate(r[4], tz, 'dd.MM.yyyy') : String(r[4] || '');
    return {
      liste: name, zeile: i + 2,
      ean: String(r[0] || '').replace(/[^0-9Xx]/g, '').toUpperCase(),
      titel: String(r[1] || ''), jahr: String(r[2] || ''), format: String(r[3] || ''),
      hinzugefuegtAm: datum, notiz: String(r[5] || ''),
      weitereEans: String(r[6] || '').split(/[,;\s]+/).map(eanBereinigen_).filter(String)
    };
  }).filter(function (x) { return x.titel || x.ean; });
}

function alleEintraege_() {
  return eintraege_('Sammlung').concat(eintraege_('Wunschliste'));
}

function zeileSchreiben_(name, d) {
  const sh = blatt_(name);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1).setNumberFormat('@');
  sh.getRange(row, 7).setNumberFormat('@');
  sh.getRange(row, 1, 1, SPALTEN.length).setValues([[
    eanBereinigen_(d.ean), titelSchreibweise_(d.titel), d.jahr ? Number(d.jahr) : '',
    d.format || '', new Date(), d.notiz || '', (d.weitereEans || []).join(', ')
  ]]);
}

function hinzufuegen_(req) {
  if (!req.titel) throw new Error('Titel fehlt');
  if (req.format && FORMATE.indexOf(req.format) < 0) throw new Error('Unbekanntes Format');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ean = eanBereinigen_(req.ean);
    if (ean && eintraege_(req.liste).some(function (x) { return eanPasst_(x, ean); })) {
      throw new Error('Diese EAN steht bereits in "' + req.liste + '"');
    }
    zeileSchreiben_(req.liste, req);
    return { ok: true, meldung: '„' + titelSchreibweise_(req.titel) + '“ wurde zu „' + req.liste + '“ hinzugefügt.' };
  } finally { lock.releaseLock(); }
}

/** Verschiebt einen Eintrag von der Wunschliste in die Sammlung. */
function kaufen_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const wl = eintraege_('Wunschliste');
    let e = wl.filter(function (x) { return x.zeile === Number(req.zeile) && x.titel === req.titel; })[0];
    if (!e) e = wl.filter(function (x) { return x.titel === req.titel; })[0];
    if (!e) throw new Error('Eintrag auf der Wunschliste nicht mehr gefunden');
    const neueEan = eanBereinigen_(req.ean) || e.ean;
    const weitere = e.weitereEans.slice();
    if (e.ean && e.ean !== neueEan && weitere.indexOf(e.ean) < 0) weitere.push(e.ean);
    zeileSchreiben_('Sammlung', {
      ean: neueEan, titel: e.titel, jahr: req.jahr || e.jahr,
      format: req.format || e.format, notiz: e.notiz, weitereEans: weitere
    });
    blatt_('Wunschliste').deleteRow(e.zeile);
    return { ok: true, meldung: '„' + e.titel + '“ wurde von der Wunschliste in die Sammlung übertragen.' };
  } finally { lock.releaseLock(); }
}

/** Hängt eine gescannte EAN an einen vorhandenen Eintrag an ("Weitere EANs"), ohne neue Zeile. */
function eanMerken_(req) {
  const ean = eanBereinigen_(req.ean);
  if (!ean) throw new Error('Ungültige EAN');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const daten = eintraege_(req.liste);
    let e = daten.filter(function (x) { return x.zeile === Number(req.zeile) && x.titel === req.titel; })[0];
    if (!e) e = daten.filter(function (x) { return x.titel === req.titel; })[0];
    if (!e) throw new Error('Eintrag nicht mehr gefunden');
    if (eanPasst_(e, ean)) return { ok: true, meldung: 'EAN ist bei „' + e.titel + '“ bereits gespeichert.' };
    const weitere = e.weitereEans.concat([ean]);
    blatt_(req.liste).getRange(e.zeile, 7).setNumberFormat('@').setValue(weitere.join(', '));
    return { ok: true, meldung: 'EAN bei „' + e.titel + '“ gemerkt. Diese Ausgabe wird ab jetzt sofort erkannt.' };
  } finally { lock.releaseLock(); }
}

function liste_(req) {
  const q = normalisieren_(req.suche);
  let daten = req.liste ? eintraege_(req.liste) : alleEintraege_();
  if (q) {
    const qEan = q.replace(/ /g, '');
    daten = daten.filter(function (x) {
      const t = normalisieren_(x.titel);
      return t.indexOf(q) >= 0 || x.ean.indexOf(qEan) >= 0 ||
        x.weitereEans.some(function (w) { return w.indexOf(qEan) >= 0; }) || titelGleich_(q, t);
    });
  }
  daten.sort(function (a, b) { return a.titel.localeCompare(b.titel, 'de'); });
  daten.forEach(function (x) { x.weitereEans = x.weitereEans.join(', '); });
  return { ok: true, eintraege: daten };
}

/* ------------------------------------------------------------------ */
/* Cover (neu in Version 3)                                           */
/* ------------------------------------------------------------------ */

/** req.filme = [{titel, jahr}] → { ok, poster: { "titel|jahr": url } }. Ergebnisse werden 6 Stunden gecacht. */
function poster_(req) {
  const filme = (req.filme || []).slice(0, 40);
  const cache = CacheService.getScriptCache();
  const schluessel = filme.map(function (f) { return 'p:' + normalisieren_(f.titel) + '|' + String(f.jahr || ''); });
  const vorhanden = schluessel.length ? cache.getAll(schluessel) : {};
  const ergebnis = {};
  const neu = {};
  filme.forEach(function (f, i) {
    const k = schluessel[i];
    const id = String(f.titel || '') + '|' + String(f.jahr || '');
    if (k in vorhanden) { ergebnis[id] = vorhanden[k]; return; }
    const t = tmdbSuche_(f.titel, f.jahr);
    const url = t.length ? (t[0].poster || '') : '';
    ergebnis[id] = url;
    neu[k] = url;
  });
  if (Object.keys(neu).length) cache.putAll(neu, 21600);
  return { ok: true, poster: ergebnis };
}
