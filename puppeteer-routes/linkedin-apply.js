/**
 * LinkedIn Apply Routes
 * À intégrer dans le puppeteer-service existant
 *
 * Dans index.js :
 *   const linkedinApply = require('./routes/linkedin-apply');
 *   app.use('/linkedin', linkedinApply);
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/tmp/screenshots';
const { injectSession } = require('./linkedin-session');

// Données personnelles pour remplir les formulaires
const APPLICANT_INFO = {
  firstName: 'Theo',
  lastName: 'Lambert',
  email: 'lambertheo@gmail.com',
  phone: '0673783010',
  location: 'Saint-Brieuc, France',
  linkedin: 'https://www.linkedin.com/in/theo-lambert-601021f1a0/',
  github: 'https://github.com/Analogium',
  portfolio: 'https://theolambert.dev',
  // Réponses standard aux questions fréquentes
  yearsExperience: '2',
  requiresSponsorship: 'Non',
  authorizedToWork: 'Oui',
  availableToStart: '1 mois',
  salaryExpectation: '38000',
};

/**
 * POST /linkedin/easy-apply
 * Postule via le bouton "Candidature simplifiée" de LinkedIn
 * Body : {
 *   job_url: string,
 *   job_title: string,
 *   cv_pdf_base64: string,   // PDF du CV adapté en base64
 *   cover_note: string,      // Lettre courte générée par Claude
 * }
 */
router.post('/easy-apply', async (req, res) => {
  const { job_url, job_title, cv_pdf_base64, cover_note } = req.body;
  if (!job_url) return res.status(400).json({ error: 'job_url requis' });

  let browser = null;
  const screenshotName = `easy-apply-${Date.now()}.png`;
  const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);

  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    browser = await getBrowser();
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await injectSession(pageObj);
    await pageObj.goto(job_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Clic sur le bouton Easy Apply
    const applyBtn = await pageObj.waitForSelector(
      'button.jobs-apply-button, .jobs-s-apply button',
      { timeout: 10000 }
    );

    const btnText = await applyBtn.textContent();
    if (!btnText.includes('simplifiée') && !btnText.includes('Easy Apply')) {
      await browser.close();
      return res.status(400).json({ error: 'Ce poste ne supporte pas la candidature simplifiée', apply_type: 'external' });
    }

    await applyBtn.click();
    await pageObj.waitForTimeout(2000);

    // Upload du CV si demandé
    const uploadInput = await pageObj.$('input[type="file"]');
    if (uploadInput && cv_pdf_base64) {
      const cvBuffer = Buffer.from(cv_pdf_base64, 'base64');
      const tmpPath = `/tmp/cv-${Date.now()}.pdf`;
      fs.writeFileSync(tmpPath, cvBuffer);

      await uploadInput.setInputFiles(tmpPath);
      await pageObj.waitForTimeout(2000);
      fs.unlinkSync(tmpPath);
    }

    // Traitement des étapes du formulaire Easy Apply (jusqu'à 5 étapes)
    let stepCount = 0;
    let submitted = false;

    while (stepCount < 8 && !submitted) {
      stepCount++;

      // Remplissage des champs texte courants
      await fillCommonFields(pageObj);

      // Saisie de la lettre de motivation si un champ textarea existe
      if (cover_note) {
        const coverTextarea = await pageObj.$('textarea[id*="cover"], textarea[name*="cover"], textarea[placeholder*="lettre"], textarea[placeholder*="cover"]');
        if (coverTextarea) {
          await coverTextarea.click({ clickCount: 3 });
          await coverTextarea.type(cover_note, { delay: 30 });
        }
      }

      // Cherche bouton Suivant ou Envoyer
      const nextBtn = await pageObj.$('button[aria-label*="Suivant"], button[aria-label*="Next"], button[aria-label*="Continue"], button[aria-label*="Continuer"]');
      const submitBtn = await pageObj.$('button[aria-label*="Envoyer"], button[aria-label*="Submit"], button[aria-label*="Soumettre"]');

      if (submitBtn) {
        await submitBtn.click();
        await pageObj.waitForTimeout(3000);
        submitted = true;
      } else if (nextBtn) {
        await nextBtn.click();
        await pageObj.waitForTimeout(2000);
      } else {
        // Cherche un bouton générique de type "primary"
        const primaryBtn = await pageObj.$('.artdeco-button--primary');
        if (primaryBtn) {
          const text = await primaryBtn.textContent();
          if (text.toLowerCase().includes('envoyer') || text.toLowerCase().includes('submit')) {
            await primaryBtn.click();
            submitted = true;
          } else {
            await primaryBtn.click();
          }
          await pageObj.waitForTimeout(2000);
        } else {
          break;
        }
      }
    }

    // Screenshot de confirmation
    await pageObj.screenshot({ path: screenshotPath, fullPage: false });

    // Vérification du succès
    const successMsg = await pageObj.evaluate(() => {
      return document.querySelector('.artdeco-toasts__item--success, .jobs-post-apply-modal')?.textContent?.trim() || null;
    });

    await browser.close();

    res.json({
      success: submitted,
      steps_completed: stepCount,
      confirmation_message: successMsg,
      screenshot_path: screenshotPath,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    console.error('[Easy Apply] Erreur:', err.message);
    res.status(500).json({ error: err.message, screenshot_path: screenshotPath });
  }
});

/**
 * POST /linkedin/external-apply
 * Postule via un formulaire externe (hors LinkedIn)
 * Body : {
 *   external_url: string,
 *   job_title: string,
 *   company: string,
 *   cv_pdf_base64: string,
 *   cover_note: string,
 *   form_analysis: object,   // Analyse du formulaire par Claude (champs détectés)
 * }
 */
router.post('/external-apply', async (req, res) => {
  const { external_url, job_title, company, cv_pdf_base64, cover_note, form_analysis } = req.body;
  if (!external_url) return res.status(400).json({ error: 'external_url requis' });

  let browser = null;
  const screenshotName = `external-apply-${Date.now()}.png`;
  const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);

  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    browser = await getBrowser();
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await pageObj.goto(external_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Remplissage basé sur l'analyse de Claude (form_analysis)
    if (form_analysis && form_analysis.fields) {
      for (const field of form_analysis.fields) {
        try {
          await fillField(pageObj, field);
          await pageObj.waitForTimeout(300);
        } catch (e) {
          console.warn(`[External Apply] Champ non rempli: ${field.label} - ${e.message}`);
        }
      }
    } else {
      // Fallback : remplissage générique
      await fillCommonFieldsExternal(pageObj, cover_note);
    }

    // Upload CV si un input file existe
    if (cv_pdf_base64) {
      const fileInputs = await pageObj.$$('input[type="file"]');
      for (const fileInput of fileInputs) {
        const accept = await fileInput.getAttribute('accept');
        if (!accept || accept.includes('pdf') || accept.includes('*')) {
          const cvBuffer = Buffer.from(cv_pdf_base64, 'base64');
          const tmpPath = `/tmp/cv-ext-${Date.now()}.pdf`;
          fs.writeFileSync(tmpPath, cvBuffer);
          await fileInput.setInputFiles(tmpPath);
          await pageObj.waitForTimeout(1500);
          fs.unlinkSync(tmpPath);
          break;
        }
      }
    }

    // Screenshot avant soumission
    await pageObj.screenshot({ path: screenshotPath });

    // Soumission du formulaire
    const submitBtn = await pageObj.$(
      'button[type="submit"], input[type="submit"], button:has-text("Envoyer"), button:has-text("Soumettre"), button:has-text("Submit"), button:has-text("Apply"), button:has-text("Postuler")'
    ).catch(() => null);

    let submitted = false;
    if (submitBtn) {
      await submitBtn.click();
      await pageObj.waitForTimeout(4000);
      submitted = true;
    }

    // Screenshot post-soumission
    const screenshotNamePost = `external-apply-post-${Date.now()}.png`;
    const screenshotPathPost = path.join(SCREENSHOTS_DIR, screenshotNamePost);
    await pageObj.screenshot({ path: screenshotPathPost });

    const finalUrl = pageObj.url();
    await browser.close();

    res.json({
      success: submitted,
      final_url: finalUrl,
      screenshot_before: screenshotPath,
      screenshot_after: screenshotPathPost,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /linkedin/analyze-form
 * Analyse la structure d'un formulaire externe pour guider le remplissage
 * Body : { url: string }
 * Retourne : { fields: [...] } à envoyer à Claude pour obtenir form_analysis
 */
router.post('/analyze-form', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url requise' });

  let browser = null;
  try {
    browser = await getBrowser();
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Attendre le rendu JS des formulaires SPA
    await pageObj.waitForSelector('input, textarea, select', { timeout: 10000 }).catch(() => null);
    await pageObj.waitForTimeout(2000);

    const formData = await pageObj.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
      const fields = inputs
        .filter(el => el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button')
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || 'text',
          name: el.name || el.id || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || '',
          required: el.required,
          selector: el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : null),
          options: el.tagName === 'SELECT'
            ? Array.from(el.options).map(o => ({ value: o.value, text: o.text }))
            : null,
        }));

      return {
        url: window.location.href,
        title: document.title,
        fields: fields.filter(f => f.selector),
        has_file_upload: inputs.some(el => el.type === 'file'),
      };
    });

    await browser.close();
    res.json({ success: true, ...formData });

  } catch (err) {
    if (browser) await browser.close().catch(() => null);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fillCommonFields(pageObj) {
  const fieldMap = [
    { selectors: ['input[name*="first"][name*="name" i], input[id*="first"][id*="name" i], input[placeholder*="prénom" i], input[placeholder*="first name" i]'], value: APPLICANT_INFO.firstName },
    { selectors: ['input[name*="last"][name*="name" i], input[id*="last"][id*="name" i], input[placeholder*="nom" i], input[placeholder*="last name" i]'], value: APPLICANT_INFO.lastName },
    { selectors: ['input[type="email"], input[name*="email" i], input[id*="email" i]'], value: APPLICANT_INFO.email },
    { selectors: ['input[type="tel"], input[name*="phone" i], input[name*="tel" i], input[id*="phone" i]'], value: APPLICANT_INFO.phone },
    { selectors: ['input[name*="city" i], input[name*="location" i], input[name*="ville" i]'], value: APPLICANT_INFO.location },
    { selectors: ['input[name*="linkedin" i], input[id*="linkedin" i]'], value: APPLICANT_INFO.linkedin },
    { selectors: ['input[name*="github" i], input[id*="github" i]'], value: APPLICANT_INFO.github },
    { selectors: ['input[name*="portfolio" i], input[name*="website" i], input[name*="site" i]'], value: APPLICANT_INFO.portfolio },
    { selectors: ['input[name*="years" i], input[name*="experience" i], input[name*="annees" i]'], value: APPLICANT_INFO.yearsExperience },
    { selectors: ['input[name*="salary" i], input[name*="salaire" i], input[name*="remuneration" i]'], value: APPLICANT_INFO.salaryExpectation },
  ];

  for (const { selectors, value } of fieldMap) {
    for (const selector of selectors) {
      const el = await pageObj.$(selector).catch(() => null);
      if (el) {
        const currentVal = await el.inputValue().catch(() => '');
        if (!currentVal) {
          await el.click({ clickCount: 3 });
          await el.type(value, { delay: 50 });
        }
        break;
      }
    }
  }

  // Radios / checkboxes : questions oui/non fréquentes
  const yesRadios = await pageObj.$$('input[type="radio"][value*="yes" i], input[type="radio"][value*="oui" i], input[type="radio"][value="1"]');
  for (const radio of yesRadios) {
    const label = await pageObj.evaluate(el => {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      return lbl?.textContent?.toLowerCase() || '';
    }, radio);

    if (label.includes('autoris') || label.includes('eligible') || label.includes('légal')) {
      await radio.click().catch(() => null);
    }
  }
}

async function fillCommonFieldsExternal(pageObj, cover_note) {
  await fillCommonFields(pageObj);

  if (cover_note) {
    const textareas = await pageObj.$$('textarea');
    for (const ta of textareas) {
      const currentVal = await ta.inputValue().catch(() => '');
      if (!currentVal) {
        await ta.click({ clickCount: 3 });
        await ta.type(cover_note, { delay: 20 });
        break;
      }
    }
  }
}

async function fillField(pageObj, field) {
  if (!field.selector) return;
  const el = await pageObj.$(field.selector);
  if (!el) return;

  if (field.tag === 'select') {
    await el.selectOption({ label: field.value }).catch(async () => {
      await el.selectOption({ value: field.value }).catch(() => null);
    });
  } else if (field.type === 'file') {
    // géré séparément
  } else if (field.type === 'checkbox' || field.type === 'radio') {
    if (field.value === true || field.value === 'true' || field.value === 'yes' || field.value === 'oui') {
      await el.check().catch(() => null);
    }
  } else {
    await el.click({ clickCount: 3 });
    await el.type(String(field.value || ''), { delay: 40 });
  }
}

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
