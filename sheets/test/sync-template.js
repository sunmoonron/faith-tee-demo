// Rewrites the TEMPLATE block in Code.gs from sheets/template/*.csv, so the tabs that setupTabs creates
// and the CSV files never drift apart. Run it after editing a template: node sheets/test/sync-template.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, TABS, templateRows } = require('./lib');

const file = path.join(ROOT, 'Code.gs');
const src = fs.readFileSync(file, 'utf8');
const begin = '/* TEMPLATE:BEGIN (generated from sheets/template by sheets/test/sync-template.js) */';
const end = '/* TEMPLATE:END */';
const a = src.indexOf(begin), b = src.indexOf(end);
if (a < 0 || b < 0 || b < a) { console.error('TEMPLATE markers not found in Code.gs'); process.exit(1); }

const lit = v => (typeof v === 'number' ? String(v) : JSON.stringify(v));
const body = TABS.map(([tab, csv]) => {
  const rows = templateRows(csv);
  const width = rows[0].length;
  return '  ' + JSON.stringify(tab) + ': [\n' + rows.map(r => {
    const cells = r.slice();
    while (cells.length < width) cells.push('');
    return '    [' + cells.map(lit).join(', ') + ']';
  }).join(',\n') + '\n  ]';
}).join(',\n');

const out = src.slice(0, a) + begin + '\nvar TEMPLATE = {\n' + body + '\n};\n' + src.slice(b);
if (out !== src) { fs.writeFileSync(file, out); console.log('Code.gs TEMPLATE updated'); } else console.log('Code.gs TEMPLATE already matches the templates');
