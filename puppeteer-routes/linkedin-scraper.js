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

// Cookie de session LinkedIn (li_at) — injecté via variable d'env
const LI_AT_COOKIE = process.env.LINKEDIN_LI_AT_COOKIE;

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
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'fr-FR',
    });

    // Injection du cookie de session LinkedIn
    await context.addCookies([
      {
        name: 'li_at',
        value: LI_AT_COOKIE,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
      }
    ]);

    const pageObj = await context.newPage();

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

    await pageObj.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Vérification de session valide
    const isLoggedIn = await pageObj.evaluate(() => {
      return !document.querySelector('.authwall-join-form');
    });

    if (!isLoggedIn) {
      await browser.close();
      return res.status(401).json({ error: 'Session LinkedIn expirée. Mettre à jour le cookie li_at.' });
    }

    // Attente du chargement des offres
    await pageObj.waitForSelector('.jobs-search__results-list, .scaffold-layout__list-container', {
      timeout: 15000,
    }).catch(() => null);

    // Extraction des offres
    const jobs = await pageObj.evaluate(() => {
      const jobCards = document.querySelectorAll(
        '.jobs-search__results-list li, .scaffold-layout__list-container li'
      );

      return Array.from(jobCards).map(card => {
        const titleEl = card.querySelector('.base-search-card__title, .job-card-list__title');
        const companyEl = card.querySelector('.base-search-card__subtitle, .job-card-container__company-name');
        const locationEl = card.querySelector('.job-search-card__location, .job-card-container__metadata-item');
        const linkEl = card.querySelector('a.base-card__full-link, a.job-card-list__title');
        const easyApplyBadge = card.querySelector('.job-search-card__easy-apply-label');
        const metaEl = card.querySelector('.job-search-card__listdate');

        // Extraction de l'ID LinkedIn depuis l'URL
        const href = linkEl?.href || '';
        const jobIdMatch = href.match(/\/jobs\/view\/(\d+)/);
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
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      locale: 'fr-FR',
    });

    await context.addCookies([{
      name: 'li_at', value: LI_AT_COOKIE,
      domain: '.linkedin.com', path: '/', httpOnly: true, secure: true,
    }]);

    const pageObj = await context.newPage();
    await pageObj.goto(job_url, { waitUntil: 'networkidle', timeout: 30000 });

    await pageObj.waitForSelector('.job-view-layout, .jobs-details', { timeout: 15000 }).catch(() => null);

    const details = await pageObj.evaluate(() => {
      const descEl = document.querySelector('.jobs-description-content__text, .job-details-jobs-unified-top-card__job-insight');
      const fullDescEl = document.querySelector('.jobs-box__html-content, .jobs-description__content');

      // Détection langue (cherche mots-clés anglais dans le titre/description)
      const titleEl = document.querySelector('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title');
      const titleText = titleEl?.textContent?.trim() || '';
      const descText = fullDescEl?.textContent || '';
      const isEnglish = /\b(developer|engineer|experience|required|skills|team|work)\b/i.test(descText);

      // Type de contrat
      const metaItems = Array.from(document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight'));
      const contractInfo = metaItems.map(el => el.textContent?.trim()).join(' | ');

      // Bouton candidature
      const easyApplyBtn = document.querySelector('.jobs-apply-button--top-card button');
      const applyType = easyApplyBtn?.textContent?.includes('Candidature simplifiée') ||
                        easyApplyBtn?.textContent?.includes('Easy Apply')
                        ? 'easy_apply' : 'external';

      // URL externe si applicable
      let externalUrl = null;
      if (applyType === 'external') {
        const externalLink = document.querySelector('a[href*="apply"], .jobs-apply-button a');
        externalUrl = externalLink?.href || null;
      }

      return {
        title: titleText,
        description: fullDescEl?.innerHTML?.trim() || descText,
        description_text: descText.trim(),
        language: isEnglish ? 'en' : 'fr',
        contract_info: contractInfo,
        apply_type: applyType,
        external_apply_url: externalUrl,
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
    const context = await browser.newContext();
    const pageObj = await context.newPage();

    await pageObj.setContent(html, { waitUntil: 'networkidle' });

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
  // Adapter selon l'implémentation du puppeteer-service existant
  // Si Playwright :
  try {
    const { chromium } = require('playwright');
    return await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch {
    // Si Puppeteer :
    const puppeteer = require('puppeteer');
    return await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}

module.exports = router;
