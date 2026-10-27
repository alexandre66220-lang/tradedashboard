# Market Dashboard

Dashboard personnel de suivi de marché, **en lecture seule** : graphique en bougies (Lightweight Charts de TradingView) alimenté par l'API Capital.com, avec une prévision expérimentale prolongée dans le futur. Next.js (App Router) + TypeScript, prévu pour Vercel.

> Aucune fonctionnalité de passage d'ordre. Le client Capital.com (`lib/capital.ts`) n'autorise que 4 appels : `POST /api/v1/session`, `GET /api/v1/prices/{epic}`, `GET /api/v1/markets/{epic}` et `GET /api/v1/clientsentiment` (part de clients acheteurs / vendeurs : donnée de marché publique). Tout autre appel est bloqué.

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
| `CALENDAR_FEED_URL` | Optionnel : adresse du calendrier économique (défaut : le flux hebdomadaire gratuit de Fair Economy, format ForexFactory) |
| `NTFY_TOPIC` | Optionnel : nom **long et aléatoire** du sujet [ntfy](https://ntfy.sh) sur lequel envoyer les alertes ; il sert de mot de passe, ne le partagez pas. Active les alertes sur téléphone |
| `NTFY_SERVER`, `NTFY_TOKEN`, `DASHBOARD_URL` | Optionnels : serveur ntfy auto-hébergé (défaut `https://ntfy.sh`), jeton d'accès à ce serveur, adresse ouverte en touchant la notification |
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

### Modèle ML v2 : ce qu'il regarde en plus

Avec `FORECAST_SERVICE_URL`, le service Python (`forecast-service/`) reçoit davantage que les 1 000 bougies du graphique (`lib/forecast/enrich.ts`) :

- **Historique plus long** : jusqu'à 5 000 bougies en 5 et 15 min (4 000 en 1 min), lues par tranches avec les dates `from` / `to` du même appel de prix, **sans** `max` (l'API refuse les deux ensemble : `error.invalid.max.daterange`) ; si elle juge la plage trop large, la plage est réduite de moitié jusqu'à ce que ça passe (`getHistory` dans `lib/capital.ts`, lecture seule). Les tranches anciennes restent en mémoire, seules les récentes sont rafraîchies. Si l'API refuse ou ignore les dates, le modèle retombe sur 1 000 bougies et ne réessaie pas avant 10 min. Les appels à Capital.com sont limités à 4 en parallèle par instance, et une réponse 429 (trop de requêtes) est réessayée après une pause.
- **Volume** des bougies, si au moins 80 % en ont un.
- **Les autres instruments** (rendements récents de l'or, du pétrole et du bitcoin, alignés sur la dernière bougie déjà commencée : aucune donnée du futur).
- **Le coût du spread** : au lieu de « hausse ou baisse », le modèle estime la probabilité que le prix bouge **de plus que le spread** vers le haut ou vers le bas. Il reste neutre quand ce mouvement est peu probable. Le spread vient de `spreadBps` dans `config/instruments.ts`.

Le calendrier et le sentiment des clients ne sont **pas** des variables du modèle : les sources ne donnent aucun historique, impossible de les apprendre sur le passé. Ils sont enregistrés avec chaque prévision du journal (sentiment, et « une annonce forte tombe dans la fenêtre » pour les séries intraday), pour juger plus tard s'ils aident.

**« Comparer les versions du modèle »** (dans « Détail du backtest », route `GET /api/forecast/compare`, calcul à la demande, 10–20 s) : le même backtest sans fuite du futur pour six versions (prix seul, + volume, + autres instruments, + coût du spread, version plus prudente, version plus souple), avec marge d'erreur et gain net par pari après spread. C'est le garde-fou contre l'auto-persuasion : une variante n'est retenue que si sa marge exclut 50 % **et** que son net est positif. Plus on compare de variantes, plus l'une paraît bonne par hasard ; le juge final reste le journal en direct.

Dans le journal, les prévisions du modèle v2 sont comptées à part (« Modèle ML v2 ») de celles de la première version (« Modèle ML v1 ») : on ne mélange pas les deux.

### Journal des prévisions en direct

Sur le plan gratuit de Vercel, les opérations de stockage sont comptées : le journal garde en mémoire la liste de ses fichiers (15 min) et son résumé (2 min), et le navigateur ne les redemande que toutes les 5 min. La prévision est redemandée une fois par minute (le prix, toutes les 5 secondes).

Le backtest rejoue le passé ; le journal juge les prévisions **en conditions réelles**. Pour chaque instrument et chaque horizon, une prévision est enregistrée à l'avance par fenêtre d'horizon (donc sans chevauchement : une toutes les 30 min, une par jour, une par semaine), puis comparée au vrai prix à l'échéance, avec la même définition que le backtest (clôtures finales, bougies décalées de `horizon / résolution`).

- **Où** : un fichier JSON par série dans un stockage Vercel Blob **privé** (`journal/<epic>__<résolution>__<horizon>.json`), mis à jour avec contrôle d'ETag (pas de perte en cas d'écritures simultanées ; l'ETag vient des métadonnées du fichier, pas de l'en-tête du téléchargement, qui peut être « faible » et ne jamais correspondre), 1 500 entrées maximum par série. Si les conflits persistent, le journal (reconstructible) finit par écraser le fichier plutôt que de rester vide ; une fenêtre dont l'écriture a échoué n'est retentée qu'après une minute.
- **Quand** : à l'ouverture du graphique (route `/api/forecast`, tableau jour/semaine) et chaque jour à 7 h UTC par Vercel Cron (`/api/journal/record`, protégé par `CRON_SECRET`). L'offre gratuite de Vercel limite les tâches planifiées à une par jour : les prévisions à 30 min ne sont donc enregistrées que quand le dashboard est consulté.
- **Affichage** : réussite avec marge d'erreur, comparaison aux stratégies naïves, verdict, et **gain simulé net** (une unité par prévision haussière ou baissière, après un spread supposé par instrument : `spreadBps` dans `config/instruments.ts`, sans frais de financement). Les statistiques sont séparées par modèle (ML / intégré). Aucun taux n'est affiché sous 20 prévisions jugées.
- **Limites** : une entrée dont la bougie sort de l'historique chargé (1 000 bougies) avant d'avoir été jugée est marquée « expirée » et ignorée.

### Mes trades (journal réel)

Le dashboard ne passe aucun ordre : vous notez vos trades à la main, soit depuis le bouton « Noter ce trade dans mon journal » du calculateur de risque (taille, stop et objectif déjà remplis), soit via le formulaire « Noter un trade ». À l'enregistrement, la prévision affichée (sens, confiance, modèle) est conservée avec le trade. Clôturez ensuite en indiquant le prix de sortie.

- **Stockage** : un fichier `trades/trades.json` dans le même stockage Blob privé que le journal des prévisions, mis à jour avec contrôle d'ETag ; 2 000 trades maximum. Routes : `GET/POST /api/trades`, `PATCH/DELETE /api/trades/[id]` (protégées par le mot de passe du site, validation stricte : le stop doit être du bon côté de l'entrée, etc.).
- **Statistiques** : résultat total, réussite avec marge d'erreur (à partir de 20 trades clôturés), espérance en R (trades avec stop), pire creux, résultat du jour, courbe cumulée, part de trades avec stop, et comparaison « dans le sens du modèle » / « à contre-sens ».
- **Perte maximale du jour** : montant à saisir dans le panneau (mémorisé sur l'appareil) ; une fois atteint, le feu passe au rouge.

### Feu « pas de trade maintenant »

Pastille sous le prix, toujours informative (rien n'est bloqué) :
- **Rouge** : marché fermé, spread au moins 3 fois le spread habituel, perte maximale du jour atteinte.
- **Orange** : spread élargi (≥ 1,8×), volatilité parmi les 10 % les plus fortes ou les plus faibles de l'historique chargé, données en retard, moitié de la perte du jour atteinte.
- Le spread réel vient des prix d'achat / vente de la fiche du marché Capital.com (rafraîchis toutes les 30 s) ; il est comparé au `spreadBps` supposé dans `config/instruments.ts`, ce qui permet aussi de recaler cette valeur sur vos vrais spreads.

### Calendrier économique

Panneau « Annonces à venir » (colonne de droite) et feu rouge autour des grosses annonces.

- **Source** : flux JSON hebdomadaire gratuit (`ff_calendar_thisweek.json`, plus la semaine suivante si elle existe), au format `{ title, country, date, impact, forecast, previous }`. Modifiable avec `CALENDAR_FEED_URL`. Lu côté serveur (`/api/calendar`, derrière le mot de passe du site), mis en cache 30 min (le flux limite les appels) ; en cas d'échec, la dernière copie valide est servie, avec une mention « données anciennes », et la source n'est pas réinterrogée pendant 10 min.
- **Lecture défensive** : les lignes mal formées, les jours fériés et les dates sans décalage horaire explicite sont ignorés (deviner le fuseau décalerait toutes les annonces). Si un flux d'au moins 10 lignes ne donne rien d'exploitable, le format est jugé inattendu : l'interface affiche « calendrier indisponible » au lieu de « aucune annonce », et le feu précise que les annonces ne sont pas vérifiées.
- **Pertinence** : par instrument, `newsCurrencies` (défaut `USD`) et `newsKeywords` dans `config/instruments.ts` (par exemple `crude`, `opec` pour le pétrole : ces titres comptent comme fort impact). Impact faible ignoré.
- **Feu** : rouge de 30 min avant à 30 min après une annonce forte, orange jusqu'à 90 min avant pour toute annonce moyenne ou forte.

### Sentiment des clients

Panneau « Sentiment des clients » : part des clients de Capital.com acheteurs ou vendeurs sur l'instrument (`GET /api/v1/clientsentiment?marketIds=…`, donnée de marché publique en lecture seule, ajoutée à la liste des appels autorisés), rafraîchie toutes les 60 s côté serveur. Les valeurs qui ne forment pas 100 % sont ignorées plutôt que devinées ; si l'appel échoue ou ne connaît pas le marché, le panneau affiche « non disponible » et l'appel n'est pas répété avant 5 min.

Ce sentiment **n'est pas une entrée du modèle** : l'API ne donne que la valeur du moment, sans historique, donc impossible de l'apprendre sur le passé. À la place, il est enregistré avec chaque prévision du journal, qui compare ensuite la réussite quand la prévision va dans le sens de la foule (≥ 60 % d'un côté), à contre-courant, ou quand la foule est partagée. Si un écart net apparaît au bout de plusieurs semaines, il pourra devenir une variable du modèle.

Le journal contient aussi un bloc **« Aller contre la foule ? »**, indépendant du modèle : à chaque fenêtre jugée qui a un sentiment enregistré, on simule un pari à l'inverse de la majorité des clients, séparément quand la foule est très d'un côté (≥ 70 % / ≤ 30 %) et plutôt d'un côté (60–70 % / 30–40 %), avec taux de réussite, marge d'erreur, gain net après spread et verdict (« signal contrarien » seulement si le taux dépasse 50 % au-delà de la marge **et** que le gain net est positif). Les fenêtres voisines se ressemblent, la marge est donc plutôt optimiste.

### Alertes sur téléphone

Notifications push gratuites via [ntfy](https://ntfy.sh) (aucun compte : l'application s'abonne à un « sujet » secret). Trois types d'alertes :
- **35 minutes avant une annonce économique majeure** (une seule fois par annonce, avec les instruments concernés) ;
- **stop ou objectif touché** sur un trade que vous avez noté comme ouvert dans « Mes trades » (stop = priorité urgente), avec le rappel de noter la clôture ;
- **prix fixé par vous** (au-dessus / en dessous), créé dans le panneau « Alertes sur téléphone » ; l'alerte se déclenche une fois.

Fonctionnement : `GET /api/alerts/check`, protégé par `Authorization: Bearer $CRON_SECRET` (refuse tout si le secret manque), compare les bougies d'1 minute depuis la création de l'alerte ou l'ouverture du trade (un pic entre deux vérifications est donc détecté), envoie, et mémorise ce qui a été envoyé (`alerts/sent.json`, 14 jours) pour ne jamais notifier deux fois ; un envoi raté est retenté à la vérification suivante. Les alertes de prix sont dans `alerts/alerts.json` (Blob privé). Le nom du sujet n'est jamais journalisé. Routes pour le panneau : `GET/POST /api/alerts`, `DELETE /api/alerts/[id]`, `POST /api/alerts/test`.

**Mise en place** : 1) installez l'application ntfy et abonnez-vous à votre sujet ; 2) ajoutez `NTFY_TOPIC` (même nom) et `CRON_SECRET` dans les variables Vercel, redéployez ; 3) l'offre gratuite de Vercel ne lance une tâche qu'une fois par jour : créez sur [cron-job.org](https://cron-job.org) (gratuit) une tâche toutes les 5 minutes sur `https://<votre-site>/api/alerts/check` avec l'en-tête `Authorization: Bearer <CRON_SECRET>` ; 4) bouton « Envoyer une notification de test » du panneau.

Limite : une alerte n'est pas un stop chez votre courtier ; le délai dépend de la fréquence de la tâche. Une prévision « forte » n'envoie volontairement pas d'alerte : sans avantage mesuré, cela pousserait à trader trop.

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

## Disposition (téléphone et ordinateur)

Le graphique, le prix et le feu « trade / pas de trade » restent en haut. En dessous, une **barre d'onglets** (fixée en bas de l'écran sur téléphone) évite de défiler indéfiniment : **Prévision** (prévision, jour / semaine, sentiment), **Trade** (conseil SL / TP, calculateur de risque), **Journal** (mes trades, journal des prévisions) et **Alertes** (calendrier, notifications). Un point rouge / orange sur « Trade » signale que le feu n'est pas vert. Les textes d'avertissement sont repliés sous « À savoir ». Sur grand écran (≥ 900 px) la prévision se place à côté du graphique et les autres panneaux s'affichent en colonnes sous l'onglet choisi. Le dernier onglet est mémorisé.

## Déployer sur Netlify (en plus de Vercel, ou à la place)

Le même code tourne sur les deux : `netlify.toml` et le dossier `netlify/functions/` ne gênent pas Vercel.

1. **Netlify → Add new project → Import from Git** → ce dépôt (la branche `main`). Netlify détecte Next.js tout seul (runtime installé au build). Un projet vide `tradedashboard-alcal` a déjà été créé ; on peut aussi y relier le dépôt.
2. **Variables d'environnement** (Project configuration → Environment variables, portées *Builds*, *Functions* et *Runtime*) : les mêmes que sur Vercel — `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`, `CAPITAL_API_PASSWORD`, `CAPITAL_ENV` (`demo`), `DASHBOARD_PASSWORD`, `CRON_SECRET`, `FORECAST_SERVICE_URL`, `FORECAST_SERVICE_TOKEN`, `NTFY_TOPIC`. **Pas de jeton Blob** : sur Netlify, le journal, les trades et les alertes sont stockés dans **Netlify Blobs** (aucune configuration, `STORAGE_BACKEND=netlify` est déjà posé), séparément du stockage Vercel : les deux sites ne partagent donc rien. Vercel Blob limite le plan gratuit à 2 000 opérations « avancées » par mois (écritures, listes), ce qui était la limite atteinte. Toute modification de variable demande un **redéploiement**.
3. **Le service ML reste sur Vercel** (projet `tradedashboard-forecast`) : Netlify n'exécute pas Python. Le dashboard l'appelle par `FORECAST_SERVICE_URL`.
4. **Tâches planifiées incluses**, sans service externe : `netlify/functions/cron-alerts.mts` (alertes, toutes les 5 min, UTC) et `cron-journal.mts` (prévisions courtes du journal, toutes les 30 min), `cron-journal-daily.mts` (prévisions jour et semaine, une fois par jour à 7 h 05 UTC : elles ne changent pas plus vite, chacune coûte une exécution du modèle) ; toutes deux passent le relais à la fonction d'arrière-plan `journal-record-background.mts` pour dépasser les 30 s des fonctions planifiées. Elles appellent `/api/alerts/check` et `/api/journal/record` (`?scope=intraday` ou `?scope=daily`) avec `Bearer $CRON_SECRET`. Elles ne tournent que sur le déploiement publié (pas sur les aperçus). Si un service externe (cron-job.org) appelle déjà ces adresses côté Vercel, ne le laissez pas appeler aussi Netlify : deux déclencheurs ne cassent rien (une seule prévision est gardée par fenêtre), mais les alertes pourraient être envoyées en double.
5. Durées : une fonction synchrone peut durer jusqu'à 60 s sur Netlify, comme `maxDuration` sur Vercel (cet export est ignoré par Netlify).

À surveiller après le premier déploiement : que l'enregistrement du journal après chaque prévision (`after()`) fonctionne sur Netlify (sinon, c'est la tâche planifiée qui remplit le journal), et que la connexion au site marche (`proxy.ts` est exécuté comme middleware).

## Sécurité

- Tout le site (pages et API) passe par `proxy.ts` (le nom du middleware dans Next.js 16). Sans cookie valide, les pages renvoient vers `/login` et l'API répond 401.
- Le cookie est `httpOnly`, `secure` (sauf avec `next dev` en http local) et `sameSite=lax`. Sa valeur est un HMAC dérivé de `DASHBOARD_PASSWORD`.
- Les identifiants Capital.com ne servent que dans les route handlers ; les jetons de session restent en mémoire côté serveur. Seuls les codes d'erreur sont journalisés.
- Cache serveur : prix 4 s, statut du marché 30 s, session réutilisée (renouvelée après 9 min d'inactivité ou sur 401).
