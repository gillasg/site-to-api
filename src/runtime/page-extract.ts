import type { PageEndpoint } from "../types.js";

// In-page code for page endpoints: fetch the page's HTML from inside the site (with its
// cookies) and, for CSS extractors, read the fields with the browser's own HTML parser.

const EXTRACT = `async (args) => {
  const response = await fetch(args.url, { credentials: 'include', headers: { accept: 'text/html' } });
  const html = await response.text();
  if (!args.extractor) return { status: response.status, html };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const read = (root, field) => {
    if (field.type === 'list') return [...root.querySelectorAll(field.selector)].map((node) => node.textContent.trim());
    const node = field.selector === ':scope' ? root : root.querySelector(field.selector);
    if (!node) return null;
    if (field.type === 'attr') return node.getAttribute(field.attr || 'href');
    if (field.type === 'html') return node.innerHTML;
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    if (field.type === 'number') { const n = parseFloat(text.replace(/[^0-9.,-]/g, '').replace(/,(?=\\d{3}(\\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
    return text;
  };
  const record = (root) => Object.fromEntries(args.extractor.fields.map((field) => [field.name, read(root, field)]));
  if (args.extractor.baseSelector) return [...doc.querySelectorAll(args.extractor.baseSelector)].map(record);
  return record(doc);
}`;

export function pageExtractExpression(url: string, extractor?: PageEndpoint["extractor"]): string {
  return `(${EXTRACT})(${JSON.stringify({ url, extractor: extractor ?? null })})`;
}
