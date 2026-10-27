# Forecast service (ML)

Service Python sans état qui fournit la prévision au dashboard quand `FORECAST_SERVICE_URL` est défini. Il reçoit les bougies dans la requête, entraîne un modèle sur cet historique, se note lui-même par backtest, puis prédit la direction à l'horizon demandé.

## Modèle

- **Cible** : le prix sera-t-il plus haut ou plus bas dans `horizon` minutes ?
- **Variables** (une cinquantaine de colonnes, toutes calculées à partir des bougies passées) : rendements sur 1 à 34 bougies normalisés par la volatilité, ratios de volatilité, RSI 14, distance aux moyennes mobiles exponentielles 10/20/50, forme de la bougie (corps, mèches, amplitude), position dans la fourchette des 20 dernières bougies, heure et jour de la semaine (intraday seulement).
- **Modèle** : moyenne d'un gradient boosting peu profond (`HistGradientBoostingClassifier`, profondeur 3, régularisé) et d'une régression logistique ridge. Les deux sont volontairement bridés : avec ~1 000 bougies, un modèle plus riche apprend surtout du bruit.
- **Version 2** (`ML v2` dans le journal) : le modèle reçoit en option le **volume** des bougies, les **autres instruments** (rendements récents normalisés, sans fuite du futur) et le **spread** de l'instrument. Avec le spread, deux têtes (« hausse de plus que le coût », « baisse de plus que le coût ») remplacent le simple « hausse ou baisse » ; le modèle reste neutre quand un mouvement qui couvre le coût est moins probable que d'habitude. Sans ces options, il se comporte comme la version 1.
- **Zone neutre** : si la probabilité de direction est entre 47 et 53 %, la prévision est « neutre ».
- **Amplitude** : `(2p − 1) × amplitude moyenne historique`, une estimation modeste. La bande haute/basse vient de la volatilité récente, bien plus prévisible que la direction.
- **Backtest** : walk-forward. Le modèle est réentraîné régulièrement et ne prédit qu'avec des données dont le résultat était déjà connu à ce moment-là (aucune fuite du futur). Mêmes statistiques que le dashboard : marge d'erreur, stratégies naïves, réussite par palier de confiance. Le test `test_random_walk_gives_no_edge` vérifie qu'un prix purement aléatoire donne ~50 %.

Le backtest renvoie aussi `coverage` (part des bougies où le modèle prend position) et `avgNetBps` (résultat moyen d'un pari après spread, en points de base). Le mode `compare` rejoue le même backtest (6 réentraînements chacun) pour six variantes du modèle, afin de voir ce que chaque ajout apporte vraiment.

Aucune promesse de précision : sur du court terme, la direction est presque imprévisible. Le dashboard affiche un verdict qui compare le modèle au hasard et aux stratégies naïves.

## Déployer sur Vercel (second projet)

1. Vercel → *Add New… → Project* → importez le même repo GitHub.
2. **Root Directory** : `forecast-service`. Framework : *Other*.
3. Variable d'environnement `FORECAST_SERVICE_TOKEN` : une longue valeur aléatoire (par exemple `openssl rand -hex 32`).
4. Déployez. L'URL de l'endpoint est `https://<votre-projet>.vercel.app/api/forecast`.
5. Dans le projet du dashboard, ajoutez :
   - `FORECAST_SERVICE_URL` = l'URL ci-dessus ;
   - `FORECAST_SERVICE_TOKEN` = **la même valeur**.
   Puis redéployez le dashboard.

Sans jeton configuré côté service, il refuse tout (503). Un jeton incorrect donne 401. Si le service échoue ou ne répond pas, le dashboard retombe sur le modèle intégré et l'indique dans l'interface.

> La dépendance scikit-learn + scipy pèse ~260 Mo décompressés. Si Vercel refuse le déploiement pour cette taille, hébergez le même dossier ailleurs (Render, Fly.io, Cloud Run, etc.) : il suffit d'exposer `api/forecast.py` ou une petite application web qui appelle `ml_forecast`.

## En local

```bash
cd forecast-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v    # ~1 min
```

Pour le brancher sur `npm run dev`, lancez le service avec `FORECAST_SERVICE_TOKEN=xxx` (par exemple avec `http.server.ThreadingHTTPServer(("127.0.0.1", 4030), api.handler)` depuis `api/forecast.py`) et mettez dans `.env.local` : `FORECAST_SERVICE_URL=http://127.0.0.1:4030/api/forecast` et `FORECAST_SERVICE_TOKEN=xxx`.

## Contrat

`POST` avec `Authorization: Bearer <jeton>` et le corps JSON :

```json
{ "epic": "GOLD", "resolution": "MINUTE_5", "resolutionMinutes": 5, "horizon": 30,
  "candles": [{ "time": 1730000000, "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0 }],
  "spreadBps": 2,
  "context": [{ "epic": "OIL_CRUDE", "time": [1730000000], "close": [72.1] }],
  "mode": "forecast" }
```

`volume`, `spreadBps`, `context` (jusqu'à 4 séries, colonnes `time` / `close`) et `mode` (`forecast` par défaut, ou `compare` : la réponse est alors `{ "variants": [...] }`) sont facultatifs. 100 à 5 000 bougies.

Réponse : même format que `/api/forecast` du dashboard (`points`, `direction`, `confidence`, `backtestHitRate`, `backtestSamples`, `backtest`, `source`, plus `features` : ce que le modèle a regardé). 422 si l'historique est insuffisant (moins de ~150 cas d'entraînement), 400 si la requête est invalide. Le service ne journalise jamais les données reçues.
