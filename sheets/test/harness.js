// Runs Code.gs locally against in-memory tabs loaded from sheets/template/*.csv, with the
// Apps Script services (SpreadsheetApp, MailApp, LockService, CacheService, Drive, ...) mocked.
// Usage: node sheets/test/harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, TABS, templateRows } = require('./lib');

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
      setDataValidation() { self.validated = (self.validated || 0) + 1; }
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); }
  setFrozenRows() {}
}

class Book {
  constructor(sheets) { this.sheets = sheets; this.toasts = []; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/TEST/edit'; }
  getSpreadsheetTimeZone() { return 'America/Los_Angeles'; }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  insertSheet(n) { const s = new Sheet(n, []); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  toast(message) { this.toasts.push(message); }
}

const loadTemplates = () => TABS.map(([tab, csv]) => new Sheet(tab, templateRows(csv)));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function makeSandbox(book) {
  const env = { sent: [], cache: new Map(), props: new Map(), drive: { files: [], failUpload: false, nextId: 1 } };
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      flush() {},
      newDataValidation() { const b = { requireValueInList() { return b; }, setAllowInvalid() { return b; }, build() { return {}; } }; return b; },
      getUi() { const m = { addItem() { return m; }, addToUi() { env.menu = true; } }; return { createMenu() { return m; } }; }
    },
    MailApp: { sendEmail(o) { env.sent.push(o); } },
    LockService: { getScriptLock: () => ({ waitLock() { env.locks = (env.locks || 0) + 1; }, releaseLock() { env.unlocks = (env.unlocks || 0) + 1; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (env.cache.has(k) ? env.cache.get(k) : null), put: (k, v) => env.cache.set(k, v) }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: {
      formatDate(d, tz, fmt) { return fmt.indexOf('HH') >= 0 ? `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ymd(d); },
      base64Decode(s) { return Buffer.from(s, 'base64'); },
      newBlob(bytes, type, name) { return { bytes, type, name, getName() { return this.name; }, setName(n) { this.name = n; return this; } }; }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (env.props.has(k) ? env.props.get(k) : null), setProperty: (k, v) => { env.props.set(k, v); } }) },
    Session: { getScriptTimeZone: () => 'America/Toronto' },
    // The Drive advanced service, v3: only what the script calls.
    Drive: {
      Files: {
        create(resource, blob) {
          if (blob && env.drive.failUpload) throw new Error('Drive is not available');
          const f = { id: 'file' + env.drive.nextId++, name: resource.name, mimeType: resource.mimeType || (blob && blob.type), parents: resource.parents || [], trashed: false, size: blob ? blob.bytes.length : 0 };
          f.webViewLink = 'https://drive.google.com/file/d/' + f.id + '/view';
          env.drive.files.push(f);
          return f;
        },
        get(id) { const f = env.drive.files.find(x => x.id === id); if (!f) throw new Error('File not found: ' + id); return f; },
        list(args) {
          const m = /name = '([^']+)'/.exec(args.q || '');
          return { files: env.drive.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder' && !f.trashed && (!m || f.name === m[1])).slice(0, args.pageSize || 100) };
        }
      }
    },
    Logger: { log() {} },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  return { gs: sandbox, env };
}

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

function run() {
  const book = new Book(loadTemplates());
  const { gs, env } = makeSandbox(book);
  const sent = env.sent;
  const sheet = name => book.getSheetByName(name);
  const settingsSheet = sheet('Settings');
  const setSetting = (key, value) => {
    const r = settingsSheet.rows.findIndex(row => row[0] === key);
    if (r < 0) settingsSheet.rows.push([key, value, '']); else settingsSheet.rows[r][1] = value;
  };
  const getSetting = key => (settingsSheet.rows.find(r => r[0] === key) || [])[1];
  const setProduct = (id, column, value) => {
    const s = sheet('Products'), c = s.rows[0].indexOf(column), r = s.rows.findIndex(row => row[0] === id);
    if (c < 0 || r < 0) throw new Error('no such product cell: ' + id + ' ' + column);
    while (s.rows[r].length <= c) s.rows[r].push('');
    s.rows[r][c] = value;
  };
  const stockRow = (id, colour, range, size) => sheet('Stock').rows.find(r => r[0] === id && r[1] === colour && r[2] === range && r[3] === size);
  const post = payload => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(payload), type: 'text/plain' } }).text);
  const postForm = fields => JSON.parse(gs.doPost({ postData: { contents: 'ignored=1', type: 'application/x-www-form-urlencoded' }, parameter: fields }).text);
  const get = params => JSON.parse(gs.doGet({ parameter: params }).text);
  const orders = () => sheet('Orders').rows.slice(1);
  const requests = () => sheet('Church requests').rows.slice(1);
  const TOKEN = 'change-me-to-a-random-string';

  console.log('Setup rows in Code.gs match sheets/template/*.csv');
  for (const [tab] of TABS) {
    const fromCsv = JSON.stringify(sheet(tab).rows), fromGs = JSON.stringify(gs.TEMPLATE[tab]);
    check(tab, fromCsv === fromGs, fromCsv === fromGs ? undefined : { csv: sheet(tab).rows.slice(0, 2), gs: (gs.TEMPLATE[tab] || []).slice(0, 2) });
  }

  console.log('doGet catalog');
  const cat = get({});
  check('ok', cat.ok === true, cat);
  check('4 active products', cat.products.length === 4, cat.products.map(p => p.id));
  check('2 approved reviews', cat.reviews.length === 2, cat.reviews);
  check('no media yet', Array.isArray(cat.media) && cat.media.length === 0, cat.media);
  check('private settings stay private', !['token', 'owner_emails', 'next_order', 'default_stock', 'next_church_request'].some(k => k in cat.settings), Object.keys(cat.settings));
  check('public settings carry the hook line and the church intro', cat.settings.hook_line === "Don't just read the Word, wear it" && /church/.test(cat.settings.church_intro), cat.settings);
  check('blank try-on note is left out', !('tryon_note' in cat.settings));
  setSetting('tryon_note', 'See the shirts at the rink on Tuesday evenings.');
  check('try-on note is public once filled in', get({}).settings.tryon_note === 'See the shirts at the rink on Tuesday evenings.');

  console.log('doGet promo');
  const pr = get({ action: 'promo', code: 'faith10', subtotal: '70' });
  check('FAITH10 is 10 percent', pr.ok && pr.discount === 7, pr);
  check('inactive code rejected', get({ action: 'promo', code: 'CHURCH5', subtotal: '70' }).ok === false);
  check('unknown code rejected', get({ action: 'promo', code: 'NOPE', subtotal: '70' }).ok === false);

  const base = {
    token: TOKEN, name: 'Test Person', phone: '416 555 0199', email: 'customer@example.com', consent: true, website: '',
    items: [{ id: 'poweredbygod', colour: 'White', range: 'mens', size: 'M', qty: 2 }, { id: 'bestai', colour: 'white', range: 'Youth', size: 'ym', qty: 1 }]
  };

  console.log('GTA delivery with a promo (no stock rows yet, so nothing is counted)');
  const r1 = post(Object.assign({}, base, { ref: 'ref-1', delivery: 'gta', postal: 'm5v 2t6', address: '12 Example St, Toronto', promo: 'faith10' }));
  check('accepted', r1.ok === true, r1);
  check('order number QV-1042', r1.number === 'QV-1042', r1.number);
  check('subtotal 98 (2 x 35 + youth 28)', r1.subtotal === 98, r1.subtotal);
  check('discount 9.80', r1.discount === 9.8, r1.discount);
  check('total 88.20', r1.total === 88.2, r1.total);
  check('instructions mention cash and the e-Transfer address', /cash/.test(r1.instructions) && /info@example.com/.test(r1.instructions) && /QV-1042/.test(r1.instructions), r1.instructions);
  check('one row appended with status New and paid No', orders().length === 1 && orders()[0][11] === 'New' && orders()[0][12] === 'No', orders()[0]);
  check('row has the number and a timestamp', orders()[0][0] === 'QV-1042' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(orders()[0][1]), orders()[0].slice(0, 2));
  check('row delivery label and postal', orders()[0][5] === 'GTA delivery' && /M5V 2T6/.test(orders()[0][6]), orders()[0].slice(5, 7));
  check('row items text', /2 x Powered by God, White, Men's M, \$70.00/.test(orders()[0][7]) && /1 x The best AI, White, Youth YM, \$28.00/.test(orders()[0][7]), orders()[0][7]);
  check('two emails sent', sent.length === 2, sent.map(m => m.to));
  check('owners email goes to both owners', sent[0].to === 'owner1@example.com,owner2@example.com' && /New order QV-1042/.test(sent[0].subject), sent[0].subject);
  check('customer email has the number, total and instructions', sent[1].to === 'customer@example.com' && /QV-1042/.test(sent[1].subject) && /\$88\.20/.test(sent[1].body) && /e-Transfer/.test(sent[1].body), sent[1].body);
  check('next_order moved to 1043', getSetting('next_order') === 1043);
  check('the lock was taken and released', env.locks === 1 && env.unlocks === 1, [env.locks, env.unlocks]);

  console.log('Duplicate submit with the same ref');
  const r1b = post(Object.assign({}, base, { ref: 'ref-1', delivery: 'gta', postal: 'M5V2T6', address: '12 Example St, Toronto', promo: 'FAITH10' }));
  check('same number returned', r1b.number === 'QV-1042', r1b);
  check('no second row, no more emails', orders().length === 1 && sent.length === 2);

  console.log('GTA delivery with a postal code outside the GTA');
  const r2 = post(Object.assign({}, base, { ref: 'ref-2', delivery: 'gta', postal: 'K1A 0B1', address: '1 Wellington St, Ottawa' }));
  check('rejected on the postal field', r2.ok === false && r2.field === 'postal', r2);
  check('no row, no email', orders().length === 1 && sent.length === 2);

  console.log('Pickup');
  const r3 = post(Object.assign({}, base, { ref: 'ref-3', delivery: 'pickup' }));
  check('accepted as QV-1043', r3.ok === true && r3.number === 'QV-1043', r3);
  check('pickup instructions carry the pickup note', /church/.test(r3.instructions) && /\$98\.00/.test(r3.instructions), r3.instructions);
  check('row has an empty address', orders()[1][6] === '', orders()[1][6]);

  console.log('Shipping while disabled, then enabled');
  const r4 = post(Object.assign({}, base, { ref: 'ref-4', delivery: 'ship', postal: 'N2L 3G1', address: '200 University Ave W, Waterloo' }));
  check('rejected while ship_enabled is no', r4.ok === false && r4.field === 'delivery', r4);
  setSetting('ship_enabled', 'yes');
  const r5 = post(Object.assign({}, base, { ref: 'ref-5', delivery: 'ship', postal: 'N2L 3G1', address: '200 University Ave W, Waterloo' }));
  check('accepted as QV-1044 with 12 shipping', r5.ok === true && r5.number === 'QV-1044' && r5.shipping === 12 && r5.total === 110, r5);
  check('ship instructions ask for the e-Transfer first', /e-Transfer of \$110\.00/.test(r5.instructions), r5.instructions);
  const r6 = post(Object.assign({}, base, { ref: 'ref-6', delivery: 'ship', postal: 'V6B 1A1', address: '100 Example Ave, Vancouver' }));
  check('non-Ontario postal code rejected', r6.ok === false && /Ontario/.test(r6.error), r6);
  const big = { items: [{ id: 'poweredbygod', colour: 'White', range: 'mens', size: 'M', qty: 5 }] };
  const r7 = post(Object.assign({}, base, big, { ref: 'ref-7', delivery: 'ship', postal: 'L5B 2C9', address: '1 City Centre Dr, Mississauga' }));
  check('free shipping at 175 subtotal', r7.ok === true && r7.shipping === 0 && r7.total === 175, r7);

  console.log('Sold out sizes from the Products tab');
  setProduct('bestai', 'sold_out_sizes', "Men's XL");
  setProduct('garden', 'sold_out_sizes', 'all');
  const r8 = post(Object.assign({}, base, { ref: 'ref-8', delivery: 'pickup', items: [{ id: 'bestai', colour: 'White', range: 'mens', size: 'XL', qty: 1 }] }));
  check("The best AI Men's XL rejected", r8.ok === false && /sold out/.test(r8.error), r8);
  const r9 = post(Object.assign({}, base, { ref: 'ref-9', delivery: 'pickup', items: [{ id: 'garden', colour: 'White', range: 'womens', size: 'S', qty: 1 }] }));
  check('Garden (all) rejected', r9.ok === false && /sold out/.test(r9.error), r9);
  const r10 = post(Object.assign({}, base, { ref: 'ref-10', delivery: 'pickup', items: [{ id: 'bestai', colour: 'White', range: 'womens', size: 'XL', qty: 1 }] }));
  check("Women's XL does not exist", r10.ok === false && /size/.test(r10.error), r10);
  setProduct('bestai', 'sold_out_sizes', '');
  setProduct('garden', 'sold_out_sizes', '');

  console.log('Honeypot, token, empty cart, bad promo');
  const before = orders().length;
  const r11 = post(Object.assign({}, base, { ref: 'ref-11', delivery: 'pickup', website: 'http://spam.example' }));
  check('honeypot: looks accepted but records nothing', r11.ok === true && orders().length === before, r11);
  const r12 = post(Object.assign({}, base, { ref: 'ref-12', delivery: 'pickup', token: 'wrong' }));
  check('wrong token rejected', r12.ok === false && /shop page/.test(r12.error), r12);
  check('empty cart rejected', post(Object.assign({}, base, { ref: 'ref-13', delivery: 'pickup', items: [] })).ok === false);
  const r14 = post(Object.assign({}, base, { ref: 'ref-14', delivery: 'pickup', promo: 'CHURCH5' }));
  check('inactive promo rejected at order time', r14.ok === false && r14.field === 'promo', r14);
  const r15 = post(Object.assign({}, base, { ref: 'ref-15', delivery: 'pickup', email: 'not-an-email' }));
  check('bad email rejected', r15.ok === false && r15.field === 'email', r15);

  console.log('Form-encoded post (the no-cors fallback)');
  const r16 = postForm({ payload: JSON.stringify(Object.assign({}, base, { ref: 'ref-16', delivery: 'pickup' })) });
  check('payload field accepted', r16.ok === true && /^QV-\d+$/.test(r16.number), r16);
  const r17 = postForm({ token: TOKEN, ref: 'ref-17', name: 'Plain Fields', phone: '6475550100', email: 'plain@example.com', delivery: 'pickup', items: JSON.stringify(base.items) });
  check('plain fields accepted', r17.ok === true, r17);

  console.log('Stock counts');
  const seeded = gs.seedStock();
  check('seedStock adds a row for every size of every active product (4 x 10)', seeded === 40 && sheet('Stock').rows.length === 41, [seeded, sheet('Stock').rows.length]);
  check('rows start at default_stock', stockRow('poweredbygod', 'White', "Men's", 'M')[4] === 25 && stockRow('garden', 'White', 'Youth', 'YL')[4] === 25, stockRow('poweredbygod', 'White', "Men's", 'M'));
  check('running it again adds nothing', gs.seedStock() === 0 && sheet('Stock').rows.length === 41);
  check('it says so in the sheet', /Added 40 stock rows/.test(book.toasts[0]) && /already/.test(book.toasts[1]), book.toasts);
  const s1 = post(Object.assign({}, base, { ref: 'stock-1', delivery: 'pickup' }));
  check('an order lowers the counts', s1.ok === true && stockRow('poweredbygod', 'White', "Men's", 'M')[4] === 23 && stockRow('bestai', 'White', 'Youth', 'YM')[4] === 24, [s1, stockRow('poweredbygod', 'White', "Men's", 'M')]);
  check('other sizes are untouched', stockRow('poweredbygod', 'White', "Men's", 'L')[4] === 25);
  stockRow('poweredbygod', 'White', "Men's", 'M')[4] = 1;
  const rowsBefore = orders().length, mailBefore = sent.length, nextBefore = getSetting('next_order');
  const s2 = post(Object.assign({}, base, { ref: 'stock-2', delivery: 'pickup' }));
  check('asking for more than is left is rejected, naming the size', s2.ok === false && s2.field === 'items' && /Only 1 left of Powered by God, White, Men's M/.test(s2.error), s2);
  check('nothing was taken, recorded, numbered or emailed', stockRow('poweredbygod', 'White', "Men's", 'M')[4] === 1 && stockRow('bestai', 'White', 'Youth', 'YM')[4] === 24 && orders().length === rowsBefore && sent.length === mailBefore && getSetting('next_order') === nextBefore);
  check('the lock is released after a rejection', env.locks === env.unlocks, [env.locks, env.unlocks]);
  const s3 = post(Object.assign({}, base, { ref: 'stock-3', delivery: 'pickup', items: [{ id: 'poweredbygod', colour: 'White', range: 'mens', size: 'L', qty: 3 }, { id: 'poweredbygod', colour: 'White', range: 'mens', size: 'L', qty: 3 }] }));
  check('two lines of one size are added up (3 + 3 of 25 leaves 19)', s3.ok === true && stockRow('poweredbygod', 'White', "Men's", 'L')[4] === 19, [s3.ok, stockRow('poweredbygod', 'White', "Men's", 'L')]);
  stockRow('poweredbygod', 'White', "Men's", 'M')[4] = 0;
  const s4 = post(Object.assign({}, base, { ref: 'stock-4', delivery: 'pickup' }));
  check('a size at zero is sold out', s4.ok === false && /Powered by God, White, Men's M is sold out/.test(s4.error), s4);
  const catStock = get({});
  const pbg = catStock.products.find(p => p.id === 'poweredbygod');
  check('the catalogue marks the zero size sold out', pbg.sold_out_sizes === "White Men's M", pbg.sold_out_sizes);
  setProduct('poweredbygod', 'sold_out_sizes', 'Youth YS');
  check('merged with sold_out_sizes from the Products tab', get({}).products.find(p => p.id === 'poweredbygod').sold_out_sizes === "Youth YS, White Men's M");
  setProduct('poweredbygod', 'sold_out_sizes', '');
  sheet('Stock').rows.filter(r => r[0] === 'garden').forEach(r => { r[4] = 0; });
  const gardenTokens = get({}).products.find(p => p.id === 'garden').sold_out_sizes.split(', ');
  check('a product with every size at zero lists all ten', gardenTokens.length === 10 && gardenTokens.includes('White Youth YL'), gardenTokens);
  stockRow('poweredbygod', 'White', "Men's", 'M')[4] = '';
  const s5 = post(Object.assign({}, base, { ref: 'stock-5', delivery: 'pickup' }));
  check('a blank count is not tracked', s5.ok === true && stockRow('poweredbygod', 'White', "Men's", 'M')[4] === '', s5);
  sheet('Stock').rows = sheet('Stock').rows.filter(r => !(r[0] === 'bestai' && r[3] === 'YM'));
  const s6 = post(Object.assign({}, base, { ref: 'stock-6', delivery: 'pickup', items: [{ id: 'bestai', colour: 'White', range: 'youth', size: 'YM', qty: 9 }] }));
  check('a size with no stock row never runs out', s6.ok === true, s6);

  console.log('Media tab');
  sheet('Media').rows.push(['Christmas flyer', 'PDF', 'christmas-flyer.pdf', '2026-11-01', 'Print it for your bulletin'], ['Launch video', 'video', 'https://youtu.be/abc123XYZ00', '2026-11-04', ''], ['No link yet', 'video', '', '2026-11-05', '']);
  const media = get({}).media;
  check('rows with a title and a file or link are served', media.length === 2 && media[0].type === 'pdf' && media[0].file === 'christmas-flyer.pdf' && media[1].file === 'https://youtu.be/abc123XYZ00', media);
  // Sheets hands the script a Date for a date cell; make it in the script's own realm, as Apps Script does.
  sheet('Media').rows.push(['Dated by the sheet', 'pdf', 'dated.pdf', vm.runInContext('new Date(2026, 10, 20)', gs), '']);
  check('a date cell is served as plain text', get({}).media[2].date === '2026-11-20', get({}).media[2]);

  console.log('Church request');
  const soon = new Date(); soon.setDate(soon.getDate() + 30);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const church = {
    type: 'church', token: TOKEN, website: '', church: 'Grace Community Church', contact: 'Dana Okafor', email: 'Dana@Grace.example', phone: '905 555 0144',
    colour: 'Navy', sizes: { mens: { S: 5, M: 10, '5XL': 3 }, womens: { m: 6 }, youth: { YL: 2, YS: '0' } }, date: ymd(soon), delivery: 'gta',
    notes: 'Logo on the front, verse on the back.', rights: true, file: { name: 'C:\\art\\grace logo.PNG', type: 'image/png', data: 'data:image/png;base64,' + png }
  };
  const mailC = sent.length;
  const c1 = post(Object.assign({}, church, { ref: 'church-1' }));
  check('accepted as CH-1001', c1.ok === true && c1.number === 'CH-1001', c1);
  check('counts only the sizes on offer (5 + 10 + 6 + 2)', c1.total === 23, c1.total);
  check('one row with the fields and status New', requests().length === 1 && requests()[0][0] === 'CH-1001' && requests()[0][2] === 'Grace Community Church' && requests()[0][4] === 'dana@grace.example' && requests()[0][15] === 'New', requests()[0]);
  check('sizes are written as text', requests()[0][7] === 'S 5, M 10' && requests()[0][8] === 'M 6' && requests()[0][9] === 'YL 2' && requests()[0][10] === 23 && requests()[0][12] === 'GTA delivery', requests()[0].slice(7, 13));
  const folder = env.drive.files.find(f => f.mimeType === 'application/vnd.google-apps.folder');
  const saved = env.drive.files.find(f => f.mimeType === 'image/png');
  check('the artwork is saved in a Church artwork folder in Drive', !!folder && folder.name === 'Church artwork' && !!saved && saved.parents[0] === folder.id && saved.size === 16, env.drive.files);
  check('the file is named after the request and the church', saved.name === 'CH-1001 Grace Community Church grace logo.PNG', saved.name);
  check('the row holds the Drive link', requests()[0][14] === saved.webViewLink && c1.artwork === 'saved', requests()[0][14]);
  check('owners get the link, the church gets a confirmation', sent.length === mailC + 2 && /Church request CH-1001: Grace Community Church, 23 shirts/.test(sent[mailC].subject) && sent[mailC].body.includes(saved.webViewLink) && sent[mailC].replyTo === 'dana@grace.example' && sent[mailC + 1].to === 'dana@grace.example' && /request CH-1001 received/.test(sent[mailC + 1].subject) && /quote/.test(sent[mailC + 1].body), sent.slice(mailC).map(m => m.subject));
  check('next_church_request moved to 1002', getSetting('next_church_request') === 1002);
  const c1b = post(Object.assign({}, church, { ref: 'church-1' }));
  check('a repeat with the same ref records nothing new', c1b.number === 'CH-1001' && requests().length === 1 && sent.length === mailC + 2);
  const c2 = post(Object.assign({}, church, { ref: 'church-2', delivery: 'pickup', file: { name: 'logo.pdf', data: png } }));
  check('the next one is CH-1002 in the same folder', c2.ok === true && c2.number === 'CH-1002' && env.drive.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder').length === 1 && requests()[1][12] === 'Pickup', c2);

  const bad = (label, change, field, pattern) => {
    const n = requests().length, m = sent.length;
    const r = post(Object.assign({}, church, { ref: 'bad-' + label }, change));
    check(label, r.ok === false && (!field || r.field === field) && (!pattern || pattern.test(r.error)) && requests().length === n && sent.length === m, r);
  };
  bad('a wrong file type is rejected', { file: { name: 'logo.exe', data: png } }, 'artwork', /PNG, JPG, PDF, SVG, AI or EPS/);
  bad('a file over 10 MB is rejected', { file: { name: 'huge.png', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') } }, 'artwork', /larger than 10 MB/);
  bad('a missing file is rejected', { file: null }, 'artwork', /Attach the artwork/);
  bad('the permission box is required', { rights: false }, 'rights', /permission/);
  bad('at least one shirt is required', { sizes: { mens: { S: 0 } } }, 'sizes', /at least one size/);
  bad('a date in the past is rejected', { date: '2020-01-01' }, 'date', /passed/);
  bad('a missing date is rejected', { date: '' }, 'date');
  bad('delivery has to be GTA or pickup', { delivery: 'ship' }, 'delivery');
  bad('a wrong token is rejected', { token: 'nope' }, undefined, /did not come from the site/);
  const nBefore = requests().length;
  const c3 = post(Object.assign({}, church, { ref: 'church-3', website: 'spam' }));
  check('honeypot: looks accepted but records nothing', c3.ok === true && requests().length === nBefore);
  const tenMb = post(Object.assign({}, church, { ref: 'church-10mb', file: { name: 'big.pdf', data: Buffer.alloc(10 * 1024 * 1024).toString('base64') } }));
  check('a file of exactly 10 MB is accepted', tenMb.ok === true, tenMb.error);

  console.log('Church request when Drive refuses the file');
  env.drive.failUpload = true;
  const mailD = sent.length;
  const c4 = post(Object.assign({}, church, { ref: 'church-4' }));
  check('the request still goes through', c4.ok === true && c4.artwork === 'emailed', c4);
  check('the file rides on the owners email instead', sent[mailD].attachments && sent[mailD].attachments.length === 1 && /attached to this email/.test(sent[mailD].body) && !sent[mailD + 1].attachments, sent[mailD].body);
  check('the row says where the artwork went', /Attached to the owners email/.test(requests()[requests().length - 1][14]), requests()[requests().length - 1][14]);
  env.drive.failUpload = false;

  console.log('setupTabs on an empty book');
  const empty = new Book([new Sheet('Sheet1', [])]);
  const fresh = makeSandbox(empty);
  const made = fresh.gs.setupTabs();
  check('creates the eight tabs', made.length === 8 && empty.getSheetByName('Settings').rows.length === 37 && empty.getSheetByName('Church requests').rows.length === 1, made);
  check('removes the empty default sheet', !empty.getSheetByName('Sheet1'));
  check('sets the sheet time zone to the script time zone', empty.tz === 'America/Toronto', empty.tz);
  check('puts status dropdowns on Orders and Church requests', empty.getSheetByName('Orders').validated === 2 && empty.getSheetByName('Church requests').validated === 1);
  const cat2 = JSON.parse(fresh.gs.doGet({ parameter: {} }).text);
  check('catalog works on the fresh book', cat2.ok && cat2.products.length === 4, cat2.products && cat2.products.length);
  fresh.gs.onOpen();
  check('onOpen adds the Store menu', fresh.env.menu === true);

  console.log('setupTabs on a sheet made by the earlier version of the script');
  const oldTabs = loadTemplates().filter(s => ['Products', 'Orders', 'Promos', 'Reviews', 'Settings'].includes(s.name));
  const oldSettings = oldTabs.find(s => s.name === 'Settings');
  oldSettings.rows = oldSettings.rows.slice(0, 29);
  oldSettings.rows.find(r => r[0] === 'owner_emails')[1] = 'david@example.com';
  oldSettings.rows.find(r => r[0] === 'next_order')[1] = 1090;
  const old = new Book(oldTabs);
  const up = makeSandbox(old);
  const madeOld = up.gs.setupTabs();
  check('adds only the three new tabs', JSON.stringify(madeOld) === JSON.stringify(['Stock', 'Media', 'Church requests']), madeOld);
  check('adds the eight new Settings rows on the end', old.getSheetByName('Settings').rows.length === 37 && old.getSheetByName('Settings').rows[29][0] === 'default_stock' && old.getSheetByName('Settings').rows[36][0] === 'next_church_request', old.getSheetByName('Settings').rows.slice(29).map(r => r[0]));
  check('leaves the values that were there alone', old.getSheetByName('Settings').rows.find(r => r[0] === 'owner_emails')[1] === 'david@example.com' && old.getSheetByName('Settings').rows.find(r => r[0] === 'next_order')[1] === 1090);
  check('a second run changes nothing', up.gs.setupTabs().length === 0 && old.getSheetByName('Settings').rows.length === 37);
  const oldOrder = JSON.parse(up.gs.doPost({ postData: { contents: JSON.stringify(Object.assign({}, base, { ref: 'old-1', delivery: 'pickup' })) } }).text);
  check('orders keep working on the upgraded sheet', oldOrder.ok === true && oldOrder.number === 'QV-1090', oldOrder);

  console.log('A sheet with no Stock or Media tab at all');
  const bare = new Book(loadTemplates().filter(s => ['Products', 'Orders', 'Promos', 'Reviews', 'Settings'].includes(s.name)));
  const bareBox = makeSandbox(bare);
  const bareCat = JSON.parse(bareBox.gs.doGet({ parameter: {} }).text);
  check('the catalogue still loads', bareCat.ok === true && bareCat.media.length === 0 && bareCat.products.length === 4, bareCat.error);
  const bareOrder = JSON.parse(bareBox.gs.doPost({ postData: { contents: JSON.stringify(Object.assign({}, base, { ref: 'bare-1', delivery: 'pickup' })) } }).text);
  check('orders still go through', bareOrder.ok === true, bareOrder);

  console.log('');
  console.log(passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run();
