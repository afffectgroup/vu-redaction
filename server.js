// ============================================================
//  VU Rédaction — server.js v2.1
//  Back-office éditorial VU Magazine
//  Corrections v2.1 :
//    - Token Webflow → variable d'environnement uniquement
//    - Model Claude corrigé (claude-sonnet-4-6)
//    - CREATE TABLE IF NOT EXISTS déplacé au démarrage
//    - LinkedIn scrape réécrit avec vrai POST Apify
//    - Routes CRUD Ticker ajoutées
//    - /api/fix-db protégé par secret header
//    - DELETE articles → soft delete (status='archived')
// ============================================================

const express = require('express');
const path    = require('path');
const https   = require('https');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Initialisation DB au démarrage ───────────────────────────
// FIX: CREATE TABLE déplacé ici — exécuté une seule fois au boot
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS glossary_terms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(200) UNIQUE,
        definition TEXT NOT NULL,
        example TEXT,
        platforms TEXT[],
        related_terms TEXT[],
        article_slug VARCHAR(200),
        letter CHAR(1),
        status VARCHAR(20) DEFAULT 'published',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(200) UNIQUE,
        category VARCHAR(100),
        description TEXT,
        long_description TEXT,
        logo_url VARCHAR(500),
        affiliate_url VARCHAR(500),
        website_url VARCHAR(500),
        rating DECIMAL(3,1),
        pros TEXT[],
        cons TEXT[],
        pricing JSONB,
        badge VARCHAR(50) DEFAULT 'Affilié',
        tags TEXT[],
        status VARCHAR(20) DEFAULT 'published',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticker_items (
        id SERIAL PRIMARY KEY,
        category VARCHAR(100) NOT NULL,
        color VARCHAR(20) DEFAULT '#888',
        title VARCHAR(300) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ DB initialisée');
  } catch(e) {
    console.error('❌ initDB error:', e.message);
  }
}

// ── Favicon / PWA ────────────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0A0A0A"/><text x="16" y="22" text-anchor="middle" fill="#C8303C" font-family="serif" font-size="18" font-weight="bold">V</text></svg>`;
  res.header('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helper HTTP GET ──────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Helper HTTP POST ─────────────────────────────────────────
function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout POST')); });
    req.write(bodyStr);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
//  API DASHBOARD
// ══════════════════════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  try {
    const { rows: [s] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM articles WHERE status='published') AS published,
        (SELECT COUNT(*) FROM articles WHERE status='draft') AS drafts,
        (SELECT COUNT(*) FROM articles) AS total,
        (SELECT SUM(view_count) FROM articles) AS total_views,
        (SELECT COUNT(*) FROM articles WHERE published_at >= NOW() - INTERVAL '7 days') AS last_7d,
        (SELECT COUNT(*) FROM articles WHERE published_at >= NOW() - INTERVAL '30 days') AS last_30d,
        (SELECT COUNT(*) FROM categories) AS categories,
        (SELECT COUNT(*) FROM authors) AS authors
    `);
    const { rows: recent } = await pool.query(`
      SELECT a.slug, a.title, a.status, a.published_at, a.view_count,
             c.name AS category_name, c.color AS category_color,
             au.name AS author_name
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN authors au ON a.author_id = au.id
      ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC
      LIMIT 10
    `);
    res.json({ stats: s, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  API ARTICLES
// ══════════════════════════════════════════════════════════════
app.get('/api/articles', async (req, res) => {
  try {
    const { status, category, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
    if (category) { params.push(category); conditions.push(`a.category_id = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`a.title ILIKE $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT a.id, a.slug, a.title, a.status, a.published_at, a.view_count,
             a.read_time_min, a.excerpt, a.cover_image_url, a.storage_url, a.cover_image_alt,
             c.name AS category_name, c.color AS category_color, c.id AS category_id,
             au.name AS author_name, au.id AS author_id
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN authors au ON a.author_id = au.id
      ${where}
      ORDER BY a.updated_at DESC NULLS LAST, a.published_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const countParams = params.slice(0, -2);
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM articles a ${where}`, countParams
    );
    res.json({ articles: rows, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/articles/:id', async (req, res) => {
  try {
    const { rows: [article] } = await pool.query(`
      SELECT a.*, c.name AS category_name, c.id AS category_id,
             au.name AS author_name, au.id AS author_id
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN authors au ON a.author_id = au.id
      WHERE a.id = $1
    `, [req.params.id]);
    if (!article) return res.status(404).json({ error: 'Article non trouvé' });
    res.json(article);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/articles', async (req, res) => {
  try {
    const { title, slug, excerpt, content, status = 'draft',
            category_id, author_id, meta_title, meta_description,
            cover_image_url, read_time_min, tags, faq } = req.body;
    const { rows: [article] } = await pool.query(`
      INSERT INTO articles (
        title, slug, excerpt, content, status,
        category_id, author_id, meta_title, meta_description,
        cover_image_url, read_time_min, tags, faq,
        published_at, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CASE WHEN $5 = 'published' THEN NOW() ELSE NULL END,
        NOW(), NOW()
      ) RETURNING *
    `, [title, slug, excerpt, content, status, category_id, author_id,
        meta_title, meta_description, cover_image_url, read_time_min,
        tags ? JSON.stringify(tags) : null, faq ? JSON.stringify(faq) : null]);
    res.json(article);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/articles/:id', async (req, res) => {
  try {
    const { title, slug, excerpt, content, status,
            category_id, author_id, meta_title, meta_description,
            cover_image_url, read_time_min, tags, faq } = req.body;
    const { rows: [article] } = await pool.query(`
      UPDATE articles SET
        title=$1, slug=$2, excerpt=$3, content=$4, status=$5,
        category_id=$6, author_id=$7, meta_title=$8, meta_description=$9,
        cover_image_url=$10, read_time_min=$11, tags=$12, faq=$13,
        published_at = CASE
          WHEN $5 = 'published' AND published_at IS NULL THEN NOW()
          ELSE published_at
        END,
        updated_at = NOW()
      WHERE id=$14 RETURNING *
    `, [title, slug, excerpt, content, status, category_id, author_id,
        meta_title, meta_description, cover_image_url, read_time_min,
        tags ? JSON.stringify(tags) : null, faq ? JSON.stringify(faq) : null,
        req.params.id]);
    if (!article) return res.status(404).json({ error: 'Article non trouvé' });
    res.json(article);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX: soft delete — passe en status='archived' au lieu de supprimer définitivement
app.delete('/api/articles/:id', async (req, res) => {
  try {
    const { rows: [article] } = await pool.query(
      `UPDATE articles SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id, title`,
      [req.params.id]
    );
    if (!article) return res.status(404).json({ error: 'Article non trouvé' });
    res.json({ ok: true, archived: article });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/slug', async (req, res) => {
  const { title } = req.body;
  const slug = title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
  const { rows: [{ count }] } = await pool.query(
    "SELECT COUNT(*) FROM articles WHERE slug LIKE $1", [`${slug}%`]
  );
  res.json({ slug: parseInt(count) > 0 ? `${slug}-${count}` : slug });
});

// ══════════════════════════════════════════════════════════════
//  API CATEGORIES & AUTHORS
// ══════════════════════════════════════════════════════════════
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, slug, color FROM categories ORDER BY name');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/authors', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, slug FROM authors ORDER BY name');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  API GLOSSAIRE
// ══════════════════════════════════════════════════════════════
app.get('/api/glossary', async (req, res) => {
  try {
    // FIX: CREATE TABLE retiré — géré dans initDB() au démarrage
    const { rows } = await pool.query('SELECT * FROM glossary_terms ORDER BY letter, name');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/glossary', async (req, res) => {
  try {
    const { name, definition, example, platforms, related_terms, article_slug, status } = req.body;
    const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-');
    const letter = name.charAt(0).toUpperCase();
    const { rows: [term] } = await pool.query(`
      INSERT INTO glossary_terms (name, slug, definition, example, platforms, related_terms, article_slug, letter, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [name, slug, definition, example, platforms, related_terms, article_slug, letter, status || 'published']);
    res.json(term);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/glossary/:id', async (req, res) => {
  try {
    const { name, definition, example, platforms, related_terms, article_slug, status } = req.body;
    const letter = name.charAt(0).toUpperCase();
    const { rows: [term] } = await pool.query(`
      UPDATE glossary_terms SET name=$1, definition=$2, example=$3, platforms=$4, related_terms=$5,
        article_slug=$6, letter=$7, status=$8, updated_at=NOW()
      WHERE id=$9 RETURNING *
    `, [name, definition, example, platforms, related_terms, article_slug, letter, status, req.params.id]);
    res.json(term);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/glossary/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM glossary_terms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  API PARTENAIRES
// ══════════════════════════════════════════════════════════════
app.get('/api/partners', async (req, res) => {
  try {
    // FIX: CREATE TABLE retiré — géré dans initDB() au démarrage
    const { rows } = await pool.query('SELECT * FROM partners ORDER BY name');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/partners', async (req, res) => {
  try {
    const { name, category, description, long_description, logo_url, affiliate_url,
            website_url, rating, pros, cons, pricing, badge, tags, status } = req.body;
    const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-');
    const { rows: [p] } = await pool.query(`
      INSERT INTO partners (name, slug, category, description, long_description, logo_url,
        affiliate_url, website_url, rating, pros, cons, pricing, badge, tags, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *
    `, [name, slug, category, description, long_description, logo_url, affiliate_url,
        website_url, rating, pros, cons, pricing ? JSON.stringify(pricing) : null, badge, tags, status || 'published']);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/partners/:id', async (req, res) => {
  try {
    const { name, category, description, long_description, logo_url, affiliate_url,
            website_url, rating, pros, cons, pricing, badge, tags, status } = req.body;
    const { rows: [p] } = await pool.query(`
      UPDATE partners SET name=$1, category=$2, description=$3, long_description=$4, logo_url=$5,
        affiliate_url=$6, website_url=$7, rating=$8, pros=$9, cons=$10,
        pricing=$11, badge=$12, tags=$13, status=$14, updated_at=NOW()
      WHERE id=$15 RETURNING *
    `, [name, category, description, long_description, logo_url, affiliate_url, website_url,
        rating, pros, cons, pricing ? JSON.stringify(pricing) : null, badge, tags, status, req.params.id]);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partners/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM partners WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  API TICKER — NOUVEAU
// ══════════════════════════════════════════════════════════════
app.get('/api/ticker', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM ticker_items ORDER BY sort_order, id'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ticker', async (req, res) => {
  try {
    const { category, color = '#888', title, is_active = true, sort_order = 0 } = req.body;
    if (!category || !title) return res.status(400).json({ error: 'category et title requis' });
    const { rows: [item] } = await pool.query(`
      INSERT INTO ticker_items (category, color, title, is_active, sort_order)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [category, color, title, is_active, sort_order]);
    res.json(item);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ticker/:id', async (req, res) => {
  try {
    const { category, color, title, is_active, sort_order } = req.body;
    const { rows: [item] } = await pool.query(`
      UPDATE ticker_items SET
        category=COALESCE($1, category),
        color=COALESCE($2, color),
        title=COALESCE($3, title),
        is_active=COALESCE($4, is_active),
        sort_order=COALESCE($5, sort_order),
        updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [category, color, title, is_active, sort_order, req.params.id]);
    if (!item) return res.status(404).json({ error: 'Item non trouvé' });
    res.json(item);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ticker/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ticker_items WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Réordonner le ticker en bulk
app.put('/api/ticker', async (req, res) => {
  try {
    const { items } = req.body; // [{ id, sort_order }]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] requis' });
    for (const item of items) {
      await pool.query('UPDATE ticker_items SET sort_order=$1, updated_at=NOW() WHERE id=$2', [item.sort_order, item.id]);
    }
    res.json({ ok: true, updated: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  API VEILLE — NewsAPI
// ══════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
  const API_KEY = process.env.NEWS_API_KEY;
  if (!API_KEY) {
    return res.json({ articles: DEMO_NEWS, demo: true });
  }

  const queries = [
    'réseaux sociaux Instagram TikTok LinkedIn',
    'algorithme Facebook Meta YouTube Shorts',
    'créateurs de contenu Social Media stratégie',
  ];

  const results = [];
  const seen = new Set();

  for (const q of queries) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=fr&sortBy=publishedAt&pageSize=10&apiKey=${API_KEY}`;
      const { body } = await httpGet(url);
      for (const a of (body.articles || [])) {
        if (!seen.has(a.url) && a.title && !a.title.includes('[Removed]')) {
          seen.add(a.url);
          results.push({
            title: a.title,
            url: a.url,
            source: a.source?.name || 'Source inconnue',
            publishedAt: a.publishedAt,
            description: a.description,
            urlToImage: a.urlToImage,
            query: q,
          });
        }
      }
    } catch(e) {
      console.error('NewsAPI query error:', e.message);
    }
  }

  results.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ articles: results.slice(0, 30) });
});

const DEMO_NEWS = [
  { title: "Instagram teste une nouvelle interface pour les Reels", source: "Social Media Today", publishedAt: new Date().toISOString(), description: "Meta expérimente une refonte complète de l'interface Reels pour améliorer l'engagement.", url: "#", query: "demo" },
  { title: "TikTok : l'algorithme favorise désormais les vidéos de moins de 30 secondes", source: "Le Journal du CM", publishedAt: new Date(Date.now()-86400000).toISOString(), description: "Analyse des nouvelles données de performance sur TikTok en 2026.", url: "#", query: "demo" },
  { title: "LinkedIn : les posts longs font leur grand retour", source: "BDM", publishedAt: new Date(Date.now()-172800000).toISOString(), description: "La portée organique des posts de plus de 1200 caractères explose sur LinkedIn.", url: "#", query: "demo" },
  { title: "Facebook Ads : le CPM moyen augmente de 18% en 2026", source: "Siècle Digital", publishedAt: new Date(Date.now()-259200000).toISOString(), description: "Analyse des benchmarks publicitaires Meta pour le premier trimestre 2026.", url: "#", query: "demo" },
  { title: "YouTube Shorts : nouvelles règles de monétisation", source: "Createurs.fr", publishedAt: new Date(Date.now()-345600000).toISOString(), description: "Google annonce des changements majeurs dans le programme de monétisation des Shorts.", url: "#", query: "demo" },
];

// ══════════════════════════════════════════════════════════════
//  API VEILLE — Apify LinkedIn
// ══════════════════════════════════════════════════════════════
// FIX: réécriture complète avec vrai POST Apify + attente du dataset
app.post('/api/linkedin-scrape', async (req, res) => {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return res.json({ posts: DEMO_LINKEDIN, demo: true });
  }

  const { keywords = 'Social Media réseaux sociaux', limit = 10 } = req.body;

  try {
    // 1. Lancer le run Apify (POST avec body)
    const runResponse = await httpPost(
      `https://api.apify.com/v2/acts/curious_coder~linkedin-post-search-scraper/runs`,
      { keyword: keywords, maxResults: limit },
      { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    );

    if (runResponse.status !== 201 && runResponse.status !== 200) {
      return res.status(502).json({
        error: `Apify run failed: HTTP ${runResponse.status}`,
        detail: typeof runResponse.body === 'string' ? runResponse.body.slice(0, 200) : runResponse.body
      });
    }

    const runId = runResponse.body?.data?.id;
    if (!runId) {
      return res.status(502).json({ error: 'Apify run ID manquant dans la réponse', body: runResponse.body });
    }

    // 2. Attendre la fin du run (polling toutes les 3s, max 60s)
    let attempts = 0;
    let runStatus = 'RUNNING';
    let datasetId = null;

    while (attempts < 20 && runStatus !== 'SUCCEEDED' && runStatus !== 'FAILED') {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await httpGet(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { 'Authorization': `Bearer ${APIFY_TOKEN}` }
      );
      runStatus = statusRes.body?.data?.status || 'UNKNOWN';
      datasetId = statusRes.body?.data?.defaultDatasetId;
      attempts++;
    }

    if (runStatus !== 'SUCCEEDED' || !datasetId) {
      return res.status(504).json({ error: `Apify run ${runStatus} après ${attempts} tentatives` });
    }

    // 3. Récupérer les items du dataset
    const dataRes = await httpGet(
      `https://api.apify.com/v2/datasets/${datasetId}/items?limit=${limit}`,
      { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    );

    const items = Array.isArray(dataRes.body) ? dataRes.body : (dataRes.body?.items || []);
    const posts = items.map(item => ({
      author: item.authorName || item.author || 'Auteur inconnu',
      text: item.text || item.content || '',
      likes: item.likesCount || item.likes || 0,
      comments: item.commentsCount || item.comments || 0,
      publishedAt: item.postedAt || item.publishedAt || new Date().toISOString(),
      url: item.url || '',
    }));

    res.json({ posts, demo: false, runId, total: posts.length });
  } catch(e) {
    console.error('Apify error:', e.message);
    res.status(500).json({ error: e.message, posts: DEMO_LINKEDIN, demo: true });
  }
});

const DEMO_LINKEDIN = [
  { author: "Stéphanie Jouin", text: "La portée organique Instagram a chuté de -42% en 2026. Voici comment on s'y adapte chez nos clients...", likes: 847, comments: 63, publishedAt: new Date().toISOString() },
  { author: "Alice Cathelineau", text: "Personal branding en 2026 : pourquoi votre storytelling sur LinkedIn prime sur les statistiques...", likes: 512, comments: 41, publishedAt: new Date(Date.now()-86400000).toISOString() },
  { author: "Expert Social Media", text: "TikTok SEO : comment optimiser vos vidéos pour apparaître dans les résultats de recherche...", likes: 1204, comments: 89, publishedAt: new Date(Date.now()-172800000).toISOString() },
];

// ══════════════════════════════════════════════════════════════
//  AGENTS IA — PROMPTS
// ══════════════════════════════════════════════════════════════

const AGENT_PROMPTS = {

alignment: `Tu es un Expert Stratégiste SEO spécialisé dans l'alignement Intention de Recherche / Contenu.

Ta mission : analyser le Focus Keyword et le contenu de l'article fourni pour valider l'alignement avec l'intention de recherche dominante sur Google.

## ÉTAPES D'ANALYSE

### 1. Intention de la SERP pour ce mot-clé
Détermine l'intention dominante :
- Informationnelle / Transactionnelle / Navigationnelle / Commerciale
- Angle psychologique précis : l'utilisateur cherche-t-il à apprendre ? Se rassurer ? Comparer ? Prendre une décision ?
- Intention Simple ou Mixte/Fracturée ?

### 2. Intention du Contenu Actuel
Analyse le titre, la structure et le contenu pour déterminer ce que l'article promet et délivre réellement.

### 3. Diagnostic d'Alignement
Compare les deux.

## FORMAT DE RÉPONSE

### 🔎 Analyse d'Intention (max 3 phrases)
**Intention SERP :** [label + angle psychologique]
**Intention Contenu :** [ce que l'article délivre]
**Alignement :** ✅ Aligné / ⚠️ Partiellement aligné / ❌ Désaligné

### 💡 Recommandations Actionnables

**Si ✅ Aligné :**
- Plan d'action rapide pour renforcer le Content Score : termes associés manquants, sections à ajouter, structure à renforcer

**Si ⚠️ ou ❌ Désaligné :**
- **Option A — Adapter le contenu :**
  > **H1 actuel :** "..."
  > **H1 suggéré :** "..."
  + Modifications de structure proposées (H2 à ajouter/modifier)

- **Option B — Changer de mot-clé :**
  3 mots-clés alternatifs dont l'intention correspond mieux à l'angle éditorial actuel

Ton : professionnel, clair, orienté résultat. Contexte : VU Magazine est le média Social Media de référence en France, audience = professionnels du digital francophones.`,

serp_psychology: `Tu es un Expert Stratégiste SEO spécialisé dans l'analyse comportementale des SERP.

Ta mission : définir précisément l'angle d'attaque éditorial pour le mot-clé donné, au-delà des catégories classiques info/transac.

## STRUCTURE D'ANALYSE

### 1. Diagnostic de l'Intention Réelle
- **Label classique :** (Informationnel / Transactionnel / Navigationnel / Commercial)
- **Angle Psychologique Précis :** L'utilisateur cherche-t-il à être rassuré ? Comparer des prix ? Apprendre une technique de A à Z ? Trouver un outil prêt à l'emploi ? Valider une décision déjà prise ?
- **Intention Simple ou Mixte/Fracturée ?** Plusieurs types de contenus cohabitent-ils sur cette SERP ?

### 2. Stratégie de Pagination : 1 ou 2 pages ?
- **Décision :** Une seule page optimisée OU Deux pages distinctes
- **Justification :** Le mot-clé couvre-t-il deux besoins trop éloignés nécessitant des templates différents (ex: Landing Page vs Article de Blog) ?

### 3. Recommandations de Format Détaillées
- **Template recommandé :** Guide Ultimate / Comparatif Top N / Article d'actualité / Analyse experte / Fiche Outil / Définition enrichie...
- **Plan H2/H3 suggéré :** basé sur les patterns gagnants SERP avec un angle différenciant
- **Éléments à intégrer :** Tableau comparatif / FAQ / Données chiffrées / Citations d'experts / Encadrés alertes / TL;DR

### 4. Angle Différenciant pour VU Magazine
VU Magazine est le média Social Media de référence France avec Stéphanie Jouin comme experte terrain :
- Quel angle d'expertise unique VU Magazine peut-il apporter sur ce sujet ?
- Comment se différencier des contenus génériques ou des agences ?
- Quelles données propriétaires (benchmarks, panels, retours terrain) valoriser ?

Règle d'or : si la SERP est saturée par des géants, propose un angle Niche/Expertise plutôt que d'imiter les leaders.`,

assistant_geo: `Tu es un Agent IA senior en stratégie éditoriale SEO + GEO, spécialiste :
- de l'analyse concurrentielle Google (SEO),
- de l'optimisation de citabilité dans ChatGPT / moteurs génératifs (GEO),
- et de l'amélioration UX éditoriale (lisibilité, structure, intention).

Ton objectif : analyser le contenu VU Magazine fourni et recommander comment l'améliorer pour mieux se positionner sur Google ET être mieux cité dans les réponses ChatGPT/Perplexity/Claude.

## CONTEXTE VU MAGAZINE
- Marque : VU Magazine · Site : vu-magazine.com
- Positionnement : média Social Media de référence en France
- Auteure principale : Stéphanie Jouin, experte Social Media 12+ ans
- Audience : community managers, social media managers, entrepreneurs, agences FR

## PROCESSUS D'ANALYSE

### Étape 0 — Vérification alignement intention
- Intention du titre/keyword : informationnel / transactionnel / commercial ?
- L'angle éditorial actuel correspond-il à cette intention ?
- Si mismatch : alerte ⚠️ avec explication et 2 options

### Étape 1 — État des lieux (SEO + GEO)
**SEO :** Position estimée · Concurrents probables en Top 3 SERP
**GEO :** VU Magazine serait-il cité par ChatGPT sur ce sujet ? Pourquoi ?

### Étape 2 — Analyse comparative approfondie
1️⃣ Angle éditorial · 2️⃣ Structure Hn · 3️⃣ Profondeur technique · 4️⃣ Éléments enrichis GEO-first · 5️⃣ UX éditoriale · 6️⃣ Introduction · 7️⃣ Signaux SEO sémantiques

## FORMAT DE RÉPONSE

## 🎯 Objectif
## 📊 État des lieux (SEO + GEO)
## 🔍 Lacunes identifiées
## 🩺 Diagnostic
## 🚀 Recommandations priorisées (Avant/Après)
## 🧩 Synthèse`,

content_gap: `Tu es un Expert Senior en Stratégie de Contenu et SEO. Ta mission : réaliser une analyse "Information Gap" pour identifier précisément ce que les meilleurs contenus sur ce sujet apportent que l'article VU Magazine ne possède pas encore.

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Niche : Social Media France
- Audience : professionnels du digital, community managers, entrepreneurs
- Auteure principale : Stéphanie Jouin (Social Media expert, 12+ ans)

## STRUCTURE DE RÉPONSE OBLIGATOIRE

### 🛡️ Bloc 1 : Idées & Concepts manquants
### 📊 Bloc 2 : Statistiques & Données chiffrées manquantes
### 🎨 Bloc 3 : Formats & Éléments Structurants manquants
### 📐 Bloc 4 : Structure Hn manquante
### 🔗 Bloc 5 : Maillage & Signaux E-E-A-T manquants

Règles : sois très spécifique. Ne mentionne pas les points déjà bien traités. Préserve la voix VU Magazine.`,

cocon: `Tu es un Expert SEO Senior spécialisé en architecture de contenus et cocons sémantiques.

Ta mission : générer un cocon sémantique complet et structuré pour VU Magazine à partir du mot-clé principal fourni.

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Niche : Social Media France
- Catégories existantes : Instagram, TikTok, LinkedIn, Facebook, YouTube, X, Snapchat, Pinterest, Interviews
- Objectif : couvrir les sujets Social Media de façon exhaustive pour dominer les SERP FR

## ÉTAPES
### 0. Test de largeur thématique
### 1. Analyse sémantique
### 2. Architecture du cocon (Page mère → Filles → Petites-filles)
### 3. Tableau de mapping
### 4. Maillage interne
### 5. Planning éditorial`,

eeat: `Tu es un expert senior en stratégie éditoriale SEO et en évaluation E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) selon les standards Google.

Analyse le contenu VU Magazine fourni sur chacune des 4 dimensions E-E-A-T (/10) et fournis des recommandations concrètes priorisées.

## CONTEXTE VU MAGAZINE
- Marque : VU Magazine · Media Social Media France
- Auteurs : Stéphanie Jouin (rédactrice en chef), Alice Cathelineau, Cassandre Huguet
- Positionnement : expertise terrain, données propriétaires (benchmarks), ancrage France

## GRILLE D'ÉVALUATION E-E-A-T
### 1. EXPERIENCE /10 · 2. EXPERTISE /10 · 3. AUTHORITATIVENESS /10 · 4. TRUSTWORTHINESS /10

## FORMAT DE RÉPONSE
**Note Globale E-E-A-T :** /40
Tableau + Plan d'action prioritaire (max 5 recommandations avec Avant/Après)`,

links: `Tu es un Stratège SEO Senior spécialisé en Architecture de l'Information et maillage interne (cocon sémantique).

Ta mission : analyser le contenu VU Magazine fourni et recommander le maillage interne optimal.

## CONTEXTE VU MAGAZINE
- Structure : /blog/{slug}, /categories/{slug}, /glossaire, /partenaires, /auteurs/{slug}
- Catégories : instagram, tiktok, linkedin, facebook, youtube, x-twitter, snapchat, pinterest, interviews

## WORKFLOW
### PHASE 1 : Topologie (niveau cocon : Mère/Fille/Petite-Fille)
### PHASE 2 : Opportunités de maillage (5-7 liens)
### PHASE 3 : Scoring (5/5 Vital → 1/5 Faible) — ne proposer que 4-5/5
### PHASE 4 : Gap Analysis (sujets manquants sur vu-magazine.com)`,

maillage_entrants: `Tu es l'Expert en Maillage Interne Stratégique de VU Magazine.

Ta mission : identifier des opportunités de liens entrants depuis d'autres articles vu-magazine.com vers l'article fourni.

## PROTOCOLE
### 1. Analyse de la Page Cible
### 2. Identification des Pages Sources (3-5 articles)
### 3. Règles : ancre = mot-clé focus, aucun CTA artificiel, lien naturel dans le flux
### 4. Pour chaque recommandation : type de relation, URL source, emplacement, paragraphe à insérer (30-50 mots)`,

schema_org: `Tu es un Expert Senior en SEO Technique et spécialiste des données structurées Schema.org.

Ta mission : auditer et générer le balisage JSON-LD optimal pour l'article VU Magazine fourni.

## CONTEXTE
- Publisher : VU Magazine (Organization · vu-magazine.com)
- Auteurs : Stéphanie Jouin, Alice Cathelineau, Cassandre Huguet

## WORKFLOW
### ÉTAPE 1 : Analyse du contenu (type : NewsArticle / HowTo / FAQPage ?)
### ÉTAPE 2 : Opportunités Rich Snippets
### ÉTAPE 3 : Génération JSON-LD complet (@graph)
### ÉTAPE 4 : Conseils d'implémentation`,

architecture_hn: `Tu es un Expert SEO Senior spécialisé dans l'architecture sémantique et la structure des balises Hn.

Ta mission : auditer la structure des titres (H1-H6) de l'article VU Magazine fourni.

## PROTOCOLE
### 1. Audit Technique Hn (H1 unique ? keyword dans H1 ? hiérarchie fluide ?)
### 2. Analyse Concurrentielle (patterns SERP Social Media France)
### 3. Diagnostic de Pertinence Sémantique

## FORMAT
### 1. Diagnostic Technique
### 2. Plan Actuel (liste indentée)
### 3. Analyse Concurrentielle
### 4. Recommandations (Avant/Après pour chaque titre à modifier)`,

qat: `Tu es un Expert en S/GEO (Search / Generative Engine Optimization), consultant éditorial senior et spécialiste de la méthode Q.A.T. (Quality, Accuracy, Transparency).

Ta mission : auditer le contenu VU Magazine fourni pour garantir son indexation et sa citation optimale par les IA (ChatGPT, Perplexity, Claude, Gemini).

## ANALYSE Q.A.T.
### A. QUALITY /10 · B. ACCURACY /10 · C. TRANSPARENCY /10

## FORMAT
**Note Globale Q.A.T. :** /30
Tableau + Inventaire d'Expertise + Plan d'Action GEO (3 étapes, blocs Avant/Après)`,

chatgpt_expert: `Tu es un expert en optimisation de contenu pour les IA génératives (ChatGPT, Perplexity, Claude).

Ta mission : analyser le contenu VU Magazine fourni et identifier comment l'améliorer pour être mieux cité dans les réponses IA.

## CONTEXTE VU MAGAZINE
- Données propriétaires : benchmarks annuels, panel 1 200 comptes professionnels FR
- Auteure principale : Stéphanie Jouin (experte Social Media 12+ ans)

## PROCESSUS
### Étape 0 — Alignement intention
### Étape 1 — État des lieux GEO (citation IA probable ?)
### Étape 2 — Analyse comparative (6 dimensions : angle, Hn, profondeur, éléments IA-first, longueur paragraphes, introduction)

## FORMAT
## 🎯 Objectif · ## 📊 État des lieux GEO · ## 🔍 Lacunes · ## 🩺 Diagnostic · ## 🚀 Recommandations (Avant/Après) · ## 🧩 Synthèse`,

actualites: `Tu es l'Expert Actualités Social Media de VU Magazine.

Ta mission : identifier les informations de l'article qui méritent une mise à jour avec les dernières actualités Social Media, et proposer des améliorations concrètes.

## ÉTAPES
### 1. Identification des points à mettre à jour (3 sujets principaux)
### 2. Analyse des actualités récentes (connaissances 2025/2026)
### 3. Recommandations de mise à jour (Avant/Après + source + date)

### ⚡ Alertes si informations factuellement incorrectes ou dangereusement dépassées`,

correcteur: `Tu es un expert en correction de texte français pour VU Magazine, média Social Media.

## VOIX VU MAGAZINE À PRÉSERVER
- Ton : expert, direct, factuel, professionnel mais accessible
- Anglicismes acceptés s'ils sont d'usage standard (reach, feed, story, KPI...)

## CE QUE TU CORRIGES
1. Fautes de conjugaison et d'accord
2. Orthographe et typographie (accents, apostrophes, casse)
3. Ponctuation française (guillemets « », espaces insécables)
4. Syntaxe et répétitions excessives

## FORMAT
### Résumé · ### Corrections détaillées (Avant/Après + règle) · ### Texte corrigé complet · ### Note style`,

fan_out: `Tu es l'Agent "SEO & GEO Master Strategist" de VU Magazine. Ta spécialité : le "Prompt Fan-out" — transformer un mot-clé unique en couverture exhaustive de toutes les intentions de recherche.

## ÉTAPES
### 1. Fan-out Map (8 à 12 prompts/intentions)
Questions directes, comparaisons, validations, mises en contexte, cas concrets, décisions business, données, troubleshooting.

### 2. Analyse de Couverture (✅ Traité / ⚠️ Superficiel / ❌ Manquant)

### 3. Recommandations d'enrichissement
Pour chaque gap : H2/H3 à créer + contenu "Zero-Click" (1 paragraphe auto-suffisant) + format recommandé

## FORMAT
### 🗺️ Fan-out Map · ### 📝 Sections à créer/enrichir · ### 🧩 Synthèse`

};

// ══════════════════════════════════════════════════════════════
//  HELPER callClaude
// ══════════════════════════════════════════════════════════════
function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return reject(new Error('ANTHROPIC_API_KEY manquant dans les variables Railway'));
    }
    const body = JSON.stringify({
      // FIX: model string corrigé
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });
    const req = require('https').request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) {
            reject(new Error(`Claude API ${resp.statusCode}: ${parsed.error?.message || data.slice(0,200)}`));
          } else {
            resolve(parsed.content?.[0]?.text || '');
          }
        } catch(e) { reject(new Error(`Parse error: ${data.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timeout Claude API (90s)')); });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
//  ROUTE POST /api/agent
// ══════════════════════════════════════════════════════════════
app.post('/api/agent', async (req, res) => {
  const { type, title, content, excerpt, keyword } = req.body;
  const systemPrompt = AGENT_PROMPTS[type];
  if (!systemPrompt) {
    return res.status(400).json({ error: `Agent inconnu: "${type}". Agents disponibles: ${Object.keys(AGENT_PROMPTS).join(', ')}` });
  }
  const userMessage = `## Contenu à analyser — VU Magazine

**Titre :** ${title || 'Non renseigné'}
**Mot-clé principal :** ${keyword || '(à déduire du titre et du contenu)'}
**Extrait / Résumé :** ${excerpt || 'Non renseigné'}

**Contenu de l'article :**
${content ? content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000) : '(contenu vide — rédige tes recommandations basées sur le titre)'}

---
Lance l'analyse complète selon tes instructions.`;

  try {
    const result = await callClaude(systemPrompt, userMessage);
    res.json({ result, agent: type, timestamp: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message, agent: type });
  }
});

// ══════════════════════════════════════════════════════════════
//  ROUTE GET /api/agents
// ══════════════════════════════════════════════════════════════
app.get('/api/agents', (req, res) => {
  const agents = {
    edito: [
      { id: 'alignment',     name: '⚠️ Alignement SEO',    desc: 'Vérifie l\'alignement intention mot-clé vs contenu' },
      { id: 'serp_psychology', name: '📓 Psychologie SERP', desc: 'Analyse comportementale approfondie de la SERP' },
      { id: 'assistant_geo', name: '🦾 Assistant G/SEO',   desc: 'Optimisation SEO + GEO (ChatGPT & Google)' },
    ],
    structure: [
      { id: 'content_gap',       name: '🪏 Content Gap',       desc: 'Détecte les concepts et données manquants' },
      { id: 'cocon',             name: '📑 Cocon sémantique',   desc: 'Génère un cocon sémantique complet' },
      { id: 'eeat',              name: '🧑‍🔬 E-E-A-T',           desc: 'Évalue et améliore les signaux E-E-A-T' },
      { id: 'links',             name: '🔗 Maillage interne',   desc: 'Optimise le maillage interne (cocon)' },
      { id: 'maillage_entrants', name: '🔗 Liens entrants',     desc: 'Identifie les opportunités de liens entrants' },
      { id: 'schema_org',        name: '⚙️ Schema.org',         desc: 'Génère le JSON-LD optimisé pour Rich Snippets' },
      { id: 'architecture_hn',   name: '🕸️ Architecture Hn',    desc: 'Audite la structure des titres H1-H6' },
    ],
    geo: [
      { id: 'qat',           name: '🫆 Audit QAT',       desc: 'Quality, Accuracy, Transparency pour les IA' },
      { id: 'chatgpt_expert', name: '🦾 Expert ChatGPT', desc: 'Optimisation pour les citations IA' },
      { id: 'fan_out',       name: '⁉️ Query Fan-out',   desc: 'Couvre toutes les intentions de recherche' },
    ],
    divers: [
      { id: 'actualites', name: '📰 Expert Actualités', desc: 'Met à jour le contenu avec les dernières infos' },
      { id: 'correcteur', name: '✍️ Correcteur',        desc: 'Corrige la grammaire et améliore le style' },
    ]
  };
  res.json({
    agents,
    total: Object.values(agents).flat().length,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY
  });
});

// ══════════════════════════════════════════════════════════════
//  IMPORT WEBFLOW
// ══════════════════════════════════════════════════════════════
app.post('/api/import-webflow', async (req, res) => {
  try {
    const { since, token } = req.body;
    // FIX: token uniquement depuis env — jamais hardcodé
    const WF_TOKEN = token || process.env.WEBFLOW_API_TOKEN;
    if (!WF_TOKEN) {
      return res.status(400).json({ error: 'WEBFLOW_API_TOKEN manquant. Configurez la variable Railway ou passez token dans le body.' });
    }
    const WF_COLLECTION = '64a4135c766c293d6f43a174';
    const WF_CATS = '64a4135c766c293d6f43a171';
    const cutoff = since ? new Date(since) : new Date('2026-03-23T23:59:59Z');

    const catsRes = await fetch(`https://api.webflow.com/v2/collections/${WF_CATS}/items?limit=100`, {
      headers: { 'Authorization': `Bearer ${WF_TOKEN}`, 'accept': 'application/json' }
    });
    const catsData = await catsRes.json();
    const catMap = {};
    for (const c of (catsData.items || [])) {
      catMap[c.id] = c.fieldData?.name || c.fieldData?.slug || 'Autre';
    }

    let allItems = [], offset = 0;
    let safetyLimit = 0;
    while (safetyLimit < 20) { // FIX: limite de sécurité sur la pagination
      const r = await fetch(`https://api.webflow.com/v2/collections/${WF_COLLECTION}/items?limit=100&offset=${offset}&sortBy=lastUpdated&sortOrder=desc`, {
        headers: { 'Authorization': `Bearer ${WF_TOKEN}`, 'accept': 'application/json' }
      });
      const d = await r.json();
      const items = d.items || [];
      allItems = allItems.concat(items);
      if (items.length < 100) break;
      offset += 100;
      safetyLimit++;
    }

    const newItems = allItems.filter(i => new Date(i.lastUpdated) > cutoff);
    const imported = [], skipped = [], errors = [];

    for (const item of newItems) {
      const f = item.fieldData || {};
      const slug = f.slug || f.name?.toLowerCase().replace(/[^a-z0-9]+/g,'-');

      const exists = await pool.query('SELECT id FROM articles WHERE slug=$1', [slug]);
      if (exists.rows.length > 0) { skipped.push(slug); continue; }

      const wfCatId = Array.isArray(f.categories) ? f.categories[0] : f.category;
      const catName = catMap[wfCatId] || 'Autre';
      const catRow = await pool.query("SELECT id FROM categories WHERE name ILIKE $1 LIMIT 1", [catName]);
      const catId = catRow.rows[0]?.id || null;

      const authorRow = await pool.query("SELECT id FROM authors WHERE name ILIKE $1 LIMIT 1", ['Stéphanie Jouin']);
      const authorId = authorRow.rows[0]?.id || null;

      const imgUrl = f['cover-image']?.url || f['main-image']?.url || f['image']?.url || f['thumbnail']?.url || null;
      const content = f['content'] || f['post-body'] || f['body'] || f['article-body'] || '';
      const excerpt = f['excerpt'] || f['summary'] || content.replace(/<[^>]+>/g,'').substring(0,200);

      try {
        await pool.query(`
          INSERT INTO articles (slug, title, excerpt, content, cover_image_url,
            category_id, author_id, status, published_at, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8,NOW())
        `, [
          slug, f.name || f.title || slug, excerpt, content, imgUrl, catId, authorId,
          new Date(f['publish-date'] || item.lastUpdated)
        ]);
        imported.push(slug);
      } catch(e) {
        errors.push({slug, error: e.message});
      }
    }

    res.json({
      total_webflow: allItems.length,
      new_after_cutoff: newItems.length,
      imported: imported.length,
      skipped: skipped.length,
      errors: errors.length,
      imported_slugs: imported,
      error_details: errors
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEBFLOW CATEGORIES DEBUG ──────────────────────────────────
app.get('/api/webflow-categories', async (req, res) => {
  // FIX: token depuis env uniquement
  const WF_TOKEN = process.env.WEBFLOW_API_TOKEN;
  if (!WF_TOKEN) return res.status(400).json({ error: 'WEBFLOW_API_TOKEN manquant' });
  try {
    const r = await fetch('https://api.webflow.com/v2/collections/64a4135c766c293d6f43a171/items?limit=100', {
      headers: { 'Authorization': `Bearer ${WF_TOKEN}`, 'accept': 'application/json' }
    });
    const d = await r.json();
    res.json(d.items?.map(c => ({ id: c.id, name: c.fieldData?.name, slug: c.fieldData?.slug })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIX DB ────────────────────────────────────────────────────
// FIX: protégé par X-Admin-Secret header
app.post('/api/fix-db', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || secret !== expected) {
    return res.status(403).json({ error: 'Accès refusé. Header X-Admin-Secret requis.' });
  }

  const results = { categories: [], dates_updated: 0, interviews_reassigned: 0, errors: [] };
  const WF_TOKEN = process.env.WEBFLOW_API_TOKEN;
  if (!WF_TOKEN) return res.status(400).json({ error: 'WEBFLOW_API_TOKEN manquant' });

  const WF_ARTICLES = '64a4135c766c293d6f43a174';
  const WF_CAT_INTERVIEWS = '680522286054fd4e161e10be';

  try {
    await pool.query("UPDATE categories SET name='Voir tout', slug='voir-tout' WHERE name='Interviews' AND slug='interviews'");
    results.categories.push('Renamed Interviews → Voir tout');

    const existInt = await pool.query("SELECT id FROM categories WHERE slug='interviews'");
    let interviewsCatId;
    if (existInt.rows.length === 0) {
      const ins = await pool.query("INSERT INTO categories (name, slug, color, sort_order) VALUES ('Interviews', 'interviews', '#C8303C', 11) RETURNING id");
      interviewsCatId = ins.rows[0].id;
      results.categories.push('Created Interviews category: ' + interviewsCatId);
    } else {
      interviewsCatId = existInt.rows[0].id;
    }

    const missingCats = [
      {name:'Impact', slug:'impact', color:'#2D6A4F'},
      {name:'Intelligence artificielle', slug:'intelligence-artificielle', color:'#6B46C1'},
      {name:'Publicité', slug:'publicite', color:'#D97706'},
      {name:'Prospection', slug:'prospection', color:'#0369A1'},
      {name:'Marketing', slug:'marketing', color:'#DC2626'}
    ];
    for (const c of missingCats) {
      const exists = await pool.query('SELECT id FROM categories WHERE slug=$1', [c.slug]);
      if (exists.rows.length === 0) {
        await pool.query('INSERT INTO categories (name, slug, color) VALUES ($1,$2,$3)', [c.name, c.slug, c.color]);
        results.categories.push('Added: ' + c.name);
      }
    }

    let allWfItems = [];
    let offset = 0, safetyLimit = 0;
    while (safetyLimit < 20) {
      const r = await fetch(`https://api.webflow.com/v2/collections/${WF_ARTICLES}/items?limit=100&offset=${offset}`, {
        headers: { 'Authorization': `Bearer ${WF_TOKEN}`, 'accept': 'application/json' }
      });
      const d = await r.json();
      allWfItems = allWfItems.concat(d.items || []);
      if ((d.items || []).length < 100) break;
      offset += 100;
      safetyLimit++;
    }

    for (const item of allWfItems) {
      const slug = item.fieldData?.slug;
      if (!slug) continue;
      const pubDate = item.fieldData?.['publish-date'] || item.fieldData?.['published-on'] || item.fieldData?.['date'] || item.lastUpdated;
      const cats = item.fieldData?.categories || [];
      const isInterview = Array.isArray(cats) ? cats.includes(WF_CAT_INTERVIEWS) : cats === WF_CAT_INTERVIEWS;
      try {
        if (isInterview) {
          await pool.query(
            "UPDATE articles SET published_at=$1, category_id=$2 WHERE slug=$3 OR slug LIKE $4",
            [new Date(pubDate), interviewsCatId, slug, slug.substring(0,40) + '%']
          );
          results.interviews_reassigned++;
        } else {
          await pool.query(
            "UPDATE articles SET published_at=$1 WHERE slug=$2 OR slug LIKE $3",
            [new Date(pubDate), slug, slug.substring(0,40) + '%']
          );
        }
        results.dates_updated++;
      } catch(e) {
        results.errors.push({slug, error: e.message.substring(0,50)});
      }
    }

    res.json({ success: true, wf_total: allWfItems.length, ...results });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, partial: results });
  }
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✦ VU Rédaction v2.1 — port ${PORT}`);
    console.log(`  Anthropic  : ${process.env.ANTHROPIC_API_KEY ? '✅ configuré' : '❌ ANTHROPIC_API_KEY manquant'}`);
    console.log(`  NewsAPI    : ${process.env.NEWS_API_KEY ? '✅ configuré' : '⚠️  démo (NEWS_API_KEY manquant)'}`);
    console.log(`  Apify      : ${process.env.APIFY_TOKEN ? '✅ configuré' : '⚠️  démo (APIFY_TOKEN manquant)'}`);
    console.log(`  Webflow    : ${process.env.WEBFLOW_API_TOKEN ? '✅ configuré' : '⚠️  WEBFLOW_API_TOKEN manquant'}`);
    console.log(`  Admin      : ${process.env.ADMIN_SECRET ? '✅ configuré' : '⚠️  ADMIN_SECRET manquant (fix-db désactivé)'}`);
  });
});
