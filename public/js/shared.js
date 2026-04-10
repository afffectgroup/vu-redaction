// ── VU Rédaction — shared.js ─────────────────────────────────
// Fonctions partagées sur toutes les pages

const MONTHS_S = ['jan.','fév.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];

// État partagé (réinitialisé à chaque page)
window.S = window.S || { cats:[], auths:[], mSel:null, mCtx:'cover' };

// ── API ───────────────────────────────────────────────────────
async function api(m, u, b) {
  try {
    const r = await fetch(u, {
      method: m,
      headers: {'Content-Type':'application/json'},
      body: b ? JSON.stringify(b) : undefined
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`Serveur indisponible (${r.status})`);
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
    return d;
  } catch(e) {
    if (e.name === 'TypeError' && e.message.includes('fetch')) toast('Impossible de joindre le serveur', 'e');
    else toast(e.message, 'e');
    throw e;
  }
}

// ── TOAST ─────────────────────────────────────────────────────
function toast(msg, type='s') {
  let w = document.getElementById('toasts');
  if (!w) { w = document.createElement('div'); w.id='toasts'; w.className='toasts'; document.body.appendChild(w); }
  const ico = {s:'✅', e:'❌', i:'ℹ️'};
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.innerHTML = `<span>${ico[type]||'ℹ️'}</span> ${msg}`;
  w.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

// ── UTILS ─────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function txt(id, v) { const e = document.getElementById(id); if(e) e.textContent = v; }
function escHtml(s) { return esc(s); }
function escAttr(s) { return String(s||'').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }
function fmtFr(s) {
  if(!s) return '';
  const d = new Date(s);
  return `${d.getDate()} ${MONTHS_S[d.getMonth()]} ${d.getFullYear()}`;
}
function formatDateFr(s) { return fmtFr(s); }

function mdHtml(md) {
  return (md||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h2>$1</h2>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>').replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>')
    .replace(/^[-*] (.+)$/gm,'<li>$1</li>').replace(/^(\d+)\. (.+)$/gm,'<li>$2</li>')
    .replace(/(<li>[\s\S]+?<\/li>\n?)+/g,'<ul>$&</ul>')
    .replace(/\n\n/g,'</p><p>').replace(/^(?!<[hulibtps])(.+)$/gm,'<p>$1</p>').replace(/<p><\/p>/g,'');
}

// ── META (catégories + auteurs) ───────────────────────────────
async function loadMeta() {
  if (S.cats && S.cats.length) return;
  try {
    const [cats, auths] = await Promise.all([api('GET','/api/categories'), api('GET','/api/authors')]);
    S.cats = cats; S.auths = auths;
    document.querySelectorAll('.sel-cats').forEach(el => {
      el.innerHTML = '<option value="">-- Catégorie --</option>';
      cats.forEach(c => { const o=document.createElement('option'); o.value=c.id; o.textContent=c.name; el.appendChild(o); });
    });
    document.querySelectorAll('.sel-auths').forEach(el => {
      el.innerHTML = '<option value="">-- Auteur --</option>';
      auths.forEach(a => { const o=document.createElement('option'); o.value=a.id; o.textContent=a.name; el.appendChild(o); });
    });
  } catch(e) { console.warn('loadMeta error:', e.message); }
}

// ── MODALES ───────────────────────────────────────────────────
function closeMod(id) { document.getElementById(id)?.classList.remove('open'); }
function closeAllModals() { document.querySelectorAll('.modal-ov').forEach(m => m.classList.remove('open')); }
function cpRes(id) {
  const el = document.getElementById(id);
  if(!el) return;
  navigator.clipboard.writeText(el.innerText||'').then(() => toast('📋 Copié !'), () => toast('Erreur copie','e'));
}

// Fermer modal au clic overlay
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-ov').forEach(o =>
    o.addEventListener('click', e => { if(e.target===o) o.classList.remove('open'); })
  );
  // Sidebar : marquer le lien actif
  const path = window.location.pathname.replace('/','') || 'dashboard';
  document.querySelectorAll('.nav-it').forEach(n => {
    if(n.dataset.page === path) n.classList.add('on');
  });
  // Statut DB
  api('GET','/api/stats').then(d => {
    const el = document.getElementById('status-txt');
    if(el) el.textContent = `DB connectée · ${d.stats?.total||0} articles`;
  }).catch(() => {
    const el = document.getElementById('status-txt');
    if(el) el.textContent = 'Erreur connexion DB';
  });
});
