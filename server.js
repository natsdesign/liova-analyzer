require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const fetch     = require('node-fetch');
const cheerio   = require('cheerio');
const path      = require('path');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY     = process.env.BREVO_API_KEY     || '';
const BREVO_LIST_ID     = parseInt(process.env.BREVO_LIST_ID || '3', 10);
const ADMIN_KEY         = process.env.ADMIN_KEY         || 'admin';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DB_PATH           = path.join(__dirname, 'db.json');

// Cache du dernier HTML analysé — fallback si le frontend ne renvoie pas htmlContent
let lastHtmlContent = '';

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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use(cors({ origin: true, credentials: true }));

app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes — réessaie dans une heure.' }
});
app.use('/api/analyze', limiter);
app.use('/api/analyze-ai', limiter);

// ──────────────────────────────────────────────────────────────
// Analysis engine
// ──────────────────────────────────────────────────────────────
function analyse($, url, rawHtml) {
  const bodyText = $('body').text() || '';
  const bodyLow  = bodyText.toLowerCase();
  const bodyHtml = $('body').html() || '';

  // ── CAT 1 : Clarté du tunnel (25 pts) ──────────────────────

  // 1a (8 pts) — CTA above the fold
  const actionVerbsRx = /démarrer|demarrer|essayer|réserver|reserver|obtenir|découvrir|decouvrir|lancer|commencer|accéder|acceder|inscrire|candidater|prendre/i;
  const firstChunk    = bodyHtml.slice(0, 3000).toLowerCase();
  const ctaAboveFoldOk = /<button|<a\s[^>]*href/.test(firstChunk) && actionVerbsRx.test(firstChunk);

  // 1b (6 pts) — Un seul objectif (landing pure ou ≤ 5 liens nav)
  const navLinkCount    = $('nav a').length;
  const singleObjectiveOk = $('nav').length === 0 || navLinkCount <= 5;

  // 1c (6 pts) — ≥ 2 CTA avec verbe fort sur toute la page
  let actionCtaCount = 0;
  $('button, a').each((_, el) => {
    if (actionVerbsRx.test($(el).text())) actionCtaCount++;
  });
  const strongCtaOk = actionCtaCount >= 2;

  // 1d (5 pts) — Peu de distractions (< 3 liens externes)
  let domain = '';
  try { domain = new URL(url).hostname; } catch {}
  let extLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('http') && domain && !href.includes(domain)) extLinks++;
  });
  const noDistractionsOk = extLinks < 3;

  // ── CAT 2 : Clarté de l'offre (25 pts) ─────────────────────

  // 2a (8 pts) — H1 orienté bénéfice (> 5 mots)
  const h1Text  = $('h1').first().text().trim();
  const h1Ok    = h1Text.split(/\s+/).filter(w => w.length > 0).length > 5;

  // 2b (6 pts) — Sous-titre présent (> 8 mots)
  let subtitleOk = false;
  $('h2, p').each((_, el) => {
    if ($(el).text().trim().split(/\s+/).filter(w => w.length > 0).length > 8) {
      subtitleOk = true;
      return false; // break
    }
  });

  // 2c (6 pts) — Prix visible
  const priceRx = /€|EUR|\$|USD|prix|tarif|offre|\/mois|\/an|gratuit|freemium/i;
  const priceOk = priceRx.test(bodyText) || priceRx.test(rawHtml);

  // 2d (5 pts) — Section d'explication
  const explainRx = /comment|ce qui est inclus|fonctionn|étapes|etapes|pourquoi|bénéfices|benefices|avantages/i;
  const explanationOk = $('h2, h3').toArray().some(el => explainRx.test($(el).text()));

  // ── CAT 3 : Confiance & Crédibilité (25 pts) ───────────────

  // 3a (8 pts) — Preuve sociale
  const socialProofRx  = /témoignage|temoignage|avis|client|ils nous font|confiance|résultats|resultats|cas client|★|⭐|\/5|satisfaction/i;
  const socialProofOk  = socialProofRx.test(bodyText) || /\+\d+/.test(bodyText);

  // 3b (6 pts) — Élément humain (photo/vidéo)
  const humanAltRx = /fondateur|équipe|equipe|team|photo|portrait/i;
  const humanOk    = $('img').toArray().some(img => humanAltRx.test($(img).attr('alt') || ''))
                   || $('video').length > 0;

  // 3c (6 pts) — FAQ
  const faqRx = /faq|question|fréquemment|frequemment|vous demandez/i;
  const faqOk = $('h2, h3').toArray().some(el => faqRx.test($(el).text().toLowerCase()));

  // 3d (5 pts) — Garantie ou engagement
  const guaranteeRx = /garanti|remboursé|rembourse|satisfait|engagement|sans risque|essai gratuit|annuler/i;
  const guaranteeOk = guaranteeRx.test(bodyLow);

  // ── CAT 4 : Branding & Cohérence (15 pts) ──────────────────

  // 4a (5 pts) — Police custom
  const fontOk = $('link[href*="fonts.googleapis.com"]').length > 0
               || rawHtml.includes('@font-face');

  // 4b (5 pts) — Cohérence couleurs (< 6 couleurs hex uniques inline)
  const inlineColors = new Set();
  $('[style]').each((_, el) => {
    const s = $(el).attr('style') || '';
    (s.match(/#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)/g) || [])
      .forEach(c => inlineColors.add(c.toLowerCase()));
  });
  const colorCohesionOk = inlineColors.size < 6;

  // 4c (2 pts) — Favicon
  const faviconOk = $('link[rel*="icon"]').length > 0;

  // 4d (3 pts) — HTTPS
  const httpsOk = url.startsWith('https://');

  // ── CAT 5 : Architecture de base (10 pts) ──────────────────

  // 5a (4 pts) — Title présent et non vide
  const titleOk = $('title').first().text().trim().length > 5;

  // 5b (3 pts) — Meta description présente
  const metaOk = ($('meta[name="description"]').attr('content') || '').trim().length > 0;

  // 5c (3 pts) — Un seul H1
  const singleH1Ok = $('h1').length === 1;

  // ── JS-heavy detection ──────────────────────────────────────
  const jsMarkers = ['__NEXT_DATA__', '__nuxt', 'data-reactroot', 'ng-version', '__NUXT__'];
  const isJsHeavy = bodyText.trim().length < 500 || jsMarkers.some(m => rawHtml.includes(m));

  // ── Checks array ────────────────────────────────────────────
  const checks = [
    // CAT 1 — Clarté du tunnel (25 pts)
    { id:'tunnel_cta_fold',    cat:'tunnel',       pts:8, ok:ctaAboveFoldOk,    jsDependent:true, label:'CTA visible au-dessus de la fold' },
    { id:'tunnel_single_obj',  cat:'tunnel',       pts:6, ok:singleObjectiveOk,                   label:'Navigation simplifiée (≤5 liens nav)' },
    { id:'tunnel_strong_cta',  cat:'tunnel',       pts:6, ok:strongCtaOk,       jsDependent:true, label:'≥2 CTA avec verbe d\'action fort' },
    { id:'tunnel_no_distract', cat:'tunnel',       pts:5, ok:noDistractionsOk,                    label:'Peu de liens externes (<3)' },
    // CAT 2 — Clarté de l'offre (25 pts)
    { id:'offre_h1',           cat:'offre',        pts:8, ok:h1Ok,              jsDependent:true, label:'H1 orienté bénéfice (>5 mots)' },
    { id:'offre_subtitle',     cat:'offre',        pts:6, ok:subtitleOk,        jsDependent:true, label:'Sous-titre présent (>8 mots)' },
    { id:'offre_price',        cat:'offre',        pts:6, ok:priceOk,           jsDependent:true, label:'Prix ou tarif visible' },
    { id:'offre_explain',      cat:'offre',        pts:5, ok:explanationOk,     jsDependent:true, label:'Section d\'explication présente' },
    // CAT 3 — Confiance & Crédibilité (25 pts)
    { id:'trust_social',       cat:'confiance',    pts:8, ok:socialProofOk,     jsDependent:true, label:'Preuve sociale détectée' },
    { id:'trust_human',        cat:'confiance',    pts:6, ok:humanOk,           jsDependent:true, label:'Élément humain (photo/vidéo)' },
    { id:'trust_faq',          cat:'confiance',    pts:6, ok:faqOk,             jsDependent:true, label:'Section FAQ présente' },
    { id:'trust_guarantee',    cat:'confiance',    pts:5, ok:guaranteeOk,       jsDependent:true, label:'Garantie ou engagement mentionné' },
    // CAT 4 — Branding & Cohérence (15 pts)
    { id:'brand_font',         cat:'branding',     pts:5, ok:fontOk,                              label:'Police custom détectée' },
    { id:'brand_colors',       cat:'branding',     pts:5, ok:colorCohesionOk,   jsDependent:true, label:'Cohérence couleurs (<6 couleurs inline)' },
    { id:'brand_favicon',      cat:'branding',     pts:2, ok:faviconOk,                           label:'Favicon présente' },
    { id:'brand_https',        cat:'branding',     pts:3, ok:httpsOk,                             label:'HTTPS activé' },
    // CAT 5 — Architecture de base (10 pts)
    { id:'arch_title',         cat:'architecture', pts:4, ok:titleOk,                             label:'Title présent et non vide' },
    { id:'arch_meta',          cat:'architecture', pts:3, ok:metaOk,                              label:'Meta description présente' },
    { id:'arch_h1',            cat:'architecture', pts:3, ok:singleH1Ok,        jsDependent:true, label:'Un seul H1' },
  ];

  if (isJsHeavy) checks.forEach(c => { if (c.jsDependent) c.skip = true; });

  const catDefs = {
    tunnel:       { score:0, max:25, verifiableMax:0 },
    offre:        { score:0, max:25, verifiableMax:0 },
    confiance:    { score:0, max:25, verifiableMax:0 },
    branding:     { score:0, max:15, verifiableMax:0 },
    architecture: { score:0, max:10, verifiableMax:0 },
  };

  let rawTotal = 0, rawMax = 0;
  checks.forEach(c => {
    if (!c.skip) {
      rawMax += c.pts;
      catDefs[c.cat].verifiableMax += c.pts;
      if (c.ok) { rawTotal += c.pts; catDefs[c.cat].score += c.pts; }
    }
  });

  const total           = rawMax > 0 ? Math.round(rawTotal / rawMax * 100) : 0;
  const verifiableCount = checks.filter(c => !c.skip).length;

  const details = {};
  checks.forEach(c => { details[c.id] = !!c.ok; });

  return { total, catDefs, details, isJsHeavy, verifiableCount };
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
    lastHtmlContent = rawHtml.slice(0, 5000);
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
      scores: {
        tunnel:       result.catDefs.tunnel.score,
        offre:        result.catDefs.offre.score,
        confiance:    result.catDefs.confiance.score,
        branding:     result.catDefs.branding.score,
        architecture: result.catDefs.architecture.score,
      },
      details:         result.details,
      isJsHeavy:       result.isJsHeavy,
      verifiableCount: result.verifiableCount,
      htmlContent:     rawHtml.slice(0, 5000)
    });
  } catch (err) {
    clearTimeout(timeout);
    return res.status(200).json({
      score: 0,
      error: 'Ce site est inaccessible ou bloque les analyses externes.'
    });
  }
});

// POST /api/analyze-ai
// Appelé après soumission email. Fait appel à l'API Anthropic puis envoie à Brevo.
app.post('/api/analyze-ai', async (req, res) => {
  const { email, url, score, scores, details, id } = req.body;
  const htmlContent = req.body.htmlContent || lastHtmlContent;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }

  // Labels lisibles pour les critères
  const criteriaLabels = {
    tunnel_cta_fold:    'CTA visible au-dessus de la fold',
    tunnel_single_obj:  'Navigation simplifiée (≤5 liens nav)',
    tunnel_strong_cta:  '≥2 CTA avec verbe d\'action fort',
    tunnel_no_distract: 'Peu de liens externes (<3)',
    offre_h1:           'H1 orienté bénéfice (>5 mots)',
    offre_subtitle:     'Sous-titre présent (>8 mots)',
    offre_price:        'Prix ou tarif visible',
    offre_explain:      'Section d\'explication présente',
    trust_social:       'Preuve sociale détectée',
    trust_human:        'Élément humain (photo/vidéo)',
    trust_faq:          'Section FAQ présente',
    trust_guarantee:    'Garantie ou engagement mentionné',
    brand_font:         'Police custom détectée',
    brand_colors:       'Cohérence couleurs (<6 couleurs inline)',
    brand_favicon:      'Favicon présente',
    brand_https:        'HTTPS activé',
    arch_title:         'Title présent et non vide',
    arch_meta:          'Meta description présente',
    arch_h1:            'Un seul H1',
  };

  const failedCriteria = Object.entries(details || {})
    .filter(([, ok]) => !ok)
    .map(([cid]) => `- ${criteriaLabels[cid] || cid}`)
    .join('\n');

  const sc = scores || {};
  const userPrompt =
`Analyse cette landing page et génère un rapport de conversion.

URL : ${url}
Score global : ${score}/100
Scores par catégorie :
- Clarté du tunnel : ${sc.tunnel || 0}/25
- Clarté de l'offre : ${sc.offre || 0}/25
- Confiance & Crédibilité : ${sc.confiance || 0}/25
- Branding & Cohérence : ${sc.branding || 0}/15
- Architecture de base : ${sc.architecture || 0}/10

Critères échoués :
${failedCriteria || 'Aucun'}

Extrait du HTML de la page (premiers 3000 chars) :
${(htmlContent || '').slice(0, 3000)}

Génère UNIQUEMENT ce JSON, rien d'autre :
{
  "diagnostic": "Une phrase percutante qui résume le vrai problème de cette landing en termes business (pas technique). Max 25 mots.",
  "priorite_1": {
    "titre": "Titre court du problème (5 mots max)",
    "explication": "Pourquoi ce problème coûte des leads concrètement. 2 phrases max. Direct.",
    "action": "Une action concrète à faire cette semaine. Commence par un verbe."
  },
  "priorite_2": {
    "titre": "...",
    "explication": "...",
    "action": "..."
  },
  "priorite_3": {
    "titre": "...",
    "explication": "...",
    "action": "..."
  },
  "point_fort": "Un vrai point positif de la page. Honnête, pas générique. 1 phrase.",
  "conclusion": "Message de closing qui donne envie de passer à l'action. Émotionnel. 2 phrases max."
}`;

  // ── Appel Anthropic ──────────────────────────────────────────
  let aiResult = null;
  const ctrl      = new AbortController();
  const aiTimeout = setTimeout(() => ctrl.abort(), 30000); // 30s

  console.log('Anthropic call started:', new Date().toISOString());
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        system:     'Tu es un expert en conversion de landing pages pour agences et startups. Tu analyses des landing pages et fournis des recommandations concrètes, directes et actionnables. Tu tutoies toujours. Tu ne fais jamais de compliments génériques. Tes recommandations sont précises et basées sur les données fournies. Tu réponds UNIQUEMENT en JSON.',
        messages:   [{ role: 'user', content: userPrompt }]
      })
    });
    clearTimeout(aiTimeout);
    console.log('Anthropic call ended:', new Date().toISOString());

    const anthropicData = await aiRes.json();
    console.log('=== ANTHROPIC RESPONSE ===');
    console.log('status:', aiRes.status);
    console.log('data:', JSON.stringify(anthropicData));

    if (!aiRes.ok) {
      console.error('Anthropic error:', anthropicData);
    } else {
      const rawText = anthropicData.content?.[0]?.text || '';
      const match   = rawText.match(/\{[\s\S]*\}/);
      if (match) aiResult = JSON.parse(match[0]);
    }
  } catch (err) {
    clearTimeout(aiTimeout);
    console.error('Anthropic fetch error:', err.message);
    console.log('Anthropic call ended (error):', new Date().toISOString());
  }

  // ── Envoi Brevo ──────────────────────────────────────────────
  const p1 = aiResult?.priorite_1 ? `${aiResult.priorite_1.titre} : ${aiResult.priorite_1.action}` : '';
  const p2 = aiResult?.priorite_2 ? `${aiResult.priorite_2.titre} : ${aiResult.priorite_2.action}` : '';
  const p3 = aiResult?.priorite_3 ? `${aiResult.priorite_3.titre} : ${aiResult.priorite_3.action}` : '';

  const listId = score < 50 ? 7 : score <= 75 ? 8 : 9;
  console.log('=== BREVO PAYLOAD ===');
  console.log('email:', email);
  console.log('score:', score);
  console.log('listId:', listId);
  console.log('aiResult:', JSON.stringify(aiResult));
  console.log('scores:', JSON.stringify(scores));

  try {
    const brevoResponse = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key':      BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json'
      },
      body: JSON.stringify({
        email,
        listIds: [listId],
        attributes: {
          URL_ANALYSEE:       url                                                                    || '',
          SCORE:              parseInt(score)                                                        || 0,
          SCORE_SEGMENT:      score < 50 ? 'A' : score <= 75 ? 'B' : 'C',
          SCORE_TUNNEL:       parseInt(sc.tunnel)                                                   || 0,
          SCORE_OFFRE:        parseInt(sc.offre)                                                    || 0,
          SCORE_CONFIANCE:    parseInt(sc.confiance)                                               || 0,
          SCORE_BRANDING:     parseInt(sc.branding)                                                || 0,
          SCORE_ARCHITECTURE: parseInt(sc.architecture)                                            || 0,
          DIAGNOSTIC:         aiResult?.diagnostic                                                  || '',
          PRIORITE_1:         aiResult?.priorite_1 ? `${aiResult.priorite_1.titre} : ${aiResult.priorite_1.action}` : '',
          PRIORITE_2:         aiResult?.priorite_2 ? `${aiResult.priorite_2.titre} : ${aiResult.priorite_2.action}` : '',
          PRIORITE_3:         aiResult?.priorite_3 ? `${aiResult.priorite_3.titre} : ${aiResult.priorite_3.action}` : '',
          POINT_FORT:         aiResult?.point_fort                                                  || '',
          CONCLUSION:         aiResult?.conclusion                                                  || '',
        },
        updateEnabled: true
      })
    });
    console.log('=== BREVO RESPONSE ===');
    console.log('status:', brevoResponse.status);
    const brevoBody = await brevoResponse.text();
    console.log('body:', brevoBody);
  } catch (err) {
    console.log('=== BREVO ERROR ===', err.message);
  }

  // ── Mise à jour db.json ──────────────────────────────────────
  const db  = readDb();
  const idx = id
    ? db.findIndex(e => e.id === id)
    : db.findLastIndex(e => e.url === url);
  if (idx !== -1) {
    db[idx].email      = email;
    db[idx].diagnostic = aiResult?.diagnostic || null;
    writeDb(db);
  }

  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────
// Admin routes
// ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

app.get('/api/leads', requireAdmin, (req, res) => {
  res.json(readDb());
});

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

app.get('/api/dashboard', requireAdmin, (req, res) => {
  const db          = readDb();
  const total       = db.length;
  const withEmail   = db.filter(e => e.email).length;
  const captureRate = total > 0 ? Math.round(withEmail / total * 100) : 0;
  const filter      = req.query.filter || 'all';

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
  <div class="metric"><div class="metric-val">${total}</div><div class="metric-label">Total analyses</div></div>
  <div class="metric"><div class="metric-val" style="color:#00E5A0">${withEmail}</div><div class="metric-label">Leads capturés</div></div>
  <div class="metric"><div class="metric-val" style="color:#EF9F27">${captureRate}%</div><div class="metric-label">Taux de capture</div></div>
</div>
<div class="filters">
  ${filterBtn('all','Tous')}${filterBtn('low','Score < 60')}${filterBtn('mid','60 – 75')}${filterBtn('high','> 75')}
</div>
<table>
  <thead><tr><th>Date</th><th>URL</th><th>Score</th><th>Email</th></tr></thead>
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
