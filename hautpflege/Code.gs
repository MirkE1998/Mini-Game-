/**
 * Hautritual – Korean-Skincare-Tracker
 * Backend (Google Apps Script). Google Sheets dient als Datenbank:
 * ein Tabellenblatt pro Tabelle, Spalten = SCHEMA unten.
 *
 * Script-Properties:
 *   SHEET_ID  – ID der Tabelle (wird von setupSchema() angelegt, falls leer)
 *   ICON_URL  – optional, öffentliche PNG-URL für das Favicon
 *
 * Alle Werte werden als Text gespeichert (Zahlenformat "@"), damit Sheets
 * Datumswerte wie "2026-10-14" nicht in Date-Objekte umwandelt.
 */

var SCHEMA_VERSION = '1';

var SCHEMA = {
  profiles:     ['id', 'name', 'skinType', 'goals', 'onboarded', 'createdAt', 'updatedAt'],
  // Eine Zeile pro Schritt UND Tageszeit (ein Schritt kann morgens und abends geplant sein).
  // frequency: "daily" oder "days:1,3,5" (Wochentage nach JS getDay(): 0 = So … 6 = Sa)
  routineSteps: ['profileId', 'stepKey', 'timeOfDay', 'frequency', 'productId', 'updatedAt'],
  // sharedWith: JSON-Array der Profil-IDs (beide = gemeinsam, eine = privat)
  // notes: JSON {amount, order, method, application, contactTime, usageDuration, usageEnd, freeText}
  products:     ['id', 'name', 'brand', 'stepKey', 'openedAt', 'paoMonths', 'sharedWith', 'notes',
                 'remainingPercent', 'createdAt', 'updatedAt'],
  // STANDARD: Spalte timeOfDay ergänzt (Vorschlag hatte sie nicht), weil derselbe Schritt
  // morgens und abends getrennt abgehakt werden muss.
  logs:         ['profileId', 'date', 'stepKey', 'timeOfDay', 'done', 'updatedAt'],
  skinLog:      ['profileId', 'date', 'rating', 'text', 'updatedAt']
};

var JSON_FIELDS = { profiles: ['goals'], products: ['sharedWith', 'notes'] };

var DEFAULT_PROFILES = [
  { id: 'bibi', name: 'Bibi' },
  { id: 'bubu', name: 'Bubu' }
];

var STEP_KEYS = ['cleanser_oil', 'cleanser_water', 'exfoliant', 'toner', 'essence', 'serum',
                 'sheet_mask', 'eye_cream', 'moisturizer', 'sunscreen'];
var SKIN_TYPES = ['dry', 'oily', 'combination', 'sensitive'];
var GOALS = ['hydration', 'blemishes', 'glow', 'wrinkles'];
var TIMES = ['morning', 'evening'];

// STANDARD: Logs und Hauttagebuch werden für die letzten 400 Tage an den Client geschickt
// (reicht für Kalender und Diagramm, hält die Antwort klein).
var HISTORY_DAYS = 400;

/* ------------------------------------------------------------------ */
/* Web-App                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  var out = HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Hautritual')
    // Erlaubt das Einbetten über launcher/index.html (eigenes Homescreen-Icon).
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  // Apps Script akzeptiert nur wenige Meta-Tags und wirft sonst eine Exception.
  // Jeder Tag wird einzeln gesetzt, damit ein abgelehnter Tag die App nicht blockiert.
  [
    ['viewport', 'width=device-width, initial-scale=1, viewport-fit=cover'],
    ['apple-mobile-web-app-capable', 'yes'],
    ['mobile-web-app-capable', 'yes']
  ].forEach(function (tag) {
    try { out.addMetaTag(tag[0], tag[1]); } catch (err) { console.warn('Meta-Tag nicht erlaubt: ' + tag[0]); }
  });
  var icon = PropertiesService.getScriptProperties().getProperty('ICON_URL');
  if (icon) out.setFaviconUrl(icon);
  return out;
}

/** Bindet weitere HTML-Dateien (z. B. JavaScript.html) in Index.html ein. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ------------------------------------------------------------------ */
/* Schema-Setup                                                        */
/* ------------------------------------------------------------------ */

/**
 * Legt alle Tabellenblätter mit Kopfzeilen an (idempotent) und die zwei Profile.
 * Einmal im Editor ausführen – wird aber auch beim ersten App-Start automatisch aufgerufen.
 */
function setupSchema() {
  var props = PropertiesService.getScriptProperties();
  var ss;
  var id = props.getProperty('SHEET_ID');
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    // STANDARD: Ohne SHEET_ID wird eine neue Tabelle im Drive des Besitzers angelegt.
    ss = SpreadsheetApp.create('Hautritual – Daten');
    props.setProperty('SHEET_ID', ss.getId());
  }

  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var wanted = SCHEMA[name];
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var existing = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].filter(String);
    // Fehlende Spalten hinten anhängen, vorhandene Daten nie verschieben.
    var headers = existing.concat(wanted.filter(function (h) { return existing.indexOf(h) < 0; }));
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  });

  // Leeres Standardblatt ("Tabelle1"/"Sheet1") entfernen.
  ss.getSheets().forEach(function (sh) {
    if (!SCHEMA[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  var now = new Date().toISOString();
  var profiles = readAll_('profiles');
  DEFAULT_PROFILES.forEach(function (p) {
    var exists = profiles.some(function (x) { return x.id === p.id; });
    if (!exists) {
      upsert_('profiles', ['id'], {
        id: p.id, name: p.name, skinType: '', goals: [], onboarded: 'false', createdAt: now, updatedAt: now
      });
    }
  });

  props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
  return { ok: true, sheetId: ss.getId(), url: ss.getUrl() };
}

function ensureSchema_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') !== SCHEMA_VERSION || !props.getProperty('SHEET_ID')) {
    withLock_(setupSchema);
  }
}

/* ------------------------------------------------------------------ */
/* Öffentliche API (google.script.run)                                 */
/* ------------------------------------------------------------------ */

/** Lädt alle Daten beider Profile (die Datenmenge ist für zwei Personen klein). */
function getAll() {
  ensureSchema_();
  var cutoff = isoDate_(new Date(Date.now() - HISTORY_DAYS * 864e5));
  var recent = function (r) { return r.date >= cutoff; };
  return {
    profiles: readAll_('profiles').map(function (p) {
      p.onboarded = p.onboarded === 'true';
      return p;
    }),
    routineSteps: readAll_('routineSteps'),
    products: readAll_('products').map(function (p) {
      p.paoMonths = Number(p.paoMonths) || 0;
      p.remainingPercent = p.remainingPercent === '' ? 100 : Number(p.remainingPercent);
      p.sharedWith = p.sharedWith || [];
      p.notes = p.notes || {};
      return p;
    }),
    logs: readAll_('logs').filter(recent).map(function (l) {
      l.done = l.done === 'true';
      return l;
    }),
    skinLog: readAll_('skinLog').filter(recent).map(function (s) {
      s.rating = Number(s.rating) || 0;
      return s;
    })
  };
}

/** Speichert Hauttyp, Ziele und Onboarding-Status eines Profils. Name bleibt fest. */
function saveProfile(p) {
  checkProfile_(p.id);
  if (p.skinType && SKIN_TYPES.indexOf(p.skinType) < 0) throw new Error('Unbekannter Hauttyp.');
  var goals = (p.goals || []).filter(function (g) { return GOALS.indexOf(g) >= 0; }).slice(0, 3);
  return withLock_(function () {
    var current = readAll_('profiles').filter(function (x) { return x.id === p.id; })[0] || {};
    var now = new Date().toISOString();
    var row = {
      id: p.id,
      name: current.name || p.id,
      skinType: p.skinType || '',
      goals: goals,
      onboarded: p.onboarded ? 'true' : 'false',
      createdAt: current.createdAt || now,
      updatedAt: now
    };
    upsert_('profiles', ['id'], row);
    row.onboarded = !!p.onboarded;
    return row;
  });
}

/** Ersetzt die komplette Routine eines Profils. steps: [{stepKey, timeOfDay, frequency, productId}] */
function saveRoutine(profileId, steps) {
  checkProfile_(profileId);
  var now = new Date().toISOString();
  var rows = (steps || []).map(function (s) {
    if (STEP_KEYS.indexOf(s.stepKey) < 0) throw new Error('Unbekannter Schritt: ' + s.stepKey);
    if (TIMES.indexOf(s.timeOfDay) < 0) throw new Error('Unbekannte Tageszeit.');
    var freq = String(s.frequency || 'daily');
    if (freq !== 'daily' && !/^days:[0-6](,[0-6])*$/.test(freq)) throw new Error('Ungültige Häufigkeit.');
    return { profileId: profileId, stepKey: s.stepKey, timeOfDay: s.timeOfDay, frequency: freq,
             productId: s.productId || '', updatedAt: now };
  });
  return withLock_(function () {
    replaceWhere_('routineSteps', function (r) { return r.profileId === profileId; }, rows);
    return rows;
  });
}

/** Legt ein Produkt an oder aktualisiert es. Gibt das gespeicherte Produkt zurück. */
function saveProduct(p) {
  if (!p || !String(p.name || '').trim()) throw new Error('Bitte einen Produktnamen angeben.');
  if (STEP_KEYS.indexOf(p.stepKey) < 0) throw new Error('Bitte eine Kategorie wählen.');
  if (p.openedAt && !isDateStr_(p.openedAt)) throw new Error('Ungültiges Öffnungsdatum.');
  var shared = (p.sharedWith || []).filter(isProfile_);
  if (!shared.length) throw new Error('Bitte mindestens ein Profil zuordnen.');
  var n = p.notes || {};
  var notes = {
    amount: clip_(n.amount, 200), order: clip_(n.order, 200), method: clip_(n.method, 200),
    application: clip_(n.application, 1000),
    contactTime: Math.max(0, Math.min(120, Number(n.contactTime) || 0)),
    usageDuration: clip_(n.usageDuration, 200),
    usageEnd: isDateStr_(n.usageEnd) ? n.usageEnd : '',
    freeText: clip_(n.freeText, 2000)
  };
  return withLock_(function () {
    var now = new Date().toISOString();
    var existing = p.id ? readAll_('products').filter(function (x) { return x.id === p.id; })[0] : null;
    var row = {
      id: existing ? existing.id : Utilities.getUuid(),
      name: clip_(p.name, 120),
      brand: clip_(p.brand, 120),
      stepKey: p.stepKey,
      openedAt: p.openedAt || '',
      paoMonths: [6, 12, 24].indexOf(Number(p.paoMonths)) >= 0 ? Number(p.paoMonths) : 12,
      sharedWith: shared,
      notes: notes,
      remainingPercent: Math.max(0, Math.min(100, Math.round(Number(p.remainingPercent)))) || 0,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    upsert_('products', ['id'], row);
    return row;
  });
}

/** Löscht ein Produkt und entfernt Verweise darauf aus den Routinen. */
function deleteProduct(id) {
  if (!id) throw new Error('Keine Produkt-ID.');
  return withLock_(function () {
    replaceWhere_('products', function (r) { return r.id === id; }, []);
    var t = table_('routineSteps');
    var col = t.headers.indexOf('productId');
    t.rows.forEach(function (r, i) {
      if (r[col] === id) t.sh.getRange(i + 2, col + 1).setValue('');
    });
    return { ok: true };
  });
}

/** Hakt Schritte ab (oder wieder auf). entries: [{profileId, date, stepKey, timeOfDay, done}] */
function setLogs(entries) {
  entries = entries || [];
  entries.forEach(function (e) {
    checkProfile_(e.profileId);
    if (!isDateStr_(e.date)) throw new Error('Ungültiges Datum.');
    if (STEP_KEYS.indexOf(e.stepKey) < 0) throw new Error('Unbekannter Schritt.');
    if (TIMES.indexOf(e.timeOfDay) < 0) throw new Error('Unbekannte Tageszeit.');
  });
  return withLock_(function () {
    var now = new Date().toISOString();
    var keys = ['profileId', 'date', 'stepKey', 'timeOfDay'];
    upsertMany_('logs', keys, entries.map(function (e) {
      return { profileId: e.profileId, date: e.date, stepKey: e.stepKey, timeOfDay: e.timeOfDay,
               done: e.done ? 'true' : 'false', updatedAt: now };
    }));
    return { ok: true };
  });
}

/** Speichert den Hautwert (1–5) und eine Notiz für einen Tag. */
function saveSkinLog(e) {
  checkProfile_(e.profileId);
  if (!isDateStr_(e.date)) throw new Error('Ungültiges Datum.');
  var rating = Math.round(Number(e.rating));
  if (!(rating >= 1 && rating <= 5)) throw new Error('Bitte einen Hautwert von 1 bis 5 wählen.');
  return withLock_(function () {
    var row = { profileId: e.profileId, date: e.date, rating: rating, text: clip_(e.text, 1000),
                updatedAt: new Date().toISOString() };
    upsert_('skinLog', ['profileId', 'date'], row);
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* Tabellen-Helfer                                                     */
/* ------------------------------------------------------------------ */

function db_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID fehlt in den Script-Properties – bitte setupSchema() ausführen.');
  return SpreadsheetApp.openById(id);
}

function table_(name) {
  var sh = db_().getSheetByName(name);
  if (!sh) throw new Error('Tabellenblatt "' + name + '" fehlt – bitte setupSchema() ausführen.');
  var values = sh.getDataRange().getDisplayValues();
  var headers = values.shift() || [];
  var rows = values.filter(function (r) { return r.join('') !== ''; });
  return { sh: sh, headers: headers, rows: rows };
}

function toObj_(name, headers, row) {
  var o = {};
  var jsonCols = JSON_FIELDS[name] || [];
  headers.forEach(function (h, i) {
    var v = row[i];
    if (jsonCols.indexOf(h) >= 0) {
      try { v = v ? JSON.parse(v) : null; } catch (err) { v = null; }
    }
    o[h] = v;
  });
  return o;
}

function toRow_(name, headers, obj) {
  var jsonCols = JSON_FIELDS[name] || [];
  return headers.map(function (h) {
    var v = obj[h];
    if (jsonCols.indexOf(h) >= 0) return JSON.stringify(v == null ? null : v);
    return v == null ? '' : String(v);
  });
}

function readAll_(name) {
  var t = table_(name);
  return t.rows.map(function (r) { return toObj_(name, t.headers, r); });
}

function writeRows_(sh, startRow, rows) {
  if (!rows.length) return;
  sh.getRange(startRow, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

function upsert_(name, keyFields, obj) {
  upsertMany_(name, keyFields, [obj]);
}

/** Aktualisiert passende Zeilen (nach keyFields) und hängt neue in einem Block an. */
function upsertMany_(name, keyFields, objs) {
  if (!objs.length) return;
  var t = table_(name);
  var keyIdx = keyFields.map(function (k) { return t.headers.indexOf(k); });
  var index = {};
  t.rows.forEach(function (r, i) {
    index[keyIdx.map(function (k) { return r[k]; }).join('|')] = i;
  });
  var appended = [];
  objs.forEach(function (o) {
    var key = keyFields.map(function (k) { return String(o[k]); }).join('|');
    var row = toRow_(name, t.headers, o);
    if (index[key] !== undefined) {
      writeRows_(t.sh, index[key] + 2, [row]);
    } else {
      index[key] = t.rows.length + appended.length;
      appended.push(row);
    }
  });
  writeRows_(t.sh, t.rows.length + 2, appended);
}

/** Entfernt alle Zeilen, auf die predicate zutrifft, und fügt newObjs hinzu. */
function replaceWhere_(name, predicate, newObjs) {
  var t = table_(name);
  var keep = t.rows.filter(function (r) { return !predicate(toObj_(name, t.headers, r)); });
  var rows = keep.concat(newObjs.map(function (o) { return toRow_(name, t.headers, o); }));
  var lastRow = t.sh.getLastRow();
  if (lastRow > 1) t.sh.getRange(2, 1, lastRow - 1, t.headers.length).clearContent();
  writeRows_(t.sh, 2, rows);
}

/* ------------------------------------------------------------------ */
/* Allgemeine Helfer                                                   */
/* ------------------------------------------------------------------ */

/** Serialisiert Schreibzugriffe, damit beide Profile gleichzeitig speichern können. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Die Daten werden gerade gespeichert – bitte kurz erneut versuchen.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function isProfile_(id) {
  return DEFAULT_PROFILES.some(function (p) { return p.id === id; });
}

function checkProfile_(id) {
  if (!isProfile_(id)) throw new Error('Unbekanntes Profil.');
}

function isDateStr_(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isoDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function clip_(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}
