/**
 * Gestion de la session LinkedIn
 * Stocke le cookie li_at + JSESSIONID dans /tmp/linkedin-session.json
 * après authentification depuis le VPS (IP valide pour LinkedIn).
 */

const fs = require('fs');
const SESSION_FILE = process.env.LINKEDIN_SESSION_FILE || '/tmp/linkedin-session.json';

/**
 * Retourne les cookies de session stockés, ou le cookie d'env en fallback.
 * @returns {{ li_at: string, jsessionid: string|null }}
 */
function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      // Vérifier que la session n'est pas trop vieille (30 jours)
      if (data.saved_at && Date.now() - data.saved_at < 30 * 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch (e) {
    // ignore
  }
  // Fallback sur l'env var
  return { li_at: process.env.LINKEDIN_LI_AT_COOKIE, jsessionid: null };
}

/**
 * Sauvegarde les cookies de session après login.
 */
function saveSession(cookies) {
  const liAt = cookies.find(c => c.name === 'li_at');
  const jsessionid = cookies.find(c => c.name === 'JSESSIONID');
  const data = {
    li_at: liAt?.value || null,
    jsessionid: jsessionid?.value || null,
    saved_at: Date.now(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Injecte les cookies de session dans une page Puppeteer.
 */
async function injectSession(page) {
  const session = getSession();
  const cookies = [];
  if (session.li_at) {
    cookies.push({ name: 'li_at', value: session.li_at, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true });
  }
  if (session.jsessionid) {
    cookies.push({ name: 'JSESSIONID', value: session.jsessionid, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true });
  }
  if (cookies.length) await page.setCookie(...cookies);
  return session;
}

module.exports = { getSession, saveSession, injectSession };
