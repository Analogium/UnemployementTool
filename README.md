# LinkedIn Auto Apply

Système de candidature automatique LinkedIn via n8n + Puppeteer + Claude.

## Architecture

```
Cron (4h)
  └─> Puppeteer: scrape LinkedIn (développeur web, remote, France, Junior/Associate)
        └─> PostgreSQL: déduplique
              └─> Par offre:
                    ├─> Claude Opus: adapte le résumé CV + génère lettre
                    ├─> Puppeteer: génère PDF du CV adapté
                    └─> Si Easy Apply  → Puppeteer remplit le formulaire LinkedIn
                        Si Externe     → Puppeteer analyse le formulaire
                                        → Claude Haiku mappe les champs
                                        → Puppeteer remplit et soumet
                              └─> PostgreSQL: log de la candidature
```

## Fichiers

```
├── db/schema.sql                      # Schéma PostgreSQL
├── puppeteer-routes/
│   ├── linkedin-scraper.js            # Routes scraping + génération PDF
│   └── linkedin-apply.js             # Routes Easy Apply + formulaires externes
├── n8n/
│   ├── 01-job-scraper.json            # Workflow scraper (importable)
│   └── 02-cv-adapter-apply.json      # Workflow CV adapter + apply (importable)
├── CV/
│   ├── cv-theo-lambert.html           # CV FR (base)
│   └── cv-theo-lambert-en.html        # CV EN (base)
└── .env                               # Variables d'environnement (ne pas committer)
```

---

## Installation

### 1. Base de données

```bash
# Sur le VPS
docker exec postgres psql -U postgres -c "CREATE DATABASE linkedin_jobs;"
docker cp db/schema.sql postgres:/tmp/schema.sql
docker exec postgres psql -U postgres -d linkedin_jobs -f /tmp/schema.sql
```

### 2. Routes Puppeteer

Copier les fichiers dans le puppeteer-service :

```bash
scp -P 2222 puppeteer-routes/*.js lambert@92.113.26.116:/home/lambert/apps/puppeteer-service/routes/
```

Puis dans `/home/lambert/apps/puppeteer-service/index.js` (ou `app.js`), ajouter :

```js
const linkedinScraper = require('./routes/linkedin-scraper');
const linkedinApply   = require('./routes/linkedin-apply');
app.use('/linkedin', linkedinScraper);
app.use('/linkedin', linkedinApply);
```

Redémarrer le service :
```bash
docker compose restart puppeteer-service
```

### 3. Variables d'environnement

Ajouter dans `/home/lambert/apps/.env` :

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
LINKEDIN_LI_AT_COOKIE=<ton cookie li_at>
N8N_WEBHOOK_URL=http://n8n:5678
SCREENSHOTS_DIR=/tmp/linkedin-screenshots
```

Puis redémarrer n8n et puppeteer-service :
```bash
docker compose restart n8n puppeteer-service
```

### 4. Workflows n8n

1. Ouvrir n8n via VPN : `http://10.0.0.1:5678`
2. Menu → **Import from file**
3. Importer `n8n/01-job-scraper.json`
4. Importer `n8n/02-cv-adapter-apply.json`
5. Dans les deux workflows, configurer la **credential PostgreSQL** :
   - Host : `postgres`
   - Port : `5432`
   - Database : `linkedin_jobs`
   - User : `postgres`
   - Password : (laisser vide, `trust` mode)
6. Dans `01-job-scraper.json`, mettre à jour `N8N_WEBHOOK_URL` si différent
7. Activer les deux workflows

---

## Obtenir le cookie LinkedIn (`li_at`)

Le cookie `li_at` est le token de session LinkedIn. Il permet au Puppeteer de se connecter sans avoir à saisir login/mot de passe.

**Étapes :**

1. Ouvrir Chrome / Firefox
2. Aller sur `https://www.linkedin.com` et se connecter
3. Ouvrir les DevTools (`F12`) → onglet **Application** (Chrome) ou **Stockage** (Firefox)
4. Dans la colonne gauche : **Cookies** → `https://www.linkedin.com`
5. Chercher le cookie nommé **`li_at`**
6. Copier sa **valeur** (longue chaîne commençant souvent par `AQE...`)
7. Coller dans `.env` :
   ```
   LINKEDIN_LI_AT_COOKIE=AQEDATxxxxxxxx...
   ```

> ⚠️ Le cookie expire généralement après quelques semaines / mois. Si le scraper retourne une erreur 401, il faut le renouveler.

---

## Notifications

Le workflow `02-cv-adapter-apply.json` contient un placeholder en fin de chaîne pour ajouter les notifications. Ajouter un nœud **Telegram** ou **Email** connecté au nœud `Sauvegarder candidature`.

**Message Telegram suggéré :**
```
✅ Candidature envoyée !
Poste : {{ $('Fusionner données').item.json.title }}
Entreprise : {{ $('Fusionner données').item.json.company }}
Type : {{ $('Fusionner données').item.json.apply_type }}
```

---

## Suivi des candidatures

Via PgAdmin (`http://10.0.0.1:5050` avec VPN) ou directement :

```bash
docker exec postgres psql -U postgres -d linkedin_jobs -c "SELECT * FROM application_summary;"
```

---

## Paramétrer les critères de recherche

Modifier dans `puppeteer-routes/linkedin-scraper.js` :

```js
const SEARCH_CONFIG = {
  keywords: 'developpeur web',   // ← changer les mots-clés
  geoId: '105015875',            // France (ne pas changer pour le remote)
  f_E: '2,3',                    // 2=Junior, 3=Associate, 4=Mid-Senior
  f_WT: '2',                     // 1=Présentiel, 2=Remote, 3=Hybride
  sortBy: 'DD',                  // DD=Date, R=Pertinence
};
```

---

## Dépannage

| Problème | Cause probable | Solution |
|----------|---------------|----------|
| Erreur 401 LinkedIn | Cookie `li_at` expiré | Renouveler le cookie |
| Aucune offre trouvée | Sélecteurs HTML changés | Vérifier les sélecteurs dans `linkedin-scraper.js` |
| PDF vide | Erreur Puppeteer | Vérifier les logs : `docker logs puppeteer-service` |
| Claude timeout | Trop de texte dans la description | Description tronquée à 3000 chars (déjà en place) |
| Easy Apply bloqué | LinkedIn a changé son UI | Mettre à jour les sélecteurs dans `linkedin-apply.js` |
