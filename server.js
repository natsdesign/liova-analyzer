require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const fetch      = require('node-fetch');
const cheerio    = require('cheerio');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_LIST_ID = parseInt(process.env.BREVO_LIST_ID || '3', 10);
const ADMIN_KEY     = process.env.ADMIN_KEY || 'admin';
const DB_PATH       = path.join(__dirname, 'db.json');

// ──────────────────────────────────────────────────────────────
// DB helpers
// ──────────────────────────────────────────────────────────────
function readDb() {
  if (!fs.existsSync(DB_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return []; }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ──────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(cors({
  origin: (origin, cb) => {
    const allowed = ['https://liova.studio', 'http://localhost:3000', 'http://127.0.0.1:3000'];
    if (!origin || allowed.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes — réessaie dans une heure.' }
});
app.use('/api/analyze', limiter);
app.use('/api/contact', limiter);

// ──────────────────────────────────────────────────────────────
// Analysis engine (port of the client-side logic)
// ──────────────────────────────────────────────────────────────
function analyse($, url, rawHtml) {
  const bodyText = $('body').text() || '';
  const bodyLow  = bodyText.toLowerCase();

  const metaContent = (name) => {
    const el = $(`meta[name="${name}"]`);
    return el.length ? (el.attr('content') || '').trim() : '';
  };
  const propContent = (prop) => {
    const el = $(`meta[property="${prop}"]`);
    return el.length ? (el.attr('content') || '').trim() : '';
  };

  // ── SEO ──
  const titleTxt = $('title').first().text().trim();
  const titleLen = titleTxt.length;
  const titleOk  = titleLen >= 30 && titleLen <= 65;

  const descTxt = metaContent('description');
  const descLen = descTxt.length;
  const descOk  = descLen >= 120 && descLen <= 160;

  const h1s  = $('h1');
  const h1Ok = h1s.length === 1;

  const vpOk = $('meta[name="viewport"]').length > 0;

  // ── Conversion ──
  const ctaOk     = $('form').length > 0 || $('button').length > 0;
  const emailRx   = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
  const telRx     = /(\+33|0)[1-9][\s.\-]?(\d{2}[\s.\-]?){3}\d{2}/;
  const contactOk = emailRx.test(bodyText) || telRx.test(bodyText);

  const spWords = ['témoignage','temoignage','avis','confiance','clients','résultats','resultats','garantie','testimonial','review','trust','customer','recommand'];
  const spOk = spWords.some(w => bodyLow.includes(w));

  const faqOk = $('h2, h3').toArray().some(el => {
    const t = $(el).text().toLowerCase();
    return t.includes('faq') || t.includes('question') || t.includes('foire');
  });

  const urgencyWords = ["limité","limite","offre","places","aujourd'hui","maintenant","exclusif","dernier","dernière","derniere","urgent","expire"];
  const urgencyOk = urgencyWords.some(w => bodyLow.includes(w));

  // ── Technique ──
  const httpsOk   = url.startsWith('https://');
  const ogTitleOk = propContent('og:title').length > 0;
  const ogImageOk = propContent('og:image').length > 0;
  const faviconOk = $('link[rel*="icon"]').length > 0;

  // ── Contenu ──
  const wordCount = bodyText.trim().split(/\s+/).filter(w => w.length > 1).length;
  const wordsOk   = wordCount > 300;

  const imgs    = $('img');
  const imgOk   = imgs.length > 0;
  const withAlt = imgs.toArray().filter(i => ($(i).attr('alt') || '').trim().length > 0).length;
  const altPct  = imgs.length > 0 ? Math.round(withAlt / imgs.length * 100) : 0;
  const altOk   = imgs.length > 0 && altPct > 50;

  let domain = '';
  try { domain = new URL(url).hostname; } catch {}
  const intLinkOk = $('a[href]').toArray().some(a => {
    const h = $(a).attr('href') || '';
    return h.startsWith('/') || (domain && h.includes(domain));
  });

  // ── Branding ──
  const jsMarkers = ['__NEXT_DATA__', '__nuxt', 'data-reactroot', 'ng-version', '__NUXT__'];
  const isJsHeavy = bodyText.trim().length < 500 || jsMarkers.some(m => rawHtml.includes(m));

  const fontOk = $('link[href*="fonts.googleapis.com"]').length > 0 ||
                 rawHtml.includes('@font-face');
  const themeColorOk  = $('meta[name="theme-color"]').length > 0;
  const manifestOk    = $('link[rel="manifest"]').length > 0;

  const inlineColors = new Set();
  $('[style]').each((_, el) => {
    const s = $(el).attr('style') || '';
    (s.match(/#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)/g) || [])
      .forEach(c => inlineColors.add(c.toLowerCase()));
  });
  const fewColorsOk = inlineColors.size < 5;

  const placeholderCount = $('a[href="#"], a[href=""]').length;
  const noPlaceholderOk  = placeholderCount === 0;

  const checks = [
    { id:'seo_title',      cat:'SEO',        pts:10, ok:titleOk,
      label:`Balise <title> (30–65 chars)`,
      reco: titleLen===0 ? "Ajoute une balise <title>."
          : titleLen<30  ? `Title trop courte (${titleLen}) — vise 30–65 chars.`
                         : `Title trop longue (${titleLen}) — passe sous 65 chars.` },
    { id:'seo_desc',       cat:'SEO',        pts:8,  ok:descOk,
      label:`Meta description (120–160 chars)`,
      reco: descLen===0  ? "Ajoute une meta description."
          : descLen<120  ? `Trop courte (${descLen}) — vise 120–160 chars.`
                         : `Trop longue (${descLen}) — elle sera coupée sur Google.` },
    { id:'seo_h1',         cat:'SEO',        pts:4,  ok:h1Ok,   jsDependent:true,
      label:`Un seul <h1> présent`,
      reco: h1s.length===0 ? "Ajoute un <h1> principal."
                           : `Tu as ${h1s.length} balises <h1> — n'en garde qu'une.` },
    { id:'seo_vp',         cat:'SEO',        pts:3,  ok:vpOk,
      label:`Meta viewport présent`,
      reco: `Ajoute <meta name="viewport" content="width=device-width, initial-scale=1">.` },
    { id:'conv_cta',       cat:'Conversion', pts:4,  ok:ctaOk,     jsDependent:true,
      label:`Formulaire ou bouton CTA présent`,
      reco: "Ajoute un bouton d'appel à l'action bien visible." },
    { id:'conv_contact',   cat:'Conversion', pts:6,  ok:contactOk, jsDependent:true,
      label:`Email ou téléphone visible`,
      reco: "Affiche clairement un email ou téléphone." },
    { id:'conv_social',    cat:'Conversion', pts:6,  ok:spOk,      jsDependent:true,
      label:`Social proof détecté`,
      reco: "Ajoute des témoignages clients ou résultats concrets." },
    { id:'conv_faq',       cat:'Conversion', pts:5,  ok:faqOk,     jsDependent:true,
      label:`Section FAQ présente`,
      reco: "Ajoute une FAQ pour lever les objections." },
    { id:'conv_urgency',   cat:'Conversion', pts:4,  ok:urgencyOk, jsDependent:true,
      label:`Urgency trigger détecté`,
      reco: "Utilise des mots d'urgence (limité, exclusif, aujourd'hui…)." },
    { id:'tech_https',     cat:'Technique',  pts:8,  ok:httpsOk,
      label:`HTTPS activé`,
      reco: "Passe ton site en HTTPS." },
    { id:'tech_ogt',       cat:'Technique',  pts:6,  ok:ogTitleOk,
      label:`Open Graph og:title présent`,
      reco: `Ajoute <meta property="og:title" content="...">.` },
    { id:'tech_ogi',       cat:'Technique',  pts:6,  ok:ogImageOk,
      label:`Open Graph og:image présent`,
      reco: "Ajoute une image Open Graph." },
    { id:'tech_fav',       cat:'Technique',  pts:5,  ok:faviconOk,
      label:`Favicon présente`,
      reco: `Ajoute <link rel="icon" href="...">.` },
    { id:'cont_words',     cat:'Contenu',    pts:8,  ok:wordsOk,   jsDependent:true,
      label:`Contenu > 300 mots (${wordCount} détectés)`,
      reco: "Enrichis ton contenu — Google favorise les pages avec +300 mots." },
    { id:'cont_img',       cat:'Contenu',    pts:5,  ok:imgOk,     jsDependent:true,
      label:`Au moins 1 image présente`,
      reco: "Ajoute des images pour rendre ta page plus engageante." },
    { id:'cont_alt',       cat:'Contenu',    pts:7,  ok:altOk,     jsDependent:true,
      label:`Alt text > 50% des images (${altPct}%)`,
      reco: "Ajoute des attributs alt descriptifs à tes images." },
    { id:'cont_int',       cat:'Contenu',    pts:5,  ok:intLinkOk, jsDependent:true,
      label:`Lien interne présent`,
      reco: "Ajoute des liens internes pour renforcer ton maillage SEO." },
    { id:'brand_font',     cat:'Branding',   pts:5,  ok:fontOk,
      label:`Police custom détectée`,
      reco: "Intègre une police de marque via Google Fonts ou @font-face." },
    { id:'brand_theme',    cat:'Branding',   pts:3,  ok:themeColorOk,
      label:`Meta theme-color présent`,
      reco: `Ajoute <meta name="theme-color" content="#COULEUR">.` },
    { id:'brand_manifest', cat:'Branding',   pts:4,  ok:manifestOk,
      label:`Manifest.json lié dans le head`,
      reco: `Ajoute <link rel="manifest" href="/manifest.json">.` },
    { id:'brand_colors',   cat:'Branding',   pts:4,  ok:fewColorsOk, jsDependent:true,
      label:`Cohérence couleurs inline (${inlineColors.size} détectées)`,
      reco: "Utilise des classes CSS plutôt que des couleurs inline." },
    { id:'brand_links',    cat:'Branding',   pts:4,  ok:noPlaceholderOk, jsDependent:true,
      label:`Aucun lien vide href="#" détecté`,
      reco: `${placeholderCount} lien(s) placeholder — remplace les href="#" par de vraies URLs.` },
  ];

  if (isJsHeavy) checks.forEach(c => { if (c.jsDependent) c.skip = true; });

  const cats = {
    SEO:        { score:0, max:25, verifiableMax:0, checks:[] },
    Conversion: { score:0, max:25, verifiableMax:0, checks:[] },
    Technique:  { score:0, max:25, verifiableMax:0, checks:[] },
    Contenu:    { score:0, max:25, verifiableMax:0, checks:[] },
    Branding:   { score:0, max:20, verifiableMax:0, checks:[] },
  };
  let rawTotal = 0;
  let rawMax   = 0;
  checks.forEach(c => {
    if (!c.skip) {
      rawMax += c.pts;
      cats[c.cat].verifiableMax += c.pts;
      if (c.ok) { rawTotal += c.pts; cats[c.cat].score += c.pts; }
    }
    cats[c.cat].checks.push(c);
  });

  const total          = rawMax > 0 ? Math.round(rawTotal / rawMax * 100) : 0;
  const verifiableCount = checks.filter(c => !c.skip).length;
  const priorites      = checks.filter(c => !c.skip && !c.ok).sort((a,b) => b.pts - a.pts).slice(0, 3);

  return { total, cats, priorites, isJsHeavy, verifiableCount };
}

// ──────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────

// POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante.' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Fetch with timeout via AbortController
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);

  let rawHtml = '';
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiovaBot/1.0)' }
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error('Site inaccessible');

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) {
      throw new Error('Le site ne retourne pas du HTML');
    }

    rawHtml = await response.text();
  } catch (err) {
    clearTimeout(timeout);
    return res.status(200).json({ error: 'Site inaccessible ou bloque les analyses externes' });
  }

  const $ = cheerio.load(rawHtml);
  const result = analyse($, url, rawHtml);

  // Persist to db.json
  const db    = readDb();
  const entry = {
    id:    Date.now(),
    url,
    score: result.total,
    date:  new Date().toISOString(),
    email: null,
    isJsHeavy: result.isJsHeavy
  };
  db.push(entry);
  writeDb(db);

  res.json({
    id:               entry.id,
    score:            result.total,
    categories:       result.cats,
    priorites:        result.priorites,
    isJsHeavy:        result.isJsHeavy,
    verifiableCount:  result.verifiableCount
  });
});

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const { email, url, score, id } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }

  // Brevo API call
  try {
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key':      BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json'
      },
      body: JSON.stringify({
        email,
        listIds: [BREVO_LIST_ID],
        attributes: {
          URL_ANALYSEE: url   || '',
          SCORE:        String(score || ''),
          PRENOM:       ''
        },
        updateEnabled: true
      })
    });
  } catch {
    // Silently fail — ne bloque pas la réponse
  }

  // Update db.json
  const db = readDb();
  // Match by id if provided, otherwise by url + recent entry
  const idx = id
    ? db.findIndex(e => e.id === id)
    : db.findLastIndex(e => e.url === url);
  if (idx !== -1) { db[idx].email = email; writeDb(db); }

  res.json({ success: true });
});

// Auth middleware pour /api/leads et /api/dashboard
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

// GET /api/leads
app.get('/api/leads', requireAdmin, (req, res) => {
  res.json(readDb());
});

// GET /api/leads/export.csv
app.get('/api/leads/export.csv', requireAdmin, (req, res) => {
  const db = readDb();
  const rows = [['Date','URL','Score','Email','JS Heavy']];
  db.forEach(e => rows.push([
    e.date, e.url, e.score, e.email || '', e.isJsHeavy ? 'oui' : 'non'
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="liova-leads.csv"');
  res.send(csv);
});

// GET /api/dashboard
app.get('/api/dashboard', requireAdmin, (req, res) => {
  const db           = readDb();
  const total        = db.length;
  const withEmail    = db.filter(e => e.email).length;
  const captureRate  = total > 0 ? Math.round(withEmail / total * 100) : 0;
  const filter       = req.query.filter || 'all';

  const filtered = filter === 'low'  ? db.filter(e => e.score <  60)
                 : filter === 'mid'  ? db.filter(e => e.score >= 60 && e.score <= 75)
                 : filter === 'high' ? db.filter(e => e.score >  75)
                 : db;

  const recent = [...filtered].reverse().slice(0, 20);

  const badgeColor = s => s < 60 ? '#FF4D4D' : s <= 75 ? '#EF9F27' : '#00E5A0';

  const rows = recent.map(e => `
    <tr>
      <td>${new Date(e.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}</td>
      <td><a href="${e.url}" target="_blank" style="color:#6C63FF">${e.url}</a></td>
      <td><span style="background:${badgeColor(e.score)};color:#fff;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700">${e.score}</span></td>
      <td style="color:${e.email ? '#00E5A0' : '#8888AA'}">${e.email || '—'}</td>
    </tr>`).join('');

  const filterBtn = (val, label) =>
    `<a href="/api/dashboard?key=${ADMIN_KEY}&filter=${val}" style="padding:7px 16px;border-radius:8px;background:${filter===val?'#6C63FF':'rgba(255,255,255,0.06)'};color:#fff;text-decoration:none;font-size:13px">${label}</a>`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liova Studio — Leads Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#0A0A0F;color:#F0F0F5;padding:32px 20px;-webkit-font-smoothing:antialiased}
  h1{font-family:'Instrument Serif',serif;font-size:26px;margin-bottom:6px}
  .sub{color:#8888AA;font-size:13px;margin-bottom:32px}
  .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}
  .metric{background:#111118;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:20px}
  .metric-val{font-family:'Instrument Serif',serif;font-size:36px;color:#6C63FF}
  .metric-label{font-size:12px;color:#8888AA;margin-top:4px}
  .filters{display:flex;gap:8px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;background:#111118;border-radius:14px;overflow:hidden}
  th{text-align:left;padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8888AA;border-bottom:1px solid rgba(255,255,255,0.06)}
  td{padding:12px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .export{display:inline-block;margin-top:20px;padding:10px 20px;background:rgba(255,255,255,0.06);border-radius:8px;color:#8888AA;text-decoration:none;font-size:13px}
  .export:hover{color:#fff}
  @media(max-width:600px){.metrics{grid-template-columns:1fr}.metric-val{font-size:28px}}
</style>
</head>
<body>
<h1>Leads Dashboard</h1>
<div class="sub">Liova Studio — Outil d'analyse de site web</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-val">${total}</div>
    <div class="metric-label">Total analyses</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:#00E5A0">${withEmail}</div>
    <div class="metric-label">Leads capturés</div>
  </div>
  <div class="metric">
    <div class="metric-val" style="color:#EF9F27">${captureRate}%</div>
    <div class="metric-label">Taux de capture</div>
  </div>
</div>

<div class="filters">
  ${filterBtn('all', 'Tous')}
  ${filterBtn('low', 'Score < 60')}
  ${filterBtn('mid', '60 – 75')}
  ${filterBtn('high', '> 75')}
</div>

<table>
  <thead>
    <tr>
      <th>Date</th><th>URL</th><th>Score</th><th>Email</th>
    </tr>
  </thead>
  <tbody>${rows || '<tr><td colspan="4" style="color:#8888AA;text-align:center;padding:32px">Aucune entrée</td></tr>'}</tbody>
</table>

<a href="/api/leads/export.csv?key=${ADMIN_KEY}" class="export">⬇ Exporter CSV</a>
</body>
</html>`;

  res.send(html);
});

// ──────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Liova Analyzer running on http://localhost:${PORT}`);
});
