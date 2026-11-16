import { Injectable, computed, signal } from '@angular/core';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Les films vus par un profil Letterboxd, sur le modèle de MFLH2 :
 *
 * 1. l'archive d'export (Settings → Data → Export sur letterboxd.com), qui contient
 *    tout l'historique mais aucun identifiant TMDB : on la rapproche par titre + année ;
 * 2. le flux RSS public, qui ne contient que les ~50 dernières entrées du journal
 *    mais porte l'identifiant TMDB (`tmdb:movieId`). Il rattrape ce qui a été vu
 *    depuis l'export.
 *
 * Letterboxd n'envoie pas d'en-têtes CORS : depuis GitHub Pages, le flux passe par
 * un petit proxy (voir `proxy/letterboxd-rss-worker.js`). Sans proxy configuré,
 * seule l'archive sert.
 */

export interface LetterboxdFilm { title: string; year: number; tmdbId: number; }

export interface ProfileState {
  username: string;
  archiveName: string;
  archiveFilms: LetterboxdFilm[];
  rssFilms: LetterboxdFilm[];
  rssCheckedAt: string;
}

export interface SeenCandidate {
  id: number;
  titles: string[];
  year: number;
}

const EMPTY: ProfileState = { username: '', archiveName: '', archiveFilms: [], rssFilms: [], rssCheckedAt: '' };

/** Index d'un profil : ids TMDB sûrs + clés « titre normalisé|année ». */
class SeenIndex {
  readonly tmdbIds = new Set<number>();
  readonly keys = new Set<string>();

  constructor(state: ProfileState) {
    for (const film of [...state.archiveFilms, ...state.rssFilms]) {
      if (film.tmdbId > 0) this.tmdbIds.add(film.tmdbId);
      const key = matchKey(film.title, film.year);
      if (key) this.keys.add(key);
    }
  }

  get size(): number { return this.keys.size; }

  has(movie: SeenCandidate): boolean {
    if (this.tmdbIds.has(movie.id)) return true;
    return movie.titles.some(t => this.keys.has(matchKey(t, movie.year)));
  }
}

@Injectable({ providedIn: 'root' })
export class LetterboxdService {
  private readonly LS_PROFILE = 'letterboxdProfile_';
  private readonly LS_PROXY = 'letterboxdProxyUrl';

  readonly profiles = [signal<ProfileState>(this.load(0)), signal<ProfileState>(this.load(1))] as const;
  readonly indexes = [
    computed(() => new SeenIndex(this.profiles[0]())),
    computed(() => new SeenIndex(this.profiles[1]())),
  ] as const;

  readonly proxyUrl = signal(localStorage.getItem(this.LS_PROXY) ?? '');

  setProxyUrl(url: string) {
    this.proxyUrl.set(url.trim());
    localStorage.setItem(this.LS_PROXY, url.trim());
  }

  setUsername(slot: 0 | 1, username: string) {
    const clean = username.trim().replace(/^@/, '');
    this.update(slot, p => p.username.toLowerCase() === clean.toLowerCase()
      ? { ...p, username: clean }
      // Autre pseudo : le flux de l'ancien n'a plus rien à faire là.
      : { ...p, username: clean, rssFilms: [], rssCheckedAt: '' });
  }

  clear(slot: 0 | 1) {
    this.update(slot, p => ({ ...EMPTY, username: p.username }));
  }

  hasData(slot: 0 | 1): boolean {
    const p = this.profiles[slot]();
    return p.archiveFilms.length > 0 || p.rssFilms.length > 0;
  }

  seen(slot: 0 | 1, movie: SeenCandidate): boolean {
    return this.indexes[slot]().has(movie);
  }

  /**
   * Lit le zip d'export. L'archive remplace la précédente (c'est un export complet :
   * fusionner garderait pour toujours un film retiré du compte).
   * Le pseudo est repris de `profile.csv` s'il n'est pas déjà saisi.
   */
  async importArchive(slot: 0 | 1, file: File): Promise<number> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
      // Seuls les fichiers de la racine : « deleted/ » et « orphaned/ » portent les mêmes noms.
      entries = unzipSync(bytes, { filter: f => /^(watched|diary|profile)\.csv$/i.test(f.name) });
    } catch {
      throw new Error("Ce fichier n'est pas un zip d'export Letterboxd.");
    }
    const read = (name: string) => {
      const key = Object.keys(entries).find(k => k.toLowerCase() === name);
      return key ? strFromU8(entries[key]) : '';
    };

    const films = new Map<string, LetterboxdFilm>();
    for (const name of ['watched.csv', 'diary.csv']) {
      for (const row of parseCsv(read(name))) {
        const title = row['Name']?.trim();
        if (!title) continue;
        const year = Number(row['Year']) || 0;
        films.set(matchKey(title, year), { title, year, tmdbId: 0 });
      }
    }
    if (films.size === 0) throw new Error('Aucun film vu trouvé dans cette archive (watched.csv vide ou absent).');

    const archiveUser = parseCsv(read('profile.csv'))[0]?.['Username']?.trim() ?? '';
    this.update(slot, p => ({
      ...p,
      username: p.username || archiveUser,
      archiveName: file.name,
      archiveFilms: [...films.values()],
    }));
    return films.size;
  }

  /** Relit le flux RSS du pseudo via le proxy. Rend le nombre d'entrées lues. */
  async refreshRss(slot: 0 | 1): Promise<number> {
    const { username } = this.profiles[slot]();
    const proxy = this.proxyUrl();
    if (!username || !proxy) return 0;

    const url = new URL(proxy);
    url.searchParams.set('u', username);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.status === 404
        ? `Profil « ${username} » introuvable sur Letterboxd (pseudo exact et profil public ?)`
        : `Flux Letterboxd de « ${username} » injoignable (HTTP ${response.status})`);
    }

    const films = parseRss(await response.text());
    this.update(slot, p => ({ ...p, rssFilms: films, rssCheckedAt: new Date().toISOString() }));
    return films.length;
  }

  private update(slot: 0 | 1, fn: (p: ProfileState) => ProfileState) {
    const next = fn(this.profiles[slot]());
    this.profiles[slot].set(next);
    try {
      localStorage.setItem(this.LS_PROFILE + slot, JSON.stringify(next));
    } catch {
      // localStorage plein : l'état reste valable pour la session.
    }
  }

  private load(slot: 0 | 1): ProfileState {
    try {
      const raw = localStorage.getItem(this.LS_PROFILE + slot);
      return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  }
}

// -- Rapprochement -------------------------------------------------------------

/**
 * Normalisation reprise de MFLH2 (TitleMatching.Normalize) : accents, année de
 * désambiguïsation, ponctuation (typographique comprise : « – », « × », espace
 * insécable), articles français et anglais, casse.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([]\s*(18|19|20)\d{2}\s*[)\]]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/×/g, ' x ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(w => w && !['the', 'a', 'an', 'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de'].includes(w))
    .join(' ');
}

function matchKey(title: string, year: number): string {
  const normalized = normalizeTitle(title);
  return normalized ? `${normalized}|${year || 0}` : '';
}

// -- Formats -------------------------------------------------------------------

/** CSV RFC 4180 (guillemets, virgules et retours à la ligne dans les champs), lu par en-tête. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...records] = rows.filter(r => r.some(f => f.trim()));
  if (!header) return [];
  const names = header.map(h => h.replace(/^﻿/, '').trim());
  return records.map(r => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ''])));
}

/**
 * Flux RSS : éléments cherchés par nom local, sans dépendre des préfixes
 * `letterboxd:` / `tmdb:`. Les listes publiées (sans `filmTitle`) sont ignorées.
 */
export function parseRss(xml: string): LetterboxdFilm[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];

  return Array.from(doc.getElementsByTagName('item')).flatMap(item => {
    const child = (name: string) =>
      Array.from(item.children).find(e => e.localName === name)?.textContent?.trim() ?? '';
    const title = child('filmTitle');
    return title
      ? [{ title, year: Number(child('filmYear')) || 0, tmdbId: Number(child('movieId')) || 0 }]
      : [];
  });
}
