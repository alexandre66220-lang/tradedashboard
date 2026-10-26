# Market Dashboard

Dashboard personnel de suivi de marché, **en lecture seule** : graphique en bougies (Lightweight Charts de TradingView) alimenté par l'API Capital.com, avec une prévision expérimentale prolongée dans le futur. Next.js (App Router) + TypeScript, prévu pour Vercel.

> Aucune fonctionnalité de passage d'ordre. Le client Capital.com (`lib/capital.ts`) n'autorise que 3 appels : `POST /api/v1/session`, `GET /api/v1/prices/{epic}` et `GET /api/v1/markets/{epic}`. Tout autre appel est bloqué.

## Variables d'environnement

Copiez `.env.example` en `.env.local` (jamais commité) et renseignez :

| Variable | Rôle |
| --- | --- |
| `CAPITAL_API_KEY` | Clé API Capital.com (Paramètres → API) |
| `CAPITAL_IDENTIFIER` | Identifiant (e-mail) du compte Capital.com |
| `CAPITAL_API_PASSWORD` | Mot de passe **de la clé API** (défini à sa création) |
| `CAPITAL_ENV` | `demo` (défaut) ou `live` |
| `DASHBOARD_PASSWORD` | Mot de passe unique du site. S'il est absent, le site entier est verrouillé (503) |
| `FORECAST_SERVICE_URL` | Optionnel : URL du service de prévision ML (`https://…/api/forecast`), voir `forecast-service/README.md` |
| `BLOB_READ_WRITE_TOKEN` | Optionnel : ajouté automatiquement par Vercel quand un stockage Blob (privé) est relié au projet ; active le journal des prévisions |
| `CRON_SECRET` | Optionnel : longue valeur aléatoire ; autorise le relevé quotidien (`/api/journal/record`, lancé par Vercel Cron) |
| `FORECAST_SERVICE_TOKEN` | Optionnel mais requis avec le service ML : secret partagé, envoyé en `Authorization: Bearer …` (même valeur des deux côtés) |

Sur Vercel : *Project → Settings → Environment Variables*, mêmes noms. Changer `DASHBOARD_PASSWORD` déconnecte toutes les sessions.

## Lancer en local

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # tests unitaires (modèle, parsing)
npm run build      # build de production
```

Sans compte Capital.com, un faux serveur reproduit les endpoints utilisés :

```bash
node scripts/mock-capital.mjs 4010
# puis dans .env.local : CAPITAL_BASE_URL=http://localhost:4010, CAPITAL_API_KEY=test-key,
# CAPITAL_IDENTIFIER=me@test, CAPITAL_API_PASSWORD=pw   (CAPITAL_BASE_URL : tests uniquement)
```

## Ajouter un instrument

Une ligne dans `config/instruments.ts` :

```ts
{ name: "Argent", epic: "SILVER", defaultHorizon: 30 },
```

Instruments actuels : or (`GOLD`), pétrole WTI (`OIL_CRUDE`), bitcoin (`BTCUSD`). Le sélecteur d'actif apparaît automatiquement dès qu'il y a au moins deux instruments, et chaque instrument a sa ligne dans le panneau « Prévisions jour / semaine ». Pour trouver l'epic exact, cherchez le marché dans la plateforme Capital.com ou via `GET /api/v1/markets?searchTerm=...`.

## Prévision

`GET /api/forecast?epic=GOLD&resolution=5&horizon=30` renvoie :

```json
{ "points": [{ "time": 1730000000, "value": 2650.1, "low": 2648.2, "high": 2652.0 }],
  "direction": "up", "confidence": 0.56, "backtestHitRate": 0.51, "backtestSamples": 640, "source": "intégré" }
```

`time` est en secondes UTC ; `resolution` vaut `1`, `5` ou `15` (minutes).

**Modèle intégré** (`lib/forecast/builtin.ts`) : pente d'une régression linéaire pondérée (exponentiellement) sur les 48 dernières clôtures en log, réduite de moitié ; bande = ±1,28 × volatilité récente × √pas (~80 %). La direction est « neutre » si le mouvement attendu est faible devant le bruit. Le taux de réussite est un backtest de cette même fonction sur l'historique chargé (directions neutres exclues). Aucune promesse de précision.

### Journal des prévisions en direct

Le backtest rejoue le passé ; le journal juge les prévisions **en conditions réelles**. Pour chaque instrument et chaque horizon, une prévision est enregistrée à l'avance par fenêtre d'horizon (donc sans chevauchement : une toutes les 30 min, une par jour, une par semaine), puis comparée au vrai prix à l'échéance, avec la même définition que le backtest (clôtures finales, bougies décalées de `horizon / résolution`).

- **Où** : un fichier JSON par série dans un stockage Vercel Blob **privé** (`journal/<epic>__<résolution>__<horizon>.json`), mis à jour avec contrôle d'ETag (pas de perte en cas d'écritures simultanées), 1 500 entrées maximum par série.
- **Quand** : à l'ouverture du graphique (route `/api/forecast`, tableau jour/semaine) et chaque jour à 7 h UTC par Vercel Cron (`/api/journal/record`, protégé par `CRON_SECRET`). L'offre gratuite de Vercel limite les tâches planifiées à une par jour : les prévisions à 30 min ne sont donc enregistrées que quand le dashboard est consulté.
- **Affichage** : réussite avec marge d'erreur, comparaison aux stratégies naïves, verdict, et **gain simulé net** (une unité par prévision haussière ou baissière, après un spread supposé par instrument : `spreadBps` dans `config/instruments.ts`, sans frais de financement). Les statistiques sont séparées par modèle (ML / intégré). Aucun taux n'est affiché sous 20 prévisions jugées.
- **Limites** : une entrée dont la bougie sort de l'historique chargé (1 000 bougies) avant d'avoir été jugée est marquée « expirée » et ignorée.

### Calculateur de risque

Dans la colonne de droite : à partir du capital, du risque par trade (1 % par défaut) et d'un stop calculé sur l'**ATR** (amplitude moyenne des 14 dernières bougies, × 1,5 par défaut, ou distance manuelle), il donne la taille de position, le stop, l'objectif (rapport gain/risque réglable), la perte maximale, le gain visé et le levier effectif, avec des alertes au-delà de 2 % de risque ou 5× de levier. Les réglages sont mémorisés sur l'appareil. Montants en devise de cotation (USD), spread non inclus.

### Conseil SL / TP

Panneau « Conseil SL / TP » (colonne de droite), calculé dans le navigateur à partir des bougies déjà chargées, sans nouvelle route :

- **Stop** : juste au-delà du dernier creux (achat) ou sommet (vente) détecté sur l'historique récent (pivot confirmé par 3 bougies de chaque côté, niveaux proches regroupés), avec une marge de 0,25 ATR ; entre 0,8 et 3,5 ATR de l'entrée. Sinon 1,5 ATR.
- **Objectifs proposés** : avant le prochain sommet / creux, cible de la prévision du modèle (si elle va dans le sens du trade), et 1, 1,5, 2 et 3 fois le risque. Réglage conseillé (★) : le niveau ou la cible du modèle si son rapport gain/risque est entre 1,5 et 3,5, sinon 1,5 fois le risque.
- **Test sur l'historique** : chaque réglage est rejoué à partir de chaque bougie (entrée à la clôture, sortie au stop, à l'objectif ou après `3 × horizon`) : part touchant l'objectif avant le stop, espérance en R après spread (`spreadBps`), marge d'erreur qui compte une seule fois les entrées qui se chevauchent. Si une bougie touche le stop et l'objectif, le stop est supposé touché en premier. Le même test est fait dans l'autre sens pour repérer l'effet de la tendance récente.
- **Alertes** : prochain obstacle trop proche (moins de 1 fois le risque), stop très large.
- Le bouton « Utiliser dans le calculateur de risque » reporte la distance du stop, le rapport gain/risque et le sens dans le calculateur.

À retenir : sur un prix sans tendance, aucun couple stop/objectif ne crée d'avantage (l'espérance reste égale à moins les frais, ce que vérifie un test). Cet outil sert à placer le risque intelligemment, pas à le faire gagner.

### Lire le backtest

Chaque prévision affiche sa réussite avec une **marge d'erreur à ~95 %** (`51 % ± 10`), puis un verdict :

- **Mieux que le hasard** : réussite moins la marge > 50 %, et meilleure que les stratégies naïves ;
- **Ne bat pas une stratégie naïve** : au-dessus de 50 %, mais pas mieux que « toujours hausse » ou « suit la dernière bougie » ;
- **Pas distinguable du hasard** ou **Moins bon que le hasard**.

La marge tient compte du chevauchement des horizons : à 30 min en bougies de 5 min, des prédictions consécutives portent presque sur le même mouvement, donc seul ~1 cas sur 6 compte comme indépendant. « Détail du backtest » montre aussi les stratégies naïves (testées sur les mêmes cas) et la réussite quand on ne garde que les prédictions dont la confiance dépasse 55, 60, 65 ou 70 %. Le champ `backtest` de la réponse JSON est optionnel pour un service externe.

### Prévisions journalière et hebdomadaire

`GET /api/outlook` calcule, pour chaque instrument, la prévision de la prochaine bougie journalière (`DAY`) et hebdomadaire (`WEEK`) avec le même modèle et son propre backtest. Il renvoie la variation attendue, la cible, la fourchette et le taux de réussite. Les bougies longues sont gardées en cache 5 min et le résultat 1 min. Si un epic est invalide, seule sa ligne affiche « indisponible ».

### Modèle de machine learning (`forecast-service/`)

Le dossier `forecast-service/` contient un service Python (gradient boosting + régression logistique, backtest walk-forward sans fuite du futur) à déployer comme **second projet Vercel** : voir `forecast-service/README.md`. Une fois `FORECAST_SERVICE_URL` et `FORECAST_SERVICE_TOKEN` définis, le dashboard l'utilise à la place du modèle intégré, avec les mêmes verdicts et comparaisons. Les réponses sont gardées en cache par instrument, horizon et dernière bougie (1 à 15 min), et un échec du service est mis en cache 30 s pour ne pas le solliciter à chaque rafraîchissement.

### Brancher un autre service externe

Définissez `FORECAST_SERVICE_URL`. L'endpoint lui envoie alors un `POST` JSON :

```json
{ "epic": "GOLD", "resolution": "MINUTE_5", "resolutionMinutes": 5, "horizon": 30,
  "candles": [{ "time": 1730000000, "open": 0, "high": 0, "low": 0, "close": 0 }] }
```

et attend une réponse au même format que `/api/forecast`. `resolution` peut aussi valoir `DAY` ou `WEEK` (avec `horizon` = 1440 ou 10080) pour les prévisions jour / semaine. Si le service échoue ou renvoie un format invalide, le modèle intégré prend le relais et l'interface l'indique. Pour un autre fournisseur, implémentez l'interface `ForecastProvider` (`lib/forecast/types.ts`).

## Sécurité

- Tout le site (pages et API) passe par `proxy.ts` (le nom du middleware dans Next.js 16). Sans cookie valide, les pages renvoient vers `/login` et l'API répond 401.
- Le cookie est `httpOnly`, `secure` (sauf avec `next dev` en http local) et `sameSite=lax`. Sa valeur est un HMAC dérivé de `DASHBOARD_PASSWORD`.
- Les identifiants Capital.com ne servent que dans les route handlers ; les jetons de session restent en mémoire côté serveur. Seuls les codes d'erreur sont journalisés.
- Cache serveur : prix 4 s, statut du marché 30 s, session réutilisée (renouvelée après 9 min d'inactivité ou sur 401).
