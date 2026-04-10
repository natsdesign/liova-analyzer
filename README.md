# Liova Analyzer

Outil d'analyse de site web — Liova Studio.

## Déploiement sur Railway

### 1. Prérequis
- Compte [Railway](https://railway.app)
- Repo GitHub connecté

### 2. Déployer

1. **New Project** → "Deploy from GitHub repo" → sélectionner `liova-analyzer`
2. Railway détecte Node.js automatiquement via `package.json`

### 3. Variables d'environnement

Dans Railway → ton projet → **Variables** :

| Variable | Valeur |
|---|---|
| `BREVO_API_KEY` | Ta clé API Brevo |
| `BREVO_LIST_ID` | `3` |
| `ADMIN_KEY` | Un mot de passe de ton choix |
| `PORT` | *(laisse vide, Railway le gère)* |

### 4. URL Railway

Une fois déployé, Railway génère une URL du type :
`https://liova-analyzer-production.up.railway.app`

→ Utiliser cette URL dans Framer comme source d'embed.

### 5. Dashboard leads

Accessible sur :
```
https://ton-url-railway.up.railway.app/api/dashboard?key=TON_ADMIN_KEY
```

## Développement local

```bash
# Installer les dépendances
npm install

# Créer le fichier .env
cp .env.example .env
# → Édite .env avec tes vraies valeurs

# Lancer le serveur
npm start
# → http://localhost:3000
```

## Structure

```
liova-analyzer/
├── server.js          # Backend Express
├── package.json
├── .env               # Variables locales (jamais committé)
├── .env.example       # Modèle de variables
├── .gitignore
├── db.json            # Créé automatiquement au premier run
└── public/
    └── index.html     # Frontend
```

## Attributs Brevo à créer manuellement

Dans Brevo → **Contacts → Attributs** → "Créer un attribut" (type Texte) :

| Attribut | Type |
|---|---|
| `URL_ANALYSEE` | Texte |
| `SCORE` | Texte |
| `SCORE_SEO` | Texte |
| `SCORE_CONVERSION` | Texte |
| `SCORE_TECHNIQUE` | Texte |
| `SCORE_CONTENU` | Texte |
| `SCORE_BRANDING` | Texte |
| `PRIORITE_1` | Texte |
| `PRIORITE_2` | Texte |
| `PRIORITE_3` | Texte |

Ces attributs sont utilisés pour personnaliser l'email 1 de la séquence.

## Routes API

| Route | Méthode | Description |
|---|---|---|
| `/api/analyze` | POST | Analyse une URL, retourne le score |
| `/api/contact` | POST | Enregistre un email dans Brevo |
| `/api/leads` | GET | Liste tous les leads (header `x-admin-key` requis) |
| `/api/leads/export.csv` | GET | Export CSV des leads |
| `/api/dashboard` | GET | Dashboard HTML des leads |
