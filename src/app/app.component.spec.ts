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
        const found = fixture.nativeElement.querySelector(`#${id}`) as T;
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
        setValidWindow();
        submit();

        expect(alertSpy).toHaveBeenCalled();
        expect(lastArgs(alertSpy)[0]).toContain('At least one Application');
        expect(openSpy).not.toHaveBeenCalled();
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
        check('paypalCheckbox');
        setValidWindow();
        submit();
        expect(openedQuery()).toContain('service:"Paypal UI"');
    });

    it('emits both ACDS services', () => {
        setText('inputServProvCode', 'TESTAGCY');
        setHost('US');
        setEnvironment('PROD');
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
