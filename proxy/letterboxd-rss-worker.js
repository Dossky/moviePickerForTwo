/**
 * Cloudflare Worker : relaie le flux RSS public d'un profil Letterboxd en ajoutant
 * les en-têtes CORS, pour que l'appli (hébergée sur GitHub Pages) puisse le lire.
 *
 * Déploiement : dash.cloudflare.com → Workers & Pages → Create → « Hello World »,
 * coller ce fichier, Deploy, puis copier l'URL (https://xxx.workers.dev) dans les
 * réglages de l'appli.
 *
 * Usage : GET https://xxx.workers.dev/?u=<pseudo>
 * Ne relaie QUE letterboxd.com/<pseudo>/rss/ : pas un proxy ouvert.
 */

// Restreindre aux origines de l'appli. Ajouter http://localhost:4200 pour le dev.
const ALLOWED_ORIGINS = [
  'https://dossky.github.io',
  'http://localhost:4200',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const username = new URL(request.url).searchParams.get('u') ?? '';
    // Pseudos Letterboxd : lettres, chiffres et « _ »
    if (!/^[A-Za-z0-9_]{1,40}$/.test(username)) {
      return new Response('Pseudo invalide', { status: 400, headers: cors });
    }

    const upstream = await fetch(`https://letterboxd.com/${username}/rss/`, {
      headers: { 'User-Agent': 'moviePickerForTwo RSS relay' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });

    return new Response(upstream.ok ? upstream.body : `Letterboxd: HTTP ${upstream.status}`, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    });
  },
};
