# Market Dashboard

Dashboard personnel de suivi de marché, **en lecture seule par défaut** (les ordres sur compte démo sont une option désactivée, voir « Ordres sur compte démo ») : graphique en bougies (Lightweight Charts de TradingView) alimenté par l'API Capital.com, avec une prévision expérimentale prolongée dans le futur. Next.js (App Router) + TypeScript, prévu pour Vercel.

> Les ordres sont **désactivés par défaut** et, même activés, **limités au compte démo** de Capital.com (voir « Ordres sur compte démo »). Hors de cette fonction, le client Capital.com (`lib/capital.ts`) n'autorise que 4 appels de lecture : `POST /api/v1/session`, `GET /api/v1/prices/{epic}`, `GET /api/v1/markets/{epic}` et `GET /api/v1/clientsentiment`. Aucun ordre en attente, aucune modification de compte, aucun retrait. Les identifiants Capital.com ne vivent que côté serveur (variables d'environnement, jamais commitées).

## Variables d'environnement

Copiez `.env.example` en `.env.local` (jamais commité) et renseignez :

| Variable | Rôle |
| --- | --- |
| `CAPITAL_API_KEY` | Clé API Capital.com (Paramètres → API) |
| `CAPITAL_IDENTIFIER` | Identifiant (e-mail) du compte Capital.com |
| `CAPITAL_API_PASSWORD` | Mot de passe **de la clé API** (défini à sa création) |
| `CAPITAL_ENV` | `demo` (défaut) ou `live` (lecture seule). Les ordres sont **refusés** dès que ce n'est pas `demo` |
| `TRADING_ENABLED` | Optionnel : `true` pour activer les ordres sur le compte **démo**. Absent ou autre valeur : aucun ordre possible (interrupteur) |
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

Instruments actuels : or (`GOLD`), pétrole WTI (`OIL_CRUDE`), bitcoin (`BTCUSD`), Nasdaq 100 (`US100`), S&P 500 (`US500`) et Euro / Dollar (`EURUSD`). Les epics sont ceux de Capital.com : si l'un est refusé (« Instrument inconnu chez Capital.com »), corrigez-le dans `config/instruments.ts`. Les coûts (`spreadBps`, `financingBpsPerDay`) sont des hypothèses à ajuster. Le champ facultatif `related` liste les (4 au plus) instruments que le modèle ML regarde en plus, par exemple le dollar pour l'or ; sans lui, ce sont les quatre premiers autres. Le relevé du journal traite les instruments trois par trois. Le sélecteur d'actif apparaît automatiquement dès qu'il y a au moins deux instruments, et chaque instrument a sa ligne dans le panneau « Prévisions jour / semaine ». Pour trouver l'epic exact, cherchez le marché dans la plateforme Capital.com ou via `GET /api/v1/markets?searchTerm=...`.

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

### Signal validé, santé du système, installation sur téléphone

- **Signal validé** (`lib/signal.ts`) : jugé sur le **journal en direct** seulement, jamais sur le backtest. « Validé » exige au moins 200 prévisions jugées, une réussite au-dessus de 50 % au-delà de la marge d'erreur, meilleure que les stratégies naïves, et un résultat positif après spread. Avant : « en observation (n / 200) » ; sinon « non validé » ou « à éviter ». Tant que ce n'est pas validé, le titre de la prévision est grisé. Route : `GET /api/journal/signal`.
- **Réussite par moment de la journée** dans le journal (Asie 0–7 h, Europe 7–13 h, New York 13–21 h, nuit 21–24 h, heures UTC), avec le net par session.
- **Comparer les horizons** (15 / 30 / 60 / 120 min), dans « Détail du backtest » : même modèle, même méthode, rien n'est écrit dans le journal.
- **Santé du système** (onglet Alertes, `GET /api/health`) : Capital.com, service ML, stockage, journal (dernier relevé, nombre sur 24 h), calendrier, réglages (`CRON_SECRET`, `NTFY_TOPIC` : seulement défini ou non, jamais la valeur). Le journal passe à « à surveiller » après 90 min sans relevé, « problème » après 6 h.
- **Résumé sous le prix** (prévision, signal, verdict du backtest), **graphique des instruments sur 24 h** (variation en %), **vue compacte** (case « Compact » : masque les textes d'explication, mémorisée sur l'appareil).
- **Installation sur l'écran d'accueil** : `app/manifest.ts` et les icônes `app/icon.png` / `app/apple-icon.png` (publiques : le téléphone les lit sans session, elles ne contiennent aucune donnée). Sur iPhone : Safari → Partager → « Sur l'écran d'accueil ». Pas de mode hors ligne : les données sont en direct.

### Aides de lecture, accord des indicateurs et Fibonacci

- **Aides sur le graphique** (boutons au-dessus du graphique, mémorisés sur l'appareil) : moyennes mobiles 20 / 50, bandes de Bollinger, RSI (volet séparé) et niveaux de **Fibonacci** (retracements 23,6 / 38,2 / 50 / 61,8 / 78,6 % de la dernière jambe, calculés sur les 100 dernières bougies : le résultat dépend de cette fenêtre, c'est une aide de lecture, pas une mesure). Rien de tout cela n'entre dans la prévision.
- **Accord des indicateurs** (`lib/indicators.ts`, panneau de l'onglet Prévision) : cinq lectures simples (moyennes, RSI, MACD, cassure des 20 dernières bougies, tendance sur l'unité de temps supérieure, obtenue en regroupant les bougies) votent hausse / baisse / neutre. Elles sont toutes calculées à partir des mêmes prix : leur accord n'est pas cinq avis indépendants.
- **Mesure plutôt que croyance** : à chaque prévision, le journal enregistre combien de lectures allaient dans le même sens (de 0 à 5) et si le prix était sur un niveau de Fibonacci (à 0,15 ATR près). L'onglet Journal montre ensuite la réussite par niveau d'accord (0–1, 2–3, 4–5) et selon la proximité d'un niveau, avec marge d'erreur. S'il n'y a pas d'écart net, l'accord ne vaut rien de plus que le hasard.

### Trade simulé, coûts réalistes, calibration, régimes de marché

Quatre mesures ajoutées au journal des prévisions (tout se remplit au fil des semaines) :

- **Trade simulé** : à chaque prévision haussière ou baissière, le journal rejoue un trade (entrée à la clôture de la bougie, stop à 1,5 ATR, objectif à deux fois le stop, sinon sortie au terme ; une bougie qui touche les deux compte comme un stop) et affiche le résultat moyen en **R** (1 R = le stop) après coûts, avec sa marge. C'est plus proche de la réalité que le taux de réussite seul. Aucun ordre n'est passé : c'est un calcul.
- **Coûts réalistes** : le spread vu sur la cotation au moment de la prévision remplace le spread supposé quand il est connu (séries intraday). Pour les prévisions jour et semaine, des **frais de nuit supposés** (`financingBpsPerDay` dans `config/instruments.ts`) sont ajoutés par nuit de détention. Ces taux sont **des hypothèses** à régler d'après les vrais taux de votre courtier (ils varient selon l'instrument, le sens et le week-end).
- **Calibration** : réussite observée par niveau de confiance (50–55, 55–60, 60–65, 65 % et plus). Dans le badge du signal, quand au moins 20 prévisions existent à ce niveau, la réussite réellement observée est indiquée à côté de la confiance affichée.
- **Régimes de marché** (`lib/regime.ts`) : volatilité calme / normale / agitée (quart bas / haut de son historique) et tendance (rapport d'efficacité de Kaufman sur 30 bougies) enregistrés à chaque prévision ; le journal donne la réussite par état, et le résumé sous le prix affiche l'état courant et ce qui a été observé dans un marché comme celui-là.

### Courbe de résultat, sauvegarde du journal, protection du mot de passe

- **Courbe de résultat** (onglet Journal) : résultat cumulé simulé des prévisions jugées, par modèle et par instrument (une unité par prévision, spread et frais de nuit déduits). Les pointillés délimitent la zone que le **hasard seul** pourrait produire à 95 % (±1,96 σ√n) : tant que la courbe reste dedans, rien n'est prouvé.
- **Sauvegarde** (`lib/backup.ts`) : chaque nuit (3 h 30 UTC, tâche planifiée Netlify `cron-backup`, ou cron Vercel), le journal, les trades et les alertes sont copiés dans `backup/<date>.json` du stockage ; les 14 dernières sont gardées. Le panneau de santé signale une sauvegarde absente ou trop ancienne. **Télécharger** une sauvegarde (`GET /api/backup`, derrière le mot de passe) et **restaurer** depuis un fichier (`POST /api/backup`, après confirmation : l'état actuel est d'abord conservé dans `backup/avant-restauration-….json`, jamais supprimé automatiquement). Une sauvegarde dans le même stockage ne protège pas d'une perte du stockage lui-même : téléchargez-en une de temps en temps.
- **Protection du mot de passe** (`lib/loginGuard.ts`) : les échecs sont comptés **dans le stockage partagé** (un compteur en mémoire ne sert à rien sur un hébergeur sans serveur fixe). Cinq échecs en 15 minutes bloquent le visiteur 15 minutes, durée doublée à chaque nouveau blocage (jusqu'à 24 h) ; pendant le blocage, même le bon mot de passe est refusé. L'adresse n'est pas stockée, seulement une empreinte. Le blocage envoie une alerte sur le téléphone si `NTFY_TOPIC` est défini. Sans stockage, un compteur par instance sert de repli.

### Journal des prévisions en direct

Sur le plan gratuit de Vercel, les opérations de stockage sont comptées : le journal garde en mémoire la liste de ses fichiers (15 min) et son résumé (2 min), et le navigateur ne les redemande que toutes les 5 min. La prévision est redemandée une fois par minute (le prix, toutes les 5 secondes).

Le backtest rejoue le passé ; le journal juge les prévisions **en conditions réelles**. Pour chaque instrument et chaque horizon, une prévision est enregistrée à l'avance par fenêtre d'horizon (donc sans chevauchement : une toutes les 30 min, une par jour, une par semaine), puis comparée au vrai prix à l'échéance, avec la même définition que le backtest (clôtures finales, bougies décalées de `horizon / résolution`).

- **Où** : un fichier JSON par série dans un stockage Vercel Blob **privé** (`journal/<epic>__<résolution>__<horizon>.json`), mis à jour avec contrôle d'ETag (pas de perte en cas d'écritures simultanées ; l'ETag vient des métadonnées du fichier, pas de l'en-tête du téléchargement, qui peut être « faible » et ne jamais correspondre), 1 500 entrées maximum par série. Si les conflits persistent, le journal (reconstructible) finit par écraser le fichier plutôt que de rester vide ; une fenêtre dont l'écriture a échoué n'est retentée qu'après une minute.
- **Quand** : à l'ouverture du graphique (route `/api/forecast`, tableau jour/semaine) et chaque jour à 7 h UTC par Vercel Cron (`/api/journal/record`, protégé par `CRON_SECRET`). L'offre gratuite de Vercel limite les tâches planifiées à une par jour : les prévisions à 30 min ne sont donc enregistrées que quand le dashboard est consulté.
- **Affichage** : réussite avec marge d'erreur, comparaison aux stratégies naïves, verdict, et **gain simulé net** (une unité par prévision haussière ou baissière, après un spread supposé par instrument : `spreadBps` dans `config/instruments.ts`, sans frais de financement). Les statistiques sont séparées par modèle (ML / intégré). Aucun taux n'est affiché sous 20 prévisions jugées.
- **Limites** : une entrée dont la bougie sort de l'historique chargé (1 000 bougies) avant d'avoir été jugée est marquée « expirée » et ignorée.

### Mes trades (journal réel)

Vous notez vos trades à la main (ou depuis un ordre démo, bouton « Noter dans mon journal ») : soit depuis le bouton « Noter ce trade dans mon journal » du calculateur de risque (taille, stop et objectif déjà remplis), soit via le formulaire « Noter un trade ». À l'enregistrement, la prévision affichée (sens, confiance, modèle) est conservée avec le trade. Clôturez ensuite en indiquant le prix de sortie.

- **Stockage** : un fichier `trades/trades.json` dans le même stockage Blob privé que le journal des prévisions, mis à jour avec contrôle d'ETag ; 2 000 trades maximum. Routes : `GET/POST /api/trades`, `PATCH/DELETE /api/trades/[id]` (protégées par le mot de passe du site, validation stricte : le stop doit être du bon côté de l'entrée, etc.).
- **Statistiques** : résultat total, réussite avec marge d'erreur (à partir de 20 trades clôturés), espérance en R (trades avec stop), pire creux, résultat du jour, courbe cumulée, part de trades avec stop, et comparaison « dans le sens du modèle » / « à contre-sens ».
- **Perte maximale du jour** : montant à saisir dans le panneau (mémorisé sur l'appareil) ; une fois atteint, le feu passe au rouge.

### Ordres sur compte démo

Option **désactivée par défaut**. Pour l'activer : variable `TRADING_ENABLED=true` (Netlify : *Project configuration → Environment variables*, puis redéployer). Pour la couper : retirer la variable et redéployer.

- **Démo uniquement, vérifié dans le code** : `assertDemoOnly()` (`lib/capital.ts`) refuse tout appel de trading si `CAPITAL_ENV` n'est pas `demo` ou si l'adresse visée est celle du compte réel. Les seuls appels de trading autorisés sont `POST /api/v1/positions`, `GET /api/v1/positions`, `DELETE /api/v1/positions/{dealId}` et `GET /api/v1/confirms/{ref}` (liste fermée, aucun ordre en attente).
- **Jamais automatique** : le calculateur de risque propose « Préparer un ordre (compte démo) » ; le panneau « Ordre sur compte démo » (onglet Trade) pré-remplit sens, taille, stop et objectif. « Vérifier l'ordre » (`POST /api/orders/preview`) contrôle l'ordre sur le prix actuel et affiche un récapitulatif signé (prix estimé, valeur, perte max., gain visé) valable 2 minutes ; « Envoyer sur le compte démo » (`POST /api/orders`) n'accepte que ce récapitulatif, une seule fois, et revérifie tout juste avant l'envoi.
- **Garde-fous** (`LIMITS` dans `lib/orders.ts`) : stop obligatoire et du bon côté du prix, objectif du bon côté, stop ni plus serré que le spread ni plus loin que 15 % ; valeur de position limitée à 25 000 $ ; 3 positions ouvertes au maximum ; même instrument et même sens refusés pendant 2 minutes (double clic) ; marché ouvert ; le prix ne doit pas avoir bougé de plus de 0,25 % depuis le récapitulatif.
- **Fermer une position** : bouton « Fermer » en deux appuis (le premier arme le bouton 5 secondes). La fermeture reste possible même si les nouveaux ordres sont coupés.
- **Si la réponse de Capital.com n'arrive pas**, l'appli le dit (« l'ordre a peut-être été envoyé ») au lieu de réessayer : vérifiez la liste des positions.
- **Protection des routes** : derrière le mot de passe du site comme tout le reste, et en plus réservées aux requêtes venant des pages du site (en-tête `Origin` vérifié).
- **Noté automatiquement** : un ordre accepté est écrit dans « Mes trades » (badge DÉMO) avec le prix d'exécution réel, le stop, l'objectif et la prévision du moment (sens, confiance, modèle). « Dans le sens du modèle » / « à contre-sens » compare ensuite vos résultats à ce que le modèle disait.
- **Fermeture reportée** : fermée depuis le dashboard, le prix confirmé par Capital.com est utilisé ; fermée par le stop, l'objectif ou sur la plateforme Capital.com, le serveur lit le prix dans l'historique d'activité (`GET /api/v1/history/activity`, lecture seule). Il compare les positions du compte démo et « Mes trades » à l'ouverture de l'onglet Trade et toutes les 5 minutes par la tâche des alertes. Si l'historique ne donne pas le prix, le trade est seulement signalé (« n'est plus ouverte chez Capital.com ») et **le prix de sortie est à saisir** : il n'est jamais deviné. Une position du compte démo que personne n'a notée est reprise automatiquement.
- **Déplacer le stop** (`PATCH /api/orders/{dealId}`, `PUT /api/v1/positions/{dealId}`) : champ + bouton « À l'entrée » + « Déplacer le stop » (deux appuis). Un stop ne peut que **se rapprocher** du prix, jamais s'en éloigner, reste du bon côté du prix avec au moins le spread de marge, et l'objectif existant est renvoyé avec la demande. Le stop d'origine reste la base du résultat en R ; le stop déplacé est noté à côté. Possible même quand les nouveaux ordres sont coupés.
- Ce n'est pas un conseil d'investissement, et rien ici ne prouve qu'un signal est rentable : voir « Signal validé ».

### Positionnement du marché (OKX, CFTC)

Panneau « Positionnement du marché » (onglet Prévision) et lignes dans le journal. **Contexte, pas signal** : rien n'entre dans le modèle tant que le journal n'a pas montré que ça aide.

- **Dérivés Bitcoin (OKX, données publiques sans clé)** : funding du contrat perpétuel BTC-USDT (ce que les acheteurs paient aux vendeurs, ou l'inverse, toutes les 8 h ; très positif = acheteurs surchargés), part des comptes acheteurs (`rubik/stat/contracts/long-short-account-ratio`) et variation des positions ouvertes sur 1 h (`open-interest-history`). Lu à la demande, gardé 2 min (5 min après un échec). Choisi plutôt que MarginPad : même type de donnée, mais une source établie et ouverte.
- **Grands spéculateurs (CFTC, rapport hebdomadaire « Commitments of Traders »)** : position nette des acteurs non commerciaux en % des positions ouvertes et son rang sur ~3 ans, pour les six instruments (codes de contrat dans `lib/context/cftc.ts`). Les positions sont celles du **mardi, publiées le vendredi** : un rapport n'est utilisé qu'après sa publication (vendredi 20 h 30 UTC), jamais avant, pour ne pas fausser les mesures.
- **Mesuré par le journal, pas supposé** : chaque prévision enregistre le funding / le rang CFTC du moment (horodatés, comme le sentiment des clients). Le journal affiche ensuite la réussite quand la prévision va **dans le sens** ou **à contre-courant** de ces foules (seuils : funding ≥ 0,02 % ou ≤ −0,005 % par 8 h ; CFTC au-dessus du 80ᵉ ou sous le 20ᵉ rang). Une fois assez de cas, on saura si ça apporte quelque chose ; seulement alors une variable pourra être ajoutée au modèle ML (le panneau « Comparer les versions du modèle » mesure le gain avec et sans).
- **Facultatif et sans risque** : chaque source a un délai court, un cache et un repli silencieux ; si l'une ne répond pas, le panneau dit « non disponible » et le reste fonctionne. « Santé du système » liste leur état (sans changer la couleur générale).
- **Écartées, et pourquoi** : sources de prix (CoinGecko, CoinCap, Goldprice…) redondantes avec Capital.com ; taux de change quotidiens (Frankfurter) remplacés par l'Euro/Dollar de Capital.com en 5 minutes ; rendements du Trésor, macro (Econdb, Helious) et ETF (TickerInside) quotidiens ou mensuels, sans lien démontré avec un mouvement de 30 minutes ; horaires de séance (Futures Clock) déjà couverts par l'état du marché et le découpage par session du journal ; mempool et stablecoins (on-chain) trop lents ; Reddit trop bruité.
- `OKX_BASE_URL` et `CFTC_URL` ne servent qu'aux tests locaux avec le faux serveur (`scripts/mock-capital.mjs`).

### Séances réelles et horloge des marchés

- **Séances** (`lib/sessions.ts`) : calculées à partir des heures d'ouverture locales de Tokyo (9 h – 15 h 30), Londres (8 h – 16 h 30) et New York (9 h 30 – 16 h), avec le fuseau horaire de chaque place (donc le changement d'heure, qui n'a pas lieu aux mêmes dates en Europe et aux États-Unis : du 25 octobre au 1er novembre 2026, par exemple, l'écart Paris / New York est de 5 h et non de 6 h). Cinq séances : Tokyo seul, Londres seul, Londres + New York (les heures les plus actives), New York seul, hors séances (nuit, week-end). Les jours fériés ne sont pas connus ; l'état du marché vient de Capital.com. Le journal des prévisions classe chaque prévision selon cette séance (avant, des tranches fixes en heures UTC, fausses une partie de l'année).
- **Panneau « Horloge des marchés »** (onglet Prévision) : ouvert / fermé pour chaque place, prochaine ouverture ou fermeture à l'heure de l'appareil, séance en cours, écart Paris / New York et date de son prochain changement.

### Annonces économiques et ordres

- Le calendrier (déjà présent : inflation, emploi, taux…) protège aussi les ordres démo : **pas d'ordre de 30 minutes avant à 15 minutes après une annonce majeure** qui concerne l'instrument. L'ordre est refusé avec la raison ; « J'ai vu l'annonce : passer outre et vérifier » permet de continuer en connaissance de cause, et le récapitulatif le rappelle. La règle est revérifiée juste avant l'envoi (une annonce qui apparaît entre-temps arrête un ordre non confirmé). Une annonce plus lointaine (jusqu'à 90 min) ajoute un avertissement « envisagez une taille réduite ». Si le calendrier est injoignable, l'ordre reste possible avec un avertissement.
- Le calculateur de risque affiche la même mise en garde (réduire la taille de moitié ou attendre) quand une annonce majeure approche.
- **Écartées** : jours fériés (Nager.Date, The Calendar) : le statut du marché de Capital.com dit déjà si un marché est fermé ; actualités RSS (Noozra) : il faudrait noter chaque titre avec un modèle de langage, et rien ne permet aujourd'hui de mesurer si ça aiderait.

### Profil de volume (théorie des enchères)

- **Quoi** (`lib/profile.ts`) : où le prix a passé son volume sur la dernière journée de bougies (hors bougie en cours) : **POC** (le prix le plus échangé), **zone de valeur** (la bande autour du POC qui contient ≈ 70 % du volume ; haut VAH, bas VAL) et la position du prix : dans la zone (« équilibre ») ou au-dessus / en dessous (« déséquilibre »). Calcul : 40 tranches de prix, le volume de chaque bougie réparti sur les tranches qu'elle traverse, zone de valeur élargie à partir du POC en prenant à chaque pas le côté le plus actif.
- **Où** : bouton « Profil » sous le graphique (lignes POC, VAH, VAL) et panneau « Profil de volume (AMT) » (onglet Prévision) avec l'histogramme, les niveaux et la lecture.
- **Limite importante** : le volume d'un CFD est un volume « de ticks » (combien de fois le prix a bougé), pas des quantités échangées en bourse : ce n'est pas du vrai flux d'ordres. Sans aucun volume, le profil compte le temps passé à chaque prix (le Market Profile classique) et le panneau l'indique.
- **Mesuré, pas supposé** : chaque prévision courte enregistre où se trouvait le prix par rapport à la zone de valeur ; le journal affiche la réussite quand la prévision est « dans la zone », « vers la zone » (retour à la valeur) ou « s'en éloigne » (le marché accepte les nouveaux prix). Si rien ne ressort après quelques semaines, l'idée sera abandonnée.

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
