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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

const corsOptions = {
  origin: true,
  credentials: true
};

app.use(cors(corsOptions));

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
  // CTA above fold : button ou form dans les 3000 premiers chars du body HTML
  const bodyHtml = $('body').html() || '';
  const ctaAboveFoldOk = /(<button|<form|<a[^>]+(btn|cta))/i.test(bodyHtml.slice(0, 3000));

  // Proposition de valeur : H1 > 5 mots
  const h1Text = $('h1').first().text().trim();
  const valuePropOk = h1Text.split(/\s+/).filter(w => w.length > 0).length > 5;

  // Social proof
  const spWords = ['témoignage','temoignage','avis','clients','résultats','resultats','cas client','ils nous font confiance','testimonial','review'];
  const spOk = spWords.some(w => bodyLow.includes(w));

  // CTA focalisé : 1 formulaire OU (0 formulaire + < 3 boutons)
  const formCount   = $('form').length;
  const buttonCount = $('button, [role="button"]').length;
  const focusedCtaOk = formCount === 1 || (formCount === 0 && buttonCount > 0 && buttonCount < 3);

  // Urgency trigger
  const urgencyWords = ["limité","limite","offre","places","aujourd'hui","maintenant","exclusif","dernier","dernière","derniere","urgent","expire"];
  const urgencyOk = urgencyWords.some(w => bodyLow.includes(w));

  // Coordonnées de contact
  const emailRx   = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
  const telRx     = /(\+33|0)[1-9][\s.\-]?(\d{2}[\s.\-]?){3}\d{2}/;
  const contactOk = emailRx.test(bodyText) || telRx.test(bodyText);

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

  const priorityMessages = {
    title_missing:    "Ton site n'a pas de titre — Google ne peut pas le référencer correctement",
    title_short:      "Ton titre de page est trop court — tu perds de la visibilité sur Google",
    title_long:       "Ton titre de page est trop long — Google le coupe dans les résultats",
    meta_missing:     "Aucune description de page — les visiteurs ne savent pas ce qu'ils vont trouver avant de cliquer",
    meta_short:       "Ta description de page est trop courte — tu rates des clics sur Google",
    meta_long:        "Ta description de page est trop longue — Google la coupe dans les résultats",
    h1_missing:       "Aucun titre principal détecté — Google ne comprend pas le sujet de ta page",
    multiple_h1:      "Plusieurs titres principaux détectés — ça confond Google et dilue ton SEO",
    no_viewport:      "Ton site n'est pas optimisé mobile — tu perds la moitié de tes visiteurs",
    no_cta_above_fold:"Aucun bouton ou formulaire visible au-dessus de la fold — le visiteur ne sait pas comment agir en arrivant",
    no_value_prop:    "Ton titre principal ne communique pas de proposition de valeur claire — le visiteur ne comprend pas ce que tu fais en 3 secondes",
    no_social_proof:  "Aucune preuve sociale (témoignages, avis clients) — difficile de convaincre sans références",
    no_focused_cta:   "Trop de boutons ou aucun — l'attention du visiteur est diluée, ce qui réduit le taux de conversion",
    no_urgency:       "Aucun élément d'urgence ou de rareté — rien ne pousse le visiteur à agir maintenant",
    no_email:         "Aucune information de contact visible — tu perds la confiance des visiteurs",
    no_https:         "Ton site n'est pas sécurisé (pas de HTTPS) — Google le pénalise et les visiteurs fuient",
    no_og_title:      "Ton site n'est pas optimisé pour les réseaux sociaux — les partages sont mal affichés",
    no_og_image:      "Aucune image de partage configurée — tes liens partagés sur LinkedIn/Facebook sont vides",
    no_favicon:       "Pas de favicon — ton site paraît moins professionnel dans les onglets du navigateur",
    low_word_count:   "Contenu trop court — Google favorise les pages avec plus de contenu",
    no_images:        "Aucune image — ton site est peu engageant visuellement",
    low_alt_text:     "Tes images n'ont pas de description — tu rates du trafic Google Images + accessibilité",
    no_internal_links:"Aucun lien interne — Google ne peut pas explorer correctement ton site",
    no_custom_font:   "Aucune police personnalisée — ton identité visuelle paraît générique",
    no_theme_color:   "Pas de couleur de thème configurée — petite perte de cohérence sur mobile",
    no_manifest:      "Site non optimisé comme application mobile (PWA)",
    broken_links:     "Des liens cassés détectés — mauvaise expérience utilisateur et pénalité SEO"
  };

  const checks = [
    // ── SEO (20 pts) ──
    { id:'seo_title',       cat:'SEO',        pts:8,  ok:titleOk,
      msgKey: titleLen===0 ? 'title_missing' : titleLen<30 ? 'title_short' : 'title_long',
      label:`Balise <title> (30–65 chars)` },
    { id:'seo_desc',        cat:'SEO',        pts:6,  ok:descOk,
      msgKey: descLen===0 ? 'meta_missing' : descLen<120 ? 'meta_short' : 'meta_long',
      label:`Meta description (120–160 chars)` },
    { id:'seo_h1',          cat:'SEO',        pts:4,  ok:h1Ok,   jsDependent:true,
      msgKey: h1s.length===0 ? 'h1_missing' : 'multiple_h1',
      label:`Un seul <h1> présent` },
    { id:'seo_vp',          cat:'SEO',        pts:2,  ok:vpOk,
      msgKey: 'no_viewport',
      label:`Meta viewport présent` },
    // ── Conversion (40 pts) ──
    { id:'conv_above_fold', cat:'Conversion', pts:10, ok:ctaAboveFoldOk, jsDependent:true,
      msgKey: 'no_cta_above_fold',
      label:`CTA visible au-dessus de la fold` },
    { id:'conv_value_prop', cat:'Conversion', pts:8,  ok:valuePropOk,    jsDependent:true,
      msgKey: 'no_value_prop',
      label:`Proposition de valeur H1 claire (> 5 mots)` },
    { id:'conv_social',     cat:'Conversion', pts:8,  ok:spOk,           jsDependent:true,
      msgKey: 'no_social_proof',
      label:`Social proof détecté` },
    { id:'conv_focused_cta',cat:'Conversion', pts:6,  ok:focusedCtaOk,   jsDependent:true,
      msgKey: 'no_focused_cta',
      label:`CTA focalisé (1 formulaire ou peu de boutons)` },
    { id:'conv_urgency',    cat:'Conversion', pts:5,  ok:urgencyOk,      jsDependent:true,
      msgKey: 'no_urgency',
      label:`Urgency trigger détecté` },
    { id:'conv_contact',    cat:'Conversion', pts:3,  ok:contactOk,      jsDependent:true,
      msgKey: 'no_email',
      label:`Email ou téléphone visible` },
    // ── Technique (15 pts) ──
    { id:'tech_https',      cat:'Technique',  pts:5,  ok:httpsOk,
      msgKey: 'no_https',
      label:`HTTPS activé` },
    { id:'tech_ogt',        cat:'Technique',  pts:4,  ok:ogTitleOk,
      msgKey: 'no_og_title',
      label:`Open Graph og:title présent` },
    { id:'tech_ogi',        cat:'Technique',  pts:4,  ok:ogImageOk,
      msgKey: 'no_og_image',
      label:`Open Graph og:image présent` },
    { id:'tech_fav',        cat:'Technique',  pts:2,  ok:faviconOk,
      msgKey: 'no_favicon',
      label:`Favicon présente` },
    // ── Contenu (15 pts) ──
    { id:'cont_words',      cat:'Contenu',    pts:6,  ok:wordsOk,   jsDependent:true,
      msgKey: 'low_word_count',
      label:`Contenu > 300 mots (${wordCount} détectés)` },
    { id:'cont_img',        cat:'Contenu',    pts:3,  ok:imgOk,     jsDependent:true,
      msgKey: 'no_images',
      label:`Au moins 1 image présente` },
    { id:'cont_alt',        cat:'Contenu',    pts:4,  ok:altOk,     jsDependent:true,
      msgKey: 'low_alt_text',
      label:`Alt text > 50% des images (${altPct}%)` },
    { id:'cont_int',        cat:'Contenu',    pts:2,  ok:intLinkOk, jsDependent:true,
      msgKey: 'no_internal_links',
      label:`Lien interne présent` },
    // ── Branding (10 pts) ──
    { id:'brand_font',      cat:'Branding',   pts:4,  ok:fontOk,
      msgKey: 'no_custom_font',
      label:`Police custom détectée` },
    { id:'brand_theme',     cat:'Branding',   pts:2,  ok:themeColorOk,
      msgKey: 'no_theme_color',
      label:`Meta theme-color présent` },
    { id:'brand_manifest',  cat:'Branding',   pts:2,  ok:manifestOk,
      msgKey: 'no_manifest',
      label:`Manifest.json lié dans le head` },
    { id:'brand_colors',    cat:'Branding',   pts:1,  ok:fewColorsOk, jsDependent:true,
      msgKey: 'broken_links',
      label:`Cohérence couleurs inline (${inlineColors.size} détectées)` },
    { id:'brand_links',     cat:'Branding',   pts:1,  ok:noPlaceholderOk, jsDependent:true,
      msgKey: 'broken_links',
      label:`Aucun lien vide href="#" détecté` },
  ];

  // Résoudre les messages business sur chaque check
  checks.forEach(c => { c.reco = priorityMessages[c.msgKey] || c.label; });

  if (isJsHeavy) checks.forEach(c => { if (c.jsDependent) c.skip = true; });

  const cats = {
    SEO:        { score:0, max:20, verifiableMax:0, checks:[] },
    Conversion: { score:0, max:40, verifiableMax:0, checks:[] },
    Technique:  { score:0, max:15, verifiableMax:0, checks:[] },
    Contenu:    { score:0, max:15, verifiableMax:0, checks:[] },
    Branding:   { score:0, max:10, verifiableMax:0, checks:[] },
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

  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error('Site inaccessible');

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) {
      throw new Error('Le site ne retourne pas du HTML');
    }

    const rawHtml = await response.text();
    const $       = cheerio.load(rawHtml);
    const result  = analyse($, url, rawHtml);

    const db    = readDb();
    const entry = {
      id:        Date.now(),
      url,
      score:     result.total,
      date:      new Date().toISOString(),
      email:     null,
      isJsHeavy: result.isJsHeavy
    };
    db.push(entry);
    writeDb(db);

    return res.status(200).json({
      id:              entry.id,
      score:           result.total,
      categories:      result.cats,
      priorites:       result.priorites,
      isJsHeavy:       result.isJsHeavy,
      verifiableCount: result.verifiableCount
    });
  } catch (err) {
    clearTimeout(timeout);
    return res.status(200).json({
      score: 0,
      error: 'Ce site est inaccessible ou bloque les analyses externes.'
    });
  }
});

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const {
    email, url, score, id,
    scoreSeo, scoreConversion, scoreTechnique, scoreContenu, scoreBranding,
    priorite1, priorite2, priorite3
  } = req.body;

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
          URL_ANALYSEE:      url               || '',
          SCORE:             String(score      || ''),
          SCORE_SEO:         String(scoreSeo         || ''),
          SCORE_CONVERSION:  String(scoreConversion  || ''),
          SCORE_TECHNIQUE:   String(scoreTechnique   || ''),
          SCORE_CONTENU:     String(scoreContenu     || ''),
          SCORE_BRANDING:    String(scoreBranding    || ''),
          PRIORITE_1:        priorite1 || '',
          PRIORITE_2:        priorite2 || '',
          PRIORITE_3:        priorite3 || ''
        },
        updateEnabled: true
      })
    });
  } catch {
    // Silently fail — ne bloque pas la réponse
  }

  // Update db.json
  const db  = readDb();
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
