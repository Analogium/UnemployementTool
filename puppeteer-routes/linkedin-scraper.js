/**
 * LinkedIn Job Scraper Routes
 * À intégrer dans le puppeteer-service existant (/home/lambert/apps/puppeteer-service/)
 *
 * Dans le fichier principal (index.js / app.js) :
 *   const linkedinScraper = require('./routes/linkedin-scraper');
 *   app.use('/linkedin', linkedinScraper);
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { injectSession } = require('./linkedin-session');

// Paramètres de recherche LinkedIn
const SEARCH_CONFIG = {
  keywords: 'developpeur web',
  geoId: '105015875',      // France
  f_E: '2,3',              // Entry level + Associate
  f_WT: '2',              // Remote uniquement
  sortBy: 'DD',           // Plus récent en premier
  pageSize: 25,
};

/**
 * POST /linkedin/scrape
 * Scrape les offres LinkedIn avec les filtres configurés
 * Body optionnel : { page: 0, keywords: '...', extraFilters: {} }
 */
router.post('/scrape', async (req, res) => {
  const { page = 0, keywords, extraFilters = {} } = req.body;
  let browser = null;

  try {
    browser = await getBrowser();
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    // Pas de cookie pour le scraping — la page publique est plus stable

    // Construction de l'URL de recherche
    const searchParams = new URLSearchParams({
      keywords: keywords || SEARCH_CONFIG.keywords,
      geoId: SEARCH_CONFIG.geoId,
      f_E: SEARCH_CONFIG.f_E,
      f_WT: SEARCH_CONFIG.f_WT,
      sortBy: SEARCH_CONFIG.sortBy,
      start: page * SEARCH_CONFIG.pageSize,
      ...extraFilters,
    });

    const searchUrl = `https://www.linkedin.com/jobs/search/?${searchParams.toString()}`;

    await pageObj.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Attente du chargement des offres (LinkedIn rend les cards via JS)
    await pageObj.waitForSelector('.base-card, .job-search-card', { timeout: 15000 }).catch(() => null);
    await pageObj.waitForTimeout(2000);

    // Extraction des offres
    const jobs = await pageObj.evaluate(() => {
      const jobCards = document.querySelectorAll('.base-card, .job-search-card');

      return Array.from(jobCards).map(card => {
        const titleEl = card.querySelector('.base-search-card__title, .job-card-list__title');
        const companyEl = card.querySelector('.base-search-card__subtitle, .job-card-container__company-name');
        const locationEl = card.querySelector('.job-search-card__location, .job-card-container__metadata-item');
        const linkEl = card.querySelector('a.base-card__full-link, a.job-card-list__title');
        const easyApplyBadge = card.querySelector('.job-search-card__easy-apply-label');
        const metaEl = card.querySelector('.job-search-card__listdate');

        // Extraction de l'ID LinkedIn depuis l'URL
        const href = linkEl?.href || '';
        const jobIdMatch = href.match(/\/jobs\/view\/[^?]*?(\d+)(?:[?&]|$)/);
        const jobId = jobIdMatch ? jobIdMatch[1] : null;

        return {
          linkedin_job_id: jobId,
          title: titleEl?.textContent?.trim() || '',
          company: companyEl?.textContent?.trim() || '',
          location: locationEl?.textContent?.trim() || '',
          job_url: href.split('?')[0],
          apply_type: easyApplyBadge ? 'easy_apply' : 'external',
          posted_at: metaEl?.getAttribute('datetime') || null,
        };
      }).filter(job => job.linkedin_job_id && job.title);
    });

    // Nombre total de résultats
    const totalResults = await pageObj.evaluate(() => {
      const countEl = document.querySelector('.jobs-search-results-list__subtitle, .results-context-header__job-count');
      return countEl?.textContent?.trim() || null;
    });

    await browser.close();

    res.json({
      success: true,
      page,
      total_results: totalResults,
      count: jobs.length,
      jobs,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    console.error('[LinkedIn Scraper] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /linkedin/job-details
 * Récupère la description complète d'une offre
 * Body : { job_url: 'https://linkedin.com/jobs/view/...' }
 */
router.post('/job-details', async (req, res) => {
  const { job_url } = req.body;
  if (!job_url) return res.status(400).json({ error: 'job_url requis' });

  let browser = null;
  try {
    browser = await getBrowser();
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await injectSession(pageObj);
    await pageObj.goto(job_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await new Promise(r => setTimeout(r, 4000));

    const details = await pageObj.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // Titre : sélecteurs publics d'abord, puis page title
      const titleEl = document.querySelector('h1, .top-card-layout__title, .topcard__title');
      const titleText = titleEl?.textContent?.trim()
        || document.title.split('|')[0].trim()
        || '';

      // Description : sélecteurs publics d'abord, puis fallback sur le body
      const fullDescEl = document.querySelector('.description__text, .show-more-less-html__markup');
      let descText = fullDescEl?.textContent?.trim() || '';
      if (descText.length < 100) {
        // Vue connectée : extraire le contenu après le titre et les infos du poste
        const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const startIdx = lines.findIndex(l => l.includes('personnes ont cliqué') || l.includes('people clicked'));
        descText = lines.slice(startIdx > 0 ? startIdx + 1 : 20).join('\n').substring(0, 3000);
      }

      // Critères
      const criteriaItems = Array.from(document.querySelectorAll('.description__job-criteria-item'));
      const contractInfo = criteriaItems.map(el => el.textContent?.replace(/\s+/g, ' ').trim()).join(' | ');

      // Détection Easy Apply via texte des boutons (fonctionne en vue connectée)
      const allBtnTexts = Array.from(document.querySelectorAll('button')).map(el => el.textContent?.trim() || '');
      const isEasyApply = allBtnTexts.some(t =>
        t.includes('Candidature simplifiée') || t.includes('Easy Apply')
      );
      const applyType = isEasyApply ? 'easy_apply' : 'external';

      const isEnglish = /\b(developer|engineer|experience|required|skills|team|work)\b/i.test(descText);

      return {
        title: titleText,
        description: fullDescEl?.innerHTML?.trim() || descText,
        description_text: descText.substring(0, 3000),
        language: isEnglish ? 'en' : 'fr',
        contract_info: contractInfo,
        apply_type: applyType,
        external_apply_url: null,
      };
    });

    await browser.close();
    res.json({ success: true, ...details });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /linkedin/generate-pdf
 * Génère un PDF depuis un HTML de CV adapté via Puppeteer + Chromium
 * (Chromium est déjà dans le container, pas de dépendance supplémentaire)
 * Body : { html: '<html>...', filename: 'cv-adapted.pdf' }
 * Retourne : le PDF en binaire (Content-Type: application/pdf)
 */
router.post('/generate-pdf', async (req, res) => {
  const { html, filename = 'cv.pdf' } = req.body;
  if (!html) return res.status(400).json({ error: 'html requis' });

  let browser = null;
  try {
    browser = await getBrowser();
    const pageObj = await browser.newPage();

    await pageObj.setContent(html, { waitUntil: 'domcontentloaded' });

    const pdfBuffer = await pageObj.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    res.status(500).json({ error: err.message });
  }
});

// Helper : récupère l'instance browser (Playwright ou Puppeteer selon le service existant)
async function getBrowser() {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  return await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });
}


module.exports = router;
