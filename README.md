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
| `FORECAST_SERVICE_URL` | Optionnel : URL d'un service de prévision externe |
| `FORECAST_SERVICE_TOKEN` | Optionnel : envoyé en `Authorization: Bearer …` au service externe |

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

### Lire le backtest

Chaque prévision affiche sa réussite avec une **marge d'erreur à ~95 %** (`51 % ± 10`), puis un verdict :

- **Mieux que le hasard** : réussite moins la marge > 50 %, et meilleure que les stratégies naïves ;
- **Ne bat pas une stratégie naïve** : au-dessus de 50 %, mais pas mieux que « toujours hausse » ou « suit la dernière bougie » ;
- **Pas distinguable du hasard** ou **Moins bon que le hasard**.

La marge tient compte du chevauchement des horizons : à 30 min en bougies de 5 min, des prédictions consécutives portent presque sur le même mouvement, donc seul ~1 cas sur 6 compte comme indépendant. « Détail du backtest » montre aussi les stratégies naïves (testées sur les mêmes cas) et la réussite quand on ne garde que les prédictions dont la confiance dépasse 55, 60, 65 ou 70 %. Le champ `backtest` de la réponse JSON est optionnel pour un service externe.

### Prévisions journalière et hebdomadaire

`GET /api/outlook` calcule, pour chaque instrument, la prévision de la prochaine bougie journalière (`DAY`) et hebdomadaire (`WEEK`) avec le même modèle et son propre backtest. Il renvoie la variation attendue, la cible, la fourchette et le taux de réussite. Les bougies longues sont gardées en cache 5 min et le résultat 1 min. Si un epic est invalide, seule sa ligne affiche « indisponible ».

### Brancher un service externe

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
