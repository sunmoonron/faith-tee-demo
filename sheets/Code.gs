/*
  Store script for the Qivgu shop. Bound to the store spreadsheet, which has these tabs:
  Products, Orders, Promos, Reviews, Settings, Stock, Media, Church requests
  (headers and example rows in sheets/template).
  Deploy as a web app: Execute as "Me", Who has access "Anyone".

  GET  ?action=catalog (default)         -> { ok, products, reviews, media, settings }  public rows and keys only
  GET  ?action=promo&code=X&subtotal=70  -> { ok, code, type, value, discount } or { ok:false, error }
  GET  ?action=ping                      -> { ok:true }
  POST a JSON body, or a form field "payload" holding JSON, or plain form fields:
       an order            -> checks and lowers the stock, appends a row to Orders, emails the owners and the customer
       { type: "church" }  -> saves the artwork to Drive, appends a row to Church requests, emails the owners and the church

  setupTabs() creates the tabs. Run it again after an update of this script: it adds any new tab and any new
  Settings row and leaves everything that is already there alone.
  seedStock() adds a Stock row for every size of every active product that does not have one yet.
  Both are also in the Store menu of the sheet.
*/

var TABS = {
  products: 'Products', orders: 'Orders', promos: 'Promos', reviews: 'Reviews', settings: 'Settings',
  stock: 'Stock', media: 'Media', church: 'Church requests'
};

var ORDER_COLUMNS = ['number', 'timestamp', 'name', 'phone', 'email', 'delivery', 'address', 'items', 'promo', 'subtotal', 'total', 'status', 'paid', 'consent'];
var CHURCH_COLUMNS = ['number', 'timestamp', 'church', 'contact', 'email', 'phone', 'colour', 'mens', 'womens', 'youth', 'total', 'date_needed', 'delivery', 'notes', 'artwork', 'status'];
var STOCK_COLUMNS = ['product', 'colour', 'range', 'size', 'count'];

var ORDER_STATUSES = ['New', 'Confirmed', 'Delivered', 'Paid', 'Cancelled'];
var CHURCH_STATUSES = ['New', 'Quoted', 'Approved', 'Printing', 'Delivered', 'Cancelled'];

var PUBLIC_SETTINGS = ['store_name', 'contact_email', 'instagram', 'etransfer_email', 'gta_enabled', 'pickup_enabled', 'pickup_note',
  'ship_enabled', 'ship_rate', 'ship_free_over', 'tax_rate', 'max_qty', 'announcement', 'hook_line', 'delivery_line', 'story',
  'giveback_line', 'review_form_url', 'music_url', 'music_label', 'music_credit', 'tryon_note', 'church_intro', 'church_terms',
  'church_sizes_mens', 'church_sizes_womens', 'church_sizes_youth'];

var DEFAULTS = {
  store_name: 'Qivgu',
  order_prefix: 'QV',
  next_order: 1001,
  next_church_request: 1001,
  default_stock: 25,
  gta_enabled: 'yes',
  pickup_enabled: 'yes',
  ship_enabled: 'no',
  ship_rate: 12,
  ship_free_over: 0,
  tax_rate: 0,
  max_qty: 10,
  church_sizes_mens: 'S, M, L, XL, 2XL',
  church_sizes_womens: 'S, M, L, XL',
  church_sizes_youth: 'YS, YM, YL',
  gta_instructions: 'We text you to arrange a delivery time. Have {total} in cash ready, or send an e-Transfer to {etransfer} with {number} in the message before we arrive.',
  pickup_instructions: 'Bring {total} in cash, or send an e-Transfer to {etransfer} with {number} in the message.',
  ship_instructions: 'Send an e-Transfer of {total} to {etransfer} with {number} in the message. We ship within a few days of it arriving and email you when it is on its way.'
};

/* Artwork a church may attach to a request, and the size limit in bytes. */
var ART_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', svg: 'image/svg+xml', ai: 'application/postscript', eps: 'application/postscript' };
var ART_MAX = 10 * 1024 * 1024;
var ART_FOLDER = 'Church artwork';

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
    var gone = soldOutFromStock(readStock());
    var products = readRows(TABS.products)
      .filter(function (r) { return isActive(r.active); })
      .map(function (r) {
        var row = plainRow(r);
        var extra = gone[(str(r.id) || slug(str(r.name))).toLowerCase()];
        if (extra) row.sold_out_sizes = [str(r.sold_out_sizes)].concat(extra).filter(Boolean).join(', ');
        return row;
      });
    var reviews = readRows(TABS.reviews)
      .filter(function (r) { return yes(r.approved); })
      .map(function (r) {
        return {
          product: plain(r.product), order: plain(firstOf(r.order, r.order_number)), name: plain(r.name),
          stars: num(r.stars, 0), text: plain(firstOf(r.text, r.review)), date: plain(firstOf(r.timestamp, r.date))
        };
      });
    var media = readRowsIf(TABS.media)
      .filter(function (r) { return str(r.title) && str(firstOf(r.file, firstOf(r.url, r.link))); })
      .map(function (r) {
        return {
          title: str(r.title), type: str(r.type).toLowerCase(), file: str(firstOf(r.file, firstOf(r.url, r.link))),
          date: plain(r.date), note: str(r.note)
        };
      });
    return jsonOut({ ok: true, products: products, reviews: reviews, media: media, settings: pub, generated: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

function doPost(e) {
  var church = false;
  try {
    var p = parsePayload(e);
    church = str(p.type).toLowerCase() === 'church';
    return jsonOut(church ? placeChurchRequest(p) : placeOrder(p));
  } catch (err) {
    return jsonOut({
      ok: false,
      error: 'Something went wrong on our side and the ' + (church ? 'request' : 'order') + ' was not saved. Email us and we will take it by hand. (' + err.message + ')'
    });
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
  if (!p || typeof p !== 'object') throw new Error('No data');
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
  if (!isEmail(email)) return fail('Enter a valid email address.', 'email');

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

  var addressText = delivery === 'pickup' ? '' : address + (postal ? ', ' + formatPostal(postal) : '');
  var itemsText = items.map(function (it) { return it.qty + ' x ' + itemLabel(it) + ', ' + money(it.price * it.qty); }).join('\n');
  var row = {
    number: '', timestamp: '', name: name, phone: phone, email: email, delivery: deliveryLabel(delivery),
    address: addressText, items: itemsText, promo: promo ? promo.code : '', subtotal: totals.subtotal, total: totals.total,
    status: 'New', paid: 'No', consent: yes(p.consent) ? 'Yes' : 'No'
  };

  /* One lock covers the stock check, the stock change, the order number and the new row, so two orders
     arriving together cannot both take the last shirt or the same number. */
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var short = takeStock(items);
    if (short) return fail(short, 'items');
    row.number = nextNumber('next_order', DEFAULTS.next_order, str(settings.order_prefix) || DEFAULTS.order_prefix);
    row.timestamp = Utilities.formatDate(new Date(), timeZone(), 'yyyy-MM-dd HH:mm');
    appendRow(TABS.orders, ORDER_COLUMNS, row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var number = row.number;
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
    var line = { id: product.id, name: product.name, colour: colour, range: range, size: size, qty: qty, price: 0 };
    if (isSoldOut(product, colour, range, size)) return { error: itemLabel(line) + ' is sold out.' };
    line.price = range === 'youth' && product.youth_price > 0 ? product.youth_price : product.price;
    list.push(line);
  }
  return { list: list };
}

function itemLabel(it) {
  return it.name + (it.colour ? ', ' + it.colour : '') + ', ' + rangeLabel(it.range) + ' ' + it.size;
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

/* Reads a counter row in Settings, moves it up by one and returns PREFIX-N. Call it while holding the script lock. */
function nextNumber(key, fallback, prefix) {
  var sh = tab(TABS.settings);
  var values = sh.getDataRange().getValues();
  var rowIndex = -1;
  for (var i = 1; i < values.length; i++) {
    if (str(values[i][0]).toLowerCase() === key) { rowIndex = i; break; }
  }
  var n = rowIndex >= 0 ? Math.floor(num(values[rowIndex][1], 0)) : 0;
  if (n < 1) n = fallback;
  if (rowIndex >= 0) sh.getRange(rowIndex + 1, 2).setValue(n + 1); else sh.appendRow([key, n + 1]);
  return prefix + '-' + n;
}

/* Appends an object as a row, matching its keys to the tab's own header row so columns can be reordered or added. */
function appendRow(tabName, columns, row) {
  var sh = tab(tabName);
  var headers;
  if (sh.getLastRow() < 1) {
    sh.appendRow(columns);
    headers = columns.slice();
  } else {
    headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(headerKey);
  }
  sh.appendRow(headers.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
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
  MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n'), replyTo: row.email, name: storeName(settings) });
}

function emailCustomer(row, totals, instructions, reviewUrl, settings) {
  var store = storeName(settings);
  var contact = contactAddress(settings);
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

/* ---------- stock ---------- */

/* Stock tab: product, colour, range, size, count. A size with no row, or a blank count, is not tracked and
   never runs out. The count goes down when an order is placed; cancelling an order does not put it back. */
function readStock() {
  var sh = book().getSheetByName(TABS.stock);
  var out = { sheet: sh, rows: {}, countCol: 0 };
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return out;
  var h = values[0].map(headerKey);
  var c = { product: h.indexOf('product'), colour: h.indexOf('colour'), range: h.indexOf('range'), size: h.indexOf('size'), count: h.indexOf('count') };
  if (c.colour < 0) c.colour = h.indexOf('color');
  if (c.product < 0 || c.size < 0 || c.count < 0) return out;
  out.countCol = c.count + 1;
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (str(v[c.product]) === '' || v[c.count] === '' || v[c.count] === null || v[c.count] === undefined) continue;
    var n = num(v[c.count], NaN);
    if (isNaN(n)) continue;
    var colour = c.colour >= 0 ? str(v[c.colour]) : '';
    var range = rangeKey(c.range >= 0 ? v[c.range] : '');
    out.rows[stockKey(v[c.product], colour, range, v[c.size])] = {
      row: i + 1, count: Math.floor(n), product: str(v[c.product]), colour: colour, range: range, size: str(v[c.size])
    };
  }
  return out;
}

function stockKey(id, colour, range, size) {
  return [id, colour, range, size].map(function (s) { return str(s).toLowerCase(); }).join('|');
}

/* Checks that every ordered size is in stock and lowers the counts. Returns '' when it went through, or the
   sentence to show the customer. Call it while holding the script lock. */
function takeStock(items) {
  var st = readStock();
  if (!st.sheet || !st.countCol) return '';
  var want = {}, keys = [];
  items.forEach(function (it) {
    var k = stockKey(it.id, it.colour, it.range, it.size);
    if (!want[k]) { want[k] = { qty: 0, it: it }; keys.push(k); }
    want[k].qty += it.qty;
  });
  for (var i = 0; i < keys.length; i++) {
    var row = st.rows[keys[i]];
    if (!row) continue;
    var w = want[keys[i]];
    if (row.count <= 0) return itemLabel(w.it) + ' is sold out.';
    if (row.count < w.qty) return 'Only ' + row.count + ' left of ' + itemLabel(w.it) + '. Lower the quantity and try again.';
  }
  keys.forEach(function (k) {
    var row = st.rows[k];
    if (row) st.sheet.getRange(row.row, st.countCol).setValue(row.count - want[k].qty);
  });
  return '';
}

/* Sizes at zero, as sold_out_sizes entries per product id, so the site treats them like any other sold-out size. */
function soldOutFromStock(st) {
  var out = {};
  for (var k in st.rows) {
    var r = st.rows[k];
    if (r.count > 0 || !r.range) continue;
    var id = r.product.toLowerCase();
    if (!out[id]) out[id] = [];
    out[id].push((r.colour ? r.colour + ' ' : '') + rangeLabel(r.range) + ' ' + r.size);
  }
  return out;
}

function seedStock() {
  var ss = book();
  var sh = ss.getSheetByName(TABS.stock);
  if (!sh) {
    sh = ss.insertSheet(TABS.stock);
    sh.getRange(1, 1, 1, STOCK_COLUMNS.length).setValues([STOCK_COLUMNS]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, STOCK_COLUMNS.length).setValues([STOCK_COLUMNS]);
  }
  var start = Math.max(0, Math.floor(num(readSettings().default_stock, DEFAULTS.default_stock)));
  var have = {};
  var values = sh.getDataRange().getValues();
  var h = values[0].map(headerKey);
  var c = { product: h.indexOf('product'), colour: h.indexOf('colour') >= 0 ? h.indexOf('colour') : h.indexOf('color'), range: h.indexOf('range'), size: h.indexOf('size'), count: h.indexOf('count') };
  if (c.product < 0 || c.colour < 0 || c.range < 0 || c.size < 0 || c.count < 0) throw new Error('The Stock tab needs the columns product, colour, range, size, count');
  for (var i = 1; i < values.length; i++) {
    have[stockKey(values[i][c.product], values[i][c.colour], rangeKey(values[i][c.range]), values[i][c.size])] = true;
  }
  var add = [];
  readRows(TABS.products).map(normalizeProduct).filter(function (p) { return p.active && p.id; }).forEach(function (p) {
    var colours = p.colours.length ? p.colours.map(function (x) { return x.name; }) : [''];
    colours.forEach(function (colour) {
      ['mens', 'womens', 'youth'].forEach(function (range) {
        p.sizes[range].forEach(function (size) {
          if (have[stockKey(p.id, colour, range, size)]) return;
          var line = h.map(function () { return ''; });
          line[c.product] = p.id; line[c.colour] = colour; line[c.range] = rangeLabel(range); line[c.size] = size; line[c.count] = start;
          add.push(line);
        });
      });
    });
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, h.length).setValues(add);
  note(add.length ? 'Added ' + add.length + ' stock rows at ' + start + ' each' : 'Every size already has a stock row');
  return add.length;
}

/* ---------- church requests ---------- */

function placeChurchRequest(p) {
  var settings = readSettings();
  if (str(p.website)) return { ok: true, number: 'CH-0' };
  if (str(settings.token) && str(p.token) !== str(settings.token)) {
    return fail('This request did not come from the site. Reload the page and try again.');
  }
  var ref = str(p.ref).slice(0, 64);
  var cache = CacheService.getScriptCache();
  if (ref) {
    var seen = cache.get('church:' + ref);
    if (seen) return JSON.parse(seen);
  }

  var church = str(p.church), contact = str(p.contact), email = str(p.email).toLowerCase(), phone = str(p.phone), colour = str(p.colour);
  if (church.length < 2) return fail('Enter the name of the church.', 'church');
  if (contact.length < 2) return fail('Enter a contact person.', 'contact');
  if (!isEmail(email)) return fail('Enter a valid email address.', 'email');
  if (phone.replace(/\D/g, '').length < 10) return fail('Enter a phone number with the area code.', 'phone');
  if (colour.length < 2) return fail('Enter the shirt colour you want.', 'colour');

  var sizes = churchSizes(p.sizes, settings);
  if (sizes.total < 1) return fail('Enter how many shirts you need in at least one size.', 'sizes');
  if (sizes.total > 5000) return fail('That is more than this form takes. Email us and we will sort it out.', 'sizes');

  var date = str(p.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Choose the date you need the shirts by.', 'date');
  if (date < Utilities.formatDate(new Date(), timeZone(), 'yyyy-MM-dd')) return fail('The date needed has already passed.', 'date');

  var delivery = str(p.delivery).toLowerCase();
  if (delivery !== 'gta' && delivery !== 'pickup') return fail('Choose delivery in the GTA or pickup.', 'delivery');
  if (!yes(p.rights)) return fail('Tick the box to confirm that you own the artwork or have permission to print it.', 'rights');
  var notes = str(p.notes).slice(0, 2000);

  var art = readArtwork(p.file);
  if (art.error) return fail(art.error, 'artwork');

  var number;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    number = nextNumber('next_church_request', DEFAULTS.next_church_request, 'CH');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  /* Save the artwork in the owner's Drive. If Drive refuses for any reason the request still goes through
     and the file rides along on the owners' email instead. */
  var link = '', attach = null;
  art.blob.setName(number + ' ' + church.replace(/[^\w .\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) + ' ' + art.name);
  try { link = saveArtwork(art.blob); } catch (x) { attach = art.blob; }

  var row = {
    number: number, timestamp: Utilities.formatDate(new Date(), timeZone(), 'yyyy-MM-dd HH:mm'), church: church, contact: contact,
    email: email, phone: phone, colour: colour, mens: sizes.text.mens, womens: sizes.text.womens, youth: sizes.text.youth,
    total: sizes.total, date_needed: date, delivery: delivery === 'gta' ? 'GTA delivery' : 'Pickup', notes: notes,
    artwork: link || 'Attached to the owners email (not saved to Drive)', status: 'New'
  };
  appendRow(TABS.church, CHURCH_COLUMNS, row);

  var emailed = { owners: false, church: false };
  try { emailOwnersChurch(row, attach, settings); emailed.owners = true; } catch (x) { }
  try { emailChurch(row, settings); emailed.church = true; } catch (x) { }

  var result = { ok: true, number: number, total: sizes.total, artwork: link ? 'saved' : 'emailed', emailed: emailed };
  if (ref) cache.put('church:' + ref, JSON.stringify(result), 21600);
  return result;
}

/* Turns { mens: { S: 5, M: 10 }, ... } into the text for the row, keeping only the sizes the Settings tab offers. */
function churchSizes(raw, settings) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (x) { raw = null; } }
  raw = raw && typeof raw === 'object' ? raw : {};
  var out = { text: { mens: '', womens: '', youth: '' }, total: 0 };
  ['mens', 'womens', 'youth'].forEach(function (range) {
    var given = raw[range] && typeof raw[range] === 'object' ? raw[range] : {};
    var lower = {};
    for (var k in given) lower[String(k).toLowerCase()] = given[k];
    var parts = [];
    list(settings['church_sizes_' + range] || DEFAULTS['church_sizes_' + range]).forEach(function (size) {
      var n = Math.floor(num(lower[size.toLowerCase()], 0));
      if (n < 1) return;
      n = Math.min(n, 999);
      parts.push(size + ' ' + n);
      out.total += n;
    });
    out.text[range] = parts.join(', ');
  });
  return out;
}

function readArtwork(file) {
  if (typeof file === 'string') { try { file = JSON.parse(file); } catch (x) { file = null; } }
  if (!file || typeof file !== 'object' || !str(file.data)) return { error: 'Attach the artwork file.' };
  var name = str(file.name).replace(/^.*[\\\/]/, '').replace(/[^\w.\- ()]+/g, '_').slice(-80) || 'artwork';
  var ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  ext = ext ? ext.toLowerCase() : '';
  if (!ART_TYPES[ext]) return { error: 'The artwork has to be a PNG, JPG, PDF, SVG, AI or EPS file.' };
  var data = str(file.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  var tooBig = 'The artwork file is larger than 10 MB. Send a smaller version.';
  if (data.length * 3 / 4 > ART_MAX + 3) return { error: tooBig };
  var bytes;
  try { bytes = Utilities.base64Decode(data); } catch (x) { return { error: 'The artwork file could not be read. Attach it again.' }; }
  if (!bytes || !bytes.length) return { error: 'The artwork file is empty. Attach it again.' };
  if (bytes.length > ART_MAX) return { error: tooBig };
  return { name: name, size: bytes.length, blob: Utilities.newBlob(bytes, ART_TYPES[ext], name) };
}

/* Uses the Drive advanced service with the drive.file permission, which only reaches files this script made. */
function saveArtwork(blob) {
  var file = Drive.Files.create({ name: blob.getName(), parents: [artworkFolderId()] }, blob, { fields: 'id,webViewLink' });
  return file.webViewLink || 'https://drive.google.com/file/d/' + file.id + '/view';
}

function artworkFolderId() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CHURCH_FOLDER_ID');
  if (id) {
    try {
      var f = Drive.Files.get(id, { fields: 'id,trashed' });
      if (f && !f.trashed) return id;
    } catch (x) { }
  }
  var found = Drive.Files.list({
    q: "name = '" + ART_FOLDER + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id)', pageSize: 1
  });
  if (found && found.files && found.files.length) id = found.files[0].id;
  else id = Drive.Files.create({ name: ART_FOLDER, mimeType: 'application/vnd.google-apps.folder' }, null, { fields: 'id' }).id;
  props.setProperty('CHURCH_FOLDER_ID', id);
  return id;
}

function churchLines(row) {
  return [
    'Church: ' + row.church,
    'Contact: ' + row.contact,
    'Email: ' + row.email,
    'Phone: ' + row.phone,
    '',
    'Shirt colour: ' + row.colour,
    row.mens ? "Men's: " + row.mens : null,
    row.womens ? "Women's: " + row.womens : null,
    row.youth ? 'Youth: ' + row.youth : null,
    'Total: ' + row.total + ' shirts',
    'Needed by: ' + row.date_needed,
    'Getting them: ' + row.delivery,
    row.notes ? 'Notes: ' + row.notes : null
  ];
}

function emailOwnersChurch(row, attach, settings) {
  var to = list(settings.owner_emails).join(',');
  if (!to) return;
  var lines = ['Church request ' + row.number + ', sent ' + row.timestamp, ''].concat(churchLines(row)).concat([
    '',
    attach ? 'Artwork: attached to this email. It could not be saved to Drive.' : 'Artwork: ' + row.artwork,
    '',
    'The row is in the Church requests tab with status New. Reply to this email to send the quote, then set the status to Quoted.',
    book().getUrl()
  ]).filter(function (l) { return l !== null; });
  var opts = {
    to: to, subject: 'Church request ' + row.number + ': ' + row.church + ', ' + row.total + ' shirts',
    body: lines.join('\n'), replyTo: row.email, name: storeName(settings)
  };
  if (attach) opts.attachments = [attach];
  MailApp.sendEmail(opts);
}

function emailChurch(row, settings) {
  var store = storeName(settings);
  var contact = contactAddress(settings);
  var lines = [
    'Hi ' + firstName(row.contact) + ',',
    '',
    'We have your request ' + row.number + ' and the artwork. We will look at it and reply with a quote.',
    ''
  ].concat(churchLines(row)).concat([
    '',
    str(settings.church_terms) || null,
    str(settings.church_terms) ? '' : null,
    'Questions, or a change to the sizes? Reply to this email.',
    '',
    store,
    contact || null
  ]).filter(function (l) { return l !== null; });
  var opts = { to: row.email, subject: store + ': request ' + row.number + ' received', body: lines.join('\n'), name: store };
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
  if (!sh) throw new Error('Missing tab: ' + name + '. Run setupTabs.');
  return sh;
}

function timeZone() {
  var tz = '';
  try { tz = Session.getScriptTimeZone(); } catch (e) { }
  return tz || 'America/Toronto';
}

/* A date typed into a cell is midnight in the sheet's own time zone, so that is the zone to read it back in. */
function sheetTimeZone() {
  var tz = '';
  try { tz = book().getSpreadsheetTimeZone(); } catch (e) { }
  return tz || timeZone();
}

function headerKey(h) {
  return String(h).trim().toLowerCase().replace(/\s+/g, '_');
}

function readRows(name) {
  return rowsOf(tab(name));
}

/* Same as readRows, for a tab an older sheet may not have yet. */
function readRowsIf(name) {
  var sh = book().getSheetByName(name);
  return sh ? rowsOf(sh) : [];
}

function rowsOf(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(headerKey);
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

function storeName(settings) {
  return str(settings.store_name) || DEFAULTS.store_name;
}

function contactAddress(settings) {
  return str(settings.contact_email) || list(settings.owner_emails)[0] || '';
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
  /* Longest colour name first, so "Black Heather" is not read as "Black". */
  var byLength = colourNames.slice().sort(function (a, b) { return b.length - a.length; });
  var out = [];
  tokens.forEach(function (t) {
    if (t === 'all' || t === 'everything') { out.push({ all: true }); return; }
    var colour = '';
    for (var i = 0; i < byLength.length; i++) {
      var lower = byLength[i].toLowerCase().replace(/['’.]/g, '');
      if (t.indexOf(lower + ' ') === 0) { colour = byLength[i]; t = t.slice(lower.length + 1); break; }
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
  if (v instanceof Date) return Utilities.formatDate(v, sheetTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function plain(v) {
  if (v instanceof Date) return Utilities.formatDate(v, sheetTimeZone(), 'yyyy-MM-dd');
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
  return v === true || /^(yes|y|true|1|x|on)$/i.test(str(v));
}

function isActive(v) {
  var s = str(v);
  return s === '' || yes(s);
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

/* Shows a small message in the sheet when a function is run from the Store menu, and logs it either way. */
function note(message) {
  Logger.log(message);
  try { book().toast(message, 'Store', 8); } catch (e) { }
}

/* ---------- setup: creates the tabs, and adds whatever a newer version of this script needs ---------- */

/* TEMPLATE:BEGIN (generated from sheets/template by sheets/test/sync-template.js) */
var TEMPLATE = {
  "Products": [
    ["id", "name", "price", "youth_price", "verse", "description", "colours", "sizes_mens", "sizes_womens", "sizes_youth", "sold_out_sizes", "images", "active", "new", "type", "note"],
    ["poweredbygod", "Powered by God", 35, 28, "", "Front: \"AI, Authentic Intelligence, Powered by God\" around a smiling face and a cross. Back: \"Living the Word\" in bold comic lettering. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.", "White #f2f2f2", "S, M, L, XL", "S, M, L", "YS, YM, YL", "", "poweredbygod-front.jpg; poweredbygod-back.jpg", "yes", "", "tee", "working name, price and second colour not confirmed"],
    ["bestai", "The best AI", 35, 28, "2 Corinthians 5:7", "Front: \"The best AI (Authentic Intelligence) is in my faith\". Back: \"Walk by faith, not by sight\" over a mountain path, with 2 Corinthians 5:7. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.", "White #f2f2f2", "S, M, L, XL", "S, M, L", "YS, YM, YL", "", "bestai-front.jpg; bestai-back.jpg", "yes", "", "tee", "working name, price and second colour not confirmed"],
    ["bible", "B.I.B.L.E.", 35, 28, "", "Front: the acrostic \"Basic Instructions Before Leaving Earth\". Back: an open Bible under a rising sun, above the Earth. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.", "White #f2f2f2", "S, M, L, XL", "S, M, L", "YS, YM, YL", "", "bible-front.jpg; bible-back.jpg", "yes", "", "tee", "working name, price and second colour not confirmed"],
    ["garden", "Garden of the Silicon Valley", 35, 28, "", "Front: two robots at the tree with the serpent, and the words \"In the Garden of the Silicon Valley, mankind said, Do not eat from the fruit of the tree. Satan said, Eat and you will be more powerful than mankind.\" The back is plain. Ring-spun cotton, regular fit, screen printed in Toronto. Machine wash cold, inside out. Hang to dry.", "White #f2f2f2", "S, M, L, XL", "S, M, L", "YS, YM, YL", "", "garden-front.jpg", "yes", "", "tee", "working name, price and second colour not confirmed"]
  ],
  "Orders": [
    ["number", "timestamp", "name", "phone", "email", "delivery", "address", "items", "promo", "subtotal", "total", "status", "paid", "consent"]
  ],
  "Promos": [
    ["code", "type", "value", "min_subtotal", "starts", "ends", "active", "note"],
    ["FAITH10", "percent", 10, 0, "", "", "yes", "sample code: 10 percent off"],
    ["CHURCH5", "amount", 5, 35, "", "", "no", "sample code: 5 dollars off orders of 35 or more"]
  ],
  "Reviews": [
    ["product", "order", "name", "stars", "text", "approved"],
    ["poweredbygod", "QV-1001", "Priya", 5, "Fits true to size and the print has not cracked after a dozen washes.", "yes"],
    ["bestai", "QV-1002", "Marcus", 4, "Runs a little large. I ordered a medium and it fits like a large.", "yes"]
  ],
  "Settings": [
    ["key", "value", "note"],
    ["store_name", "Qivgu", "Shown in emails and in the site when the site loads it"],
    ["owner_emails", "owner1@example.com, owner2@example.com", "Who gets the new-order email. Separate several with commas"],
    ["token", "change-me-to-a-random-string", "Must match the token in the site config. Blocks posts that do not come from the site"],
    ["order_prefix", "QV", "Order numbers look like QV-1042"],
    ["next_order", 1042, "The next order number. The script moves it up by one per order"],
    ["contact_email", "info@example.com", "Reply-to address on customer emails and shown in the site footer"],
    ["instagram", "@yourhandle", "Shown as text in the site footer"],
    ["etransfer_email", "info@example.com", "Where customers send e-Transfers"],
    ["gta_enabled", "yes", "Offer free GTA delivery (postal codes starting with M or L)"],
    ["gta_instructions", "We text you to arrange a delivery time. Have {total} in cash ready, or send an e-Transfer to {etransfer} with {number} in the message before we arrive.", "Sent to the customer who picks GTA delivery. {total} {etransfer} {number} are filled in"],
    ["pickup_enabled", "yes", "Offer pickup"],
    ["pickup_note", "Pickup at the church after the Sunday service or at the rink on Tuesday evenings. We text you to confirm.", "Shown on the checkout form and in the email for pickup orders"],
    ["pickup_instructions", "Bring {total} in cash, or send an e-Transfer to {etransfer} with {number} in the message.", "Sent to the customer who picks pickup. {total} {etransfer} {number} are filled in"],
    ["ship_enabled", "no", "Offer shipping within Ontario (e-Transfer first)"],
    ["ship_rate", 12, "Flat shipping charge in dollars"],
    ["ship_free_over", 150, "Shipping is free when the subtotal after discounts reaches this. 0 turns it off"],
    ["ship_instructions", "Send an e-Transfer of {total} to {etransfer} with {number} in the message. We ship within a few days of it arriving and email you when it is on its way.", "Sent to the customer who picks shipping. {total} {etransfer} {number} are filled in"],
    ["tax_rate", 0, "Percent added to the total. Leave 0 while not registered for HST"],
    ["max_qty", 10, "Most of one size and colour in a single order"],
    ["announcement", "Free delivery in the GTA. Pay cash or e-Transfer at the door.", "One line under the header. Leave blank to hide"],
    ["hook_line", "Don't just read the Word, wear it", "Shown once below the product grid"],
    ["delivery_line", "Free delivery in the GTA. Pay cash or e-Transfer at the door.", "Shown below the grid and on every product page"],
    ["story", "", "Your story in two or three sentences. Blank hides it"],
    ["giveback_line", "", "Your give-back line in your own words. Blank hides it"],
    ["review_form_url", "", "Pre-filled Google Form link with {product} and {order} where the form expects them, for example https://docs.google.com/forms/d/e/FORM_ID/viewform?usp=pp_url&entry.111={product}&entry.222={order}. Blank hides the review links"],
    ["music_url", "", "Link to a royalty-free track (mp3). Blank hides the play button"],
    ["music_label", "Play the song", "Text of the play button"],
    ["music_credit", "", "Credit line shown beside the play button if the licence asks for one"],
    ["default_stock", 25, "How many of each size the Stock tab starts with when seedStock adds a new product"],
    ["tryon_note", "", "Where people can see and feel the shirts in person: the place, the address and the hours. Shown in the FAQ and on product pages. Blank hides it"],
    ["church_intro", "We print your church's own design on our shirts. Send the artwork and the sizes you need and we reply with a quote.", "First paragraph on the Churches page. Blank hides it"],
    ["church_terms", "", "Minimum quantity, turnaround and how payment works for church orders, in one or two sentences. Shown under the intro. Blank hides it"],
    ["church_sizes_mens", "S, M, L, XL, 2XL", "Men's sizes offered on the church request form"],
    ["church_sizes_womens", "S, M, L, XL", "Women's sizes offered on the church request form"],
    ["church_sizes_youth", "YS, YM, YL", "Youth sizes offered on the church request form"],
    ["next_church_request", 1001, "The next church request number. The script moves it up by one per request"]
  ],
  "Stock": [
    ["product", "colour", "range", "size", "count"]
  ],
  "Media": [
    ["title", "type", "file", "date", "note"]
  ],
  "Church requests": [
    ["number", "timestamp", "church", "contact", "email", "phone", "colour", "mens", "womens", "youth", "total", "date_needed", "delivery", "notes", "artwork", "status"]
  ]
};
/* TEMPLATE:END */

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Store')
      .addItem('Create missing tabs and settings', 'setupTabs')
      .addItem('Add stock rows for new products', 'seedStock')
      .addToUi();
  } catch (e) { }
}

function setupTabs() {
  var ss = book();
  var names = Object.keys(TEMPLATE);
  var made = [], added = [];
  names.forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var sh = ss.insertSheet(name);
    var rows = TEMPLATE[name];
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sh.setFrozenRows(1);
    made.push(name);
  });

  /* An older sheet keeps its Settings values; rows this version needs and the sheet lacks go on the end. */
  var settings = ss.getSheetByName(TABS.settings);
  if (settings && made.indexOf(TABS.settings) < 0) {
    var have = {};
    settings.getDataRange().getValues().forEach(function (r) { have[str(r[0]).toLowerCase()] = true; });
    var missing = TEMPLATE[TABS.settings].slice(1).filter(function (r) { return !have[str(r[0]).toLowerCase()]; });
    if (missing.length) {
      settings.getRange(settings.getLastRow() + 1, 1, missing.length, missing[0].length).setValues(missing);
      added = missing.map(function (r) { return r[0]; });
    }
  }

  dropdown(ss.getSheetByName(TABS.orders), 'status', ORDER_STATUSES);
  dropdown(ss.getSheetByName(TABS.orders), 'paid', ['No', 'Yes']);
  dropdown(ss.getSheetByName(TABS.church), 'status', CHURCH_STATUSES);
  try { ss.setSpreadsheetTimeZone(timeZone()); } catch (e) { }

  var first = ss.getSheets()[0];
  if (first && names.indexOf(first.getName()) < 0 && ss.getSheets().length > names.length && first.getLastRow() === 0) ss.deleteSheet(first);

  var parts = [];
  if (made.length) parts.push('Created: ' + made.join(', '));
  if (added.length) parts.push('New settings: ' + added.join(', '));
  note(parts.length ? parts.join('. ') : 'Every tab and setting is already there');
  return made;
}

function dropdown(sh, column, values) {
  if (!sh || sh.getLastColumn() < 1) return;
  var c = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(headerKey).indexOf(column);
  if (c < 0) return;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  sh.getRange(2, c + 1, 2000, 1).setDataValidation(rule);
}
