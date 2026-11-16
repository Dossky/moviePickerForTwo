import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { LetterboxdService } from '../services/letterboxd.service';
import { DEFAULT_FILTERS, Genre, Movie, MovieFilters, Provider, TmdbService } from '../services/tmdb.service';

type Slot = 0 | 1;
type SeenFilter = 'all' | 'hideAny' | 'hideBoth' | 'hide0' | 'hide1' | 'onlyBoth';
type GenreState = 'none' | 'include' | 'exclude';

const LANGUAGES: { code: string; label: string }[] = [
  { code: '', label: 'Toutes' },
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'Anglais' },
  { code: 'ja', label: 'Japonais' },
  { code: 'ko', label: 'Coréen' },
  { code: 'es', label: 'Espagnol' },
  { code: 'it', label: 'Italien' },
  { code: 'de', label: 'Allemand' },
  { code: 'zh', label: 'Chinois' },
  { code: 'hi', label: 'Hindi' },
  { code: 'da', label: 'Danois' },
  { code: 'sv', label: 'Suédois' },
];

const SORTS: { value: string; label: string }[] = [
  { value: 'popularity.desc', label: 'Popularité' },
  { value: 'vote_average.desc', label: 'Meilleures notes' },
  { value: 'vote_count.desc', label: 'Les plus votés' },
  { value: 'primary_release_date.desc', label: 'Plus récents' },
  { value: 'primary_release_date.asc', label: 'Plus anciens' },
  { value: 'revenue.desc', label: 'Box-office' },
];

@Component({
  selector: 'app-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './picker.component.html',
  styleUrl: './picker.component.css',
})
export class PickerComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly tmdb = inject(TmdbService);
  readonly lb = inject(LetterboxdService);

  readonly languages = LANGUAGES;
  readonly sorts = SORTS;
  readonly slots: Slot[] = [0, 1];
  readonly currentYear = new Date().getFullYear();

  private readonly LS_FILTERS = 'movieFilters';
  private readonly LS_SEEN_FILTER = 'seenFilter';

  // Données
  genres = signal<Genre[]>([]);
  providers = signal<Provider[]>([]);
  movies = signal<Movie[]>([]);
  page = signal(0);
  totalPages = signal(1);
  totalResults = signal(0);
  loading = signal(false);
  error = signal('');

  // Filtres
  filters = signal<MovieFilters>(this.loadFilters());
  seenFilter = signal<SeenFilter>((localStorage.getItem(this.LS_SEEN_FILTER) as SeenFilter) || 'all');
  showFilters = signal(window.innerWidth > 900);

  // Letterboxd
  showSeen = signal(false);
  checking = signal(false);
  slotMessages = signal<[string, string]>(['', '']);
  checkMessage = signal('');

  // Dialogues
  showTokenDialog = signal(false);
  showSettings = signal(false);
  tokenInput = signal('');
  tokenError = signal('');
  proxyInput = signal(this.lb.proxyUrl());
  selected = signal<Movie | null>(null);
  selectedImdb = signal('');

  @ViewChild('sentinel') sentinel?: ElementRef<HTMLElement>;
  private observer?: IntersectionObserver;
  private request?: Subscription;
  private debounce?: ReturnType<typeof setTimeout>;

  visibleMovies = computed(() => {
    const movies = this.movies();
    const filter = this.seenFilter();
    if (!this.showSeen() || filter === 'all') return movies;
    return movies.filter(m => {
      const [a, b] = [this.isSeen(0, m), this.isSeen(1, m)];
      switch (filter) {
        case 'hideAny': return !a && !b;
        case 'hideBoth': return !(a && b);
        case 'hide0': return !a;
        case 'hide1': return !b;
        case 'onlyBoth': return a && b;
        default: return true;
      }
    });
  });

  seenCounts = computed(() => {
    const movies = this.movies();
    if (!this.showSeen()) return null;
    let a = 0, b = 0, both = 0;
    for (const m of movies) {
      const [x, y] = [this.isSeen(0, m), this.isSeen(1, m)];
      if (x) a++;
      if (y) b++;
      if (x && y) both++;
    }
    return { a, b, both, total: movies.length };
  });

  activeFilterCount = computed(() => {
    const f = this.filters();
    const d = DEFAULT_FILTERS;
    return [
      f.genres.length + f.excludedGenres.length > 0,
      f.yearFrom !== d.yearFrom || f.yearTo !== d.yearTo,
      f.minRating !== d.minRating,
      f.minVotes !== d.minVotes,
      f.runtimeMin !== d.runtimeMin || f.runtimeMax !== d.runtimeMax,
      f.language !== d.language,
      f.providers.length > 0,
    ].filter(Boolean).length;
  });

  @HostListener('document:keydown.escape')
  closeOverlays() {
    this.selected.set(null);
    this.showSettings.set(false);
  }

  ngOnInit() {
    if (!this.tmdb.token) {
      this.showTokenDialog.set(true);
      return;
    }
    this.start();
  }

  ngAfterViewInit() {
    this.observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) this.loadMore();
    }, { rootMargin: '600px' });
    if (this.sentinel) this.observer.observe(this.sentinel.nativeElement);
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    this.request?.unsubscribe();
  }

  private start() {
    this.tmdb.genres().subscribe({ next: g => this.genres.set(g), error: () => {} });
    this.tmdb.providers().subscribe({ next: p => this.providers.set(p), error: () => {} });
    this.reload();
  }

  // -- Grille -------------------------------------------------------------------

  reload() {
    this.request?.unsubscribe();
    this.movies.set([]);
    this.page.set(0);
    this.totalPages.set(1);
    this.loading.set(false);
    this.loadMore();
  }

  loadMore() {
    if (this.loading() || !this.tmdb.token || this.page() >= this.totalPages()) return;
    this.loading.set(true);
    this.error.set('');

    this.request = this.tmdb.movies(this.filters(), this.page() + 1).subscribe({
      next: result => {
        const known = new Set(this.movies().map(m => m.id));
        this.movies.update(list => [...list, ...result.movies.filter(m => !known.has(m.id))]);
        this.page.set(result.page);
        this.totalPages.set(result.totalPages);
        this.totalResults.set(result.totalResults);
        this.loading.set(false);
        // Grand écran ou filtre « vus » qui masque beaucoup : continuer tant que la sentinelle est visible
        queueMicrotask(() => this.fillViewport());
      },
      error: err => {
        this.loading.set(false);
        if (err?.status === 401) {
          this.error.set('Token TMDB refusé.');
          this.showTokenDialog.set(true);
        } else {
          this.error.set('TMDB ne répond pas, réessaie dans un instant.');
        }
      },
    });
  }

  private fillViewport() {
    const el = this.sentinel?.nativeElement;
    if (el && el.getBoundingClientRect().top < window.innerHeight + 600) this.loadMore();
  }

  // -- Filtres ------------------------------------------------------------------

  patchFilters(patch: Partial<MovieFilters>, delay = 0) {
    this.filters.update(f => ({ ...f, ...patch }));
    localStorage.setItem(this.LS_FILTERS, JSON.stringify(this.filters()));
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.reload(), delay);
  }

  numberOrNull(value: string | number | null): number | null {
    const n = Number(value);
    return value === '' || value === null || Number.isNaN(n) || n <= 0 ? null : n;
  }

  genreState(id: number): GenreState {
    const f = this.filters();
    return f.genres.includes(id) ? 'include' : f.excludedGenres.includes(id) ? 'exclude' : 'none';
  }

  /** Clic : neutre → inclus → exclu → neutre. */
  cycleGenre(id: number) {
    const f = this.filters();
    const state = this.genreState(id);
    const genres = f.genres.filter(g => g !== id);
    const excludedGenres = f.excludedGenres.filter(g => g !== id);
    if (state === 'none') genres.push(id);
    if (state === 'include') excludedGenres.push(id);
    this.patchFilters({ genres, excludedGenres });
  }

  toggleProvider(id: number) {
    const providers = this.filters().providers;
    this.patchFilters({ providers: providers.includes(id) ? providers.filter(p => p !== id) : [...providers, id] });
  }

  resetFilters() {
    this.patchFilters({ ...DEFAULT_FILTERS, query: this.filters().query });
  }

  setSeenFilter(value: SeenFilter) {
    this.seenFilter.set(value);
    localStorage.setItem(this.LS_SEEN_FILTER, value);
    queueMicrotask(() => this.fillViewport());
  }

  private loadFilters(): MovieFilters {
    try {
      return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(this.LS_FILTERS) ?? '{}') };
    } catch {
      return { ...DEFAULT_FILTERS };
    }
  }

  // -- Letterboxd -----------------------------------------------------------------

  isSeen(slot: Slot, movie: Movie): boolean {
    return this.lb.seen(slot, {
      id: movie.id,
      titles: [movie.english_title, movie.original_title, movie.title].filter(Boolean),
      year: Number(movie.release_date?.slice(0, 4)) || 0,
    });
  }

  displayName(slot: Slot): string {
    return this.lb.profiles[slot]().username || (slot === 0 ? 'Pseudo 1' : 'Pseudo 2');
  }

  slotStatus(slot: Slot): string {
    const p = this.lb.profiles[slot]();
    const parts: string[] = [];
    if (p.archiveFilms.length) parts.push(`${p.archiveFilms.length} films (archive)`);
    if (p.rssFilms.length) parts.push(`${p.rssFilms.length} récents (RSS)`);
    return parts.join(' · ') || 'Aucune donnée';
  }

  onUsername(slot: Slot, value: string) {
    this.lb.setUsername(slot, value);
  }

  async onArchive(slot: Slot, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const count = await this.lb.importArchive(slot, file);
      this.setSlotMessage(slot, `${count} films importés`);
    } catch (e) {
      this.setSlotMessage(slot, (e as Error).message);
    }
  }

  clearSlot(slot: Slot) {
    this.lb.clear(slot);
    this.setSlotMessage(slot, '');
  }

  private setSlotMessage(slot: Slot, message: string) {
    this.slotMessages.update(m => (slot === 0 ? [message, m[1]] : [m[0], message]) as [string, string]);
  }

  /** « Qui a vu ? » : relit les flux RSS (si proxy) puis affiche les coches. */
  async checkSeen() {
    if (this.showSeen() && !this.checking()) {
      // Deuxième clic : on masque les coches
      this.showSeen.set(false);
      this.checkMessage.set('');
      return;
    }

    const usable = this.slots.filter(s => this.lb.profiles[s]().username || this.lb.hasData(s));
    if (usable.length === 0) {
      this.checkMessage.set('Saisis au moins un pseudo, ou importe une archive Letterboxd.');
      return;
    }

    this.checking.set(true);
    this.checkMessage.set('');
    const problems: string[] = [];

    if (this.lb.proxyUrl()) {
      await Promise.all(usable.map(async slot => {
        try {
          await this.lb.refreshRss(slot);
        } catch (e) {
          problems.push((e as Error).message);
        }
      }));
    } else if (usable.some(s => !this.lb.profiles[s]().archiveFilms.length)) {
      problems.push('Sans proxy RSS ni archive, impossible de savoir ce qui a été vu : voir ⚙ Réglages.');
    }

    for (const slot of usable) {
      if (!this.lb.hasData(slot)) problems.push(`Rien à comparer pour ${this.displayName(slot)}.`);
    }

    this.checking.set(false);
    this.showSeen.set(true);
    this.checkMessage.set([...new Set(problems)].join(' '));
    queueMicrotask(() => this.fillViewport());
  }

  // -- Fiche ----------------------------------------------------------------------

  open(movie: Movie) {
    this.selected.set(movie);
    this.selectedImdb.set('');
    this.tmdb.imdbUrl(movie.id).subscribe(url => this.selectedImdb.set(url));
  }

  genreNames(movie: Movie): string {
    const byId = new Map(this.genres().map(g => [g.id, g.name]));
    return movie.genre_ids.map(id => byId.get(id)).filter(Boolean).join(', ');
  }

  year(movie: Movie): string {
    return movie.release_date?.slice(0, 4) ?? '';
  }

  // -- Réglages -------------------------------------------------------------------

  submitToken() {
    const token = this.tokenInput().trim();
    if (!token) {
      this.tokenError.set('Colle ton token TMDB.');
      return;
    }
    this.tokenError.set('');
    this.tmdb.validateToken(token).subscribe(valid => {
      if (!valid) {
        this.tokenError.set('Token refusé par TMDB (il faut le « jeton d\'accès en lecture », v4).');
        return;
      }
      this.tmdb.setToken(token);
      this.showTokenDialog.set(false);
      this.tokenInput.set('');
      this.start();
    });
  }

  openSettings() {
    this.proxyInput.set(this.lb.proxyUrl());
    this.showSettings.set(true);
  }

  saveSettings() {
    const proxy = this.proxyInput().trim();
    if (proxy && !/^https:\/\//.test(proxy)) return;
    this.lb.setProxyUrl(proxy);
    this.showSettings.set(false);
  }

  changeToken() {
    this.showSettings.set(false);
    this.showTokenDialog.set(true);
  }
}
