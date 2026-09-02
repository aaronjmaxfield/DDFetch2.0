import { Component, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { environmentsFor } from './query/environments.config';
import { LegacyQueryBuilderService } from './query/legacy-query-builder.service';
import { QueryBuilderV2Service } from './query/query-builder-v2.service';
import { RecentSearch, RecentSearchesService } from './query/recent-searches.service';
import { EngineId, QueryInput, QueryResult } from './query/query-input.model';
import {
  fieldsFor,
  findCategory,
  ScopeField,
  ScopeGuidance,
  ScopeOption,
  SCOPES,
  scopeSuppliesOwnLogs,
} from './query/scopes.config';

/** Which engine(s) to run for a submission. */
export type EngineMode = 'v2' | 'legacy' | 'compare';

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

  onIncludeToggle(which: 'chronic' | 'indexer' | 'emse' | 'iis', on: boolean) {
    if (which === 'chronic') this.showChronic = on;
    if (which === 'indexer') this.includeIndexer = on;
    if (which === 'emse') this.includeEmse = on;
    if (which === 'iis') this.includeIis = on;
    // The previewed query no longer matches the form.
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

  onTimeframeChange() {
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

  private convertTimestamps(): [number, number] {
    const beginTimestampElement = this.getInputElement('inputBeginTimestamp') as HTMLInputElement;
    const endTimestampElement = this.getInputElement('inputEndTimestamp') as HTMLInputElement;
    return this.convertToUnixTimestamps(beginTimestampElement.value, endTimestampElement.value);
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
