/**
 * LinkedIn Login Route
 * Gère le login depuis le VPS avec support du code de vérification email.
 *
 * POST /linkedin/login          → démarre le login
 * POST /linkedin/verify         → soumet le code de vérification
 * GET  /linkedin/session-status → vérifie la session stockée
 */

const express = require('express');
const router = express.Router();
const { saveSession, getSession } = require('./linkedin-session');
const fs = require('fs');

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/tmp/linkedin-screenshots';

// Browser maintenu en vie pendant la vérification
let pendingBrowser = null;
let pendingPage = null;

/**
 * POST /linkedin/login
 * Body : { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email et password requis' });
  }

  // Fermer un éventuel browser précédent
  if (pendingBrowser) {
    await pendingBrowser.close().catch(() => null);
    pendingBrowser = null;
    pendingPage = null;
  }

  let browser = null;
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#username', { timeout: 10000 });

    await page.click('#username', { clickCount: 3 });
    await page.type('#username', email, { delay: 60 });
    await page.click('#password', { clickCount: 3 });
    await page.type('#password', password, { delay: 60 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);

    const currentUrl = page.url();
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/login-result.png` });

    // Checkpoint / vérification email ou 2FA
    if (currentUrl.includes('/checkpoint/') || currentUrl.includes('/challenge/')) {
      // Garder le browser ouvert pour la vérification
      pendingBrowser = browser;
      pendingPage = page;

      // Détecter le type de vérification
      const verifyInfo = await page.evaluate(() => {
        const body = document.body.innerText;
        const emailHint = document.querySelector('[data-test-email-hint], .challenge-email-hint');
        return {
          hint: emailHint?.textContent?.trim() || null,
          hasEmailCode: body.includes('code') || body.includes('vérification') || body.includes('verification'),
          inputSelector: document.querySelector('input[name="pin"], input[id*="input__email"], input[id*="pin"]')?.id || null,
        };
      });

      return res.status(202).json({
        status: 'verification_required',
        message: 'LinkedIn a envoyé un code de vérification. Appelez POST /linkedin/verify avec le code reçu.',
        email_hint: verifyInfo.hint,
        current_url: currentUrl,
      });
    }

    // Login direct réussi
    if (currentUrl.includes('/feed') || currentUrl.includes('/home') || !currentUrl.includes('/login')) {
      const cookies = await page.cookies();
      const session = saveSession(cookies);
      await browser.close();
      return res.json({
        success: true,
        message: 'Session LinkedIn créée depuis le VPS.',
        li_at_preview: session.li_at ? session.li_at.substring(0, 20) + '...' : null,
      });
    }

    // Mauvais identifiants
    const errorMsg = await page.evaluate(() => {
      const el = document.querySelector('.alert-content, #error-for-password, .form__error--visible');
      return el?.textContent?.trim() || null;
    });
    await browser.close();
    return res.status(401).json({ success: false, message: errorMsg || 'Identifiants incorrects.' });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    console.error('[LinkedIn Login]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /linkedin/verify
 * Body : { code: '123456' }
 * Soumet le code de vérification email/2FA reçu après /login.
 */
router.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code requis' });
  if (!pendingPage || !pendingBrowser) {
    return res.status(400).json({ error: 'Aucun login en attente. Appelez d\'abord POST /linkedin/login.' });
  }

  try {
    const page = pendingPage;
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Trouver le champ de code (plusieurs sélecteurs possibles selon le type de checkpoint)
    const codeSelectors = [
      'input[name="pin"]',
      'input[id*="pin"]',
      'input[id*="input__email"]',
      'input[autocomplete="one-time-code"]',
      'input[type="text"]',
      'input[type="number"]',
    ];

    let inputEl = null;
    for (const sel of codeSelectors) {
      inputEl = await page.$(sel);
      if (inputEl) break;
    }

    if (!inputEl) {
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/verify-error.png` });
      return res.status(400).json({
        error: 'Champ de code non trouvé sur la page.',
        screenshot: `${SCREENSHOTS_DIR}/verify-error.png`,
      });
    }

    // Saisir le code
    await inputEl.click({ clickCount: 3 });
    await inputEl.type(String(code), { delay: 80 });

    // Soumettre
    const submitBtn = await page.$('button[type="submit"], button[data-id="submit-btn"], #email-pin-submit-button');
    if (submitBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        submitBtn.click(),
      ]);
    } else {
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    }

    const currentUrl = page.url();
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/verify-result.png` });

    // Vérifier le résultat
    if (!currentUrl.includes('/login') && !currentUrl.includes('/checkpoint') && !currentUrl.includes('/challenge')) {
      const cookies = await page.cookies();
      const session = saveSession(cookies);

      await pendingBrowser.close().catch(() => null);
      pendingBrowser = null;
      pendingPage = null;

      return res.json({
        success: true,
        message: 'Session LinkedIn créée depuis le VPS.',
        li_at_preview: session.li_at ? session.li_at.substring(0, 20) + '...' : null,
      });
    }

    // Code incorrect ou nouvelle étape
    const errorMsg = await page.evaluate(() => {
      const el = document.querySelector('.alert-content, .error-for-pin, [data-test-id="error"]');
      return el?.textContent?.trim() || null;
    });

    return res.status(401).json({
      success: false,
      message: errorMsg || 'Code incorrect ou étape supplémentaire requise.',
      current_url: currentUrl,
    });

  } catch (err) {
    console.error('[LinkedIn Verify]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /linkedin/session-status
 */
router.get('/session-status', async (req, res) => {
  const session = getSession();
  if (!session.li_at) {
    return res.json({ status: 'no_session', message: 'Aucune session. Appeler POST /linkedin/login.' });
  }

  let browser = null;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'li_at', value: session.li_at, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true });
    if (session.jsessionid) {
      await page.setCookie({ name: 'JSESSIONID', value: session.jsessionid, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true });
    }
    await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    await browser.close();

    const valid = url.includes('/jobs') && !url.includes('/login') && !url.includes('/checkpoint');
    return res.json({
      status: valid ? 'valid' : 'expired',
      current_url: url,
      saved_at: session.saved_at ? new Date(session.saved_at).toISOString() : null,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    res.json({ status: 'error', error: err.message.split('\n')[0] });
  }
});

async function getBrowser() {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  return await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

module.exports = router;
