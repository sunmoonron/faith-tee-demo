/*
  Store script. Bound to the store spreadsheet, which has these tabs:
  Products, Orders, Promos, Reviews, Settings (headers and example rows in sheets/template).
  Deploy as a web app: Execute as "Me", Who has access "Anyone".

  GET  ?action=catalog (default)         -> { ok, products, reviews, settings }  public rows and keys only
  GET  ?action=promo&code=X&subtotal=70  -> { ok, code, type, value, discount } or { ok:false, error }
  GET  ?action=ping                      -> { ok:true }
  POST a JSON body, or a form field "payload" holding JSON, or plain form fields -> places an order,
       appends a row to Orders, emails the owners and the customer, returns { ok, number, total, instructions }.

  Run setupTabs() once from the editor to create the tabs with their headers and example rows.
*/

var TABS = { products: 'Products', orders: 'Orders', promos: 'Promos', reviews: 'Reviews', settings: 'Settings' };

var ORDER_COLUMNS = ['number', 'timestamp', 'name', 'phone', 'email', 'delivery', 'address', 'items', 'promo', 'subtotal', 'total', 'status', 'paid', 'consent'];

var PUBLIC_SETTINGS = ['store_name', 'contact_email', 'instagram', 'etransfer_email', 'gta_enabled', 'pickup_enabled', 'pickup_note',
  'ship_enabled', 'ship_rate', 'ship_free_over', 'tax_rate', 'max_qty', 'announcement', 'hook_line', 'delivery_line', 'story',
  'giveback_line', 'review_form_url', 'music_url', 'music_label', 'music_credit'];

var DEFAULTS = {
  store_name: 'Qivgu',
  order_prefix: 'QV',
  next_order: 1001,
  gta_enabled: 'yes',
  pickup_enabled: 'yes',
  ship_enabled: 'no',
  ship_rate: 12,
  ship_free_over: 0,
  tax_rate: 0,
  max_qty: 10,
  gta_instructions: 'We text you to arrange a delivery time. Have {total} in cash ready, or send an e-Transfer to {etransfer} with {number} in the message before we arrive.',
  pickup_instructions: 'Bring {total} in cash, or send an e-Transfer to {etransfer} with {number} in the message.',
  ship_instructions: 'Send an e-Transfer of {total} to {etransfer} with {number} in the message. We ship within a few days of it arriving and email you when it is on its way.'
};

/* ---------- web app entry points ---------- */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = str(params.action) || 'catalog';
  try {
    if (action === 'ping') return jsonOut({ ok: true });
    if (action === 'promo') {
      var code = str(params.code).toUpperCase();
      if (!code) return jsonOut({ ok: false, error: 'Enter a code.' });
      return jsonOut(findPromo(code, num(params.subtotal, 0)));
    }
    var settings = readSettings();
    var pub = {};
    PUBLIC_SETTINGS.forEach(function (k) {
      if (settings[k] !== undefined && settings[k] !== null && settings[k] !== '') pub[k] = plain(settings[k]);
    });
    var products = readRows(TABS.products)
      .filter(function (r) { return isActive(r.active); })
      .map(plainRow);
    var reviews = readRows(TABS.reviews)
      .filter(function (r) { return yes(r.approved); })
      .map(function (r) {
        return {
          product: plain(r.product), order: plain(firstOf(r.order, r.order_number)), name: plain(r.name),
          stars: num(r.stars, 0), text: plain(firstOf(r.text, r.review)), date: plain(firstOf(r.timestamp, r.date))
        };
      });
    return jsonOut({ ok: true, products: products, reviews: reviews, settings: pub, generated: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    return jsonOut(placeOrder(parsePayload(e)));
  } catch (err) {
    return jsonOut({ ok: false, error: 'Something went wrong on our side and the order was not saved. Email us and we will take it by hand. (' + err.message + ')' });
  }
}

function parsePayload(e) {
  var p = null;
  var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
  if (raw) { try { p = JSON.parse(raw); } catch (x) { p = null; } }
  if ((!p || typeof p !== 'object') && e && e.parameter) {
    if (e.parameter.payload) { try { p = JSON.parse(e.parameter.payload); } catch (x) { p = null; } }
    if (!p || typeof p !== 'object') {
      p = {};
      for (var k in e.parameter) p[k] = e.parameter[k];
      if (typeof p.items === 'string') { try { p.items = JSON.parse(p.items); } catch (x) { } }
    }
  }
  if (!p || typeof p !== 'object') throw new Error('No order data');
  return p;
}

/* ---------- orders ---------- */

function placeOrder(p) {
  var settings = readSettings();
  if (str(p.website)) return { ok: true, number: str(settings.order_prefix) + '-0', total: 0, instructions: '' };
  if (str(settings.token) && str(p.token) !== str(settings.token)) {
    return fail('This order did not come from the shop page. Reload the page and try again.');
  }
  var ref = str(p.ref).slice(0, 64);
  var cache = CacheService.getScriptCache();
  if (ref) {
    var seen = cache.get('order:' + ref);
    if (seen) return JSON.parse(seen);
  }

  var name = str(p.name), phone = str(p.phone), email = str(p.email).toLowerCase();
  if (name.length < 2) return fail('Enter your name.', 'name');
  if (phone.replace(/\D/g, '').length < 10) return fail('Enter a phone number with the area code.', 'phone');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.', 'email');

  var delivery = str(p.delivery).toLowerCase();
  var postal = str(p.postal).toUpperCase().replace(/[^A-Z0-9]/g, '');
  var address = str(p.address).replace(/\s+/g, ' ');
  if (delivery === 'gta') {
    if (!yes(settings.gta_enabled)) return fail('GTA delivery is not available right now.', 'delivery');
    if (!/^[ML]\d[A-Z]\d[A-Z]\d$/.test(postal)) return fail('We deliver to postal codes starting with M or L. Check the postal code, or choose pickup.', 'postal');
    if (address.length < 5) return fail('Enter the delivery address.', 'address');
  } else if (delivery === 'pickup') {
    if (!yes(settings.pickup_enabled)) return fail('Pickup is not available right now.', 'delivery');
  } else if (delivery === 'ship') {
    if (!yes(settings.ship_enabled)) return fail('Shipping is not available right now.', 'delivery');
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal)) return fail('Enter a valid postal code.', 'postal');
    if (!/^[KLMNP]/.test(postal)) return fail('We only ship within Ontario.', 'postal');
    if (address.length < 5) return fail('Enter the shipping address.', 'address');
  } else {
    return fail('Choose how you want to get your order.', 'delivery');
  }

  var products = readRows(TABS.products).map(normalizeProduct).filter(function (x) { return x.active; });
  var items = normalizeItems(p.items, products, settings);
  if (items.error) return fail(items.error, 'items');
  items = items.list;

  var subtotal = round2(items.reduce(function (a, it) { return a + it.price * it.qty; }, 0));
  var promo = null, promoCode = str(p.promo).toUpperCase();
  if (promoCode) {
    promo = findPromo(promoCode, subtotal);
    if (!promo.ok) return fail(promo.error, 'promo');
  }
  var totals = priceOrder(subtotal, promo, delivery, settings);

  var number = nextOrderNumber(settings);
  var when = Utilities.formatDate(new Date(), timeZone(), 'yyyy-MM-dd HH:mm');
  var addressText = delivery === 'pickup' ? '' : address + (postal ? ', ' + formatPostal(postal) : '');
  var itemsText = items.map(function (it) {
    return it.qty + ' x ' + it.name + (it.colour ? ', ' + it.colour : '') + ', ' + rangeLabel(it.range) + ' ' + it.size + ', ' + money(it.price * it.qty);
  }).join('\n');
  var row = {
    number: number, timestamp: when, name: name, phone: phone, email: email, delivery: deliveryLabel(delivery),
    address: addressText, items: itemsText, promo: promo ? promo.code : '', subtotal: totals.subtotal, total: totals.total,
    status: 'New', paid: 'No', consent: yes(p.consent) ? 'Yes' : 'No'
  };
  appendOrder(row);

  var instructions = buildInstructions(delivery, number, totals.total, addressText, settings);
  var reviewUrl = reviewLink(settings, items[0].id, number);
  var emailed = { owners: false, customer: false };
  try { emailOwners(row, totals, settings); emailed.owners = true; } catch (x) { }
  try { emailCustomer(row, totals, instructions, reviewUrl, settings); emailed.customer = true; } catch (x) { }

  var result = {
    ok: true, number: number, delivery: delivery, subtotal: totals.subtotal, discount: totals.discount, shipping: totals.shipping,
    tax: totals.tax, total: totals.total, promo: promo ? promo.code : '', instructions: instructions, reviewUrl: reviewUrl, emailed: emailed
  };
  if (ref) cache.put('order:' + ref, JSON.stringify(result), 21600);
  return result;
}

function normalizeItems(raw, products, settings) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (x) { raw = null; } }
  if (!raw || !raw.length) return { error: 'Your cart is empty.' };
  if (raw.length > 20) return { error: 'That is too many lines for one order. Email us for a group order.' };
  var maxQty = Math.max(1, Math.floor(num(settings.max_qty, 10)));
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i] || {};
    var product = null;
    for (var j = 0; j < products.length; j++) if (products[j].id === str(it.id)) { product = products[j]; break; }
    if (!product) return { error: 'One of the items is no longer available. Remove it from the cart and try again.' };
    var qty = Math.floor(num(it.qty, 0));
    if (qty < 1 || qty > maxQty) return { error: 'Quantity must be between 1 and ' + maxQty + ' for each line.' };
    var range = rangeKey(it.range);
    var size = range ? matchCase(str(it.size), product.sizes[range]) : '';
    if (!range || !size) return { error: product.name + ': choose a size.' };
    var colour = '';
    if (product.colours.length) {
      colour = matchCase(str(it.colour), product.colours.map(function (c) { return c.name; }));
      if (!colour) return { error: product.name + ': choose a colour.' };
    }
    if (isSoldOut(product, colour, range, size)) {
      return { error: product.name + (colour ? ' in ' + colour : '') + ', ' + rangeLabel(range) + ' ' + size + ' is sold out.' };
    }
    var price = range === 'youth' && product.youth_price > 0 ? product.youth_price : product.price;
    list.push({ id: product.id, name: product.name, colour: colour, range: range, size: size, qty: qty, price: price });
  }
  return { list: list };
}

function findPromo(code, subtotal) {
  var rows = readRows(TABS.promos);
  var now = new Date();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (str(r.code).toUpperCase() !== code) continue;
    if (!yes(r.active)) return { ok: false, error: 'That code is not active.' };
    var starts = asDate(r.starts), ends = asDate(r.ends);
    if (starts && now < starts) return { ok: false, error: 'That code is not active yet.' };
    if (ends && now > new Date(ends.getTime() + 86399000)) return { ok: false, error: 'That code has expired.' };
    var min = num(r.min_subtotal, 0);
    if (min > 0 && subtotal < min) return { ok: false, error: 'That code needs a subtotal of ' + money(min) + '.' };
    var type = str(r.type).toLowerCase() === 'amount' ? 'amount' : 'percent';
    var value = num(r.value, 0);
    var discount = type === 'percent' ? subtotal * value / 100 : Math.min(value, subtotal);
    return { ok: true, code: str(r.code).toUpperCase(), type: type, value: value, discount: round2(discount) };
  }
  return { ok: false, error: 'That code is not valid.' };
}

function priceOrder(subtotal, promo, delivery, settings) {
  var discount = promo ? Math.min(promo.discount, subtotal) : 0;
  var after = round2(subtotal - discount);
  var shipping = 0;
  if (delivery === 'ship') {
    var free = num(settings.ship_free_over, 0);
    shipping = free > 0 && after >= free ? 0 : round2(num(settings.ship_rate, 0));
  }
  var tax = round2((after + shipping) * num(settings.tax_rate, 0) / 100);
  return { subtotal: subtotal, discount: round2(discount), shipping: shipping, tax: tax, total: round2(after + shipping + tax) };
}

function nextOrderNumber(settings) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = tab(TABS.settings);
    var values = sh.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if (str(values[i][0]).toLowerCase() === 'next_order') { rowIndex = i; break; }
    }
    var n = rowIndex >= 0 ? Math.floor(num(values[rowIndex][1], 0)) : 0;
    if (n < 1) n = DEFAULTS.next_order;
    if (rowIndex >= 0) sh.getRange(rowIndex + 1, 2).setValue(n + 1); else sh.appendRow(['next_order', n + 1]);
    SpreadsheetApp.flush();
    return (str(settings.order_prefix) || DEFAULTS.order_prefix) + '-' + n;
  } finally {
    lock.releaseLock();
  }
}

function appendOrder(row) {
  var sh = tab(TABS.orders);
  var headers;
  if (sh.getLastRow() < 1) {
    sh.appendRow(ORDER_COLUMNS);
    headers = ORDER_COLUMNS.slice();
  } else {
    headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) {
      return String(h).trim().toLowerCase().replace(/\s+/g, '_');
    });
  }
  var out = headers.map(function (h) { return row[h] === undefined ? '' : row[h]; });
  sh.appendRow(out);
}

function buildInstructions(delivery, number, total, addressText, settings) {
  var vars = { '{total}': money(total), '{etransfer}': str(settings.etransfer_email) || str(settings.contact_email), '{number}': number };
  var fillIn = function (t) { return String(t).replace(/\{total\}|\{etransfer\}|\{number\}/g, function (m) { return vars[m]; }); };
  if (delivery === 'gta') return 'Free delivery to ' + addressText + '. ' + fillIn(str(settings.gta_instructions) || DEFAULTS.gta_instructions);
  if (delivery === 'pickup') return (str(settings.pickup_note) ? str(settings.pickup_note) + ' ' : '') + fillIn(str(settings.pickup_instructions) || DEFAULTS.pickup_instructions);
  return 'Shipping to ' + addressText + '. ' + fillIn(str(settings.ship_instructions) || DEFAULTS.ship_instructions);
}

function reviewLink(settings, productId, number) {
  var t = str(settings.review_form_url);
  if (!t) return '';
  return t.replace(/\{product\}/g, encodeURIComponent(productId)).replace(/\{order\}/g, encodeURIComponent(number));
}

function emailOwners(row, totals, settings) {
  var to = list(settings.owner_emails).join(',');
  if (!to) return;
  var subject = 'New order ' + row.number + ': ' + row.name + ', ' + row.delivery + ', ' + money(totals.total);
  var lines = [
    'Order ' + row.number + ', placed ' + row.timestamp,
    '',
    'Name: ' + row.name,
    'Phone: ' + row.phone,
    'Email: ' + row.email,
    'Delivery: ' + row.delivery,
    row.address ? 'Address: ' + row.address : null,
    '',
    'Items:',
    row.items,
    '',
    'Subtotal: ' + money(totals.subtotal),
    totals.discount ? 'Discount (' + row.promo + '): -' + money(totals.discount) : null,
    totals.shipping ? 'Shipping: ' + money(totals.shipping) : null,
    totals.tax ? 'Tax: ' + money(totals.tax) : null,
    'Total: ' + money(totals.total),
    '',
    'Email list: ' + row.consent,
    '',
    'The row is in the Orders tab with status New. Set it to Confirmed once you have arranged a time, then Delivered and Paid.',
    book().getUrl()
  ].filter(function (l) { return l !== null; });
  MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n'), replyTo: row.email, name: str(settings.store_name) || DEFAULTS.store_name });
}

function emailCustomer(row, totals, instructions, reviewUrl, settings) {
  var store = str(settings.store_name) || DEFAULTS.store_name;
  var contact = str(settings.contact_email) || list(settings.owner_emails)[0] || '';
  var lines = [
    'Hi ' + firstName(row.name) + ',',
    '',
    'We have your order ' + row.number + '. Thank you.',
    '',
    row.items,
    '',
    'Subtotal: ' + money(totals.subtotal),
    totals.discount ? 'Discount (' + row.promo + '): -' + money(totals.discount) : null,
    totals.shipping ? 'Shipping: ' + money(totals.shipping) : null,
    totals.tax ? 'Tax: ' + money(totals.tax) : null,
    'Total: ' + money(totals.total),
    '',
    instructions,
    '',
    reviewUrl ? 'Once it is in your hands, tell us how it fits: ' + reviewUrl : null,
    reviewUrl ? '' : null,
    'Questions? Reply to this email.',
    '',
    store,
    contact || null
  ].filter(function (l) { return l !== null; });
  var opts = { to: row.email, subject: store + ': order ' + row.number + ' received', body: lines.join('\n'), name: store };
  if (contact) opts.replyTo = contact;
  MailApp.sendEmail(opts);
}

/* ---------- sheet access ---------- */

function book() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) throw new Error('No spreadsheet. Bind the script to the sheet or set the SHEET_ID script property.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

function tab(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function timeZone() {
  var tz = '';
  try { tz = Session.getScriptTimeZone(); } catch (e) { }
  return tz || 'America/Toronto';
}

function readRows(name) {
  var values = tab(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase().replace(/\s+/g, '_'); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {}, empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[i][c];
      if (v === null || v === undefined) v = '';
      row[headers[c]] = v;
      if (v !== '') empty = false;
    }
    if (!empty) rows.push(row);
  }
  return rows;
}

function readSettings() {
  var out = {};
  for (var k in DEFAULTS) out[k] = DEFAULTS[k];
  readRows(TABS.settings).forEach(function (r) {
    var key = str(r.key).toLowerCase();
    if (!key) return;
    var v = r.value;
    if (v === '' || v === null || v === undefined) { if (!(key in DEFAULTS)) out[key] = ''; return; }
    out[key] = v;
  });
  return out;
}

/* ---------- product helpers (the site repeats these rules in its own code) ---------- */

function normalizeProduct(r) {
  var g = function (k) { return str(r[k]); };
  var colours = list(firstOf(r.colours, r.colors)).map(function (entry) {
    var m = entry.match(/^(.*?)\s*(#[0-9a-fA-F]{3,8})?$/);
    return { name: str(m ? m[1] : entry), hex: m && m[2] ? m[2] : '' };
  }).filter(function (c) { return c.name; });
  var p = {
    id: g('id') || slug(g('name')),
    name: g('name'),
    price: num(r.price, 0),
    youth_price: num(r.youth_price, 0),
    colours: colours,
    sizes: { mens: list(r.sizes_mens), womens: list(r.sizes_womens), youth: list(r.sizes_youth) },
    active: isActive(r.active)
  };
  p.soldOut = parseSoldOut(g('sold_out_sizes'), colours.map(function (c) { return c.name; }));
  return p;
}

function parseSoldOut(text, colourNames) {
  var tokens = list(text).map(function (t) { return t.toLowerCase().replace(/['’.]/g, '').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  var lowerColours = colourNames.map(function (c) { return c.toLowerCase(); });
  var out = [];
  tokens.forEach(function (t) {
    if (t === 'all' || t === 'everything') { out.push({ all: true }); return; }
    var colour = '';
    for (var i = 0; i < lowerColours.length; i++) {
      if (t.indexOf(lowerColours[i] + ' ') === 0) { colour = colourNames[i]; t = t.slice(lowerColours[i].length + 1); break; }
    }
    var words = t.split(' ');
    var range = rangeKey(words[0]);
    var size = range ? words.slice(1).join(' ') : t;
    out.push({ colour: colour, range: range, size: size });
  });
  return out;
}

function isSoldOut(product, colour, range, size) {
  var s = size.toLowerCase();
  for (var i = 0; i < product.soldOut.length; i++) {
    var t = product.soldOut[i];
    if (t.all) return true;
    if (t.colour && t.colour.toLowerCase() !== String(colour).toLowerCase()) continue;
    if (t.range && t.range !== range) continue;
    if (!t.size || t.size === s) return true;
  }
  return false;
}

function rangeKey(word) {
  var w = str(word).toLowerCase().replace(/['’.]/g, '');
  if (/^(mens|men|man|male|adult)$/.test(w)) return 'mens';
  if (/^(womens|women|woman|ladies|female)$/.test(w)) return 'womens';
  if (/^(youth|youths|kids|kid|child|children|boys|girls)$/.test(w)) return 'youth';
  return '';
}

function rangeLabel(range) {
  return range === 'mens' ? "Men's" : range === 'womens' ? "Women's" : 'Youth';
}

function deliveryLabel(d) {
  return d === 'gta' ? 'GTA delivery' : d === 'pickup' ? 'Pickup' : 'Shipping';
}

/* ---------- small utilities ---------- */

function fail(message, field) {
  var out = { ok: false, error: message };
  if (field) out.field = field;
  return out;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, timeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function plain(v) {
  if (v instanceof Date) return Utilities.formatDate(v, timeZone(), 'yyyy-MM-dd');
  if (typeof v === 'number') return v;
  return str(v);
}

function plainRow(r) {
  var out = {};
  for (var k in r) out[k] = plain(r[k]);
  return out;
}

function firstOf(a, b) {
  return a !== undefined && a !== null && a !== '' ? a : (b === undefined || b === null ? '' : b);
}

function num(v, fallback) {
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : fallback;
}

function yes(v) {
  return /^(yes|y|true|1|x|on)$/i.test(str(v));
}

function isActive(v) {
  var s = str(v);
  return s === '' || yes(s);
}

function list(v) {
  return str(v).split(/[,;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function matchCase(value, options) {
  var v = String(value).toLowerCase();
  for (var i = 0; i < options.length; i++) if (String(options[i]).toLowerCase() === v) return options[i];
  return '';
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n) {
  return '$' + round2(n).toFixed(2);
}

function formatPostal(p) {
  return p.length === 6 ? p.slice(0, 3) + ' ' + p.slice(3) : p;
}

function firstName(name) {
  return str(name).split(/\s+/)[0] || 'there';
}

function asDate(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

/* ---------- one-time setup: creates the tabs with headers and example rows ---------- */

var TEMPLATE = {
  Products: [
    ['id', 'name', 'price', 'youth_price', 'verse', 'description', 'colours', 'sizes_mens', 'sizes_womens', 'sizes_youth', 'sold_out_sizes', 'images', 'active', 'new', 'type', 'note'],
    ['bestill', 'Be still', 35, 28, 'Psalm 46:10', 'Psalm 46:10 printed on the chest. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.', 'Black #111111, White #f2f2f2', 'S, M, L, XL', 'S, M, L', 'YS, YM, YL', '', 'Black: bestill-black.jpg; White: bestill-white.jpg', 'yes', 'yes', 'tee', 'sample row: replace with your own product'],
    ['fearnot', 'Fear not', 35, 28, 'Isaiah 41:10', 'Isaiah 41:10 in block letters. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.', 'Black #111111, White #f2f2f2', 'S, M, L, XL', 'S, M, L', 'YS, YM, YL', "Men's XL", 'Black: fearnot-black.jpg; White: fearnot-white.jpg', 'yes', '', 'tee', 'sample row: replace with your own product'],
    ['walkbyfaith', 'Walk by faith', 35, 28, '2 Corinthians 5:7', '2 Corinthians 5:7 stacked down the chest. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.', 'Black #111111, White #f2f2f2', 'S, M, L, XL', 'S, M, L', 'YS, YM, YL', '', 'Black: walkbyfaith-black.jpg; White: walkbyfaith-white.jpg', 'yes', '', 'tee', 'sample row: replace with your own product'],
    ['grace', 'Grace upon grace', 35, 28, 'John 1:16', 'John 1:16 in small type over the heart. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.', 'Black #111111, White #f2f2f2', 'S, M, L, XL', 'S, M, L', 'YS, YM, YL', 'all', 'Black: grace-black.jpg; White: grace-white.jpg', 'yes', '', 'tee', 'sample row: sold out everywhere']
  ],
  Orders: [
    ['number', 'timestamp', 'name', 'phone', 'email', 'delivery', 'address', 'items', 'promo', 'subtotal', 'total', 'status', 'paid', 'consent']
  ],
  Promos: [
    ['code', 'type', 'value', 'min_subtotal', 'starts', 'ends', 'active', 'note'],
    ['FAITH10', 'percent', 10, 0, '', '', 'yes', 'sample code: 10 percent off'],
    ['CHURCH5', 'amount', 5, 35, '', '', 'no', 'sample code: 5 dollars off orders of 35 or more']
  ],
  Reviews: [
    ['product', 'order', 'name', 'stars', 'text', 'approved'],
    ['bestill', 'QV-1001', 'Priya', 5, 'Fits true to size and the print has not cracked after a dozen washes.', 'yes'],
    ['fearnot', 'QV-1002', 'Marcus', 4, 'Runs a little large. I ordered a medium and it fits like a large.', 'yes']
  ],
  Settings: [
    ['key', 'value', 'note'],
    ['store_name', 'Qivgu', 'Shown in emails and in the site when the site loads it'],
    ['owner_emails', 'owner1@example.com, owner2@example.com', 'Who gets the new-order email. Separate several with commas'],
    ['token', 'change-me-to-a-random-string', 'Must match the token in the site config. Blocks posts that do not come from the site'],
    ['order_prefix', 'QV', 'Order numbers look like QV-1042'],
    ['next_order', 1042, 'The next order number. The script moves it up by one per order'],
    ['contact_email', 'info@example.com', 'Reply-to address on customer emails and shown in the site footer'],
    ['instagram', '@yourhandle', 'Shown as text in the site footer'],
    ['etransfer_email', 'info@example.com', 'Where customers send e-Transfers'],
    ['gta_enabled', 'yes', 'Offer free GTA delivery (postal codes starting with M or L)'],
    ['gta_instructions', DEFAULTS.gta_instructions, 'Sent to the customer who picks GTA delivery. {total} {etransfer} {number} are filled in'],
    ['pickup_enabled', 'yes', 'Offer pickup'],
    ['pickup_note', 'Pickup at the church after the Sunday service or at the rink on Tuesday evenings. We text you to confirm.', 'Shown on the checkout form and in the email for pickup orders'],
    ['pickup_instructions', DEFAULTS.pickup_instructions, 'Sent to the customer who picks pickup. {total} {etransfer} {number} are filled in'],
    ['ship_enabled', 'no', 'Offer shipping within Ontario (e-Transfer first)'],
    ['ship_rate', 12, 'Flat shipping charge in dollars'],
    ['ship_free_over', 150, 'Shipping is free when the subtotal after discounts reaches this. 0 turns it off'],
    ['ship_instructions', DEFAULTS.ship_instructions, 'Sent to the customer who picks shipping. {total} {etransfer} {number} are filled in'],
    ['tax_rate', 0, 'Percent added to the total. Leave 0 while not registered for HST'],
    ['max_qty', 10, 'Most of one size and colour in a single order'],
    ['announcement', 'Free delivery in the GTA. Pay cash or e-Transfer at the door.', 'One line under the header. Leave blank to hide'],
    ['hook_line', "Don't just read the Word, wear it", 'Shown once below the product grid'],
    ['delivery_line', 'Free delivery in the GTA. Pay cash or e-Transfer at the door.', 'Shown below the grid and on every product page'],
    ['story', '', 'Your story in two or three sentences. Blank hides it'],
    ['giveback_line', '', 'Your give-back line in your own words. Blank hides it'],
    ['review_form_url', '', 'Pre-filled Google Form link with {product} and {order} where the form expects them, for example https://docs.google.com/forms/d/e/FORM_ID/viewform?usp=pp_url&entry.111={product}&entry.222={order}. Blank hides the review links'],
    ['music_url', '', 'Link to a royalty-free track (mp3). Blank hides the play button'],
    ['music_label', 'Play the song', 'Text of the play button'],
    ['music_credit', '', 'Credit line shown beside the play button if the licence asks for one']
  ]
};

function setupTabs() {
  var ss = book();
  var names = ['Products', 'Orders', 'Promos', 'Reviews', 'Settings'];
  var made = [];
  names.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) return;
    sh = ss.insertSheet(name);
    var rows = TEMPLATE[name];
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sh.setFrozenRows(1);
    made.push(name);
  });
  var orders = ss.getSheetByName('Orders');
  if (orders) {
    var status = SpreadsheetApp.newDataValidation().requireValueInList(['New', 'Confirmed', 'Delivered', 'Paid', 'Cancelled'], true).setAllowInvalid(true).build();
    var paid = SpreadsheetApp.newDataValidation().requireValueInList(['No', 'Yes'], true).setAllowInvalid(true).build();
    orders.getRange(2, 12, 2000, 1).setDataValidation(status);
    orders.getRange(2, 13, 2000, 1).setDataValidation(paid);
  }
  try { ss.setSpreadsheetTimeZone(timeZone()); } catch (e) { }
  var first = ss.getSheets()[0];
  if (first && names.indexOf(first.getName()) < 0 && ss.getSheets().length > names.length && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log(made.length ? 'Created: ' + made.join(', ') : 'All tabs already exist');
  return made;
}
