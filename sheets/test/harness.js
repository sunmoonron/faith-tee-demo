// Runs Code.gs locally against in-memory tabs loaded from sheets/template/*.csv, with the
// Apps Script services (SpreadsheetApp, MailApp, LockService, CacheService, ...) mocked.
// Usage: node sheets/test/harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// Google Sheets turns numeric text into numbers; do the same so the script sees what it would see live.
function sheetValue(s) {
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(r => r.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  ensure(row, col) { while (this.rows.length < row) this.rows.push([]); while (this.rows[row - 1].length < col) this.rows[row - 1].push(''); }
  getDataRange() {
    const self = this;
    return { getValues() { const w = self.getLastColumn(); return self.rows.map(r => { const c = r.slice(); while (c.length < w) c.push(''); return c; }); } };
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) { const rr = self.rows[row - 1 + r] || []; const v = rr[col - 1 + c]; line.push(v === undefined ? '' : v); }
          out.push(line);
        }
        return out;
      },
      setValue(v) { self.ensure(row, col); self.rows[row - 1][col - 1] = v; },
      setValues(vals) { vals.forEach((line, r) => line.forEach((v, c) => { self.ensure(row + r, col + c); self.rows[row + r - 1][col + c - 1] = v; })); },
      setDataValidation() {}
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); }
  setFrozenRows() {}
}

class Book {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/TEST/edit'; }
  getSpreadsheetTimeZone() { return 'America/Toronto'; }
  insertSheet(n) { const s = new Sheet(n, []); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

function loadTemplates() {
  const dir = path.join(ROOT, 'template');
  return ['Products', 'Orders', 'Promos', 'Reviews', 'Settings'].map(name => {
    const rows = parseCsv(fs.readFileSync(path.join(dir, name + '.csv'), 'utf8')).map(r => r.map(sheetValue));
    return new Sheet(name, rows);
  });
}

function pad(n) { return String(n).padStart(2, '0'); }

function makeSandbox(book, sent, cache) {
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      flush() {},
      newDataValidation() { const b = { requireValueInList() { return b; }, setAllowInvalid() { return b; }, build() { return {}; } }; return b; }
    },
    MailApp: { sendEmail(o) { sent.push(o); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate(d, tz, fmt) {
        const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate()), h = pad(d.getHours()), mi = pad(d.getMinutes());
        return fmt.indexOf('HH') >= 0 ? `${y}-${m}-${day} ${h}:${mi}` : `${y}-${m}-${day}`;
      }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Logger: { log: (...a) => console.log('  [Logger]', ...a) },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  return sandbox;
}

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

function run() {
  const sent = [], cache = new Map();
  const book = new Book(loadTemplates());
  const gs = makeSandbox(book, sent, cache);
  const settingsSheet = book.getSheetByName('Settings');
  const setSetting = (key, value) => {
    const r = settingsSheet.rows.findIndex(row => row[0] === key);
    if (r < 0) settingsSheet.rows.push([key, value, '']); else settingsSheet.rows[r][1] = value;
  };
  const post = payload => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(payload), type: 'text/plain' } }).text);
  const postForm = fields => JSON.parse(gs.doPost({ postData: { contents: 'ignored=1', type: 'application/x-www-form-urlencoded' }, parameter: fields }).text);
  const get = params => JSON.parse(gs.doGet({ parameter: params }).text);
  const orders = () => book.getSheetByName('Orders').rows.slice(1);
  const TOKEN = 'change-me-to-a-random-string';

  console.log('Template rows embedded in Code.gs match sheets/template/*.csv');
  for (const name of ['Products', 'Orders', 'Promos', 'Reviews', 'Settings']) {
    const fromCsv = JSON.stringify(book.getSheetByName(name).rows);
    const fromGs = JSON.stringify(gs.TEMPLATE[name]);
    check(name, fromCsv === fromGs, fromCsv === fromGs ? undefined : { csv: book.getSheetByName(name).rows.slice(0, 3), gs: gs.TEMPLATE[name].slice(0, 3) });
  }

  console.log('doGet catalog');
  const cat = get({});
  check('ok', cat.ok === true, cat);
  check('4 active products', cat.products.length === 4, cat.products.map(p => p.id));
  check('2 approved reviews', cat.reviews.length === 2, cat.reviews);
  check('public settings have no token or owner emails', !('token' in cat.settings) && !('owner_emails' in cat.settings) && !('next_order' in cat.settings), Object.keys(cat.settings));
  check('public settings carry the hook line', cat.settings.hook_line === "Don't just read the Word, wear it", cat.settings.hook_line);

  console.log('doGet promo');
  const pr = get({ action: 'promo', code: 'faith10', subtotal: '70' });
  check('FAITH10 is 10 percent', pr.ok && pr.discount === 7, pr);
  const pr2 = get({ action: 'promo', code: 'CHURCH5', subtotal: '70' });
  check('inactive code rejected', pr2.ok === false, pr2);
  const pr3 = get({ action: 'promo', code: 'NOPE', subtotal: '70' });
  check('unknown code rejected', pr3.ok === false, pr3);

  const base = {
    token: TOKEN, name: 'Test Person', phone: '416 555 0199', email: 'customer@example.com', consent: true, website: '',
    items: [{ id: 'bestill', colour: 'Black', range: 'mens', size: 'M', qty: 2 }, { id: 'fearnot', colour: 'white', range: 'Youth', size: 'ym', qty: 1 }]
  };

  console.log('GTA delivery with a promo');
  const r1 = post(Object.assign({}, base, { ref: 'ref-1', delivery: 'gta', postal: 'm5v 2t6', address: '12 Example St, Toronto', promo: 'faith10' }));
  check('accepted', r1.ok === true, r1);
  check('order number SW-1042', r1.number === 'SW-1042', r1.number);
  check('subtotal 98 (2 x 35 + youth 28)', r1.subtotal === 98, r1.subtotal);
  check('discount 9.80', r1.discount === 9.8, r1.discount);
  check('total 88.20', r1.total === 88.2, r1.total);
  check('instructions mention cash and the e-Transfer address', /cash/.test(r1.instructions) && /info@example.com/.test(r1.instructions) && /SW-1042/.test(r1.instructions), r1.instructions);
  check('one row appended with status New and paid No', orders().length === 1 && orders()[0][11] === 'New' && orders()[0][12] === 'No', orders()[0]);
  check('row delivery label and postal', orders()[0][5] === 'GTA delivery' && /M5V 2T6/.test(orders()[0][6]), orders()[0].slice(5, 7));
  check('row items text', /2 x Be still, Black, Men's M, \$70.00/.test(orders()[0][7]) && /1 x Fear not, White, Youth YM, \$28.00/.test(orders()[0][7]), orders()[0][7]);
  check('two emails sent', sent.length === 2, sent.map(m => m.to));
  check('owners email goes to both owners', sent[0].to === 'owner1@example.com,owner2@example.com' && /New order SW-1042/.test(sent[0].subject), sent[0].subject);
  check('customer email has the number, total and instructions', sent[1].to === 'customer@example.com' && /SW-1042/.test(sent[1].subject) && /\$88\.20/.test(sent[1].body) && /e-Transfer/.test(sent[1].body), sent[1].body);
  check('next_order moved to 1043', settingsSheet.rows.find(r => r[0] === 'next_order')[1] === 1043);

  console.log('Duplicate submit with the same ref');
  const r1b = post(Object.assign({}, base, { ref: 'ref-1', delivery: 'gta', postal: 'M5V2T6', address: '12 Example St, Toronto', promo: 'FAITH10' }));
  check('same number returned', r1b.number === 'SW-1042', r1b);
  check('no second row, no more emails', orders().length === 1 && sent.length === 2);

  console.log('GTA delivery with a postal code outside the GTA');
  const r2 = post(Object.assign({}, base, { ref: 'ref-2', delivery: 'gta', postal: 'K1A 0B1', address: '1 Wellington St, Ottawa' }));
  check('rejected on the postal field', r2.ok === false && r2.field === 'postal', r2);
  check('no row, no email', orders().length === 1 && sent.length === 2);

  console.log('Pickup');
  const r3 = post(Object.assign({}, base, { ref: 'ref-3', delivery: 'pickup' }));
  check('accepted as SW-1043', r3.ok === true && r3.number === 'SW-1043', r3);
  check('pickup instructions carry the pickup note', /church/.test(r3.instructions) && /\$98\.00/.test(r3.instructions), r3.instructions);
  check('row has an empty address', orders()[1][6] === '', orders()[1][6]);

  console.log('Shipping while disabled, then enabled');
  const r4 = post(Object.assign({}, base, { ref: 'ref-4', delivery: 'ship', postal: 'N2L 3G1', address: '200 University Ave W, Waterloo' }));
  check('rejected while ship_enabled is no', r4.ok === false && r4.field === 'delivery', r4);
  setSetting('ship_enabled', 'yes');
  const r5 = post(Object.assign({}, base, { ref: 'ref-5', delivery: 'ship', postal: 'N2L 3G1', address: '200 University Ave W, Waterloo' }));
  check('accepted as SW-1044 with 12 shipping', r5.ok === true && r5.number === 'SW-1044' && r5.shipping === 12 && r5.total === 110, r5);
  check('ship instructions ask for the e-Transfer first', /e-Transfer of \$110\.00/.test(r5.instructions), r5.instructions);
  const r6 = post(Object.assign({}, base, { ref: 'ref-6', delivery: 'ship', postal: 'V6B 1A1', address: '100 Example Ave, Vancouver' }));
  check('non-Ontario postal code rejected', r6.ok === false && /Ontario/.test(r6.error), r6);
  const big = { items: [{ id: 'bestill', colour: 'Black', range: 'mens', size: 'M', qty: 5 }] };
  const r7 = post(Object.assign({}, base, big, { ref: 'ref-7', delivery: 'ship', postal: 'L5B 2C9', address: '1 City Centre Dr, Mississauga' }));
  check('free shipping at 175 subtotal', r7.ok === true && r7.shipping === 0 && r7.total === 175, r7);

  console.log('Sold out sizes');
  const r8 = post(Object.assign({}, base, { ref: 'ref-8', delivery: 'pickup', items: [{ id: 'fearnot', colour: 'Black', range: 'mens', size: 'XL', qty: 1 }] }));
  check("Fear not Men's XL rejected", r8.ok === false && /sold out/.test(r8.error), r8);
  const r9 = post(Object.assign({}, base, { ref: 'ref-9', delivery: 'pickup', items: [{ id: 'grace', colour: 'Black', range: 'womens', size: 'S', qty: 1 }] }));
  check('Grace upon grace (all) rejected', r9.ok === false && /sold out/.test(r9.error), r9);
  const r10 = post(Object.assign({}, base, { ref: 'ref-10', delivery: 'pickup', items: [{ id: 'fearnot', colour: 'Black', range: 'womens', size: 'XL', qty: 1 }] }));
  check("Women's XL does not exist", r10.ok === false && /size/.test(r10.error), r10);

  console.log('Honeypot, token, empty cart, bad promo');
  const before = orders().length;
  const r11 = post(Object.assign({}, base, { ref: 'ref-11', delivery: 'pickup', website: 'http://spam.example' }));
  check('honeypot: looks accepted but records nothing', r11.ok === true && orders().length === before, r11);
  const r12 = post(Object.assign({}, base, { ref: 'ref-12', delivery: 'pickup', token: 'wrong' }));
  check('wrong token rejected', r12.ok === false && /shop page/.test(r12.error), r12);
  const r13 = post(Object.assign({}, base, { ref: 'ref-13', delivery: 'pickup', items: [] }));
  check('empty cart rejected', r13.ok === false, r13);
  const r14 = post(Object.assign({}, base, { ref: 'ref-14', delivery: 'pickup', promo: 'CHURCH5' }));
  check('inactive promo rejected at order time', r14.ok === false && r14.field === 'promo', r14);
  const r15 = post(Object.assign({}, base, { ref: 'ref-15', delivery: 'pickup', email: 'not-an-email' }));
  check('bad email rejected', r15.ok === false && r15.field === 'email', r15);

  console.log('Form-encoded post (the no-cors fallback)');
  const r16 = postForm({ payload: JSON.stringify(Object.assign({}, base, { ref: 'ref-16', delivery: 'pickup' })) });
  check('payload field accepted', r16.ok === true && /^SW-\d+$/.test(r16.number), r16);
  const r17 = postForm({ token: TOKEN, ref: 'ref-17', name: 'Plain Fields', phone: '6475550100', email: 'plain@example.com', delivery: 'pickup', items: JSON.stringify(base.items) });
  check('plain fields accepted', r17.ok === true, r17);

  console.log('setupTabs on an empty book');
  const empty = new Book([new Sheet('Sheet1', [])]);
  const gs2 = makeSandbox(empty, [], new Map());
  const made = gs2.setupTabs();
  check('creates the five tabs', made.length === 5 && empty.getSheetByName('Settings').rows.length === 29, made);
  check('removes the empty default sheet', !empty.getSheetByName('Sheet1'));
  const cat2 = JSON.parse(gs2.doGet({ parameter: {} }).text);
  check('catalog works on the fresh book', cat2.ok && cat2.products.length === 4, cat2.products && cat2.products.length);

  console.log('');
  console.log(passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run();
