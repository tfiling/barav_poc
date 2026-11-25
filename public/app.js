// Shared helpers
export async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function renderNav(active) {
  const links = [
    ['new.html', 'New item'],
    ['inventory.html', 'Inventory'],
    ['update.html', 'Update stock'],
    ['archetypes.html', 'Archetypes'],
  ];
  const nav = document.createElement('nav');
  nav.innerHTML = links
    .map(([href, label]) => `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`)
    .join('');
  document.body.prepend(nav);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const fmtNum = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });

export function printQr(item) {
  let label = document.querySelector('.print-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'print-label';
    document.body.append(label);
  }
  label.innerHTML = `<img src="${item.qrDataUrl}" alt="QR code"><h2>${esc(item.name)}</h2><p>${esc(item.supplier)} · ${esc(item.receivedDate)}</p>`;
  const img = label.querySelector('img');
  const go = () => window.print();
  img.complete ? go() : (img.onload = go);
}
