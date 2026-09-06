import { api, ago, count, esc } from './util.js';

const ROUTES = {
  overview: () => import('./views/overview.js'),
  stock: () => import('./views/stock.js'),
  catalogue: () => import('./views/catalogue.js'),
  receivables: () => import('./views/receivables.js'),
  orders: () => import('./views/orders.js'),
  tally: () => import('./views/tally.js'),
  roadmap: () => import('./views/roadmap.js'),
};

const view = document.getElementById('view');
const pageTitle = document.getElementById('page-title');

function currentRoute() {
  const name = (location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  return ROUTES[name] ? name : 'overview';
}

async function route() {
  const name = currentRoute();
  document.querySelectorAll('.nav-link').forEach((a) =>
    a.classList.toggle('active', a.getAttribute('href') === `#/${name}`)
  );
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const mod = await ROUTES[name]();
    pageTitle.textContent = mod.title;
    document.title = `${mod.title} · Balaji Enterprises`;
    await mod.render(view);
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="body">
      <strong>Could not load this screen.</strong>
      <p class="dim" style="margin:8px 0 0">${esc(err.message)}</p>
    </div></div>`;
  }
}

// --- topbar ----------------------------------------------------------------
const modePill = document.getElementById('mode-pill');
const syncPill = document.getElementById('sync-pill');
const syncBtn = document.getElementById('sync-now');

async function refreshTopbar() {
  try {
    const [target, status] = await Promise.all([api('/tally/target'), api('/sync/status')]);
    modePill.innerHTML = target.simulated
      ? '<span class="pill warn" title="Talking to a simulated TallyPrime over the real XML protocol"><i class="led"></i>Simulated Tally</span>'
      : '<span class="pill ok"><i class="led"></i>Live Tally</span>';

    const last = status.last;
    if (status.running) {
      syncPill.innerHTML = '<span class="pill accent">Syncing…</span>';
    } else if (!last) {
      syncPill.innerHTML = '<span class="pill">Never synced</span>';
    } else {
      const tone = last.status === 'ok' ? '' : last.status === 'partial' ? 'warn' : 'bad';
      const records = last.datasets.reduce((s, d) => s + d.records, 0);
      syncPill.innerHTML = `<span class="pill ${tone}" title="${count(records)} records">Synced ${ago(last.finished_at)}</span>`;
    }
  } catch {
    /* signed out — the api helper already redirected */
  }
}

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncPill.innerHTML = '<span class="pill accent">Syncing…</span>';
  try {
    await api('/sync/run', { method: 'POST' });
    await refreshTopbar();
    await route();
  } finally {
    syncBtn.disabled = false;
  }
});

document.getElementById('signout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login';
});

api('/me')
  .then(({ user }) => {
    document.getElementById('who').textContent = `${user.name} · ${user.role}`;
  })
  .catch(() => {});

window.addEventListener('hashchange', route);
route();
refreshTopbar();
setInterval(refreshTopbar, 60000);
