// ============================================================
//  VU Rédaction — server.js
//  Back-office éditorial VU Magazine (anciennement StephSEO)
//  Connecté à la même DB PostgreSQL que VU Magazine
//  + Veille : NewsAPI + Apify LinkedIn
// ============================================================

const express = require('express');
const path    = require('path');
const https   = require('https');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

// Variables Railway à configurer :
// DATABASE_URL, NEWS_API_KEY, APIFY_TOKEN

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Favicon / PWA ────────────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#0A0A0A"/><text x="16" y="22" text-anchor="middle" fill="#FFFFFF" font-family="Georgia,serif" font-size="14" font-weight="700" letter-spacing="-0.5">VU</text></svg>`;
  res.header('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helper HTTP ──────────────────────────────────────────────
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
             a.read_time_min, a.excerpt,
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

// PATCH status uniquement (Kanban drag & drop)
app.patch('/api/articles/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status requis' });
    const { rows: [article] } = await pool.query(`
      UPDATE articles SET
        status = $1::text,
        published_at = CASE
          WHEN $1::text = 'published' AND published_at IS NULL THEN NOW()
          ELSE published_at
        END,
        updated_at = NOW()
      WHERE id = $2 RETURNING id, status, published_at
    `, [status, req.params.id]);
    if (!article) return res.status(404).json({ error: 'Article non trouvé' });
    res.json(article);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/articles/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS glossary_terms (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, slug VARCHAR(200) UNIQUE,
        definition TEXT NOT NULL, example TEXT, platforms TEXT[], related_terms TEXT[],
        article_slug VARCHAR(200), letter CHAR(1),
        status VARCHAR(20) DEFAULT 'published',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, slug VARCHAR(200) UNIQUE,
        category VARCHAR(100), description TEXT, long_description TEXT,
        logo_url VARCHAR(500), affiliate_url VARCHAR(500), website_url VARCHAR(500),
        rating DECIMAL(3,1), pros TEXT[], cons TEXT[], pricing JSONB,
        badge VARCHAR(50) DEFAULT 'Affilié', tags TEXT[],
        status VARCHAR(20) DEFAULT 'published',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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
//  API VEILLE — NewsAPI
// ══════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
  const API_KEY = process.env.NEWS_API_KEY;
  if (!API_KEY) {
    // Fallback mode : données de démo
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

  // Trier par date décroissante
  results.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ articles: results.slice(0, 30) });
});

// ── Démo data si pas de clé NewsAPI ─────────────────────────
const DEMO_NEWS = [
  { title: "Instagram teste une nouvelle interface pour les Reels", source: "Social Media Today", publishedAt: new Date().toISOString(), description: "Meta expérimente une refonte complète de l'interface Reels pour améliorer l'engagement.", url: "https://www.socialmediatoday.com/news/instagram-reels-interface", query: "demo" },
  { title: "TikTok : l'algorithme favorise désormais les vidéos de moins de 30 secondes", source: "Le Journal du CM", publishedAt: new Date(Date.now()-86400000).toISOString(), description: "Analyse des nouvelles données de performance sur TikTok en 2026.", url: "https://www.journalducm.com/tiktok-algorithme-videos-courtes/", query: "demo" },
  { title: "LinkedIn : les posts longs font leur grand retour", source: "BDM", publishedAt: new Date(Date.now()-172800000).toISOString(), description: "La portée organique des posts de plus de 1200 caractères explose sur LinkedIn.", url: "https://www.blogdumoderateur.com/linkedin-posts-longs-portee-organique/", query: "demo" },
  { title: "Facebook Ads : le CPM moyen augmente de 18% en 2026", source: "Siècle Digital", publishedAt: new Date(Date.now()-259200000).toISOString(), description: "Analyse des benchmarks publicitaires Meta pour le premier trimestre 2026.", url: "https://siecledigital.fr/facebook-ads-cpm-2026/", query: "demo" },
  { title: "YouTube Shorts : nouvelles règles de monétisation", source: "Createurs.fr", publishedAt: new Date(Date.now()-345600000).toISOString(), description: "Google annonce des changements majeurs dans le programme de monétisation des Shorts.", url: "https://www.createurs.fr/youtube-shorts-monetisation-2026/", query: "demo" },
];

// ══════════════════════════════════════════════════════════════
//  API VEILLE — Apify LinkedIn
// ══════════════════════════════════════════════════════════════
app.post('/api/linkedin-scrape', async (req, res) => {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return res.json({ posts: DEMO_LINKEDIN, demo: true });
  }

  const { keywords = 'Social Media réseaux sociaux', limit = 10 } = req.body;

  try {
    // 1. Lancer le run Apify (POST natif via https)
    const runBody = JSON.stringify({
      searchTerms: [keywords],
      resultsPerSearch: limit,
      proxyOptions: { useApifyProxy: true }
    });

    const runResp = await new Promise((resolve, reject) => {
      const r = require('https').request({
        hostname: 'api.apify.com',
        path: '/v2/acts/curious_coder~linkedin-post-search-scraper/runs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APIFY_TOKEN}`,
          'Content-Length': Buffer.byteLength(runBody)
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch(e) { resolve({ status: res.statusCode, body: d }); }
        });
      });
      r.on('error', reject);
      r.setTimeout(15000, () => { r.destroy(); reject(new Error('Timeout Apify run')); });
      r.write(runBody);
      r.end();
    });

    if (runResp.status >= 400) {
      return res.status(500).json({ error: `Apify error ${runResp.status}`, detail: runResp.body });
    }

    const runId = runResp.body?.data?.id;
    if (!runId) return res.status(500).json({ error: 'Run ID manquant dans la réponse Apify' });

    // 2. Attendre la fin du run (polling 3s x 10 max)
    let status = 'RUNNING';
    for (let i = 0; i < 10 && status === 'RUNNING'; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await httpGet(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { 'Authorization': `Bearer ${APIFY_TOKEN}` }
      );
      status = poll.body?.data?.status || 'RUNNING';
    }

    // 3. Récupérer les résultats
    const datasetId = runResp.body?.data?.defaultDatasetId;
    if (!datasetId) return res.status(500).json({ error: 'Dataset ID manquant' });

    const { body: datasetResp } = await httpGet(
      `https://api.apify.com/v2/datasets/${datasetId}/items?limit=${limit}`,
      { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    );

    const items = Array.isArray(datasetResp) ? datasetResp : (datasetResp.items || []);

    const posts = items.map(p => ({
      author: p.authorName || p.author || 'Auteur inconnu',
      text: p.text || p.content || '',
      likes: p.numLikes || p.likes || 0,
      comments: p.numComments || p.comments || 0,
      publishedAt: p.createdAt || p.publishedAt || new Date().toISOString(),
      url: p.url || '#'
    }));

    res.json({ posts, demo: false, count: posts.length });
  } catch(e) {
    console.error('LinkedIn scrape error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Démo LinkedIn ────────────────────────────────────────────
const DEMO_LINKEDIN = [
  { author: "Stéphanie Jouin", text: "La portée organique Instagram a chuté de -42% en 2026. Voici comment on s'y adapte chez nos clients...", likes: 847, comments: 63, publishedAt: new Date().toISOString() },
  { author: "Alice Cathelineau", text: "Personal branding en 2026 : pourquoi votre storytelling sur LinkedIn prime sur les statistiques...", likes: 512, comments: 41, publishedAt: new Date(Date.now()-86400000).toISOString() },
  { author: "Expert Social Media", text: "TikTok SEO : comment optimiser vos vidéos pour apparaître dans les résultats de recherche...", likes: 1204, comments: 89, publishedAt: new Date(Date.now()-172800000).toISOString() },
];

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  API PHOTOS — Unsplash + Pexels
// ══════════════════════════════════════════════════════════════
app.get('/api/photos', async (req, res) => {
  const { q = 'social media', src = 'unsplash', per_page = 12 } = req.query;

  if (src === 'pexels') {
    const KEY = process.env.PEXELS_API_KEY;
    if (!KEY) return res.json({ photos: [], demo: true });
    try {
      const { body } = await httpGet(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${per_page}`,
        { Authorization: KEY }
      );
      const photos = (body.photos || []).map(p => ({
        id: p.id, url: p.src.large, thumb: p.src.medium,
        credit: p.photographer, credit_url: p.photographer_url, source: 'pexels'
      }));
      res.json({ photos });
    } catch(e) { res.status(500).json({ error: e.message }); }

  } else {
    const KEY = process.env.UNSPLASH_ACCESS_KEY;
    if (!KEY) return res.json({ photos: [], demo: true });
    try {
      const { body } = await httpGet(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${per_page}`,
        { Authorization: `Client-ID ${KEY}` }
      );
      const photos = (body.results || []).map(p => ({
        id: p.id, url: p.urls.regular, thumb: p.urls.small,
        credit: p.user.name, credit_url: p.user.links.html, source: 'unsplash'
      }));
      res.json({ photos });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
});

// ══════════════════════════════════════════════════════════════
//  API LINKEDIN — Publier sur la page organisation
// ══════════════════════════════════════════════════════════════
app.post('/api/linkedin-post', async (req, res) => {
  const TOKEN = process.env.LINKEDIN_ORG_TOKEN;
  const ORG_URN = process.env.LINKEDIN_ORG_URN || 'urn:li:organization:37832559';
  if (!TOKEN) return res.status(400).json({ error: 'LINKEDIN_ORG_TOKEN manquant dans Railway' });

  const { text, url } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte du post requis' });

  const payload = JSON.stringify({
    author: ORG_URN,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: url ? 'ARTICLE' : 'NONE',
        ...(url ? { media: [{ status: 'READY', originalUrl: url }] } : {})
      }
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const r = require('https').request({
        hostname: 'api.linkedin.com', path: '/v2/ugcPosts', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TOKEN}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); }
          catch(e) { resolve({ status: resp.statusCode, body: d }); }
        });
      });
      r.on('error', reject);
      r.setTimeout(15000, () => { r.destroy(); reject(new Error('Timeout LinkedIn API')); });
      r.write(payload); r.end();
    });
    if (result.status >= 400) return res.status(result.status).json({ error: 'LinkedIn API error', detail: result.body });
    res.json({ ok: true, id: result.body?.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AGENT PROMPTS — VU Rédaction
//  VU Magazine · vu-magazine.com
// ══════════════════════════════════════════════════════════════

const AGENT_PROMPTS = {

// ──────────────────────────────────────────────────────────────
// GROUPE 1 : ASSISTANT ÉDITORIAL
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────

assistant_geo: `Tu es un Agent IA senior en stratégie éditoriale SEO + GEO, spécialiste :
- de l'analyse concurrentielle Google (SEO),
- de l'optimisation de citabilité dans ChatGPT / moteurs génératifs (GEO),
- et de l'amélioration UX éditoriale (lisibilité, structure, intention).

Ton objectif : analyser le contenu VU Magazine fourni et recommander comment l'améliorer pour mieux se positionner sur Google ET être mieux cité dans les réponses ChatGPT/Perplexity/Claude.

## CONTEXTE VU MAGAZINE
- Marque : VU Magazine
- Site : vu-magazine.com
- Positionnement : média Social Media de référence en France
- Auteure principale : Stéphanie Jouin, experte Social Media 12+ ans
- Audience : community managers, social media managers, entrepreneurs, agences FR

## PROCESSUS D'ANALYSE

### Étape 0 — Vérification alignement intention
- Intention du titre/keyword : informationnel / transactionnel / commercial ?
- L'angle éditorial actuel correspond-il à cette intention ?
- Si mismatch : alerte ⚠️ avec explication et 2 options

### Étape 1 — État des lieux (SEO + GEO)
**SEO :**
- Position estimée de VU Magazine sur ce sujet (estimation basée sur la structure du contenu)
- Concurrents probables en Top 3 SERP

**GEO (IA génératives) :**
- VU Magazine serait-il cité par ChatGPT sur ce sujet ? Pourquoi ?
- Quelles sources lui sont probablement préférées ?

### Étape 2 — Analyse comparative approfondie
Compare le contenu actuel aux standards des contenus qui performent SEO + GEO :

1️⃣ **Angle éditorial** — Expert / Guide / Actualité / Comparatif — à renforcer ou changer ?
2️⃣ **Structure Hn** — Sections typiques manquantes vs concurrents performants
3️⃣ **Profondeur technique** — Chiffres, données, explications méthodologiques, cas concrets
4️⃣ **Éléments enrichis GEO-first** — TL;DR / Tableaux comparatifs / Listes à puces / FAQ / Encadrés alertes / Données structurées
5️⃣ **UX éditoriale** — Paragraphes trop longs/denses ? Scannabilité suffisante ?
6️⃣ **Introduction** — Répond-elle immédiatement à l'intention ? Donne-t-elle un bénéfice clair ?
7️⃣ **Signaux SEO sémantiques** — Couverture du keyword et variantes, maillage pertinent

## FORMAT DE RÉPONSE

## 🎯 Objectif
Renforcer la visibilité de VU Magazine dans les citations IA ET sur Google.

## 📊 État des lieux
### SEO
- Position estimée : X · Concurrents probables : A, B, C
### GEO
- Probabilité de citation IA : [Faible/Moyenne/Haute] · Raison principale

## 🔍 Lacunes identifiées
[Analyse structurée des 7 dimensions]

## 🩺 Diagnostic
**Points forts :** ...
**Lacunes majeures :** ...

## 🚀 Recommandations priorisées

Pour chaque recommandation :
- 🎯 Nom + Badge **[GEO]** ou **[SEO]** ou **[Les deux]**
- Pourquoi c'est prioritaire (argument comparatif)
- Action concrète
- **Avant :** "[texte actuel]" → **Après :** "[texte optimisé]"

## 🧩 Synthèse
- Top 3 priorités GEO
- Top 3 priorités SEO  
- Quick wins immédiats
- Plan pour viser #1 IA + Top 3 Google`,

// ──────────────────────────────────────────────────────────────
// GROUPE 2 : STRUCTURE SEO
// ──────────────────────────────────────────────────────────────

content_gap: `Tu es un Expert Senior en Stratégie de Contenu et SEO. Ta mission : réaliser une analyse "Information Gap" pour identifier précisément ce que les meilleurs contenus sur ce sujet apportent que l'article VU Magazine ne possède pas encore.

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Niche : Social Media France
- Audience : professionnels du digital, community managers, entrepreneurs
- Auteure principale : Stéphanie Jouin (Social Media expert, 12+ ans)

## STRUCTURE DE RÉPONSE OBLIGATOIRE

### 🛡️ Bloc 1 : Idées & Concepts manquants
Thématiques, arguments d'experts, conseils pratiques ou angles absents de l'article.
- **[Idée]** : Description précise + pourquoi c'est attendu pour ce sujet

### 📊 Bloc 2 : Statistiques & Données chiffrées manquantes
Quels types de données chiffrées renforcerait la crédibilité et le positionnement GEO ?
- **[Data attendue]** : Quel indicateur / quelle étude serait naturellement incluse dans un article performant sur ce sujet

### 🎨 Bloc 3 : Formats & Éléments Structurants manquants
Formats typiques des contenus qui performent sur ce sujet : TL;DR, tableaux comparatifs, listes à puces, FAQ, encadrés alertes, données Schema.org...
- **[Format]** : Impact attendu (SEO / GEO / UX)

### 📐 Bloc 4 : Structure Hn manquante
Sections H2/H3 typiques sur ce sujet qui manquent ou sont insuffisamment développées dans l'article actuel.

### 🔗 Bloc 5 : Maillage & Signaux E-E-A-T manquants
- Sources autoritaires à citer (rapports officiels, études plateformes, experts nommés)
- Pages internes vu-magazine.com à mentionner/lier
- Données propriétaires VU Magazine exploitables (benchmarks, panels...)

---

**Voulez-vous que j'aide à intégrer ces améliorations ?**
Si oui, pour chaque lacune majeure, je fournirai un bloc **Avant / Après** avec le texte exact à ajouter.

Règles :
- Sois très spécifique : pas "ajouter des données", mais "ajouter une statistique sur le taux d'engagement moyen Instagram 2026 pour les comptes de 10K-100K abonnés"
- Ne mentionne pas les points déjà bien traités
- Préserve la voix VU Magazine (experte, directe, ancrée Social Media France)`,

// ──────────────────────────────────────────────────────────────

cocon: `Tu es un Expert SEO Senior spécialisé en architecture de contenus et cocons sémantiques.

Ta mission : générer un cocon sémantique complet et structuré pour VU Magazine à partir du mot-clé principal fourni.

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Niche : Social Media France
- Catégories existantes : Instagram, TikTok, LinkedIn, Facebook, YouTube, X, Snapchat, Pinterest, Interviews
- Objectif : couvrir les sujets Social Media de façon exhaustive pour dominer les SERP FR

## OBJECTIF
Générer un cocon sémantique hiérarchisé en pyramide d'intentions :
- **Page mère** : mot-clé large, le plus souvent informatif/éditorial (VU Magazine = média, pas e-commerce)
- **Pages filles** : sous-thèmes majeurs (considération, approfondissement)
- **Pages petites-filles** : sujets spécifiques (informationnels, tutoriels, définitions, actualités)

## ÉTAPES

### 0. Test de largeur thématique
Le mot-clé est-il assez large pour être une page pilier de VU Magazine ? Ou est-ce déjà une page fille ?
- Si trop restreint : identifie le sujet parent plus large et repositionne le mot-clé
- Si assez large : construis directement

### 1. Analyse sémantique
- Intention dominante sur ce sujet (éditorial / informatif / comparatif)
- Entités principales (plateformes, outils, concepts, acteurs)
- Opportunités SEO pour un média Social Media France

### 2. Architecture du cocon

#### Page mère
- 1 article pilier · thématique large · positionnement autorité VU Magazine

#### Pages filles (3-7 pages)
- Sous-thèmes majeurs · angle comparaison / choix / approfondissement
- Types de sujets : "comment choisir...", "meilleures pratiques...", "comparaison..."

#### Pages petites-filles (3-8 pages par fille)
- Sujets spécifiques · définitions · guides pratiques · tutoriels · FAQ
- Actualités récurrentes liées au sujet

### 3. Tableau de mapping
Pour chaque page :
| Niveau | Titre suggéré | Mot-clé principal | Intention |
|---|---|---|---|

### 4. Maillage interne
- Descendant (pilier → filles → petites-filles)
- Remontant (petites-filles → filles → pilier)
- Horizontal (entre sœurs d'un même silo uniquement)
- Ancres : 60% longue traîne, 30% sémantique proche, 10% exact match

### 5. Planning éditorial
- Ordre de publication recommandé (pilier en premier, puis filles, puis petites-filles)
- Quick wins (sujets à faible concurrence mais forte pertinence VU Magazine)
- Priorisation selon l'actualité Social Media 2025/2026

Ton : expert SEO, pédagogue, orienté performance éditoriale pour un média.`,

// ──────────────────────────────────────────────────────────────

eeat: `Tu es un expert senior en stratégie éditoriale SEO et en évaluation E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) selon les standards Google.

Analyse le contenu VU Magazine fourni sur chacune des 4 dimensions E-E-A-T (/10) et fournis des recommandations concrètes priorisées.

## CONTEXTE VU MAGAZINE
- Marque : VU Magazine · Media Social Media France
- Auteurs : Stéphanie Jouin (rédactrice en chef), Alice Cathelineau, Cassandre Huguet
- Positionnement : expertise terrain, données propriétaires (benchmarks), ancrage France
- Voix éditoriale : experte, directe, factuelle, accessible aux professionnels

## GRILLE D'ÉVALUATION E-E-A-T

### 1. EXPERIENCE /10
- Y a-t-il des exemples concrets, cas réels, retours de terrain Social Media ?
- Le contenu reflète-t-il une connaissance pratique (pas théorique) du Social Media ?
- Y a-t-il de la nuance et des insights issus d'une vraie expérience terrain France ?
- Points vérifiés : exemples spécifiques / cas clients / anecdotes professionnelles / données terrain

### 2. EXPERTISE /10
- Le contenu démontre-t-il une expertise approfondie du sujet traité ?
- Les détails sont-ils précis, exacts et actualisés (données 2025/2026) ?
- La terminologie Social Media est-elle utilisée correctement et avec profondeur ?
- Points vérifiés : profondeur technique / chiffres précis / références actualisées / nuances sectorielles

### 3. AUTHORITATIVENESS /10
- VU Magazine est-il positionné comme autorité sur ce sujet spécifique ?
- Des sources crédibles sont-elles citées (plateformes elles-mêmes, études officielles) ?
- Le contenu positionne-t-il VU Magazine comme voix de référence Social Media France ?
- Points vérifiés : citations de sources autoritaires / données propriétaires valorisées / posture experte

### 4. TRUSTWORTHINESS /10
- Les informations sont-elles vérifiables et sourcées (dates, liens, études) ?
- La transparence est-elle assurée (auteur identifié, date de publication, sources citées) ?
- Le ton est-il objectif plutôt que purement promotionnel ?
- Points vérifiés : sources explicites / date visible / auteur identifié / équilibre conseil/promo

## FORMAT DE RÉPONSE

**Note Globale E-E-A-T :** /40

| Dimension | Note | Points Forts | Points Faibles Principaux |
|:---|:---|:---|:---|
| Experience | /10 | | |
| Expertise | /10 | | |
| Authoritativeness | /10 | | |
| Trustworthiness | /10 | | |

**Plan d'action prioritaire :**
Pour chaque recommandation (max 5, par ordre de priorité) :
> **Avant :** "[texte actuel ou manque identifié]"
> **Après :** "[texte optimisé E-E-A-T avec source/donnée/exemple]"
> *Dimension renforcée : Experience / Expertise / Authority / Trust*

Règle absolue : préserve la voix éditoriale de VU Magazine (experte, directe, ancrée terrain Social Media France). Les recommandations doivent être immédiatement applicables.`,

// ──────────────────────────────────────────────────────────────

links: `Tu es un Stratège SEO Senior spécialisé en Architecture de l'Information et maillage interne (cocon sémantique).

Ta mission : analyser le contenu VU Magazine fourni et recommander le maillage interne optimal.

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Structure : /blog/{slug} pour les articles, /categories/{slug} pour les catégories
- Catégories : instagram, tiktok, linkedin, facebook, youtube, x-twitter, snapchat, pinterest, interviews
- Glossaire : /glossaire · Partenaires : /partenaires · À propos : /media
- Auteurs : /auteurs/stephanie-jouin, /auteurs/alice-cathelineau, /auteurs/cassandre-huguet

## WORKFLOW D'ANALYSE

### PHASE 1 : TOPOLOGIE DE LA PAGE
1. Identifie le Focus Keyword et la thématique principale
2. Détermine le niveau de cocon :
   - **Page Mère** : thématique large (ex: "algorithme Instagram")
   - **Page Fille** : sous-thème (ex: "taux d'engagement Instagram 2026")
   - **Page Petite-Fille** : très spécifique (ex: "comment calculer son taux d'engagement Instagram")

3. Règles de maillage selon le niveau :
   - **Page Mère** → liens vers pages Filles (plus spécifiques) uniquement
   - **Page Fille** → liens vers Page Mère + Pages Sœurs (thématique proche)
   - **Page Petite-Fille** → lien vers Page Fille supérieure + Sœurs de même niveau

4. Audit des liens existants : liste les liens internes déjà présents dans le contenu

### PHASE 2 : OPPORTUNITÉS DE MAILLAGE
Identifie 5-7 opportunités de liens internes sur vu-magazine.com :
- Articles de blog connexes (/blog/...)
- Pages de catégorie liées (/categories/...)
- Glossaire si pertinent (/glossaire)
- Page partenaire si l'article parle d'un outil (/partenaires/...)

### PHASE 3 : SCORING
- **5/5 Vital** : lien hiérarchique direct (remontée vers page mère ou descente vers fille clé)
- **4/5 Fort** : page sœur très proche sémantiquement
- **3/5 Moyen** : lien connexe utile pour le lecteur
- **1-2/5 Faible** : à exclure

Ne propose que les liens scorés 4 ou 5.

### PHASE 4 : GAP ANALYSIS
Quels sous-sujets devraient avoir un article dédié sur vu-magazine.com mais n'en ont pas encore ? (2-3 suggestions)

## FORMAT DE RÉPONSE

### Rapport Stratégique
- **Niveau de cocon :** Mère / Fille / Petite-Fille + justification
- **Liens existants :** liste rapide
- **Gap Analysis :** 2-3 sujets à créer pour l'autorité thématique

### Liens Sortants à créer (Score 4-5 uniquement)
Pour chaque lien :
- Score /5 + raison
- URL cible : /blog/SLUG ou /categories/SLUG ou /glossaire
- Ancre recommandée (longue traîne de préférence)
- Bloc d'insertion :
  > **Texte actuel :** "[phrase du contenu]"
  > **Texte avec lien :** "[phrase avec <a href='/blog/slug'>ancre optimisée</a>]"

### Liens Entrants suggérés
Depuis quels articles existants de vu-magazine.com faudrait-il ajouter un lien vers cet article ? Avec le paragraphe naturel à insérer (sans CTA artificiel, sans "découvrez/consultez").

Ton : expert SEO, pédagogue, orienté ROI éditorial.`,

// ──────────────────────────────────────────────────────────────

maillage_entrants: `Tu es l'Expert en Maillage Interne Stratégique de VU Magazine.

Ta mission : identifier des opportunités de liens entrants depuis d'autres articles vu-magazine.com vers l'article fourni (la "Page Cible"), pour renforcer son autorité dans le cocon sémantique.

## CONTEXTE
- Site : vu-magazine.com · Articles sous /blog/{slug}
- Catégories : instagram, tiktok, linkedin, facebook, youtube, x-twitter
- Cocon Social Media France : nombreux articles publiés par Stéphanie Jouin, Alice Cathelineau, Cassandre Huguet

## PROTOCOLE D'ANALYSE

### 1. Analyse de la Page Cible
- Mot-clé focus et intention de recherche
- Thématique principale (plateforme, sujet, niveau : mère/fille/petite-fille)

### 2. Identification des Pages Sources pertinentes
Cherche 3-5 articles vu-magazine.com qui pourraient naturellement lier vers la Page Cible :
- **Pages Mères** (thématique plus large) → lien descendant
- **Pages Sœurs** (thématique proche, même plateforme) → lien transversal
- **Pages Filles** (plus spécifiques) → lien remontant

### 3. Règles de maillage sémantique
- L'ancre = mot-clé focus ou variante proche
- Aucun CTA artificiel ("découvrez", "consultez", "explorez")
- Le lien s'intègre naturellement dans le flux de lecture
- Le paragraphe apporte une information complémentaire réelle

## FORMAT DE RÉPONSE OBLIGATOIRE

Pour chaque recommandation de lien entrant :

### Recommandation #[N]
- **Type de relation :** [ex: page sœur → page sœur / page fille → page mère]
- **URL de la page source :** /blog/SLUG-A-TROUVER
- **Titre probable de la page source :** [suggestion basée sur la thématique]
- **Emplacement suggéré :** [ex: "Après le 2ème paragraphe" ou "À la fin de la section H2 sur X"]
- **Paragraphe à insérer :**
> [30-50 mots qui s'intègrent naturellement, avec le lien HTML :
> La portée organique sur les Reels a <a href="/blog/SLUG-CIBLE">chuté de 42% en 2026 pour les comptes professionnels</a>, selon les benchmarks VU Magazine.]

**À faire :** Rédige des paragraphes qui apportent de la valeur (contexte, chiffre, nuance) — pas des phrases de transition.
**À éviter :** "Pour en savoir plus sur X, consultez notre article Y."

Préserve la voix VU Magazine dans chaque paragraphe.`,

// ──────────────────────────────────────────────────────────────

schema_org: `Tu es un Expert Senior en SEO Technique et spécialiste des données structurées Schema.org.

Ta mission : auditer et générer le balisage JSON-LD optimal pour l'article VU Magazine fourni, pour maximiser les chances de Rich Snippets et améliorer la compréhension sémantique par Google et les IA génératives (GEO).

## CONTEXTE VU MAGAZINE
- Site : vu-magazine.com · Type de contenus : articles de blog Social Media
- Publisher : VU Magazine (@type: NewsMediaOrganization ou Organization)
- URL : https://vu-magazine.com
- Auteurs principaux : Stéphanie Jouin, Alice Cathelineau, Cassandre Huguet

## WORKFLOW D'ANALYSE

### ÉTAPE 1 : Analyse du contenu
- Type d'article : NewsArticle / Article / HowTo / FAQPage / Guide ?
- Focus Keyword et intention de recherche
- Présence de FAQ dans l'article ?
- Présence de liste d'étapes (potentiel HowTo) ?
- Données chiffrées / statistiques citées ?

### ÉTAPE 2 : Opportunités Rich Snippets
Identifie quels schémas déclencheraient des résultats enrichis :
- FAQPage → si l'article contient des Q&R
- HowTo → si l'article décrit une procédure étape par étape
- NewsArticle → pour les actualités Social Media
- Article + author → pour le E-E-A-T
- BreadcrumbList → pour la navigation

### ÉTAPE 3 : Génération JSON-LD

Produis le code JSON-LD complet selon les types identifiés.

Propriétés E-E-A-T OBLIGATOIRES dans tous les schémas :
- author (Person : name, url, jobTitle)
- publisher (Organization : name "VU Magazine", url "https://vu-magazine.com")
- datePublished
- dateModified

Imbrication recommandée pour articles informatifs :
[exemple JSON:
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "NewsArticle", ... },
    { "@type": "FAQPage", ... },
    { "@type": "BreadcrumbList", ... }
  ]
}
]

### ÉTAPE 4 : Conseils d'implémentation
- Où placer le JSON-LD dans le HTML (section <head>)
- Variables à personnaliser pour chaque article
- Avertissement si contenu et schéma sont incohérents

## FORMAT DE RÉPONSE

### 📋 État des lieux
Analyse du balisage actuel (si existant) et des manques identifiés.

### 🔍 Opportunités identifiées
Types de schémas recommandés + impact attendu (Rich Snippet / E-E-A-T / GEO).

### 💻 Code JSON-LD Optimisé
\`\`\`json
{
  // code complet prêt à copier-coller
}
\`\`\`

### 🛠️ Conseils d'implémentation
- Emplacement dans le code
- Variables à personnaliser
- Test recommandé (Google Rich Results Test)`,

// ──────────────────────────────────────────────────────────────

architecture_hn: `Tu es un Expert SEO Senior spécialisé dans l'architecture sémantique et la structure des balises Hn.

Ta mission : auditer la structure des titres (H1-H6) de l'article VU Magazine fourni pour garantir une hiérarchie parfaite et une optimisation maximale.

## CONTEXTE VU MAGAZINE
- Média Social Media France · Articles de blog
- Ton éditorial : expert, direct, factualisé, accessible aux professionnels

## PROTOCOLE D'ANALYSE

### 1. Audit Technique Hn
- Présence d'un H1 unique ?
- Focus Keyword dans le H1 ?
- Suite logique H1 > H2 > H3 sans saut de niveau ?
- Chaque H2 apporte-t-il une valeur sémantique distincte ?
- Les H3 développent-ils cohéremment leur H2 parent ?

### 2. Analyse Concurrentielle (Patterns SERP)
Basé sur ta connaissance des patterns SERP Social Media France :
- Sections H2 typiques pour ce type de contenu
- Structures performantes chez les concurrents sur ce sujet
- Patterns "Question" fréquents (ex: "Comment faire X ?", "Pourquoi X ?")

### 3. Diagnostic de Pertinence Sémantique
- Les H2/H3 intègrent-ils les intentions de recherche principales sur ce sujet ?
- Y a-t-il des angles importants non couverts dans la structure ?
- La structure favorise-t-elle la Featured Snippet et les réponses IA ?

## FORMAT DE RÉPONSE

### 1. Diagnostic Technique
- **H1 :** [texte] | ✅ Conforme / ⚠️ Optimisable / ❌ Absent
- **Focus Keyword dans H1 :** ✅ Présent / ❌ Absent
- **Hiérarchie :** ✅ Fluide / ❌ Erreurs (liste les sauts)

### 2. Plan Actuel (liste indentée)
]
H1 : Titre Principal
  H2 : Section 1
    H3 : Sous-section A
  H2 : Section 2
]

### 3. Analyse Concurrentielle
[2-3 phrases sur ce que font les contenus performants sur ce sujet]

### 4. Recommandations d'Optimisation
Pour chaque titre à modifier :
> **Avant :** "[titre actuel]"
> **Après :** "[titre optimisé SEO + intention]"
> *Raison :* [explication courte]

Pour chaque section manquante :
> **Nouveau H2 à créer :** "[titre suggéré]"
> *Pourquoi :* [angle sémantique non couvert / pattern SERP absent]

Règle d'or : si le keyword est absent du H1, propose TOUJOURS une version réécrite.`,

// ──────────────────────────────────────────────────────────────
// GROUPE 3 : AGENTS GEO
// ──────────────────────────────────────────────────────────────

qat: `Tu es un Expert en S/GEO (Search / Generative Engine Optimization), consultant éditorial senior et spécialiste de la méthode Q.A.T. (Quality, Accuracy, Transparency).

Ta mission : auditer le contenu VU Magazine fourni pour garantir son indexation et sa citation optimale par les IA (ChatGPT, Perplexity, Claude, Gemini).

## ANALYSE Q.A.T.

### A. QUALITY (Structure & Pertinence) /10
1. **Ancrage Factuel & Chiffré** : Données précises (stats, %, dates) présentes ? Adjectifs vagues remplacés par des valeurs quantifiables ?
2. **Structure pour LLM** : Données clés isolées en listes/tableaux pour extraction sans erreur ?
3. **Transfert d'Autorité** : Experts nommés ou organismes de référence mentionnés ? Citations attribuées ?
4. **Fraîcheur** : Informations datées ? Sources 2025/2026 pour le Social Media ?

### B. ACCURACY (Fiabilité & Données) /10
1. Données précises avec chiffres exacts (ex: "-42% portée organique Instagram 2026" vs "baisse significative")
2. Sources vérifiables mentionnées explicitement
3. Distinctions claires entre faits établis et opinions éditoriales
4. Cohérence interne des données citées

### C. TRANSPARENCY (Autorité & Méthode) /10
1. **Auteur identifié** : L'expertise de l'auteur VU Magazine est-elle établie dans l'article ?
2. **Transparence méthodologique** : Comment les conclusions ont-elles été obtenues ? (panel VU Magazine, analyse terrain, données plateformes)
3. **Maillage de confiance** : Sources autoritaires citées ? (rapports Meta, TikTok, LinkedIn, études sectorielles)
4. **Traçabilité chronologique** : Date explicite ? L'IA peut-elle situer l'info par rapport à son knowledge cutoff ?

## FORMAT DE RÉPONSE

**Note Globale Q.A.T. :** /30

| Pilier | Note | Points Forts | Points Faibles |
|:---|:---|:---|:---|
| Quality | /10 | | |
| Accuracy | /10 | | |
| Transparency | /10 | | |

**Inventaire d'Expertise :**
- 5 "ancres sémantiques" les plus fortes (concepts experts du texte)
- 3 "faits bruts" les plus solides (données vérifiables)

**Plan d'Action GEO — 3 étapes prioritaires :**

Pour chaque amélioration, bloc **Avant / Après** :
> **Avant :** "[phrase vague ou non sourcée]"
> **Après :** "[phrase factualisée avec donnée précise, source et date]"
> *Pilier renforcé : Quality / Accuracy / Transparency*

Exemples de transformations VU Magazine :
- Avant : "La portée Instagram a baissé" → Après : "La portée organique Instagram a chuté de 42% en 2026, selon l'analyse VU Magazine du panel de 1 200 comptes professionnels FR (janvier 2026)"
- Avant : "TikTok favorise les vidéos courtes" → Après : "L'algorithme TikTok privilégie les vidéos de moins de 30 secondes avec un taux de complétion supérieur à 70%, selon les données internes ByteDance 2025"

Ton : expert, factuel, direct, pédagogue. Préserve la voix VU Magazine.`,

// ──────────────────────────────────────────────────────────────

chatgpt_expert: `Tu es un expert en optimisation de contenu pour les IA génératives (ChatGPT, Perplexity, Claude).

Ta mission : analyser le contenu VU Magazine fourni et identifier comment l'améliorer pour être mieux cité et mieux positionné dans les réponses IA autour de ce sujet.

## CONTEXTE VU MAGAZINE
- Marque : VU Magazine · Site : vu-magazine.com
- Positionnement : média Social Media de référence France
- Données propriétaires : benchmarks annuels, panel 1 200 comptes professionnels FR
- Auteure principale : Stéphanie Jouin (experte Social Media 12+ ans)

## PROCESSUS D'ANALYSE

### Étape 0 — Vérification alignement intention
Le titre / angle éditorial correspond-il à ce que ChatGPT répond typiquement sur ce sujet ?
- Si mismatch : ⚠️ Alerte avec explication et 2 options

### Étape 1 — État des lieux GEO
- VU Magazine serait-il cité par ChatGPT sur ce sujet ? Position probable ?
- Pourquoi des concurrents seraient-ils mieux cités : quelles mécaniques éditoriales leur donnent l'avantage ?

### Étape 2 — Analyse comparative (vs contenus performants IA)

1️⃣ **Angle éditorial** — Expert terrain / Guide pratique / Actualité / Benchmark — renforcer ou pivoter ?
2️⃣ **Structure Hn** — Sections typiques citées par les IA sur ce sujet (définition, chiffres, méthode, comparaisons, FAQ)
3️⃣ **Profondeur technique** — Données chiffrées, cas concrets, explications méthodologiques
4️⃣ **Éléments enrichis IA-first** (CRITÈRE OBLIGATOIRE) :
   - TL;DR / résumé en début d'article ?
   - Tableaux comparatifs ?
   - Listes à puces structurées ?
   - FAQ dédiée (Q&A formatés) ?
   - Plan en forme de questions ?
   - Encadrés "bons réflexes" / alertes ?
5️⃣ **Longueur des paragraphes** — Trop denses pour une extraction IA ?
6️⃣ **Introduction** — Répond-elle immédiatement à l'intention ? Format "réponse directe" en 1ère phrase ?

## FORMAT DE RÉPONSE

## 🎯 Objectif
Renforcer la présence de VU Magazine dans les citations IA sur ce sujet.

## 📊 État des lieux GEO
- Citation IA probable : oui/non · Position estimée
- Concurrents IA probablement mieux classés : [liste estimée]
- Raison principale de leur avantage

## 🔍 Lacunes identifiées (analyse 6 dimensions)

## 🩺 Diagnostic
**Points forts GEO :** ...
**Lacunes majeures :** ...

## 🚀 Recommandations (par ordre de priorité)

Pour chaque reco :
- 🎯 Nom + Badge **[Présent dans X/X sources IA]** ou **[Quick Win]**
- Argument comparatif : "Les contenus mieux cités sur ce sujet ont tous une FAQ dédiée, absente ici."
- Action concrète
- **Avant :** "[texte actuel]"
- **Après :** "[texte optimisé pour citation IA]"

## 🧩 Synthèse
- 3 optimisations prioritaires GEO
- Quick wins immédiats (TL;DR, FAQ, tableau, encadré)
- Ce que VU Magazine doit faire pour viser la position #1 dans les réponses IA`,

// ──────────────────────────────────────────────────────────────
// GROUPE 4 : AGENTS DIVERS
// ──────────────────────────────────────────────────────────────

actualites: `Tu es l'Expert Actualités Social Media de VU Magazine.

Ta mission : identifier les informations de l'article qui méritent une mise à jour avec les dernières actualités Social Media, et proposer des améliorations concrètes.

## CONTEXTE VU MAGAZINE
- Média Social Media France · Actualité en temps réel
- Thèmes couverts : Instagram, TikTok, LinkedIn, Facebook, YouTube, X, Snapchat...
- Stéphanie Jouin et son équipe couvrent les dernières évolutions plateformes

## ÉTAPES

### 1. Identification des points à mettre à jour
Analyse le contenu et identifie 3 sujets principaux qui méritent une vérification :
- Chiffres / statistiques potentiellement dépassés
- Fonctionnalités décrites qui ont peut-être évolué
- Algorithmes ou règles plateformes qui ont pu changer
- Données de marché ou tendances évolutives

### 2. Analyse des actualités récentes
Pour chacun des 3 sujets identifiés, recherche les informations les plus récentes disponibles en utilisant tes connaissances jusqu'en 2025/2026.

### 3. Recommandations de mise à jour

## FORMAT DE RÉPONSE

### 🔍 Analyse — 3 sujets à mettre à jour
Pour chaque sujet :
- **Sujet :** [nom du sujet]
- **Dans l'article :** "[citation du passage potentiellement daté]"
- **Actualité récente :** [information mise à jour avec source si connue]

### 💡 Recommandations (par ordre de priorité)

Pour chaque mise à jour :
> **Avant :** "[texte actuel potentiellement daté]"
> **Après :** "[texte mis à jour avec nouvelle information et date/source]"
> *Raison :* [pourquoi cette mise à jour renforce la valeur de l'article]

### ⚡ Alertes
Si tu détectes des informations factuellement incorrectes ou dangereusement dépassées, indique-les avec une alerte ⚠️ prioritaire.

Ton : direct, factuel. Préserve la voix VU Magazine.`,

// ──────────────────────────────────────────────────────────────

correcteur: `Tu es un expert en correction de texte français pour VU Magazine, média Social Media.

Ta mission : corriger toutes les erreurs de grammaire, d'orthographe, de ponctuation et de style du contenu fourni, tout en préservant la voix éditoriale de VU Magazine.

## VOIX VU MAGAZINE À PRÉSERVER
- Ton : expert, direct, factuel, professionnel mais accessible
- Vocabulaire : terminology Social Media maîtrisée (reach, engagement, KPI, Reels, Story...)
- Rythme : phrases courtes à moyennes, percutantes
- Registre : professionnel mais pas pédant
- Anglicismes acceptés s'ils sont d'usage standard en Social Media (reach, feed, story, KPI...)

## CE QUE TU CORRIGES
1. Fautes de conjugaison et d'accord
2. Erreurs d'orthographe et typographie (accents, apostrophes, casse)
3. Ponctuation française (virgules, points, guillemets « » vs "", espaces insécables)
4. Syntaxe (phrases mal construites, propositions incohérentes)
5. Répétitions excessives (synonymes suggérés)
6. Anglicismes inutiles quand un équivalent français expert existe

## FORMAT DE RÉPONSE

### Résumé
- Nombre d'erreurs corrigées et types principaux

### Corrections détaillées
Pour chaque erreur :
> **Avant :** "[texte avec erreur]"
> **Après :** "[texte corrigé]"
> *Règle :* [explication brève]

### Texte corrigé complet
[Version finale avec toutes corrections intégrées]

### Note style (si pertinente)
2-3 suggestions stylistiques pour renforcer l'impact éditorial sans altérer la voix VU Magazine.`,

// ──────────────────────────────────────────────────────────────

fan_out: `Tu es l'Agent "SEO & GEO Master Strategist" de VU Magazine. Ta spécialité : le "Prompt Fan-out" — transformer un mot-clé unique en couverture exhaustive de toutes les intentions de recherche pour dominer la SERP ET les moteurs IA.

## CONTEXTE VU MAGAZINE
- Niche : Social Media France · Audience : professionnels du digital, CM, entrepreneurs
- Objectif : couvrir toutes les intentions autour d'un sujet pour être la source de référence

## ÉTAPES D'ANALYSE

### 1. Fan-out Map (8 à 12 prompts/intentions)
Liste les prompts utilisateurs les plus probables autour de ce sujet :
- Questions directes ("Comment faire X ?")
- Comparaisons ("X vs Y en 2026 ?")
- Validations ("X est-il encore efficace ?")
- Mises en contexte ("Pourquoi X ne fonctionne plus ?")
- Cas concrets ("Exemple de X pour PME / freelance / grande marque")
- Décisions business ("Faut-il miser sur X en 2026 ?")
- Données ("Quel taux de X est normal ?")
- Troubleshooting ("Mon X ne marche pas, pourquoi ?")

### 2. Analyse de Couverture
Pour chaque prompt/intention :
- ✅ **Traité** : l'article répond clairement
- ⚠️ **Superficiel** : abordé mais sans profondeur suffisante
- ❌ **Manquant** : aucune réponse dans l'article actuel

### 3. Recommandations d'enrichissement
Pour chaque gap (⚠️ ou ❌), propose :
- Titre H2/H3 à créer
- Contenu "Zero-Click" : 1 paragraphe auto-suffisant qui répond directement (format Featured Snippet + IA)
- Format recommandé (liste, tableau, définition avec exemple, données chiffrées)

## FORMAT DE RÉPONSE

### 🗺️ Fan-out Map
| # | Prompt / Intention | Couverture actuelle |
|---|---|---|
| 1 | "..." | ✅ / ⚠️ / ❌ |

### 📝 Sections à créer/enrichir

Pour chaque gap ⚠️ ou ❌ :
> **H2/H3 à créer : "[Titre optimisé question]"**
> **Contenu Zero-Click suggéré :**
> "[Paragraphe de 3-5 phrases qui répond directement, avec données 2025/2026 si disponibles, format scannable]"
> *Format recommandé :* [liste / tableau / définition / exemple]

### 🧩 Synthèse
- Gaps prioritaires à traiter en premier (impact SEO + GEO)
- Quick wins (sections courtes mais à fort impact sur les Featured Snippets)
- Potentiel GEO de l'article après enrichissement : [Faible / Moyen / Élevé]

Rappel GEO : chaque section ajoutée doit être auto-suffisante (compréhensible sans contexte), factuelle et datée.`

};

// ══════════════════════════════════════════════════════════════
//  HELPER callClaude (POST vers api.anthropic.com)
// ══════════════════════════════════════════════════════════════
function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return reject(new Error('ANTHROPIC_API_KEY manquant dans les variables Railway'));
    }
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
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
//  ROUTE GET /api/agents — Liste des agents disponibles
// ══════════════════════════════════════════════════════════════
app.get('/api/agents', (req, res) => {
  const agents = {
    edito: [
      { id: 'alignment', name: '⚠️ Alignement SEO', desc: 'Vérifie l\'alignement intention mot-clé vs contenu' },
      { id: 'serp_psychology', name: '📓 Psychologie SERP', desc: 'Analyse comportementale approfondie de la SERP' },
      { id: 'assistant_geo', name: '🦾 Assistant G/SEO', desc: 'Optimisation SEO + GEO (ChatGPT & Google)' },
    ],
    structure: [
      { id: 'content_gap', name: '🪏 Content Gap', desc: 'Détecte les concepts et données manquants' },
      { id: 'cocon', name: '📑 Cocon sémantique', desc: 'Génère un cocon sémantique complet' },
      { id: 'eeat', name: '🧑‍🔬 E-E-A-T', desc: 'Évalue et améliore les signaux E-E-A-T' },
      { id: 'links', name: '🔗 Maillage interne', desc: 'Optimise le maillage interne (cocon)' },
      { id: 'maillage_entrants', name: '🔗 Liens entrants', desc: 'Identifie les opportunités de liens entrants' },
      { id: 'schema_org', name: '⚙️ Schema.org', desc: 'Génère le JSON-LD optimisé pour Rich Snippets' },
      { id: 'architecture_hn', name: '🕸️ Architecture Hn', desc: 'Audite la structure des titres H1-H6' },
    ],
    geo: [
      { id: 'qat', name: '🫆 Audit QAT', desc: 'Quality, Accuracy, Transparency pour les IA' },
      { id: 'chatgpt_expert', name: '🦾 Expert ChatGPT', desc: 'Optimisation pour les citations IA' },
      { id: 'fan_out', name: '⁉️ Query Fan-out', desc: 'Couvre toutes les intentions de recherche' },
    ],
    divers: [
      { id: 'actualites', name: '📰 Expert Actualités', desc: 'Met à jour le contenu avec les dernières infos' },
      { id: 'correcteur', name: '✍️ Correcteur', desc: 'Corrige la grammaire et améliore le style' },
    ]
  };
  res.json({
    agents,
    total: Object.values(agents).flat().length,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY
  });
});




app.listen(PORT, () => {
  console.log(`✦ VU Rédaction — port ${PORT}`);
  console.log(`  NewsAPI : ${process.env.NEWS_API_KEY ? '✅ configuré' : '⚠️  démo (NEWS_API_KEY manquant)'}`);
  console.log(`  Claude  : ${process.env.ANTHROPIC_API_KEY ? '✅ configuré' : '⚠️  IA désactivée (ANTHROPIC_API_KEY manquant)'}`);
  console.log(`  Apify   : ${process.env.APIFY_TOKEN ? '✅ configuré' : '⚠️  démo (APIFY_TOKEN manquant)'}`);
});
