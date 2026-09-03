import type { Mock } from "vitest";
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { AppComponent } from './app.component';

/**
 * Characterization tests.
 *
 * These pin the query strings DDFetch generates TODAY, exercised through the
 * component's real surface (fill the form, click Fetch, inspect the Datadog URL
 * handed to window.open). They intentionally assert current behavior -- bugs
 * included -- so that the Angular 16 -> 22 upgrade can be verified as
 * behavior-preserving. Query corrections come afterwards, as deliberate edits
 * to these expectations.
 */
describe('AppComponent (characterization)', () => {
    let fixture: ComponentFixture<AppComponent>;
    let component: AppComponent;
    let openSpy: Mock;
    let alertSpy: Mock;

    /** Fixed "now" so rehydration and trace-ID windows are deterministic. */
    const NOW = new Date(2026, 7, 27, 14, 30, 0, 0); // 2026-08-27 14:30 local

    beforeEach(async () => {
        /*
         * The component reads recent searches from localStorage on init, so
         * leftover state leaks between tests. Added while a range-picker
         * preference was also stored: one test toggling that editor removed the
         * timestamp inputs from the DOM for every test after it. The preference
         * is gone -- the picker is the only editor now -- but the recent
         * searches remain, and the isolation is worth keeping either way.
         */
        localStorage.clear();

        await TestBed.configureTestingModule({
            imports: [FormsModule],
            declarations: [AppComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(AppComponent);
        component = fixture.componentInstance;

        openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {
        });

        vi.useFakeTimers();
        vi.setSystemTime(NOW);

        // These tests pin the LEGACY engine's output. The component now defaults
        // to 'compare', which deliberately does not auto-open a URL.
        component.engineMode = 'legacy';

        fixture.detectChanges();
    });

    afterEach(() => {
        vi.useRealTimers();
        // Vitest's spyOn returns the existing mock when a property is already
        // spied, so window.open/alert would otherwise accumulate calls across
        // tests in this file. Jasmine restored spies automatically; Vitest does
        // not.
        vi.restoreAllMocks();
    });

    // ---------------------------------------------------------------- helpers

    function el<T extends HTMLElement>(id: string): T {
        let found = fixture.nativeElement.querySelector(`#${id}`) as T;
        // TRACE_ID and Additional Parameters sit behind a collapsed disclosure,
        // so they are not in the DOM until it is opened. Opening it here keeps
        // that a fact about the UI in one place, instead of a setup line in
        // every test that touches either field. A field that is genuinely gone
        // still throws.
        if (!found && !component.showAdvanced) {
            component.showAdvanced = true;
            fixture.detectChanges();
            found = fixture.nativeElement.querySelector(`#${id}`) as T;
        }
        if (!found)
            throw new Error(`No element #${id} in template`);
        return found;
    }

    function setText(id: string, value: string) {
        const input = el<HTMLInputElement>(id);
        input.value = value;
        input.dispatchEvent(new Event('input'));
    }

    function setHost(host: string) {
        const select = el<HTMLSelectElement>('inputHost');
        select.value = host;
        select.dispatchEvent(new Event('change'));
        fixture.detectChanges(); // environment <option>s are rendered from availableEnvironments
    }

    function setEnvironment(env: string) {
        const select = el<HTMLSelectElement>('inputEnvironment');
        select.value = env;
        select.dispatchEvent(new Event('change'));
    }

    function check(id: string) {
        const box = el<HTMLInputElement>(id);
        box.checked = true;
        box.dispatchEvent(new Event('change'));
    }

    /**
     * Civic Platform is checked by default in the template, so a test that means
     * "this selection and nothing else" has to clear it explicitly. Without
     * this, several tests below would quietly assert on a query that also
     * carried the biz-tier branch, and their names would no longer describe
     * their input.
     */
    function uncheck(id: string) {
        const box = el<HTMLInputElement>(id);
        box.checked = false;
        box.dispatchEvent(new Event('change'));
    }

    /**
     * The scope dropdowns are rendered from config, so driving them through the
     * component's own handlers keeps a test from depending on the order the
     * options happen to be listed in.
     */
    function selectScope(category: string, option: string) {
        component.onScopeCategoryChange(category);
        if (option) component.onScopeOptionChange(option);
        fixture.detectChanges();
    }

    function setTimestamps(begin: string, end: string) {
        setText('inputBeginTimestamp', begin);
        setText('inputEndTimestamp', end);
        fixture.detectChanges();
    }

    /** A valid same-day window entirely in the past relative to NOW. */
    function setValidWindow() {
        setTimestamps('2026-08-27T00:00', '2026-08-27T14:00');
    }

    function submit() {
        component.onSubmit(new Event('submit'));
    }

    /** Arguments of a spy's most recent call, asserting it was called at all. */
    function lastArgs(spy: Mock): unknown[] {
        const call = vi.mocked(spy).mock.lastCall;
        if (!call) throw new Error('Expected the spy to have been called');
        return call as unknown[];
    }

    /** The URL passed to window.open, parsed. */
    function openedUrl(): URL {
        expect(openSpy).toHaveBeenCalled();
        return new URL(lastArgs(openSpy)[0] as string);
    }

    function openedQuery(): string {
        return openedUrl().searchParams.get('query') ?? '';
    }

    function isRehydrateUrl(): boolean {
        return openedUrl().pathname.includes('historical-views');
    }

    // ------------------------------------------------------------ smoke tests

    it('creates the component', () => {
        expect(component).toBeTruthy();
    });

    it('starts with the README hidden', () => {
        expect(component.readmeHidden).toBe(true);
    });

    it('toggles the README', () => {
        component.toggleReadme();
        expect(component.readmeHidden).toBe(false);
        component.toggleReadme();
        expect(component.readmeHidden).toBe(true);
    });

    it('prepopulates both timestamp fields on init', () => {
        expect(component.activeBeginCalendarValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(component.activeEndCalendarValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    // ------------------------------------------------- host -> environment map

    it('exposes no environments until a host is chosen', () => {
        expect(component.availableEnvironments).toEqual([]);
    });

    it('offers CVCN for US but not for AU', () => {
        setHost('US');
        expect(component.availableEnvironments).toContain('CVCN');
        setHost('AU');
        expect(component.availableEnvironments).not.toContain('CVCN');
        expect(component.availableEnvironments).toContain('CONV');
    });

    it('offers the Oregon-specific environment list', () => {
        setHost('OREGON');
        expect(component.availableEnvironments).toEqual([
            'PROD',
            'TRAIN',
            'DEV',
            'CONFIG',
            'STG',
        ]);
    });

    it('clears the selected environment when the host changes', () => {
        setHost('US');
        setEnvironment('PROD');
        setHost('CA');
        expect(component.environment).toBe('');
    });

    // ------------------------------------------------ advanced disclosure
    // A trace ID search ignores every other field on the form, so a value left
    // behind inside a collapsed section would hijack the next Fetch with
    // nothing on screen to explain why the results looked nothing like the
    // form. Collapsing must clear it.

    it('starts with the advanced fields collapsed', () => {
        expect(component.showAdvanced).toBe(false);
        expect(fixture.nativeElement.querySelector('#inputTraceID')).toBeNull();
        expect(fixture.nativeElement.querySelector('#inputAdditionalParams')).toBeNull();
        expect(fixture.nativeElement.querySelector('#showChronicCheckbox')).toBeNull();
        expect(fixture.nativeElement.querySelector('#includeIndexerCheckbox')).toBeNull();
        expect(fixture.nativeElement.querySelector('#includeEmseCheckbox')).toBeNull();
    });

    it('resets the include toggles when the advanced section is collapsed', () => {
        component.showAdvanced = true;
        fixture.detectChanges();
        check('showChronicCheckbox');
        check('includeIndexerCheckbox');
        expect(component.showChronic).toBe(true);
        expect(component.includeIndexer).toBe(true);

        component.toggleAdvanced(); // collapse

        expect(component.showChronic).toBe(false);
        expect(component.includeIndexer).toBe(false);
        expect(component.includeEmse).toBe(false);
    });

    it('drops a typed trace ID when the advanced section is collapsed again', () => {
        setText('inputTraceID', '20260827124240646-4f3b5f17'); // opens the disclosure
        component.toggleAdvanced(); // collapse
        fixture.detectChanges();

        expect(component.traceId).toBe('');

        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        setValidWindow();
        submit();

        // A normal agency search, not the trace-ID path.
        expect(openedQuery()).not.toContain('20260827124240646-4f3b5f17');
    });

    // ----------------------------------------------------------- trace ID path

    it('builds a trace ID query for a prefixed ACA trace and ignores other fields', () => {
        setText('inputTraceID', 'aca-260827134315118-181f5a23-965fbe1b');
        submit();

        const query = openedQuery();
        expect(query).toContain('*aca-260827134315118-181f5a23-965fbe1b*');
        expect(query).toContain('@TRACE_ID:*aca-260827134315118-181f5a23-965fbe1b*');
        // Prefixed trace IDs omit the CAPI-style property facet.
        expect(query).not.toContain('@Properties.log.TraceId');
    });

    it('adds @Properties.log.TraceId only when the trace ID has no prefix', () => {
        setText('inputTraceID', '20260827124240646-4f3b5f17');
        submit();
        expect(openedQuery()).toContain('@Properties.log.TraceId:20260827124240646-4f3b5f17');
    });

    it('parses a YYMMDD trace ID and a YYYYMMDD trace ID to the same day', () => {
        setText('inputTraceID', '260827134315118-181f5a23');
        submit();
        const shortForm = openedUrl().searchParams.get('from_ts');

        openSpy.mockClear();
        setText('inputTraceID', 'W-20260827124240646-4f3b5f17');
        submit();
        const longForm = openedUrl().searchParams.get('from_ts');

        expect(shortForm).toBe(longForm);
    });

    it('windows a same-day trace ID from midnight to now', () => {
        setText('inputTraceID', '20260827124240646-4f3b5f17');
        submit();

        const midnight = new Date(2026, 7, 27, 0, 0, 0, 0).getTime();
        expect(openedUrl().searchParams.get('from_ts')).toBe(String(midnight));
        expect(openedUrl().searchParams.get('to_ts')).toBe(String(NOW.getTime()));
    });

    it('rejects a trace ID with no recognizable date', () => {
        setText('inputTraceID', 'not-a-trace-id');
        submit();
        expect(alertSpy).toHaveBeenCalledWith('Invalid traceID.');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('routes a trace ID older than 15 days to the rehydration page', () => {
        setText('inputTraceID', '20260701124240646-4f3b5f17');
        submit();
        expect(isRehydrateUrl()).toBe(true);
    });

    it('routes a recent trace ID to the live log explorer', () => {
        setText('inputTraceID', '20260827124240646-4f3b5f17');
        submit();
        expect(isRehydrateUrl()).toBe(false);
        expect(openedUrl().searchParams.get('live')).toBe('false');
    });

    // -------------------------------------------------------------- validation

    it('blocks submission when no application or service is selected', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        setValidWindow();
        submit();

        expect(alertSpy).toHaveBeenCalled();
        /*
         * Reworded 2026-09-02. The check still fires with nothing selected --
         * an empty query with no explanation is worse than a prompt -- but it
         * now names the fix instead of listing the checkbox block, and it is no
         * longer part of the missing-required-fields alert.
         */
        expect(lastArgs(alertSpy)[0]).toContain('Tick at least one application');
        expect(lastArgs(alertSpy)[0]).toContain('scope that has logs of its own');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('lets a scope that has its own service run with no application ticked', () => {
        /*
         * The friction this replaces: wanting payment-adapter-service on its
         * own, with biz and ACA off, and being told to tick an application the
         * search did not need. Forte, Paypal Commerce and SecurePay all reach
         * PAS; ACDS and ADS are the document equivalents.
         */
        // Scope only reaches the query through the v2 engine; these tests
        // otherwise pin legacy output.
        component.engineMode = 'v2';
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        setValidWindow();
        selectScope('payment', 'forte');
        submit();

        expect(alertSpy).not.toHaveBeenCalled();
        expect(openSpy).toHaveBeenCalled();
        expect(openedQuery()).toContain('payment-adapter-service');
    });

    it('still blocks a filter-only scope, naming the scope rather than the checkboxes', () => {
        // A document name narrows a population; it does not supply one. With no
        // tier ticked there is nothing for it to filter.
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        setValidWindow();
        selectScope('documents', '');
        submit();

        expect(lastArgs(alertSpy)[0]).toContain('Documents scope narrows a search');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('passes raw mode through and forgets it when Advanced is closed', () => {
        /*
         * The reset matters more than the wiring. A raw mode left on behind a
         * collapsed disclosure would keep discarding the scope filters the
         * visible form still appears to be applying -- the same reasoning as the
         * other Advanced fields, and worse here because it is silent.
         */
        component.engineMode = 'v2';
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        setValidWindow();
        selectScope('payment', 'forte');

        el<HTMLInputElement>('rawModeCheckbox').click();
        expect(component.rawMode).toBe(true);
        submit();
        expect(openedQuery()).not.toContain('@PROVIDER');

        component.toggleAdvanced();
        expect(component.rawMode).toBe(false);
    });

    describe('recent agency menu', () => {
        /*
         * The row used to read `SCOTTCOUNTYMN  US · PROD  6x` in a menu pinned
         * to the field width. `US · PROD` wrapped to a second line and the
         * count was pushed past the right edge and clipped -- so the frequency
         * that explains the ordering could not be seen.
         */
        function seed(entries: Array<[string, string, string]>) {
            component.visibleRecent = entries.map(([agency, host, environment]) => ({
                agency,
                host,
                environment,
                count: 1,
                lastUsed: 1,
            }));
        }

        it('drops the host, which is what was overflowing', () => {
            seed([['SCOTTCOUNTYMN', 'US', 'NONPROD1']]);
            expect(component.recentEnvLabel(component.visibleRecent[0])).toBe('NONPROD1');
        });

        it('brings the host back when it is the only thing telling two rows apart', () => {
            /*
             * The entry is keyed on agency + host + environment, so without
             * this two rows would look identical and select different things.
             */
            seed([
                ['CRC', 'US', 'TEST'],
                ['CRC', 'AU', 'TEST'],
            ]);

            expect(component.recentEnvLabel(component.visibleRecent[0])).toBe('US · TEST');
            expect(component.recentEnvLabel(component.visibleRecent[1])).toBe('AU · TEST');
        });

        it('keeps the host hidden when the environments already differ', () => {
            seed([
                ['SCOTTCOUNTYMN', 'US', 'PROD'],
                ['SCOTTCOUNTYMN', 'US', 'NONPROD1'],
            ]);

            expect(component.recentEnvLabel(component.visibleRecent[0])).toBe('PROD');
            expect(component.recentEnvLabel(component.visibleRecent[1])).toBe('NONPROD1');
        });

        it('still applies the host even though it is not shown', () => {
            // The host is hidden, not dropped -- selecting a row must still set
            // it, or the search runs against the wrong region.
            component.recentSearches = [
                { agency: 'CRC', host: 'US', environment: 'TEST', count: 3, lastUsed: 1 },
            ];
            component.applyRecent(component.recentSearches[0]);

            expect(component.host).toBe('US');
            expect(component.environment).toBe('TEST');
        });
    });

    describe('range picker', () => {
        /*
         * An alternative editor over the same two values. The point of these
         * tests is that it cannot diverge from the two-field version -- both
         * write activeBeginCalendarValue and activeEndCalendarValue, so
         * validation and submit cannot tell which was used.
         *
         * NOW is fixed at 2026-08-27 14:30 local in this suite.
         */
        function dayAt(key: string) {
            const found = component.calendarDays.find((d) => d.key === key);
            if (!found) throw new Error(`No ${key} in the drawn month`);
            return found;
        }

        it('is the only visible editor, with the old fields hidden but live', () => {
            /*
             * The two-field editor was removed from the UI on 2026-09-03 but
             * NOT from the DOM: validateForm reads both by id and the
             * characterization tests fill them. They stay bound to the same two
             * values, so they cannot drift from what the picker shows.
             */
            expect(fixture.nativeElement.querySelector('#rangeToggleBtn')).toBeTruthy();

            const hidden = fixture.nativeElement.querySelector('#inputBeginTimestamp');
            expect(hidden).toBeTruthy();
            expect(hidden.closest('.scope-legacy-inputs')).toBeTruthy();
        });

        it('keeps the hidden fields in step with the picker', () => {
            component.calendarMonth = new Date(2026, 6, 1);
            component.pickDay(dayAt('2026-07-27'));
            fixture.detectChanges();

            const begin = fixture.nativeElement.querySelector(
                '#inputBeginTimestamp'
            ) as HTMLInputElement;
            const end = fixture.nativeElement.querySelector(
                '#inputEndTimestamp'
            ) as HTMLInputElement;

            /*
             * The COMPONENT field is what matters and what submit now reads.
             * The hidden inputs are written by ngModel asynchronously, so
             * asserting their DOM value here would be testing Angular's flush
             * timing rather than the picker -- and relying on it was the bug:
             * convertTimestamps() used to read the DOM and could see a value
             * the picker had already replaced.
             */
            expect(component.activeBeginCalendarValue).toBe('2026-07-27T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-27T23:59');
            expect(begin).toBeTruthy();
            expect(end).toBeTruthy();
        });

        it('submits the window the picker shows, not a stale input value', () => {
            // The regression this guards: submit read the hidden DOM inputs,
            // which ngModel writes asynchronously, so a fresh pick could be
            // searched as the previous window.
            setText('inputServProvCode', 'TESTAGCY');
            setHost('US');
            setEnvironment('PROD');
            component.calendarMonth = new Date(2026, 7, 1);
            component.pickDay(dayAt('2026-08-20'));
            component.pickDay(dayAt('2026-08-21'));

            submit();

            const from = Number(openedUrl().searchParams.get('from_ts'));
            expect(new Date(from).toISOString().slice(0, 10)).toBe('2026-08-20');
        });

        it('a single click selects that whole day', () => {
            component.activeBeginCalendarValue = '2026-08-27T14:00';
            component.activeEndCalendarValue = '2026-08-27T14:30';
            component.calendarMonth = new Date(2026, 6, 1); // July

            component.pickDay(dayAt('2026-07-27'));

            expect(component.activeBeginCalendarValue).toBe('2026-07-27T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-27T23:59');
        });

        it('a second, later click extends the window across both days', () => {
            component.calendarMonth = new Date(2026, 6, 1);
            component.pickDay(dayAt('2026-07-27'));
            component.pickDay(dayAt('2026-07-30'));

            expect(component.activeBeginCalendarValue).toBe('2026-07-27T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-30T23:59');
        });

        it('an earlier second click restarts rather than inverting the range', () => {
            // An inverted range would fail validation with a confusing message,
            // so the picker cannot produce one.
            component.calendarMonth = new Date(2026, 6, 1);
            component.pickDay(dayAt('2026-07-27'));
            component.pickDay(dayAt('2026-07-20'));

            expect(component.activeBeginCalendarValue).toBe('2026-07-20T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-20T23:59');
            expect(component.activeBeginCalendarValue < component.activeEndCalendarValue).toBe(true);
        });

        it('marks future days unselectable and ignores a click on one', () => {
            component.calendarMonth = new Date(2026, 7, 1); // August, containing NOW
            expect(dayAt('2026-08-28').disabled).toBe(true);
            expect(dayAt('2026-08-27').disabled).toBe(false);

            component.activeBeginCalendarValue = '2026-08-01T00:00';
            component.pickDay(dayAt('2026-08-28'));
            expect(component.activeBeginCalendarValue).toBe('2026-08-01T00:00');
        });

        it('clamps today to now rather than to 23:59', () => {
            component.calendarMonth = new Date(2026, 7, 1);
            component.pickDay(dayAt('2026-08-27'));
            expect(component.activeEndCalendarValue.startsWith('2026-08-27T14:3')).toBe(true);
        });

        it('cannot page into the future', () => {
            component.calendarMonth = new Date(2026, 7, 1); // the current month
            expect(component.nextMonthDisabled).toBe(true);
            component.nextMonth();
            expect(component.calendarMonth.getMonth()).toBe(7);
        });

        it('draws a fixed six-week grid so the popover never changes height', () => {
            component.calendarMonth = new Date(2026, 6, 1);
            expect(component.calendarDays.length).toBe(42);
            component.calendarMonth = new Date(2026, 1, 1); // February
            expect(component.calendarDays.length).toBe(42);
        });

        it('edits the time without disturbing the chosen dates', () => {
            component.activeBeginCalendarValue = '2026-07-27T00:00';
            component.activeEndCalendarValue = '2026-07-29T23:59';

            component.rangeStartTime = '09:18';
            component.rangeEndTime = '09:25';

            expect(component.activeBeginCalendarValue).toBe('2026-07-27T09:18');
            expect(component.activeEndCalendarValue).toBe('2026-07-29T09:25');
        });

        it('closes when the range completes, not on the first click', () => {
            /*
             * "when I select my dates it should be auto closed" -- but closing
             * on the FIRST click would make a multi-day window unreachable,
             * which is the whole point of the control. So the first click
             * leaves it open to be extended and the second closes it.
             */
            component.calendarMonth = new Date(2026, 6, 1);
            component.rangeOpen = true;

            component.pickDay(dayAt('2026-07-27'));
            expect(component.rangeOpen).toBe(true);

            component.pickDay(dayAt('2026-07-30'));
            expect(component.rangeOpen).toBe(false);
        });

        it('a single day is two clicks on the same date, and closes', () => {
            component.calendarMonth = new Date(2026, 6, 1);
            component.rangeOpen = true;

            component.pickDay(dayAt('2026-07-27'));
            component.pickDay(dayAt('2026-07-27'));

            expect(component.activeBeginCalendarValue).toBe('2026-07-27T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-27T23:59');
            expect(component.rangeOpen).toBe(false);
        });

        it('a Timeframe preset resets the picker instead of extending from it', () => {
            /*
             * The Timeframe dropdown sits beside the picker and writes the same
             * timestamps. Without a reset, choosing a preset and then clicking
             * one day would extend from the date the preset had just replaced.
             */
            component.calendarMonth = new Date(2026, 6, 1);
            component.pickDay(dayAt('2026-07-27')); // leaves the picker extending

            component.selectedTimeframe = 'Past 7 Days';
            component.onTimeframeChange();
            expect(component.activeBeginCalendarValue).toContain('2026-08-20');
            expect(component.rangeOpen).toBe(false);

            // The next click starts a fresh range rather than extending.
            component.calendarMonth = new Date(2026, 7, 1);
            component.pickDay(dayAt('2026-08-25'));
            expect(component.activeBeginCalendarValue).toBe('2026-08-25T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-08-25T23:59');
        });

        
        
        it('keeps the time controls reachable after a range completes', () => {
            /*
             * The tension between "close when I select my dates" and editing
             * times: completing a multi-day range closes the popover, so the
             * time fields are only reachable by reopening -- and reopening must
             * not disturb the dates already chosen.
             */
            component.calendarMonth = new Date(2026, 6, 1);
            component.rangeOpen = true;
            component.pickDay(dayAt('2026-07-27'));
            component.pickDay(dayAt('2026-07-30'));
            expect(component.rangeOpen).toBe(false);

            component.toggleRangeOpen();
            expect(component.rangeOpen).toBe(true);
            expect(component.activeBeginCalendarValue).toBe('2026-07-27T00:00');
            expect(component.activeEndCalendarValue).toBe('2026-07-30T23:59');

            // And editing a time from there leaves the dates alone.
            component.rangeStartTime = '09:18';
            expect(component.activeBeginCalendarValue).toBe('2026-07-27T09:18');
            expect(component.activeEndCalendarValue).toBe('2026-07-30T23:59');
        });

        it('keeps the Timeframe dropdown alongside the picker', () => {
            // Requested explicitly: the presets answer "recently" and the
            // picker answers "that specific day".
            expect(fixture.nativeElement.querySelector('#selectedTimeframe')).toBeTruthy();
            expect(fixture.nativeElement.querySelector('#rangeToggleBtn')).toBeTruthy();
        });

        it('positions the popover from the trigger so the card cannot clip it', () => {
            /*
             * `.form-panel` sets overflow: hidden, so an absolutely positioned
             * popover from a mid-form field had its bottom cut off -- which hid
             * the time controls entirely. Fixed positioning escapes that, but
             * only if real viewport coordinates are set.
             */
            component.rangeOpen = false;
            component.toggleRangeOpen();
            fixture.detectChanges();

            const pop = fixture.nativeElement.querySelector('.range-pop') as HTMLElement;
            expect(pop).toBeTruthy();
            expect(getComputedStyle(pop).position).toBe('fixed');
            // A coordinate was actually computed rather than left at the default.
            expect(pop.style.top).not.toBe('');
            expect(pop.style.left).not.toBe('');
        });
    });

    it('states the window it is about to search, in local time and UTC', () => {
        /*
         * A real search came back empty and was reported as the feature being
         * broken; the window had ended six minutes before the event. Nothing in
         * the UI said what window was being searched, so there was nothing to
         * check. UTC is shown too because the inputs are browser-local.
         */
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        setValidWindow();
        submit();
        // The component is OnPush and submit() does not run change detection.
        fixture.detectChanges();

        const note = fixture.nativeElement.querySelector('.window-note')?.textContent ?? '';
        expect(note).toContain('Searching');
        expect(note).toContain('UTC');
        expect(component.searchWindowUtc).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} to /);
    });

    it('names every missing required field in one alert', () => {
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const message = lastArgs(alertSpy)[0] as string;
        expect(message).toContain('ServProvCode');
        expect(message).toContain('Host');
        expect(message).toContain('Environment');
    });

    it('rejects a window shorter than one minute', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setTimestamps('2026-08-27T10:00', '2026-08-27T10:00');
        submit();

        expect(alertSpy).toHaveBeenCalledWith('End timestamp must be at least 1 minute after the begin timestamp.');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('rejects timestamps in the future', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setTimestamps('2026-08-28T10:00', '2026-08-28T11:00');
        submit();

        expect(alertSpy).toHaveBeenCalledWith('Timestamps cannot be in the future.');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('rejects two payment services at once', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('forteCheckbox');
        check('paypalCheckbox');
        setValidWindow();
        submit();

        expect(alertSpy).toHaveBeenCalledWith('Please select only one payment service (Forte or Paypal Commerce)');
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('rejects two document services at once', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('acdsCheckbox');
        check('adsCheckbox');
        setValidWindow();
        submit();

        expect(alertSpy).toHaveBeenCalledWith('Please select only one document service (ACDS or ADS)');
        expect(openSpy).not.toHaveBeenCalled();
    });

    // -------------------------------------------------- Civic Platform queries

    it('builds a US PROD Civic Platform query with SERV_PROV_CODE, JNDI and host', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('@SERV_PROV_CODE:*TESTAGCY*');
        expect(query).toContain('@JNDI:*testagcy-prod*');
        expect(query).toContain('@JNDI:*TESTAGCY-PROD*');
        expect(query).toContain('host:*mtprd*');
    });

    it('maps every US non-prod environment onto the mtsup host', () => {
        for (const env of ['TEST', 'SUPP', 'NONPROD1', 'NONPROD4']) {
            openSpy.mockClear();
            setText('inputServProvCode', 'TESTAGCY');
            setHost('US');
            setEnvironment(env);
            check('civicPlatformCheckbox');
            setValidWindow();
            submit();
            expect(openedQuery(), env).toContain('host:*mtsup*');
        }
    });

    it('prefixes AU environments and targets the auprd host', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('AU');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('@JNDI:*testagcy-auprod*');
        expect(query).toContain('@JNDI:*TESTAGCY-AUPROD*');
        expect(query).toContain('host:*auprd*');
    });

    it('suffixes CA environments and targets the caprd host', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('CA');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('@JNDI:*testagcy-prodca*');
        expect(query).toContain('@JNDI:*TESTAGCY-PRODCA*');
        expect(query).toContain('host:*caprd*');
    });

    it('leaves AU NONPROD environments unprefixed', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('AU');
        setEnvironment('NONPROD2');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('@JNDI:*testagcy-nonprod2*');
    });

    it('omits JNDI entirely for OREGON', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('OREGON');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).not.toContain('@JNDI');
        expect(query).toContain('@SERV_PROV_CODE:*TESTAGCY*');
        expect(query).toContain('host:*orprd*');
    });

    it('maps OREGON TRAIN onto the ortest host', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('OREGON');
        setEnvironment('TRAIN');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('host:*ortest*');
    });

    // -------------------------------------------------- Citizen Access queries

    it('pulls in Civic Platform automatically when only Citizen Access is chosen', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('citizenAccessCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('service:*aca*');
        // ACA is the frontend; the biz-tier query must still be present.
        expect(query).toContain('@SERV_PROV_CODE:*TESTAGCY*');
        expect(query).toContain('@JNDI:*testagcy-prod*');
    });

    it('lowercases the filename token in the ACA query', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('citizenAccessCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('filename:*testagcy-prod*');
    });

    it('uses the orprd filename form for OREGON PROD ACA', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('OREGON');
        setEnvironment('PROD');
        check('citizenAccessCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('filename:*testagcy-orprd-aca*');
    });

    it('omits the ACA clause for OREGON CONFIG', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('OREGON');
        setEnvironment('CONFIG');
        check('citizenAccessCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).not.toContain('service:*aca*');
    });

    // ------------------------------------------------------------ CAPI queries

    it('builds a CAPI query from the original environment name', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('constructAPICheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('service:capi');
        expect(query).toContain('@Properties.log.EnvName:*PROD*');
        expect(query).toContain('@Properties.log.Agency:*TESTAGCY*');
    });

    // --------------------------------------------- additional service queries

    it('emits the Forte service list', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('forteCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('service:payment-adapter-service');
        expect(query).toContain('service:config-store-service');
    });

    it('adds the Paypal UI service for Paypal Commerce', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('paypalCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('service:"Paypal UI"');
    });

    it('emits both ACDS services', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('acdsCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('service:acds');
        expect(query).toContain('service:edms-handler');
    });

    it('emits the ADS service', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        uncheck('civicPlatformCheckbox');
        check('adsCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('service:av.ads');
    });

    /**
     * KNOWN DEFECT, pinned deliberately.
     *
     * The additional-service clause carries no agency and no environment filter,
     * and it is OR'd with the main query rather than AND'd. Selecting Forte
     * therefore returns payment-adapter-service logs for every tenant in every
     * environment. Recorded here so the upgrade does not silently change it and
     * so the fix has a failing test to flip.
     */
    it('does NOT scope additional services to agency or environment (known defect)', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        check('forteCheckbox');
        setValidWindow();
        submit();

        const query = openedQuery();
        const serviceClause = '(service:payment-adapter-service OR name:event-log-service OR service:config-store-service)';
        expect(query).toContain(serviceClause);
        // The clause is a bare OR branch, unqualified by agency or host.
        expect(query).toContain(`OR ${serviceClause}`);
    });

    // ----------------------------------------------------- additional params

    it('wildcards a single additional parameter', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setText('inputAdditionalParams', 'NullPointerException');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('*NullPointerException*');
    });

    it('joins multiple additional parameters with OR', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setText('inputAdditionalParams', 'timeout refused');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('*timeout* OR *refused*');
    });

    it('preserves a quoted phrase without wildcards', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setText('inputAdditionalParams', '"connection reset"');
        setValidWindow();
        submit();

        const query = openedQuery();
        expect(query).toContain('"connection reset"');
        expect(query).not.toContain('*"connection');
    });

    // -------------------------------------------------------- URL construction

    it('sets the log explorer view parameters', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setValidWindow();
        submit();

        const url = openedUrl();
        expect(url.origin + url.pathname).toBe('https://app.datadoghq.com/logs');
        expect(url.searchParams.get('cols')).toBe('host,service');
        expect(url.searchParams.get('index')).toBe('*');
        expect(url.searchParams.get('viz')).toBe('stream');
    });

    it('sends windows older than 15 days to the rehydration page', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
        check('civicPlatformCheckbox');
        setTimestamps('2026-07-01T00:00', '2026-07-01T23:59');
        submit();

        expect(isRehydrateUrl()).toBe(true);
        expect(openedUrl().searchParams.has('query')).toBe(true);
    });

    it('opens the generated URL in a new tab', () => {
        setText('inputTraceID', '20260827124240646-4f3b5f17');
        submit();
        expect(lastArgs(openSpy)[1]).toBe('_blank');
    });

    // ----------------------------------------------------- timeframe presets

    it('moves the begin timestamp back when a preset is chosen', () => {
        component.selectedTimeframe = 'Past 7 Days';
        component.onTimeframeChange();

        const begin = new Date(component.activeBeginCalendarValue);
        const end = new Date(component.activeEndCalendarValue);
        expect(end.getTime()).toBeGreaterThan(begin.getTime());
        const spanDays = (end.getTime() - begin.getTime()) / 86400000;
        expect(spanDays).toBeCloseTo(7, 0);
    });

    it('sets the begin timestamp to midnight for TODAY', () => {
        component.selectedTimeframe = 'TODAY';
        component.onTimeframeChange();
        expect(component.activeBeginCalendarValue.endsWith('T00:00')).toBe(true);
    });
});
