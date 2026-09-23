import { Component, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { environmentsFor } from './query/environments.config';
import { LegacyQueryBuilderService } from './query/legacy-query-builder.service';
import { QueryBuilderV2Service } from './query/query-builder-v2.service';
import { RecentSearch, RecentSearchesService } from './query/recent-searches.service';
import { EngineId, QueryInput, QueryResult } from './query/query-input.model';
import { CHRONIC_PATTERNS, ROUTINE_CHATTER } from './query/noise.config';
import {
  activeScopeExtras,
  fieldsFor,
  findCategory,
  findOption,
  ScopeField,
  ScopeGuidance,
  ScopeOption,
  SCOPES,
  scopeSuppliesOwnLogs,
} from './query/scopes.config';

/** What the scope status chip says, and what its details list. */
export interface ScopeStatus {
  tone: 'raw' | 'open' | 'scoped';
  label: string;
  hidden: { what: string; chronic: boolean }[];
  kept: string[];
  notes: string[];
  chronicHidden: boolean;
}

/** Which engine(s) to run for a submission. */
export type EngineMode = 'v2' | 'legacy' | 'compare';

/** One cell in the range picker's month grid. */
export interface CalendarDay {
  /** `YYYY-MM-DD` in LOCAL time -- the same shape the inputs use. */
  key: string;
  label: number;
  inMonth: boolean;
  isStart: boolean;
  isEnd: boolean;
  inRange: boolean;
  isToday: boolean;
  disabled: boolean;
}

/**
 * `YYYY-MM-DD` for a Date in LOCAL time.
 *
 * Not `toISOString().slice(0, 10)`, which is UTC and therefore reports the
 * wrong day for any evening west of Greenwich -- 8pm Mountain is already
 * tomorrow in UTC, so a "today" comparison would disable today.
 */
function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** One engine's output, ready to render and open. */
export interface QueryPreview {
  engine: EngineId;
  label: string;
  query: string;
  url: string;
  rehydrate: boolean;
  warnings: string[];
  errors: string[];
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false
})
export class AppComponent {
  servProvCode: string = '';
  host: string = '';
  environment: string = '';
  selectedTimeframe: string = 'TODAY';
  /*
   * What the Timeframe dropdown shows once the calendar or the time fields have
   * taken over. Without it the dropdown kept claiming the last preset, so
   * choosing that preset again was not a change, no event fired, and the preset
   * appeared to do nothing -- reported 2026-09-22 after a calendar pick.
   */
  static readonly CUSTOM_TIMEFRAME = 'CUSTOM';
  beginTimestamp: number = 0;
  endTimestamp: number = 0;
  activeBeginCalendarValue: string = '';
  activeEndCalendarValue: string = '';
  applicationsUsed: string[] = [];
  additionalServices: string[] = [];
  traceId: string = '';
  additionalParams: string = '';
  readmeHidden: boolean = true;
  availableEnvironments: string[] = [];

  /**
   * Defaults to the corrected engine. Every clause it generates was run against
   * live Datadog on 2026-08-27 and returns events, so the side-by-side compare
   * that used to be the default now costs a click for no benefit. 'compare' is
   * still selectable for spot-checking a query against the old behaviour, and
   * 'legacy' remains a real fallback -- the characterization tests guarantee it
   * reproduces the original queries exactly.
   */
  engineMode: EngineMode = 'v2';

  /**
   * Whether to show the engine selector at all. Off: it is a testing affordance,
   * and "New (v2)" means nothing to the frontline users this form is for.
   *
   * The legacy engine, `compare` mode and the characterization tests all remain,
   * so setting this to true restores a side-by-side comparison run.
   */
  showEngineSelector = false;

  /** Populated on submit; drives the preview panel. */
  previews: QueryPreview[] = [];
  /** Whether the generated query text is expanded. Collapsed by default. */
  showQueryText = false;

  /*
   * -------------------------------------------------------------------------
   * THE WINDOW, STATED IN THE RESULT
   * -------------------------------------------------------------------------
   * A real search came back empty and was reported as the feature being
   * broken. The query was fine; the window ended six minutes before the event.
   * Nothing in the UI said what window was about to be searched, so there was
   * nothing to check.
   *
   * UTC is shown alongside local because the timestamp inputs are
   * browser-local: two people typing the same clock time in different
   * timezones get different searches, and the second one has no way to know.
   */
  get searchWindowLabel(): string {
    if (!this.beginTimestamp || !this.endTimestamp) return '';
    const fmt = (ms: number) =>
      new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    const mins = Math.round((this.endTimestamp - this.beginTimestamp) / 60000);
    const span = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
    return `${fmt(this.beginTimestamp)} to ${fmt(this.endTimestamp)} (${span})`;
  }

  get searchWindowUtc(): string {
    if (!this.beginTimestamp || !this.endTimestamp) return '';
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    return `${fmt(this.beginTimestamp)} to ${fmt(this.endTimestamp)} UTC`;
  }

  constructor(
    private legacyEngine: LegacyQueryBuilderService,
    private v2Engine: QueryBuilderV2Service,
    private recent: RecentSearchesService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    const { beginTimestamp, endTimestamp } = this.generateTimestamps();
    this.activeBeginCalendarValue = beginTimestamp.toISOString().slice(0, 16);
    this.activeEndCalendarValue = endTimestamp.toISOString().slice(0, 16);
    this.readmeHidden = true;
    this.recentSearches = this.recent.list(20);
  }

  toggleReadme() {
    this.readmeHidden = !this.readmeHidden;
  }

  /**
   * Every expert control lives behind this, collapsed by default: TRACE_ID,
   * Additional Parameters, and the three include toggles. None of them is
   * actionable without knowing how the engine scopes and excludes, and an
   * unexplained control costs every user attention while helping only a few.
   */
  showAdvanced = false;

  toggleAdvanced() {
    this.showAdvanced = !this.showAdvanced;
    if (!this.showAdvanced) {
      // Closing resets everything behind it, so the collapsed form always means
      // exactly what it shows. Otherwise a setting nobody can see changes the
      // results: a TRACE_ID search ignores every other field on the form, and
      // the include toggles widen the query with nothing on screen to say so.
      this.traceId = '';
      this.additionalParams = '';
      this.showChronic = false;
      this.includeIndexer = false;
      this.includeEmse = false;
      this.includeIis = false;
      // Especially this one. A hidden raw mode would silently discard the scope
      // filters the collapsed form still appears to be applying.
      this.rawMode = false;
      this.previews = [];
    }
  }

  get isCompareMode(): boolean {
    return this.engineMode === 'compare';
  }

  onEngineModeChange(mode: EngineMode) {
    this.engineMode = mode;
    this.previews = [];
  }

  onSubmit(event: Event) {
    event.preventDefault();
    this.previews = [];

    // Absent from the DOM whenever the Advanced disclosure is collapsed, so
    // these have to tolerate a missing element rather than assume one.
    this.traceId = this.readInputValue('inputTraceID');
    this.additionalParams = this.readInputValue('inputAdditionalParams');

    // A trace ID search ignores every other field, and the query is identical
    // whichever engine is selected, so it is handled separately.
    if (this.traceId.trim() !== '') {
      this.submitTraceIdSearch();
      return;
    }

    if (!this.validateForm()) return;

    const [beginUnix, endUnix] = this.convertTimestamps();
    if (!this.validateTimestamps(beginUnix, endUnix)) return;
    this.setValues(beginUnix, endUnix);

    /*
     * Recorded here, after validation, so a half-filled form or a typo that
     * failed validation does not pollute the suggestions. Only the
     * agency/host/environment triple is stored -- never the scoped identifiers.
     */
    this.recent.record(this.servProvCode, this.host, this.environment);
    this.recentSearches = this.recent.list(20);

    const input = this.buildQueryInput();
    const previews: QueryPreview[] = [];

    for (const engineId of this.enginesToRun()) {
      const engine = engineId === 'legacy' ? this.legacyEngine : this.v2Engine;
      const result: QueryResult = engine.build(input);
      previews.push(this.toPreview(engineId, engine.label, result));
    }

    this.previews = previews;

    const blocking = previews.flatMap((p) => p.errors);
    if (blocking.length) {
      alert([...new Set(blocking)].join('\n'));
      return;
    }

    // Compare mode shows both queries for inspection rather than opening them,
    // partly so two popups are not blocked. Single-engine mode keeps the
    // original behaviour of going straight to Datadog.
    if (!this.isCompareMode && previews.length === 1 && previews[0].url) {
      this.openURLInNewTab(previews[0].url);
    }
  }

  private enginesToRun(): EngineId[] {
    if (this.engineMode === 'compare') return ['legacy', 'v2'];
    return [this.engineMode];
  }

  private toPreview(engine: EngineId, label: string, result: QueryResult): QueryPreview {
    if (!result.query) {
      return {
        engine, label, query: '', url: '', rehydrate: false,
        warnings: result.warnings, errors: result.errors,
      };
    }
    const rehydrate = this.isTimestampMoreThanFifteenDaysAgo(this.beginTimestamp);
    const url = rehydrate
      ? this.generateRehydrateURL(result.query)
      : this.generateRedirectURL(result.query);
    return {
      engine, label, query: result.query, url, rehydrate,
      warnings: result.warnings, errors: result.errors,
    };
  }

  /** Open a previewed query. Used by the per-engine buttons in compare mode. */
  openPreview(preview: QueryPreview) {
    if (preview.url) this.openURLInNewTab(preview.url);
  }

  private submitTraceIdSearch() {
    const timestamps = this.setTimestampsFromTraceId(this.traceId);
    if (!timestamps) {
      alert('Invalid traceID.');
      return;
    }

    const { beginTimestamp, endTimestamp } = timestamps;
    this.beginTimestamp = beginTimestamp;
    this.endTimestamp = endTimestamp;

    if (this.isTimestampInFuture(beginTimestamp, endTimestamp)) return;

    const query = this.buildTraceIdDatadogQuery(this.traceId);
    const rehydrate = this.isTimestampMoreThanFifteenDaysAgo(beginTimestamp);
    const url = rehydrate ? this.generateRehydrateURL(query) : this.generateRedirectURL(query);

    this.previews = [
      { engine: 'v2', label: 'Trace ID', query, url, rehydrate, warnings: [], errors: [] },
    ];
    this.openURLInNewTab(url);
  }

  private buildQueryInput(): QueryInput {
    return {
      servProvCode: this.servProvCode,
      host: this.host,
      environment: this.environment,
      applications: this.applicationsUsed,
      additionalServices: this.additionalServices,
      additionalParams: this.additionalParams,
      showChronic: this.showChronic,
      includeIndexer: this.includeIndexer,
      includeEmse: this.includeEmse,
      includeIis: this.includeIis,
      rawMode: this.rawMode,
      // Omitted entirely when nothing is scoped, so the engine takes its
      // original path and the fast search is byte-identical to before.
      scope: this.scopeCategory
        ? {
            category: this.scopeCategory,
            option: this.scopeOption || undefined,
            fields: this.scopeFieldValues,
          }
        : undefined,
    };
  }

  /*
   * The three "include normally hidden" switches. Grouped because they are the
   * same kind of decision -- each one adds back a population the engine holds
   * out by default -- and because grouping them costs one row instead of three.
   *
   * All default to off. Each default was measured, not assumed:
   *   chronic  ~60,000 slow-report warnings in 24h on a busy tenant, 99.6% of
   *            everything surviving the scope
   *   indexer  57% of a real payment investigation, and zero errors or warns
   *   emse     7,525 info-only lines against 1,052 for the rest of the branch
   */
  showChronic = false;
  includeIndexer = false;
  includeEmse = false;
  /*
   * Off by default and deliberately so: LEECO alone logs 1,891,225 IIS access
   * lines in 24 hours. But they were unreachable at ANY setting until now, and
   * they are the only place the HTTP status and page duration live -- in one
   * real case the proof that a payment page took 121 seconds and returned a 302
   * existed only there.
   */
  includeIis = false;

  /*
   * The scope status chip under the Scope dropdown. Replaced the notes under
   * the Generated Query block on 2026-09-22: there they arrived only after
   * Fetch, below the form, as paragraphs -- the place least likely to be read.
   * The chip is one line beside the control it describes, live as the form
   * changes, with the detail one click away.
   *
   * The label comes from the scope state alone so it is right even on a
   * half-filled form. The notes come from the engine itself, built from the
   * live page values, so they cannot drift from what Fetch will actually do.
   */
  scopeNotesOpen = false;

  get scopeStatus(): ScopeStatus {
    const status: ScopeStatus = {
      tone: 'open',
      label: '',
      hidden: [],
      kept: [],
      notes: this.liveEngineNotes(),
      chronicHidden: false,
    };

    if (this.rawMode) {
      status.tone = 'raw';
      status.label = 'Raw logs · nothing filtered';
      return status;
    }

    const category = findCategory(this.scopeCategory);
    if (!category) {
      const agency = this.liveValue('inputServProvCode').trim().toUpperCase();
      const env = this.liveValue('inputEnvironment');
      const target =
        agency && env && env !== '--SELECT--' ? `${agency} ${env}` : 'this agency and environment';
      status.label = `Unfiltered · everything for ${target}`;
      return status;
    }

    // Same exception lists the engine applies, so the count is the real one.
    const { chatterExceptions, chronicExceptions } = activeScopeExtras(
      this.scopeCategory,
      this.scopeOption || undefined,
      this.scopeFieldValues
    );
    for (const p of ROUTINE_CHATTER) {
      if (chatterExceptions.includes(p.phrase)) status.kept.push(p.what);
      else status.hidden.push({ what: p.what, chronic: false });
    }
    for (const p of CHRONIC_PATTERNS) {
      if (chronicExceptions.includes(p.phrase)) status.kept.push(p.what);
      else if (!this.showChronic) status.hidden.push({ what: p.what, chronic: true });
    }
    status.chronicHidden = status.hidden.some((h) => h.chronic);

    const option = findOption(this.scopeCategory, this.scopeOption || undefined);
    const name = option ? `${category.label} / ${option.label}` : category.label;
    status.tone = 'scoped';
    status.label = `${name} only · ${status.hidden.length} noise patterns hidden`;
    return status;
  }

  /*
   * The engine's own notes for the form as it stands. The two chronic lines
   * are dropped because the chip lists those patterns individually; every
   * other note is shown as the engine wrote it. Empty until the form is
   * complete enough to build, which is the same point Fetch would work.
   */
  private liveEngineNotes(): string[] {
    const input: QueryInput = {
      ...this.buildQueryInput(),
      servProvCode: this.liveValue('inputServProvCode'),
      host: this.liveValue('inputHost'),
      environment: this.liveValue('inputEnvironment'),
      applications: this.getCheckedApplications(),
      additionalServices: this.getCheckedAdditionalServices(),
    };
    if (!input.servProvCode.trim() || input.host === '--SELECT--' || !input.environment) return [];
    if (input.environment === '--SELECT--') return [];
    const result = this.v2Engine.build(input);
    if (result.errors.length || !result.query) return [];
    return result.warnings.filter(
      (w) => !w.startsWith('Hidden because') && !w.startsWith('Kept because')
    );
  }

  private liveValue(id: string): string {
    return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  }

  /** Whether the chosen start is past the live window, as the picker shows it. */
  get rangeNeedsRehydration(): boolean {
    const begin = new Date(this.activeBeginCalendarValue).getTime();
    return !Number.isNaN(begin) && this.isTimestampMoreThanFifteenDaysAgo(begin);
  }

  /** The picker's window in UTC, for the trigger's tooltip. */
  get rangeSummaryUtc(): string {
    const b = new Date(this.activeBeginCalendarValue);
    const e = new Date(this.activeEndCalendarValue);
    if (Number.isNaN(b.getTime()) || Number.isNaN(e.getTime())) return '';
    const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
    return `${fmt(b)} to ${fmt(e)} UTC`;
  }

  /*
   * Easter egg, added 2026-09-22: click the dog five times in quick succession
   * and it wiggles, and the tagline says thank you for four seconds. Touches
   * nothing but these two flags. No cursor change or hint, so it stays found
   * rather than advertised.
   */
  petted = false;
  wiggling = false;
  private pets = 0;
  private petResetTimer?: ReturnType<typeof setTimeout>;

  onLogoClick() {
    // Five clicks with no gap longer than 1.5s. Slower clicking starts over.
    clearTimeout(this.petResetTimer);
    this.pets++;
    this.petResetTimer = setTimeout(() => (this.pets = 0), 1500);
    if (this.pets < 5) return;

    this.pets = 0;
    this.petted = true;
    this.wiggling = true;
    setTimeout(() => {
      this.wiggling = false;
      this.cdr.markForCheck();
    }, 900);
    setTimeout(() => {
      this.petted = false;
      this.cdr.markForCheck();
    }, 4000);
  }

  onIncludeToggle(which: 'chronic' | 'indexer' | 'emse' | 'iis', on: boolean) {
    if (which === 'chronic') this.showChronic = on;
    if (which === 'indexer') this.includeIndexer = on;
    if (which === 'emse') this.includeEmse = on;
    if (which === 'iis') this.includeIis = on;
    // The previewed query no longer matches the form.
    this.previews = [];
  }

  /*
   * Separate from the four above, and separately placed in the template, because
   * it is a different kind of thing: those add one population each, this one
   * turns off every filter at once. Grouping it with them would make it look
   * like a fifth checkbox of equal weight.
   *
   * See QueryInput.rawMode for exactly what it drops.
   */
  rawMode = false;

  onRawModeToggle(on: boolean) {
    this.rawMode = on;
    this.previews = [];
  }

  // ------------------------------------------------------------ scoped search

  /** Category dropdown options. */
  readonly scopeCategories = SCOPES;

  /**
   * Guidance for whichever scope is selected, or null. Drives the top section of
   * the Instructions panel, so scope-specific help costs no card height.
   */
  get activeGuidance(): ScopeGuidance | null {
    return findCategory(this.scopeCategory)?.guidance ?? null;
  }

  get activeScopeLabel(): string {
    return findCategory(this.scopeCategory)?.label ?? '';
  }

  scopeCategory = '';
  scopeOption = '';
  /** Keyed by ScopeField.id. */
  scopeFieldValues: Record<string, string> = {};

  /** Provider/service options for the chosen category. */
  get scopeOptions(): ScopeOption[] {
    return findCategory(this.scopeCategory)?.options ?? [];
  }

  /** The fields to render right now -- category-level plus option-level. */
  get scopeFields(): ScopeField[] {
    return fieldsFor(this.scopeCategory, this.scopeOption);
  }

  onScopeCategoryChange(value: string) {
    this.scopeCategory = value;
    // Drop the narrower selections rather than carrying a stale provider or a
    // field that no longer exists in the new category.
    this.scopeOption = '';
    this.scopeFieldValues = {};
    this.previews = [];
  }

  onScopeOptionChange(value: string) {
    this.scopeOption = value;
    // Category-level values survive; option-level ones may not exist any more.
    const live = new Set(this.scopeFields.map((f) => f.id));
    for (const key of Object.keys(this.scopeFieldValues)) {
      if (!live.has(key)) delete this.scopeFieldValues[key];
    }
    this.previews = [];
  }

  onScopeFieldInput(id: string, value: string) {
    this.scopeFieldValues[id] = value;
    this.previews = [];
  }

  clearScope() {
    this.scopeCategory = '';
    this.scopeOption = '';
    this.scopeFieldValues = {};
    this.previews = [];
  }

  /* =========================================================================
   * RANGE PICKER -- an alternative editor for the same two values
   * =========================================================================
   * Requested as "a joint timestamp that allows you to select a multi day
   * window, kind of like datadog uses", to be tried alongside the existing two
   * fields rather than instead of them: "I want to test to see if I like it
   * better or if we leave it alone."
   *
   * THE DESIGN DECISION THAT MAKES THIS SAFE: it writes
   * `activeBeginCalendarValue` and `activeEndCalendarValue`, the same two
   * strings the two-field version writes. Validation, submit, the rehydration
   * boundary and the window note all read those, so none of them can tell which
   * editor was used and none of them changed. Switching editors mid-search
   * keeps whatever is already selected.
   *
   * It lives in a popover, like the recent-agency menu, so a calendar costs
   * zero card height while closed -- the no-scrollbar goal is the constraint
   * every layout decision here answers to.
   */
  /*
   * The two-field editor and the switcher were removed on 2026-09-03 -- "Let's
   * remove the old time picker, this one is definitely better." The two
   * `datetime-local` inputs remain in the DOM, visually hidden, because
   * `validateForm` reads them by id and the characterization tests fill them;
   * they stay bound to the same two values, so nothing downstream changed. Same
   * pattern and same class as the legacy additional-service checkboxes.
   */
  rangeOpen = false;
  /** Viewport coordinates for the popover, read from the trigger when it opens. */
  rangePopTop = 0;
  rangePopLeft = 0;
  /** First of the month currently drawn. */
  calendarMonth: Date = startOfMonth(new Date());
  /**
   * True once a start has been picked and the next click should extend the end.
   *
   * Every click leaves a VALID range rather than a half-open one: the first
   * click sets start and end to the same day, and the second extends the end.
   * A picker that can sit in a broken state invites a submit in that state.
   */
  private extending = false;

  toggleRangeOpen() {
    this.rangeOpen = !this.rangeOpen;
    if (!this.rangeOpen) return;

    // Open on the month the current start is in, not on today -- otherwise
    // reopening after picking July drops you back in September.
    const start = this.activeBeginCalendarValue.slice(0, 10);
    this.calendarMonth = startOfMonth(start ? new Date(`${start}T12:00`) : new Date());
    this.extending = false;
    this.placeRangePop();
  }

  /*
   * The popover is `position: fixed` to escape the card's `overflow: hidden`,
   * so it needs real viewport coordinates rather than a CSS offset.
   *
   * It flips above the trigger when there is not enough room below, which is
   * the same clipping problem one level out: escaping the card only helps if it
   * then fits on screen.
   */
  private placeRangePop() {
    const trigger = document.getElementById('rangeToggleBtn');
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const POP_HEIGHT = 330;
    const below = window.innerHeight - r.bottom;
    this.rangePopTop = below < POP_HEIGHT && r.top > POP_HEIGHT ? r.top - POP_HEIGHT - 4 : r.bottom + 4;
    this.rangePopLeft = r.left;
  }

  closeRange() {
    this.rangeOpen = false;
  }

  /** What the collapsed control shows. */
  get rangeSummary(): string {
    const b = this.activeBeginCalendarValue;
    const e = this.activeEndCalendarValue;
    if (!b || !e) return 'Select a time range';
    const fmt = (v: string) =>
      new Date(`${v}`).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    // Name the preset that produced the range, so choosing one after a
    // calendar pick visibly overwrites it rather than just shifting the dates.
    const preset =
      this.selectedTimeframe === AppComponent.CUSTOM_TIMEFRAME ? '' : `${this.selectedTimeframe} · `;
    return `${preset}${fmt(b)} – ${fmt(e)}`;
  }

  get calendarMonthLabel(): string {
    return this.calendarMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  prevMonth() {
    this.calendarMonth = addMonths(this.calendarMonth, -1);
  }

  nextMonth() {
    // Nothing to search in the future, so there is nothing to page into.
    if (this.nextMonthDisabled) return;
    this.calendarMonth = addMonths(this.calendarMonth, 1);
  }

  get nextMonthDisabled(): boolean {
    const next = addMonths(this.calendarMonth, 1);
    return next > startOfMonth(new Date());
  }

  /** Six weeks of cells, so the grid never changes height between months. */
  get calendarDays(): CalendarDay[] {
    const first = this.calendarMonth;
    const gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());

    const startKey = this.activeBeginCalendarValue.slice(0, 10);
    const endKey = this.activeEndCalendarValue.slice(0, 10);
    const todayKey = localDayKey(new Date());

    const out: CalendarDay[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      const key = localDayKey(d);
      out.push({
        key,
        label: d.getDate(),
        inMonth: d.getMonth() === first.getMonth(),
        isStart: key === startKey,
        isEnd: key === endKey,
        inRange: key > startKey && key < endKey,
        isToday: key === todayKey,
        // Future days cannot be searched; the form rejects them on submit.
        disabled: key > todayKey,
      });
    }
    return out;
  }

  pickDay(day: CalendarDay) {
    if (day.disabled) return;
    this.selectedTimeframe = AppComponent.CUSTOM_TIMEFRAME;

    const startKey = this.activeBeginCalendarValue.slice(0, 10);

    if (!this.extending || day.key < startKey) {
      // Start a new range. Both ends on one day, which is a complete and
      // sensible selection on its own -- "what happened that day".
      this.activeBeginCalendarValue = `${day.key}T00:00`;
      this.activeEndCalendarValue = this.endOfDay(day.key);
      this.extending = true;
    } else {
      this.activeEndCalendarValue = this.endOfDay(day.key);
      this.extending = false;
      /*
       * Close on COMPLETION, not on the first click. Requested as "when I
       * select my dates it should be auto closed", and the second click is
       * where the dates stop being provisional.
       *
       * Closing on the first click would make a multi-day window unreachable
       * -- the whole point of the control -- so the first click leaves it open
       * to be extended. A single day is two clicks on the same date, which
       * lands here because a repeat click is not "earlier" and so completes
       * the range rather than restarting it.
       */
      this.rangeOpen = false;
    }
    this.previews = [];
  }

  /* The time halves, edited in place so the date selection is not disturbed. */
  get rangeStartTime(): string {
    return this.activeBeginCalendarValue.slice(11, 16) || '00:00';
  }
  set rangeStartTime(value: string) {
    if (!value) return;
    this.activeBeginCalendarValue = `${this.activeBeginCalendarValue.slice(0, 10)}T${value}`;
    this.selectedTimeframe = AppComponent.CUSTOM_TIMEFRAME;
    this.previews = [];
  }

  /*
   * A "Whole day" reset lived here and was removed the same day it was added,
   * along with the "Time of day" heading above the time fields -- both were
   * noise once the popover was actually visible rather than clipped. Re-picking
   * the day gives the whole day back, so the button was a shortcut for
   * something already one click away.
   */

  get rangeEndTime(): string {
    return this.activeEndCalendarValue.slice(11, 16) || '23:59';
  }
  set rangeEndTime(value: string) {
    if (!value) return;
    this.activeEndCalendarValue = `${this.activeEndCalendarValue.slice(0, 10)}T${value}`;
    this.selectedTimeframe = AppComponent.CUSTOM_TIMEFRAME;
    this.previews = [];
  }

  onTimeframeChange() {
    /*
     * Resetting here rather than in a picker-specific handler, because the
     * Timeframe dropdown writes the timestamps directly and both editors share
     * it. Without this, choosing a preset and then clicking one calendar day
     * would EXTEND from the date the preset had just replaced, producing a
     * window neither action asked for.
     */
    this.extending = false;
    this.rangeOpen = false;
    // Not selectable, but guard anyway: it names a range, it cannot compute one.
    if (this.selectedTimeframe === AppComponent.CUSTOM_TIMEFRAME) return;

    const currentDate = new Date();
    let beginTimestampDate = new Date();

    if (this.selectedTimeframe === 'TODAY') {
      beginTimestampDate = new Date(currentDate);
      beginTimestampDate.setHours(0, 0, 0, 0);
    }
    if (this.selectedTimeframe === 'Past 15 Minutes') {
      beginTimestampDate.setMinutes(currentDate.getMinutes() - 15);
    } else if (this.selectedTimeframe === 'Past 1 Hour') {
      beginTimestampDate.setHours(currentDate.getHours() - 1);
    } else if (this.selectedTimeframe === 'Past 4 Hours') {
      beginTimestampDate.setHours(currentDate.getHours() - 4);
    } else if (this.selectedTimeframe === 'Past 1 Day') {
      beginTimestampDate.setDate(currentDate.getDate() - 1);
    } else if (this.selectedTimeframe === 'Past 2 Days') {
      beginTimestampDate.setDate(currentDate.getDate() - 2);
    } else if (this.selectedTimeframe === 'Past 3 Days') {
      beginTimestampDate.setDate(currentDate.getDate() - 3);
    } else if (this.selectedTimeframe === 'Past 7 Days') {
      beginTimestampDate.setDate(currentDate.getDate() - 7);
    } else if (this.selectedTimeframe === 'Past 15 Days') {
      // 15 days is exactly the rehydration boundary, so this preset used to sit
      // on the line and flip between live search and rehydration depending on
      // how long the user took to submit. Backed off by 10 minutes to stay
      // reliably inside the live window.
      beginTimestampDate.setDate(currentDate.getDate() - 15);
      beginTimestampDate.setMinutes(beginTimestampDate.getMinutes() + 10);
    }

    this.activeBeginCalendarValue = this.convertUTCtoLocal(beginTimestampDate)
      .toISOString()
      .slice(0, 16);
    this.activeEndCalendarValue = this.convertUTCtoLocal(currentDate).toISOString().slice(0, 16);
  }

  /*
   * The two-field editor's date-snapping handlers (onBeginDateChange /
   * onEndDateChange) lived here and were REMOVED on 2026-09-03 with that
   * editor.
   *
   * They were briefly kept wired to the now-hidden compatibility inputs, which
   * caused a real bug: ngModelChange fires while Angular writes the value in
   * during a re-render, the handler compared the incoming date against the one
   * it held, decided the date had changed, and snapped the range back --
   * silently discarding a calendar selection that had just been made.
   *
   * Nothing replaced them because nothing needs to: pickDay() produces whole
   * days by construction, and resetTimesToWholeDay() covers going back to one.
   */

  /**
   * 23:59 on the given day, or the current time if that day is today.
   *
   * Datadog is exclusive of nothing here -- 23:59 loses the final minute of the
   * day, which is the cost of matching what the user typed. 23:59:59 is not
   * expressible in a `datetime-local` input at minute precision.
   */
  private endOfDay(day: string): string {
    const now = new Date();
    // localDayKey rather than the UTC-shifted trick: 8pm Mountain is already
    // tomorrow in UTC, so an ISO slice would fail to recognise today.
    if (day === localDayKey(now)) {
      return this.convertUTCtoLocal(now).toISOString().slice(0, 16);
    }
    return `${day}T23:59`;
  }

  private convertUTCtoLocal(utcDate: Date): Date {
    const localTimezoneOffset = utcDate.getTimezoneOffset();
    return new Date(utcDate.getTime() - localTimezoneOffset * 60000);
  }

  /**
   * Everything remembered, most useful first. Read once per change-detection
   * pass rather than on every template binding.
   */
  recentSearches: RecentSearch[] = [];

  /**
   * The recent-agency menu, shown only while the ServProvCode field has focus.
   *
   * A permanent chip row worked but was clutter: this is something you need once
   * at the start of a session, not something to look at all day. Focus-triggered
   * and absolutely positioned, so it costs ZERO layout height.
   */
  showRecentMenu = false;

  /** Filtered by whatever has been typed so far, capped at four rows. */
  visibleRecent: RecentSearch[] = [];

  onAgencyFocus() {
    this.refreshVisibleRecent(this.readInputValue('inputServProvCode'));
    this.showRecentMenu = true;
  }

  onAgencyInput(value: string) {
    this.servProvCode = value;
    this.refreshVisibleRecent(value);
    // Typing something with no match closes the menu rather than leaving an
    // empty box hanging under the field.
    this.showRecentMenu = this.visibleRecent.length > 0;
  }

  /*
   * Blur fires BEFORE click, so closing here would destroy the menu item before
   * its click could land -- which is why selection is wired to `mousedown` and
   * calls preventDefault. This handler only covers tabbing or clicking away.
   */
  onAgencyBlur() {
    this.showRecentMenu = false;
  }

  closeRecentMenu() {
    this.showRecentMenu = false;
  }

  /**
   * Whether this row needs its host shown.
   *
   * ---------------------------------------------------------------------------
   * THE HOST IS NORMALLY HIDDEN, BECAUSE IT DID NOT FIT
   * ---------------------------------------------------------------------------
   * The row used to read `SCOTTCOUNTYMN  US · PROD  6x`, which wrapped
   * `US · PROD` onto two lines and pushed the count past the right edge of the
   * menu -- clipped, so the frequency that explains the ordering was invisible.
   *
   * Dropping the host is safe in almost every case, since an agency lives on
   * one host. It is NOT safe in general: the stored entry is keyed on agency +
   * host + environment, so the same agency on two hosts would render two
   * identical-looking rows that select different things.
   *
   * So the host appears only when it is the thing that tells two visible rows
   * apart. The list is capped at four, so scanning it per row costs nothing.
   */
  recentNeedsHost(entry: RecentSearch): boolean {
    return this.visibleRecent.some(
      (other) =>
        other !== entry &&
        other.agency === entry.agency &&
        other.environment === entry.environment &&
        other.host !== entry.host
    );
  }

  /**
   * The secondary line for a row: the environment, prefixed by the host only
   * where that is what tells two rows apart.
   *
   * Built here rather than in the template so it is one interpolation. The
   * inline `@if` version wrapped the value in stray whitespace, which showed as
   * a gap before the separator.
   */
  recentEnvLabel(entry: RecentSearch): string {
    return this.recentNeedsHost(entry)
      ? `${entry.host} · ${entry.environment}`
      : entry.environment;
  }

  pickRecent(entry: RecentSearch, event?: Event) {
    // preventDefault on mousedown stops the input blurring, so the menu is not
    // torn down mid-selection.
    event?.preventDefault();
    this.applyRecent(entry);
    this.showRecentMenu = false;
  }

  private refreshVisibleRecent(typed: string) {
    const q = (typed ?? '').trim().toUpperCase();
    const all = this.recentSearches;
    this.visibleRecent = (q ? all.filter((e) => e.agency.startsWith(q)) : all).slice(0, 4);
  }

  /**
   * Fill the whole triple from one click. The point of the feature is that
   * ServProvCode, Host and Environment are three separate actions that are
   * almost always the same three values.
   */
  applyRecent(entry: RecentSearch) {
    const agencyEl = this.getInputElement('inputServProvCode') as HTMLInputElement | null;
    const hostEl = this.getInputElement('inputHost') as HTMLSelectElement | null;
    if (!agencyEl || !hostEl) return;

    agencyEl.value = entry.agency;
    this.servProvCode = entry.agency;

    hostEl.value = entry.host;
    this.onHostChange();

    /*
     * detectChanges() is load-bearing, and this failed silently without it.
     *
     * `onHostChange()` repopulates `availableEnvironments`, but the <option>
     * elements come from an @for in the template, so they do not exist in the
     * DOM until Angular renders. Assigning `select.value` before that render is
     * a no-op against a missing option: agency and host filled correctly and the
     * environment stayed on --SELECT--, which then failed validation with the
     * chip visibly "applied".
     *
     * A unit test would not have caught it -- `this.environment` was being set
     * either way. It showed up only in a browser, which is why the component
     * test below asserts the DOM value rather than the field.
     */
    this.cdr.detectChanges();

    const envEl = this.getInputElement('inputEnvironment') as HTMLSelectElement | null;
    if (envEl) {
      envEl.value = entry.environment;
      this.environment = entry.environment;
    }
    this.previews = [];
  }

  onHostChange() {
    const hostElement = this.getInputElement('inputHost') as HTMLSelectElement;
    this.host = hostElement.value;

    const environmentElement = this.getInputElement('inputEnvironment') as HTMLSelectElement;
    environmentElement.value = '--SELECT--';
    this.environment = '';
    this.previews = [];

    // Single source of truth: the same table the v2 engine uses.
    this.availableEnvironments = environmentsFor(this.host);
  }

  private validateForm(): boolean {
    const servProvCodeElement = this.getInputElement('inputServProvCode') as HTMLInputElement;
    const hostElement = this.getInputElement('inputHost') as HTMLSelectElement;
    const environmentElement = this.getInputElement('inputEnvironment') as HTMLSelectElement;
    const beginTimestampElement = this.getInputElement('inputBeginTimestamp') as HTMLInputElement;
    const endTimestampElement = this.getInputElement('inputEndTimestamp') as HTMLInputElement;

    const missingFields: string[] = [];

    if (servProvCodeElement.value.trim() === '') missingFields.push('ServProvCode');
    if (hostElement.value.trim() === '' || hostElement.value.trim() === '--SELECT--')
      missingFields.push('Host');
    if (environmentElement.value.trim() === '' || environmentElement.value.trim() === '--SELECT--')
      missingFields.push('Environment');
    if (beginTimestampElement.value.trim() === '') missingFields.push('Begin Timestamp');
    if (endTimestampElement.value.trim() === '') missingFields.push('End Timestamp');

    const applicationsUsed = this.getCheckedApplications();
    const additionalServices = this.getCheckedAdditionalServices();

    if (missingFields.length > 0) {
      alert('Please fill in the following fields: ' + missingFields.join(', '));
      return false;
    }

    /*
     * -------------------------------------------------------------------------
     * A SCOPE THAT BRINGS ITS OWN LOGS DOES NOT NEED AN APPLICATION.
     * -------------------------------------------------------------------------
     * This used to be an unconditional "At least one Application (Civic
     * Platform, Citizen Access, CAPI) or Additional Service" in the missing-
     * fields list, which blocked a search the engine would have built without
     * complaint. Reported as confusing, and the concrete case is a real one:
     * looking at payment-adapter-service on its own, with biz and ACA unticked,
     * because PAS is where the adapter conversation is recorded.
     *
     * Now it is derived -- see `scopeSuppliesOwnLogs`. Forte, Paypal Commerce,
     * SecurePay, ACDS and ADS each name a service, so they stand alone. The
     * filter-only scopes cannot, because a CAP ID or a document name narrows a
     * population rather than supplying one.
     *
     * Kept as a check rather than dropped entirely because the alternative is
     * worse than a prompt: with nothing selected the engine has no branch to
     * build, so the user would get an empty result and no idea why. The
     * difference is that it now fires only when it is true, and names the fix.
     */
    const scopeStandsAlone = scopeSuppliesOwnLogs(this.scopeCategory, this.scopeOption);
    if (
      applicationsUsed.length === 0 &&
      additionalServices.length === 0 &&
      !scopeStandsAlone
    ) {
      const scopeLabel = findCategory(this.scopeCategory)?.label;
      alert(
        scopeLabel
          ? `The ${scopeLabel} scope narrows a search rather than being a log source of its own, so it needs somewhere to look. Tick Civic Platform (or Citizen Access, or Construct API) as well.`
          : 'Tick at least one application -- Civic Platform, Citizen Access or Construct API -- or choose a scope that has logs of its own, such as Payment > Forte or Documents > ADS.'
      );
      return false;
    }

    return true;
  }

  private validateTimestamps(beginTimestamp: number, endTimestamp: number): boolean {
    if (endTimestamp - beginTimestamp < 60000) {
      alert('End timestamp must be at least 1 minute after the begin timestamp.');
      return false;
    }
    return !this.isTimestampInFuture(beginTimestamp, endTimestamp);
  }

  private isTimestampInFuture(beginTimestamp: number, endTimestamp: number): boolean {
    const currentUnixTimestamp = new Date().getTime();
    if (beginTimestamp > currentUnixTimestamp || endTimestamp > currentUnixTimestamp) {
      alert('Timestamps cannot be in the future.');
      return true;
    }
    return false;
  }

  private isTimestampMoreThanFifteenDaysAgo(beginTimestamp: number): boolean {
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    return new Date(beginTimestamp) < fifteenDaysAgo;
  }

  private setValues(beginTimestamp: number, endTimestamp: number) {
    this.servProvCode = (this.getInputElement('inputServProvCode') as HTMLInputElement)?.value;
    this.host = (this.getInputElement('inputHost') as HTMLSelectElement)?.value;
    this.environment = (this.getInputElement('inputEnvironment') as HTMLSelectElement)?.value;
    this.beginTimestamp = beginTimestamp;
    this.endTimestamp = endTimestamp;
    this.applicationsUsed = this.getCheckedApplications();
    this.additionalServices = this.getCheckedAdditionalServices();
  }

  /*
   * Reads the COMPONENT fields, not the DOM inputs. Changed 2026-09-03 while
   * removing the two-field editor, and it is a correctness fix rather than a
   * tidy-up.
   *
   * It used to read `inputBeginTimestamp.value` and
   * `inputEndTimestamp.value`. Those inputs are now hidden compatibility
   * elements written by Angular, and ngModel writes the view asynchronously --
   * so a submit could read a value the picker had already replaced and search
   * the wrong window. It showed up immediately: after picking 27 July the
   * component held `2026-07-27T00:00` while the input still read
   * `2026-08-27T00:00`.
   *
   * The component fields are what every editor writes, so they are the source
   * of truth. Typing into the hidden inputs still works -- two-way ngModel
   * updates the field synchronously on input -- which is what the
   * characterization tests rely on.
   */
  private convertTimestamps(): [number, number] {
    return this.convertToUnixTimestamps(
      this.activeBeginCalendarValue,
      this.activeEndCalendarValue
    );
  }

  private getInputElement(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  /** Empty string for a field that is not currently rendered. */
  private readInputValue(id: string): string {
    return (this.getInputElement(id) as HTMLInputElement | null)?.value ?? '';
  }

  private getCheckedApplications(): string[] {
    const checkboxes = document.getElementsByName(
      'applicationsUsed[]'
    ) as NodeListOf<HTMLInputElement>;
    return Array.from(checkboxes)
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
  }

  private getCheckedAdditionalServices(): string[] {
    const checkboxes = document.getElementsByName(
      'additionalServices[]'
    ) as NodeListOf<HTMLInputElement>;
    return Array.from(checkboxes)
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
  }

  private convertToUnixTimestamps(
    beginTimestamp: string,
    endTimestamp: string
  ): [number, number] {
    return [new Date(beginTimestamp).getTime(), new Date(endTimestamp).getTime()];
  }

  private generateRehydrateURL(query: string) {
    const baseURL = 'https://app.datadoghq.com/logs/pipelines/historical-views/add';
    const queryParams = new URLSearchParams({
      query,
      from_ts: this.beginTimestamp.toString(),
      to_ts: this.endTimestamp.toString(),
    });
    return `${baseURL}?${queryParams.toString()}`;
  }

  private generateRedirectURL(query: string) {
    const baseURL = 'https://app.datadoghq.com/logs';
    const queryParams = new URLSearchParams({
      query,
      cols: 'host,service',
      index: '*',
      messageDisplay: 'inline',
      stream_sort: 'time,desc',
      viz: 'stream',
      from_ts: this.beginTimestamp.toString(),
      to_ts: this.endTimestamp.toString(),
      live: 'false',
    });
    return `${baseURL}?${queryParams.toString()}`;
  }

  private openURLInNewTab(fullURL: string) {
    window.open(fullURL, '_blank');
  }

  private generateTimestamps() {
    const today = new Date();
    const beginTimestamp = new Date(
      today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0
    );
    const endTimestamp = new Date();

    return {
      beginTimestamp: new Date(
        beginTimestamp.getTime() - beginTimestamp.getTimezoneOffset() * 60000
      ),
      endTimestamp: new Date(endTimestamp.getTime() - endTimestamp.getTimezoneOffset() * 60000),
    };
  }

  private setTimestampsFromTraceId(traceId: string) {
    // Accepts, with or without a prefix:
    //   aca-250604134315118-181f5a23-965fbe1b
    //   W-20250604124240646-4f3b5f17
    const match = traceId.match(/(?:^|[-_])((?:20\d{6})|(?:\d{6}))/);
    if (!match || !match[1]) return null;

    const dateStr = match[1];
    let year: number, month: number, day: number;

    if (dateStr.length === 8) {
      year = parseInt(dateStr.substring(0, 4), 10);
      month = parseInt(dateStr.substring(4, 6), 10);
      day = parseInt(dateStr.substring(6, 8), 10);
    } else {
      year = 2000 + parseInt(dateStr.substring(0, 2), 10);
      month = parseInt(dateStr.substring(2, 4), 10);
      day = parseInt(dateStr.substring(4, 6), 10);
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const beginTimestamp = new Date(year, month - 1, day, 0, 0, 0, 0);
    const currentDate = new Date();

    const isToday =
      currentDate.getFullYear() === year &&
      currentDate.getMonth() === month - 1 &&
      currentDate.getDate() === day;

    const endTimestamp = isToday ? currentDate : new Date(year, month - 1, day, 23, 59, 59, 999);

    return { beginTimestamp: beginTimestamp.getTime(), endTimestamp: endTimestamp.getTime() };
  }

  private buildTraceIdDatadogQuery(traceId: string): string {
    let query = `*${traceId}* OR @TRACE_ID:*${traceId}*`;
    const hasPrefix = /^[^\d]+-/.test(traceId);
    if (!hasPrefix) {
      query += ` OR @Properties.log.TraceId:${traceId}`;
    }
    return query;
  }
}
