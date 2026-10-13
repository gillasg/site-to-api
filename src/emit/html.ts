import { createRedactor } from "../redact.js";
import type { Overrides, SiteModel } from "../types.js";
import { toOpenApi } from "./openapi.js";
import { curlExample, redactedSamples } from "./report.js";

// A self-contained HTML report that doubles as API docs: every operation with its parameters,
// schemas, confidence, curl example and samples. When served by `site-to-api serve`, each
// operation can be tried live.

function escapeScript(json: string): string {
  const backslash = String.fromCharCode(92);
  return json
    .replace(/</g, backslash + "u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), backslash + "u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), backslash + "u2029");
}

export function htmlReport(
  model: SiteModel,
  rules: Overrides["redact"] = {},
  live?: { endpoint: string },
): string {
  const redactor = createRedactor(rules);
  const data = {
    site: model.site,
    title: model.title,
    origins: model.origins,
    openapi: toOpenApi(model, rules),
    samples: redactedSamples(model, rules),
    curl: Object.fromEntries(
      model.operations.map((op) => [op.id, curlExample(op, redactor) ?? ""]),
    ),
    noise: model.noise.slice(0, 200).map((item) => ({ ...item, url: redactor.text(item.url) })),
    channels: model.channels,
    live: live ?? null,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)} API</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="brand">${escapeHtml(model.title)} <span>API</span></div><input id="filter" type="search" placeholder="Filter operations" aria-label="Filter operations"></header>
<main><nav id="nav" aria-label="Operations"></nav><section id="detail" aria-live="polite"></section></main>
<script type="application/json" id="data">${escapeScript(JSON.stringify(data))}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string,
  );
}

const STYLE = `
:root{--bg:#fbfbfa;--panel:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e7e6e3;--accent:#3355ff;--get:#13795b;--post:#9a5b00;--del:#b42318;--put:#5b3fd1;--chip:#f2f1ee;--code:#f6f5f2}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--panel:#1b1b1e;--text:#ececef;--muted:#9a9aa2;--line:#2c2c31;--accent:#8ea2ff;--get:#4cc79a;--post:#f0b252;--del:#ff8a80;--put:#b7a6ff;--chip:#26262b;--code:#202024}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;gap:16px;align-items:center;padding:12px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:650;font-size:16px;flex:1}.brand span{color:var(--muted);font-weight:500}
#filter{width:min(320px,50vw);padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
main{display:grid;grid-template-columns:minmax(220px,320px) 1fr;min-height:calc(100vh - 57px)}
nav{border-right:1px solid var(--line);padding:12px 8px;overflow:auto;max-height:calc(100vh - 57px);position:sticky;top:57px}
nav h4{margin:14px 10px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
nav button{display:flex;gap:8px;align-items:center;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:7px;background:none;color:var(--text);cursor:pointer;font:inherit}
nav button:hover,nav button[aria-current=true]{background:var(--chip)}
.m{font:600 10px/1 ui-monospace,monospace;padding:3px 5px;border-radius:4px;min-width:42px;text-align:center;color:#fff;background:var(--get)}
.m.POST{background:var(--post)}.m.DELETE{background:var(--del)}.m.PUT,.m.PATCH{background:var(--put)}.m.PAGE{background:var(--muted)}
#detail{padding:24px clamp(16px,4vw,40px);max-width:980px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px}
.path{font:13px ui-monospace,monospace;color:var(--muted);word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:12px}
.chip.high{color:var(--get)}.chip.medium{color:var(--post)}.chip.low{color:var(--del)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font:12px/1.45 ui-monospace,monospace;max-height:420px}
details summary{cursor:pointer;color:var(--muted);margin:6px 0}
.flag{color:var(--post)}form.try{display:grid;gap:8px;margin-top:8px}form.try label{display:grid;gap:3px;font-size:12px;color:var(--muted)}
form.try input,form.try textarea{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:12px ui-monospace,monospace}
form.try button{justify-self:start;padding:7px 14px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
@media (max-width:760px){main{grid-template-columns:1fr}nav{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
// The serve command opens this page with #token=…; it is kept for this tab only.
if (location.hash.startsWith('#token=')) { try { sessionStorage.setItem('site-to-api-token', location.hash.slice(7)); } catch {} history.replaceState(null, '', location.pathname); }
let token = ''; try { token = sessionStorage.getItem('site-to-api-token') || ''; } catch {}
const ops = [];
for (const [path, item] of Object.entries(data.openapi.paths)) for (const [method, op] of Object.entries(item)) {
  for (const variant of op['x-variants'] || [op]) ops.push({ path, method: method.toUpperCase(), op: variant, page: !!op['x-page-endpoint'] });
}
const el = (tag, attrs = {}, ...children) => { const node = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); for (const child of children.flat()) if (child != null) node.append(child); return node; };
const pre = (value) => el('pre', {}, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const resolve = (schema) => { let s = schema; for (let i = 0; i < 8 && s && s.$ref; i++) s = data.openapi.components.schemas[s.$ref.split('/').pop()]; return s; };
function expand(schema, depth = 0) {
  if (!schema || depth > 6) return schema;
  if (schema.$ref) return { ['(' + schema.$ref.split('/').pop() + ')']: expand(resolve(schema), depth + 1) };
  if (Array.isArray(schema)) return schema.map((s) => expand(s, depth + 1));
  if (typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, expand(v, depth + 1)]));
}
function renderNav(filter = '') {
  const nav = document.getElementById('nav'); nav.replaceChildren();
  const groups = {};
  for (const item of ops) { if (filter && !(item.op.operationId + ' ' + item.path).toLowerCase().includes(filter)) continue; (groups[item.op.tags?.[0] || 'other'] ||= []).push(item); }
  for (const [tag, list] of Object.entries(groups)) {
    nav.append(el('h4', {}, tag));
    for (const item of list) nav.append(el('button', { 'data-id': item.op.operationId, onclick: () => show(item) }, el('span', { class: 'm ' + (item.page ? 'PAGE' : item.method) }, item.page ? 'PAGE' : item.method), item.op.operationId));
  }
  if (data.channels.length) { nav.append(el('h4', {}, 'streams')); for (const ch of data.channels) nav.append(el('button', { onclick: () => showChannel(ch) }, el('span', { class: 'm PAGE' }, ch.kind === 'sse' ? 'SSE' : 'WS'), ch.id)); }
  nav.append(el('h4', {}, 'report'), el('button', { onclick: showNoise }, 'What was left out'));
}
function params(op) {
  if (!op.parameters?.length) return null;
  return el('table', {}, el('tr', {}, ['Name', 'In', 'Required', 'Schema', 'Example'].map((h) => el('th', {}, h))), op.parameters.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.name)), el('td', {}, p.in), el('td', {}, p.required ? 'yes' : 'no'), el('td', {}, JSON.stringify(p.schema)), el('td', {}, p['x-constant'] ?? p.example ?? (p['x-generated'] ? 'generated: ' + p['x-generated'] : '')))));
}
function tryForm(op) {
  if (!data.live || !token) return null;
  const fields = (op.parameters || []).filter((p) => !p['x-constant'] && !p['x-generated']);
  const out = el('div');
  const form = el('form', { class: 'try', onsubmit: async (event) => {
    event.preventDefault();
    const body = {};
    for (const p of fields) { const v = form.elements[p.name].value; if (v !== '') body[p.name] = v; }
    const extra = form.elements.__json?.value.trim(); if (extra) Object.assign(body, JSON.parse(extra));
    out.replaceChildren(el('p', {}, 'Calling…'));
    const response = await fetch(data.live.endpoint + '/ops/' + op.operationId, { method: 'POST', headers: { 'content-type': 'application/json', 'x-site-to-api-token': token }, body: JSON.stringify(body) });
    out.replaceChildren(pre(await response.json()));
  } }, fields.map((p) => el('label', {}, p.name + (p.required ? ' *' : ''), el('input', { name: p.name, placeholder: String(p.example ?? '') }))), op.requestBody ? el('label', {}, 'Body fields (JSON)', el('textarea', { name: '__json', rows: '4' })) : null, el('button', { type: 'submit' }, 'Call'));
  return el('div', {}, el('h2', {}, 'Try it'), form, out);
}
function show(item) {
  const op = item.op; history.replaceState(null, '', '#' + op.operationId);
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-current', String(b.dataset.id === op.operationId));
  const ok = Object.entries(op.responses || {}).find(([s]) => s.startsWith('2'));
  const schema = ok?.[1]?.content && Object.values(ok[1].content)[0]?.schema;
  const body = op.requestBody && Object.values(op.requestBody.content)[0]?.schema;
  const samples = data.samples[op.operationId] || [];
  const bucket = op['x-confidence-bucket'];
  document.getElementById('detail').replaceChildren(
    el('h1', {}, op.operationId), el('div', { class: 'path' }, item.method + ' ' + (op['x-origin'] || data.origins[0] || '') + item.path),
    el('div', { class: 'chips' }, bucket ? el('span', { class: 'chip ' + bucket }, bucket + ' confidence ' + Math.round(op['x-confidence'] * 100) + '%') : null, el('span', { class: 'chip' }, (op['x-sample-count'] ?? 0) + ' samples'), op['x-role'] ? el('span', { class: 'chip' }, op['x-role']) : null, op['x-pagination'] ? el('span', { class: 'chip' }, 'paginated: ' + op['x-pagination'].style) : null, op['x-signing'] ? el('span', { class: 'chip low' }, 'signed') : null, ...(op.security || []).flatMap((s) => Object.keys(s)).map((s) => el('span', { class: 'chip' }, '🔑 ' + s))),
    ...(op['x-flags'] || []).map((f) => el('p', { class: 'flag' }, '⚠ ' + f)),
    op.description ? el('p', {}, op.description) : null,
    params(op) ? el('h2', {}, 'Parameters') : null, params(op),
    body ? el('h2', {}, 'Request body') : null, body ? pre(expand(body)) : null,
    schema ? el('h2', {}, 'Response') : null, schema ? pre(expand(schema)) : null,
    op['x-dependencies'] ? el('details', {}, el('summary', {}, 'Where values come from'), pre(op['x-dependencies'])) : null,
    op['x-pagination'] ? el('details', {}, el('summary', {}, 'Pagination'), pre(op['x-pagination'])) : null,
    op['x-signing'] ? el('details', {}, el('summary', {}, 'Signing'), pre(op['x-signing'])) : null,
    data.curl[op.operationId] ? el('h2', {}, 'curl') : null, data.curl[op.operationId] ? pre(data.curl[op.operationId]) : null,
    samples.length ? el('details', {}, el('summary', {}, samples.length + ' redacted samples'), pre(samples)) : null,
    tryForm(op));
}
function showChannel(ch) { document.getElementById('detail').replaceChildren(el('h1', {}, ch.id), el('div', { class: 'path' }, ch.kind + ' ' + ch.url), ...ch.messages.map((m) => el('div', {}, el('h2', {}, m.direction + ' ' + m.name + ' (' + m.count + ')'), m.schema ? pre(m.schema) : null))); }
function showNoise() { document.getElementById('detail').replaceChildren(el('h1', {}, 'Left out'), el('table', {}, el('tr', {}, el('th', {}, 'URL'), el('th', {}, 'Why'), el('th', {}, 'Count')), data.noise.map((n) => el('tr', {}, el('td', {}, n.url), el('td', {}, n.reason), el('td', {}, String(n.count || '')))))); }
document.getElementById('filter').addEventListener('input', (e) => renderNav(e.target.value.toLowerCase()));
renderNav();
const start = ops.find((i) => i.op.operationId === location.hash.slice(1)) || ops[0];
if (start) show(start);
`;
