// Shared by harness.js and sync-template.js: the template files, and a CSV reader that sees cells the way Google Sheets would.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Tab name in the spreadsheet, and the template file that holds its header and example rows.
const TABS = [
  ['Products', 'Products.csv'], ['Orders', 'Orders.csv'], ['Promos', 'Promos.csv'], ['Reviews', 'Reviews.csv'],
  ['Settings', 'Settings.csv'], ['Stock', 'Stock.csv'], ['Media', 'Media.csv'], ['Church requests', 'Church-requests.csv']
];

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

function templateRows(file) {
  return parseCsv(fs.readFileSync(path.join(ROOT, 'template', file), 'utf8')).map(r => r.map(sheetValue));
}

module.exports = { ROOT, TABS, parseCsv, sheetValue, templateRows };
