import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { AppComponent } from './app.component';
import { LegacyQueryBuilderService } from './query/legacy-query-builder.service';
import { QueryBuilderV2Service } from './query/query-builder-v2.service';

/**
 * Covers the dual-engine behaviour: which engines run, what gets rendered in the
 * preview panel, and when a URL is opened automatically.
 */
describe('AppComponent engine modes', () => {
    let fixture: ComponentFixture<AppComponent>;
    let component: AppComponent;
    let openSpy: ReturnType<typeof vi.spyOn>;
    let alertSpy: ReturnType<typeof vi.spyOn>;

    const NOW = new Date(2026, 7, 27, 14, 30, 0, 0);

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [FormsModule],
            declarations: [AppComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(AppComponent);
        component = fixture.componentInstance;
        openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        fixture.detectChanges();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function el(id: string): HTMLElement {
        return fixture.nativeElement.querySelector(`#${id}`) as HTMLElement;
    }

    function fillValidForm(opts: { apps?: string[]; services?: string[]; host?: string; env?: string } = {}) {
        const spc = el('inputServProvCode') as HTMLInputElement;
        spc.value = 'AGCY';
        spc.dispatchEvent(new Event('input'));

        const hostSel = el('inputHost') as HTMLSelectElement;
        hostSel.value = opts.host ?? 'US';
        hostSel.dispatchEvent(new Event('change'));
        fixture.detectChanges();

        const envSel = el('inputEnvironment') as HTMLSelectElement;
        envSel.value = opts.env ?? 'PROD';
        envSel.dispatchEvent(new Event('change'));

        const appBoxes: Record<string, string> = {
            'Civic Platform': 'civicPlatformCheckbox',
            'Citizen Access': 'citizenAccessCheckbox',
            CAPI: 'constructAPICheckbox',
        };
        for (const a of opts.apps ?? ['Civic Platform']) {
            (el(appBoxes[a]) as HTMLInputElement).checked = true;
        }

        const svcBoxes: Record<string, string> = {
            Forte: 'forteCheckbox',
            'Paypal Commerce': 'paypalCheckbox',
            SecurePay: 'securePayCheckbox',
            ACDS: 'acdsCheckbox',
            ADS: 'adsCheckbox',
        };
        for (const s of opts.services ?? []) {
            (el(svcBoxes[s]) as HTMLInputElement).checked = true;
        }

        const b = el('inputBeginTimestamp') as HTMLInputElement;
        b.value = '2026-08-27T00:00';
        b.dispatchEvent(new Event('input'));
        const e = el('inputEndTimestamp') as HTMLInputElement;
        e.value = '2026-08-27T14:00';
        e.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    }

    function submit() {
        component.onSubmit(new Event('submit'));
        fixture.detectChanges();
    }

    function previewNodes(): HTMLElement[] {
        return Array.from(fixture.nativeElement.querySelectorAll('.query-preview'));
    }

    // ------------------------------------------------------------ default mode

    it('defaults to comparing both engines', () => {
        expect(component.engineMode).toBe('compare');
        expect(component.isCompareMode).toBe(true);
    });

    it('compare mode produces one preview per engine', () => {
        fillValidForm();
        submit();

        expect(component.previews.length).toBe(2);
        expect(component.previews.map((p) => p.engine)).toEqual(['legacy', 'v2']);
    });

    it('compare mode does NOT open a tab automatically', () => {
        fillValidForm();
        submit();
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('compare mode renders both queries with their own Open button', () => {
        fillValidForm();
        submit();

        const nodes = previewNodes();
        expect(nodes.length).toBe(2);
        expect(nodes[0].textContent).toContain('Legacy');
        expect(nodes[1].textContent).toContain('New (v2)');
        expect(
            fixture.nativeElement.querySelectorAll('.query-open').length
        ).toBe(2);
    });

    it('compare mode shows the actual query text for each engine', () => {
        fillValidForm();
        submit();

        const legacy = TestBed.inject(LegacyQueryBuilderService);
        const v2 = TestBed.inject(QueryBuilderV2Service);
        const input = {
            servProvCode: 'AGCY', host: 'US', environment: 'PROD',
            applications: ['Civic Platform'], additionalServices: [], additionalParams: '',
        };

        expect(component.previews[0].query).toBe(legacy.build(input).query);
        expect(component.previews[1].query).toBe(v2.build(input).query);

        const rendered = Array.from(
            fixture.nativeElement.querySelectorAll('.query-text')
        ).map((n) => (n as HTMLElement).textContent);
        expect(rendered[0]).toContain('@SERV_PROV_CODE');
        expect(rendered[1]).toContain('@SERV_PROV_CODE');
    });

    it('the two engines really differ for a payment service', () => {
        fillValidForm({ services: ['Forte'] });
        submit();

        const [legacyPreview, v2Preview] = component.previews;
        expect(legacyPreview.query).not.toBe(v2Preview.query);
        // The defect and its fix, side by side: legacy's service branch carries
        // no agency filter, v2's does.
        expect(legacyPreview.query).not.toContain('@agencycode');
        expect(v2Preview.query).toContain('@agencycode:AGCY');
    });

    // ------------------------------------------------------ single-engine modes

    it('v2 mode runs only v2 and opens the tab', () => {
        component.engineMode = 'v2';
        fillValidForm();
        submit();

        expect(component.previews.length).toBe(1);
        expect(component.previews[0].engine).toBe('v2');
        expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('legacy mode runs only legacy and opens the legacy query', () => {
        component.engineMode = 'legacy';
        fillValidForm();
        submit();

        expect(component.previews.length).toBe(1);
        expect(component.previews[0].engine).toBe('legacy');

        const url = new URL(String(vi.mocked(openSpy).mock.lastCall?.[0]));
        expect(url.searchParams.get('query')).toBe(component.previews[0].query);
    });

    it('opening a preview from compare mode uses that engine URL', () => {
        fillValidForm();
        submit();

        component.openPreview(component.previews[1]);
        expect(String(vi.mocked(openSpy).mock.lastCall?.[0])).toBe(component.previews[1].url);
    });

    it('changing engine mode clears stale previews', () => {
        fillValidForm();
        submit();
        expect(component.previews.length).toBe(2);

        component.onEngineModeChange('v2');
        expect(component.previews).toEqual([]);
    });

    it('changing host clears stale previews', () => {
        fillValidForm();
        submit();
        expect(component.previews.length).toBeGreaterThan(0);

        component.onHostChange();
        expect(component.previews).toEqual([]);
    });

    // ---------------------------------------------------------------- warnings

    it('renders a v2 warning where legacy was silent', () => {
        component.engineMode = 'compare';
        fillValidForm({ host: 'OREGON', env: 'DEV', apps: ['Citizen Access'] });
        submit();

        const legacyPreview = component.previews[0];
        const v2Preview = component.previews[1];

        expect(legacyPreview.warnings).toEqual([]);
        expect(v2Preview.warnings.some((w) => w.includes('Citizen Access'))).toBe(true);

        const warningText = Array.from(
            fixture.nativeElement.querySelectorAll('.query-warning')
        ).map((n) => (n as HTMLElement).textContent).join(' ');
        expect(warningText).toContain('Citizen Access');
    });

    it('flags a rehydration-bound search in the preview', () => {
        component.engineMode = 'v2';
        fillValidForm();
        const b = el('inputBeginTimestamp') as HTMLInputElement;
        b.value = '2026-07-01T00:00';
        b.dispatchEvent(new Event('input'));
        const e = el('inputEndTimestamp') as HTMLInputElement;
        e.value = '2026-07-01T23:59';
        e.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        submit();

        expect(component.previews[0].rehydrate).toBe(true);
        expect(component.previews[0].url).toContain('historical-views');
        expect(fixture.nativeElement.querySelector('.query-badge')).toBeTruthy();
    });

    // ------------------------------------------------------------------ errors

    it('alerts and opens nothing when two payment services are selected', () => {
        fillValidForm({ services: ['Forte', 'Paypal Commerce'] });
        submit();

        expect(alertSpy).toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled();
        expect(fixture.nativeElement.querySelector('.query-error')).toBeTruthy();
    });

    it('deduplicates the same error raised by both engines', () => {
        fillValidForm({ services: ['ACDS', 'ADS'] });
        submit();

        const message = String(vi.mocked(alertSpy).mock.lastCall?.[0]);
        // Both engines object; the user should not see it twice verbatim.
        expect(message.split('\n').length).toBeLessThanOrEqual(2);
    });

    // ---------------------------------------------------------------- trace ID

    it('trace ID search opens immediately and previews the query', () => {
        const t = el('inputTraceID') as HTMLInputElement;
        t.value = '20260827124240646-4f3b5f17';
        t.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        submit();

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(component.previews.length).toBe(1);
        expect(component.previews[0].label).toBe('Trace ID');
        expect(component.previews[0].query).toContain('@TRACE_ID');
    });

    it('trace ID search is unaffected by engine mode', () => {
        for (const mode of ['legacy', 'v2', 'compare'] as const) {
            component.previews = [];
            openSpy.mockClear();
            component.engineMode = mode;

            const t = el('inputTraceID') as HTMLInputElement;
            t.value = '20260827124240646-4f3b5f17';
            t.dispatchEvent(new Event('input'));
            fixture.detectChanges();
            submit();

            expect(component.previews.length, `engineMode=${mode}`).toBe(1);
            expect(openSpy, `engineMode=${mode}`).toHaveBeenCalledTimes(1);
        }
    });

    // ------------------------------------------------------------ new controls

    it('exposes the engine selector and SecurePay checkbox in the template', () => {
        expect(el('engineCompare')).toBeTruthy();
        expect(el('engineV2')).toBeTruthy();
        expect(el('engineLegacy')).toBeTruthy();
        expect(el('securePayCheckbox')).toBeTruthy();
    });

    it('the engine radios reflect and drive engineMode', () => {
        const v2Radio = el('engineV2') as HTMLInputElement;
        v2Radio.dispatchEvent(new Event('change'));
        fixture.detectChanges();

        expect(component.engineMode).toBe('v2');
        expect((el('engineV2') as HTMLInputElement).checked).toBe(true);
    });
});
