# VU Rédaction

Back-office éditorial de VU Magazine. Gestion des articles, glossaire, partenaires, veille et agents IA SEO/GEO.

## Stack
- Node.js + Express
- PostgreSQL (partagé avec VU Magazine)
- Anthropic Claude (agents IA éditoriaux)

## Structure
```
vu-redaction/
├── server.js          ← serveur Express (API + routing)
├── public/
│   └── index.html     ← frontend single-page
├── package.json
└── .gitignore
```

## Variables Railway requises

| Variable            | Description                              | Obligatoire |
|---------------------|------------------------------------------|-------------|
| `DATABASE_URL`      | PostgreSQL Railway (même DB que VU Mag)  | ✅ Oui      |
| `ANTHROPIC_API_KEY` | Clé API Claude (agents IA)               | ✅ Oui      |
| `NEWS_API_KEY`      | Clé NewsAPI (veille actualités)          | ⚠️ Optionnel |
| `APIFY_TOKEN`       | Token Apify (scraping LinkedIn)          | ⚠️ Optionnel |

## Déploiement Railway

1. Créer un nouveau service Railway depuis ce repo GitHub
2. Ajouter les variables ci-dessus dans Railway → Variables
3. Railway détecte automatiquement `npm start` via `package.json`
4. Custom Start Command : **laisser vide** (Railway utilise `npm start`)

## Dev local

```bash
npm install
DATABASE_URL=... ANTHROPIC_API_KEY=... node server.js
```
