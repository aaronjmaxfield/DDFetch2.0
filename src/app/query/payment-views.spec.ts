import { TestBed } from '@angular/core/testing';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { QueryInput } from './query-input.model';
import { findCategory, findView, guidanceFor } from './scopes.config';

/**
 * Guards for the Payment "Looking for" views, 2026-09-29. Measurements behind
 * each signature are in research/PAYMENT_VIEWS.md.
 */
describe('Payment "Looking for" views', () => {
  let v2: QueryBuilderV2Service;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    v2 = TestBed.inject(QueryBuilderV2Service);
  });

  function payment(view?: string, overrides: Partial<QueryInput> = {}, option?: string): QueryInput {
    return {
      servProvCode: 'AGCY',
      host: 'US',
      environment: 'PROD',
      applications: ['Civic Platform', 'Citizen Access'],
      additionalServices: [],
      additionalParams: '',
      scope: { category: 'payment', option, view, fields: {} },
      ...overrides,
    };
  }

  const VIEW_IDS = ['adapter', 'postback-failures', 'outcomes'];

  it('offers three views on Payment, and none elsewhere', () => {
    expect(findCategory('payment')?.views?.map((v) => v.id)).toEqual(VIEW_IDS);
    expect(findCategory('documents')?.views).toBeUndefined();
  });

  it('changes nothing when no view is picked', () => {
    const without = payment();
    delete without.scope!.view;
    expect(v2.build(payment()).query).toBe(v2.build(without).query);
  });

  it('ignores a view id that does not belong to the category', () => {
    const q = v2.build({ ...payment(), scope: { category: 'documents', view: 'outcomes' } }).query;
    expect(q).not.toContain('Processing cap payment ends');
  });

  describe.each(VIEW_IDS)('%s', (id) => {
    it('is split by tier, so no signature is required of a tier that does not write it', () => {
      const clause = findView('payment', id)!.clause({
        agencyUpper: 'AGCY',
        agencyLower: 'agcy',
        env: { ui: 'PROD', jndi: 'prod' } as never,
      });
      expect(clause.startsWith('((service:aca AND (')).toBe(true);
      expect(clause).toContain(' OR (-service:aca AND (');
    });

    it('replaces the biz-tier payment markers rather than stacking on them', () => {
      // Several signatures carry no payment word, so the markers would delete them.
      expect(v2.build(payment()).query).toContain('*transaction-id*');
      expect(v2.build(payment(id)).query).not.toContain('*transaction-id*');
    });

    it('states what it cannot see', () => {
      const view = findView('payment', id)!;
      expect(view.blindSpots.length).toBeGreaterThan(40);
      expect(v2.build(payment(id)).warnings).toContain(view.blindSpots);
    });

    it('is ignored in raw mode, which promises nothing was filtered', () => {
      const raw = v2.build(payment(id, { rawMode: true }));
      const rawNoView = v2.build(payment(undefined, { rawMode: true }));
      expect(raw.query).toBe(rawNoView.query);
    });

    it('uses no wildcard-wrapped multi-word phrase', () => {
      // `*a b*` over-matches on these logs; every multi-word signature is quoted.
      const clause = findView('payment', id)!.clause({
        agencyUpper: 'AGCY',
        agencyLower: 'agcy',
        env: { ui: 'PROD', jndi: 'prod' } as never,
      });
      // Strip quoted phrases first; what is left must hold no `*word word*`.
      expect(clause.replace(/"[^"]*"/g, '""')).not.toMatch(/\*[^*\s()"]+ [^*\s()"]+\*/);
    });
  });

  describe('Which adapter is configured', () => {
    it('lifts the EPaymentConfig chatter exclusion, because those lines are the answer', () => {
      expect(v2.build(payment()).query).toContain('-@logger.name:EPaymentConfig');
      const q = v2.build(payment('adapter')).query;
      expect(q).not.toContain('-@logger.name:EPaymentConfig');
      expect(q).toContain('@logger.name:EPaymentConfig');
    });

    it('falls back to free text for Oregon, whose ACA lines have no logger facet', () => {
      expect(v2.build(payment('adapter')).query).toContain('(*adapterName* AND -@logger.name:*)');
    });

    it('also reads the adapter-specific loggers and the postback line, because EPaymentConfig can be absent for an agency', () => {
      const q = v2.build(payment('adapter')).query;
      expect(q).toContain('Accela.ACA.Web.Payment.AccelaAdapterPayment');
      expect(q).toContain('Accela.ACA.Web.Payment.CoBrandPlusHandler');
      // The colon-joined phrase must include the step, or it matches 0.
      expect(q).toContain('"Redirect Payment Logging:HandlePostbackData"');
    });

    it('says the biz arm is back-office payments only', () => {
      expect(findView('payment', 'adapter')!.blindSpots).toContain('BACK-OFFICE');
    });
  });

  describe('Failed postbacks and callbacks', () => {
    it('brings the redirect-adapter postback page into the ACA identity', () => {
      expect(v2.build(payment()).query).not.toContain('AGCY/payment/paymentpostback.aspx');
      expect(v2.build(payment('postback-failures')).query).toContain(
        '(service:aca AND filename:u_ex* AND "AGCY/payment/paymentpostback.aspx")'
      );
    });

    it('keeps anything but a clean 200 on the callback pages, and drops uptime monitors', () => {
      const q = v2.build(payment('postback-failures')).query;
      expect(q).toContain('"AGCY/Cap/PaymentResult.aspx" AND -"200 0 0"');
      expect(q).toContain('-(PRTG OR Splunk OR Go-http-client*)');
      expect(q).toContain('("postback:success%3dfalse" AND -*not%20available*)');
    });

    it('uses the environment segment outside production', () => {
      const q = v2.build(payment('postback-failures', { environment: 'SUPP' })).query;
      expect(q).toContain('"AGCY-SUPP/payment/paymentpostback.aspx"');
    });

    it('scopes "Connection reset" to the SecurePay adapter, where it is not database noise', () => {
      expect(v2.build(payment('postback-failures')).query).toContain(
        '(service:app-pci-payment-adapter AND "Connection reset")'
      );
    });
  });

  describe('Payment outcomes', () => {
    it('carries a success and a failure anchor for each tier', () => {
      const q = v2.build(payment('outcomes')).query;
      for (const s of [
        '"The payment is successfully"',
        '"Applying ACA payment result ends"',
        '"Processing cap payment ends"',
        '"This transaction has been reversed"',
        '"payrix /txns result"',
      ]) {
        expect(q).toContain(s);
      }
    });
  });

  it('warns that adapter lines are missing when no Provider is picked', () => {
    const PROVIDER = 'No Provider is selected';
    expect(v2.build(payment('outcomes')).warnings.some((w) => w.includes(PROVIDER))).toBe(true);
    expect(v2.build(payment('outcomes', {}, 'forte')).warnings.some((w) => w.includes(PROVIDER))).toBe(false);
  });

  describe('warns when a tier the view needs is not ticked', () => {
    const NOT_TICKED = (app: string) => (w: string) => w.startsWith(`${app} is not ticked`);

    it('Payment adapter without Citizen Access -- the ACA-only Forte agency miss, 2026-10-01', () => {
      const w = v2.build(payment('adapter', { applications: ['Civic Platform'] })).warnings;
      expect(w.some(NOT_TICKED('Citizen Access'))).toBe(true);
      expect(w.some(NOT_TICKED('Civic Platform'))).toBe(false);
    });

    it('Payment adapter without Civic Platform', () => {
      const w = v2.build(payment('adapter', { applications: ['Citizen Access'] })).warnings;
      expect(w.some(NOT_TICKED('Civic Platform'))).toBe(true);
    });

    it('says nothing when both are ticked', () => {
      for (const id of VIEW_IDS) {
        const w = v2.build(payment(id)).warnings;
        expect(w.some((x) => x.includes('is not ticked'))).toBe(false);
      }
    });

    it('Failed postbacks without Citizen Access', () => {
      const w = v2.build(payment('postback-failures', { applications: ['Civic Platform'] })).warnings;
      expect(w.some(NOT_TICKED('Citizen Access'))).toBe(true);
    });

    it('the custom-adapter and CoBrandPlus options filter only ACA, so they need it', () => {
      for (const opt of ['custom-adapter', 'cobrandplus']) {
        const w = v2.build(payment(undefined, { applications: ['Civic Platform'] }, opt)).warnings;
        expect(w.some(NOT_TICKED('Citizen Access'))).toBe(true);
      }
    });

    it('EMSE and Batch need Civic Platform', () => {
      for (const category of ['emse', 'batch']) {
        const w = v2.build({
          ...payment(),
          applications: ['Citizen Access'],
          scope: { category, fields: {} },
        }).warnings;
        expect(w.some(NOT_TICKED('Civic Platform'))).toBe(true);
      }
    });

    it('a marker-only scope with Civic Platform unticked changes nothing, and says so', () => {
      const GENERIC = 'only narrows Civic Platform lines';
      const base = { ...payment(), applications: ['Citizen Access'] };
      const records = (fields: Record<string, string>) =>
        v2.build({ ...base, scope: { category: 'records', fields } }).warnings;
      expect(records({}).some((w) => w.includes(GENERIC))).toBe(true);
      // A field value scopes the ACA side too, so the scope does do something.
      expect(records({ capId: '26ABC-00000-00001' }).some((w) => w.includes(GENERIC))).toBe(false);
      // Not when Civic Platform is ticked.
      expect(
        v2.build({ ...payment(), scope: { category: 'records', fields: {} } }).warnings.some((w) => w.includes(GENERIC))
      ).toBe(false);
    });

    it('stays quiet in raw mode, which ignores scopes', () => {
      const w = v2.build(payment('adapter', { applications: ['Civic Platform'], rawMode: true })).warnings;
      expect(w.some((x) => x.includes('is not ticked'))).toBe(false);
    });
  });

  it("lists the view's guidance first", () => {
    const g = guidanceFor('payment', undefined, 'adapter')!;
    expect(g.what).toContain('payment adapter this agency is configured to use');
    expect(g.notes?.[0]).toContain('short window');
    expect(guidanceFor('payment', undefined)!.notes?.[0]).not.toContain('short window');
  });
});
