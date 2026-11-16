import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, shareReplay } from 'rxjs';

export interface Movie {
  id: number;
  title: string;
  original_title: string;
  /** Titre anglais : c'est celui que Letterboxd met dans ses exports. */
  english_title: string;
  release_date: string;
  poster_path: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids: number[];
  original_language: string;
  overview: string;
}

export interface Genre { id: number; name: string; }
export interface Provider { provider_id: number; provider_name: string; logo_path: string; display_priority: number; }

export interface MovieFilters {
  query: string;
  sortBy: string;
  genres: number[];
  excludedGenres: number[];
  yearFrom: number | null;
  yearTo: number | null;
  minRating: number;
  minVotes: number;
  runtimeMin: number | null;
  runtimeMax: number | null;
  language: string;
  providers: number[];
}

export const DEFAULT_FILTERS: MovieFilters = {
  query: '',
  sortBy: 'popularity.desc',
  genres: [],
  excludedGenres: [],
  yearFrom: null,
  yearTo: null,
  minRating: 0,
  minVotes: 100,
  runtimeMin: null,
  runtimeMax: null,
  language: '',
  providers: [],
};

export interface MoviePage { movies: Movie[]; page: number; totalPages: number; totalResults: number; }

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private http = inject(HttpClient);
  private readonly apiUrl = 'https://api.themoviedb.org/3';
  private readonly LS_TOKEN = 'tmdbToken';
  readonly region = 'FR';

  get token(): string { return (localStorage.getItem(this.LS_TOKEN) ?? '').trim(); }
  setToken(token: string) { localStorage.setItem(this.LS_TOKEN, token.trim()); }

  private headers(token = this.token): HttpHeaders {
    return new HttpHeaders(token ? { Authorization: `Bearer ${token}` } : {});
  }

  validateToken(token: string): Observable<boolean> {
    return this.http.get(`${this.apiUrl}/configuration`, { headers: this.headers(token.trim()) }).pipe(
      map(() => true),
      catchError(() => of(false)),
    );
  }

  private genres$?: Observable<Genre[]>;
  genres(): Observable<Genre[]> {
    return this.genres$ ??= this.http
      .get<{ genres: Genre[] }>(`${this.apiUrl}/genre/movie/list?language=fr-FR`, { headers: this.headers() })
      .pipe(map(r => r.genres), shareReplay(1));
  }

  private providers$?: Observable<Provider[]>;
  providers(): Observable<Provider[]> {
    return this.providers$ ??= this.http
      .get<{ results: Provider[] }>(
        `${this.apiUrl}/watch/providers/movie?language=fr-FR&watch_region=${this.region}`,
        { headers: this.headers() })
      .pipe(
        map(r => r.results.sort((a, b) => a.display_priority - b.display_priority).slice(0, 30)),
        shareReplay(1),
      );
  }

  /**
   * Une page de résultats. Recherche texte si `query` est rempli (TMDB n'accepte
   * alors que l'année : les autres filtres sont appliqués côté client), sinon discover.
   *
   * Chaque page est demandée deux fois, en français pour l'affichage et en anglais
   * pour le rapprochement avec les exports Letterboxd, qui sont en anglais.
   * Les deux réponses arrivent dans le même ordre, mais on recolle par id.
   */
  movies(filters: MovieFilters, page: number): Observable<MoviePage> {
    const query = filters.query.trim();
    const path = query ? '/search/movie' : '/discover/movie';
    const params = query ? this.searchParams(filters, page) : this.discoverParams(filters, page);

    const get = (language: string) => this.http.get<any>(`${this.apiUrl}${path}`, {
      headers: this.headers(),
      params: params.set('language', language),
    });

    return forkJoin([get('fr-FR'), get('en-US').pipe(catchError(() => of({ results: [] })))]).pipe(
      map(([fr, en]) => {
        const englishTitles = new Map<number, string>(
          (en.results as any[]).map(m => [m.id, m.title as string]));
        let movies: Movie[] = (fr.results as any[]).map(m => ({
          ...m,
          english_title: englishTitles.get(m.id) ?? m.original_title,
        }));
        if (query) movies = movies.filter(m => this.matchesClientSide(m, filters));
        return {
          movies,
          page: fr.page,
          totalPages: Math.min(fr.total_pages, 500),
          totalResults: fr.total_results,
        };
      }),
    );
  }

  private discoverParams(f: MovieFilters, page: number): HttpParams {
    let p = new HttpParams()
      .set('include_adult', 'false')
      .set('page', page)
      .set('sort_by', f.sortBy);

    if (f.genres.length) p = p.set('with_genres', f.genres.join(','));          // ET
    if (f.excludedGenres.length) p = p.set('without_genres', f.excludedGenres.join('|'));
    if (f.yearFrom) p = p.set('primary_release_date.gte', `${f.yearFrom}-01-01`);
    if (f.yearTo) p = p.set('primary_release_date.lte', `${f.yearTo}-12-31`);
    if (f.minRating > 0) p = p.set('vote_average.gte', f.minRating);
    if (f.minVotes > 0) p = p.set('vote_count.gte', f.minVotes);
    if (f.runtimeMin) p = p.set('with_runtime.gte', f.runtimeMin);
    if (f.runtimeMax) p = p.set('with_runtime.lte', f.runtimeMax);
    if (f.language) p = p.set('with_original_language', f.language);
    if (f.providers.length) {
      p = p.set('with_watch_providers', f.providers.join('|'))                    // OU
        .set('watch_region', this.region)
        .set('with_watch_monetization_types', 'flatrate|free|ads');
    }
    // Les films pas encore sortis n'ont rien à faire dans un « on regarde quoi ce soir »
    if (!f.yearTo) p = p.set('primary_release_date.lte', new Date().toISOString().slice(0, 10));
    return p;
  }

  private searchParams(f: MovieFilters, page: number): HttpParams {
    let p = new HttpParams().set('query', f.query.trim()).set('include_adult', 'false').set('page', page);
    if (f.yearFrom && f.yearFrom === f.yearTo) p = p.set('primary_release_year', f.yearFrom);
    return p;
  }

  private matchesClientSide(m: Movie, f: MovieFilters): boolean {
    const year = Number(m.release_date?.slice(0, 4)) || 0;
    if (f.yearFrom && year < f.yearFrom) return false;
    if (f.yearTo && year > f.yearTo) return false;
    if (f.minRating > 0 && m.vote_average < f.minRating) return false;
    if (f.genres.some(g => !m.genre_ids.includes(g))) return false;
    if (f.excludedGenres.some(g => m.genre_ids.includes(g))) return false;
    if (f.language && m.original_language !== f.language) return false;
    return true;
  }

  imdbUrl(id: number): Observable<string> {
    return this.http.get<{ imdb_id: string | null }>(`${this.apiUrl}/movie/${id}/external_ids`, { headers: this.headers() })
      .pipe(map(r => r.imdb_id ? `https://www.imdb.com/title/${r.imdb_id}/` : ''), catchError(() => of('')));
  }

  posterUrl(path: string | null, size: 'w342' | 'w500' = 'w342'): string {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
  }

  logoUrl(path: string): string {
    return `https://image.tmdb.org/t/p/w92${path}`;
  }
}
