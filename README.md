# moviePickerForTwo

Trouver un film à regarder à deux : une grille de films TMDB avec plein de filtres
(genres inclus/exclus, années, note, nombre de votes, durée, langue, plateformes de
streaming en France, recherche par titre), et un bouton **« Qui a vu ? »** qui pose sur
chaque affiche une coche de couleur pour chacun des deux profils Letterboxd :
orange en haut à gauche pour le pseudo 1, bleue en haut à droite pour le pseudo 2.
Le filtre « Films vus » permet ensuite de ne garder que ce qu'aucun des deux n'a vu.

Même stack que MovieShreddle : Angular 18 standalone, sans backend, hébergé sur GitHub Pages.

## TMDB

Au premier lancement, l'appli demande un **jeton d'accès en lecture** TMDB
(themoviedb.org → Paramètres → API → *API Read Access Token*). Il est gardé dans le
localStorage du navigateur, jamais dans le dépôt.

## Films vus sur Letterboxd

Letterboxd n'a pas d'API publique. Comme dans MFLH2, deux sources se complètent :

| Source | Contenu | Rapprochement |
|---|---|---|
| Archive d'export (`.zip`) | tout l'historique (`watched.csv`, `diary.csv`) | titre normalisé + année (titres FR, EN et originaux TMDB) |
| Flux RSS du profil | ~50 dernières entrées du journal | identifiant TMDB (`tmdb:movieId`), exact |

- **Archive** : sur letterboxd.com, *Settings → Data → Export your data*, puis bouton ↓ à
  côté du pseudo. Lue dans le navigateur, rien n'est envoyé nulle part. Le pseudo est
  repris de `profile.csv` s'il n'est pas saisi.
- **RSS** : Letterboxd n'envoie pas d'en-têtes CORS, donc le navigateur ne peut pas le lire
  directement depuis GitHub Pages. Le dossier [`proxy/`](proxy/letterboxd-rss-worker.js)
  contient un Cloudflare Worker d'une vingtaine de lignes qui ne relaie que
  `letterboxd.com/<pseudo>/rss/`. Une fois déployé (gratuit), coller son URL dans ⚙ Réglages.

Sans archive, seuls les ~50 derniers films du journal sont connus. Sans proxy, seule
l'archive sert.

## Développement

```bash
npm install
npm start            # http://localhost:4200
```

## Déploiement (GitHub Pages)

```bash
npm run deploy       # build avec --base-href /moviePickerForTwo/ puis push sur la branche gh-pages
```

Dans *Settings → Pages* du dépôt : *Deploy from a branch* → `gh-pages` / `(root)`.
