import { TestBed } from '@angular/core/testing';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { QueryInput } from './query-input.model';
import { findCategory, guidanceFor } from './scopes.config';
import { lintSecurePayTerms, SECUREPAY_LINTS } from './securepay-lints';
import { SECUREPAY_FACETLESS_RESTART_NOISE } from './environments.config';

/**
 * Guards for the changes made after testing the eleven engineering SecurePay
 * SOPs against live Datadog, 2026-09-25.
 */
describe('SecurePay SOP signals', () => {
  let v2: QueryBuilderV2Service;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    v2 = TestBed.inject(QueryBuilderV2Service);
  });

  function securePay(overrides: Partial<QueryInput> = {}, fields: Record<string, string> = {}): QueryInput {
    return {
      servProvCode: 'AGCY',
      host: 'US',
      environment: 'TEST',
      applications: ['Civic Platform'],
      additionalServices: [],
      additionalParams: '',
      scope: { category: 'payment', option: 'securepay', fields },
      ...overrides,
    };
  }

  const ACCESS = 'PCI Data Viewers';

  describe('SecurePay trace ID field', () => {
    it('searches the PCI facet, the biz facet and free text together', () => {
      const id = 'W-20260101120000000-1a2b3c4d';
      const { query } = v2.build(securePay({}, { securePayTraceId: id }));
      expect(query).toContain(`(@accela.trace_id:${id} OR @TRACE_ID:${id} OR *${id}*)`);
    });

    it('warns that abc-123-trace is shared by many test payments', () => {
      const { warnings } = v2.build(securePay({}, { securePayTraceId: 'abc-123-trace' }));
      expect(warnings.some((w) => w.includes('fixed test trace ID'))).toBe(true);
    });

    it('warns about an unevaluated simple{...} trace', () => {
      const { warnings } = v2.build(securePay({}, { securePayTraceId: 'simple{header.x}' }));
      expect(warnings.some((w) => w.includes('unfilled template'))).toBe(true);
    });
  });

  describe('Merchant ID field', () => {
    it('emits free text, because no @merchant facet exists', () => {
      const { query } = v2.build(securePay({}, { payrixMerchantId: 't1_mer_0123456789abcdef0123456' }));
      expect(query).toContain('*t1_mer_0123456789abcdef0123456*');
      expect(query).not.toContain('@merchant');
    });

    it('warns when given a transaction ID instead of a merchant ID', () => {
      const { warnings } = v2.build(securePay({}, { payrixMerchantId: 't1_txn_0123456789abcdef0123456' }));
      expect(warnings.some((w) => w.includes('does not look like a Payrix merchant ID'))).toBe(true);
    });

    it('is only offered under SecurePay', () => {
      const forte = findCategory('payment')!.options.find((o) => o.id === 'forte')!;
      expect((forte.fields ?? []).map((f) => f.id)).not.toContain('payrixMerchantId');
    });
  });

  describe('production access warning', () => {
    it('is raised for SecurePay in PROD', () => {
      const { warnings } = v2.build(securePay({ environment: 'PROD' }));
      expect(warnings.some((w) => w.includes(ACCESS))).toBe(true);
    });

    it('is not raised in TEST, where eng-arch-pci is searched', () => {
      const { warnings } = v2.build(securePay());
      expect(warnings.some((w) => w.includes(ACCESS))).toBe(false);
    });

    it('is not raised for Forte in PROD', () => {
      const { warnings } = v2.build(
        securePay({ environment: 'PROD', scope: { category: 'payment', option: 'forte', fields: {} } })
      );
      expect(warnings.some((w) => w.includes(ACCESS))).toBe(false);
    });
  });

  describe('non-prod adapter visibility warning', () => {
    const NONPROD = 'only visible for the engineering test cluster';

    it('is raised for SecurePay in STG, whose adapter half runs on nonprod-pci', () => {
      const { warnings } = v2.build(securePay({ environment: 'STG' }));
      expect(warnings.some((w) => w.includes(NONPROD))).toBe(true);
    });

    it('is not raised in PROD, which gets the production warning instead', () => {
      const { warnings } = v2.build(securePay({ environment: 'PROD' }));
      expect(warnings.some((w) => w.includes(NONPROD))).toBe(false);
      expect(warnings.some((w) => w.includes(ACCESS))).toBe(true);
    });

    it('is not raised without SecurePay', () => {
      const { warnings } = v2.build(
        securePay({ environment: 'STG', scope: { category: 'payment', option: 'forte', fields: {} } })
      );
      expect(warnings.some((w) => w.includes(NONPROD))).toBe(false);
    });
  });

  describe('PaymentResult.aspx callback line', () => {
    const withAca = (env: string, option = 'securepay') =>
      securePay({
        environment: env,
        applications: ['Civic Platform', 'Citizen Access'],
        scope: { category: 'payment', option, fields: {} },
      });

    it('is admitted under Payment without Include IIS, bare in PROD', () => {
      const { query } = v2.build(withAca('PROD'));
      expect(query).toContain('(service:aca AND filename:u_ex* AND "AGCY/Cap/PaymentResult.aspx")');
    });

    it('is bare in STG too', () => {
      const { query } = v2.build(withAca('STG'));
      expect(query).toContain('"AGCY/Cap/PaymentResult.aspx"');
      expect(query).not.toContain('"AGCY-STG/Cap/PaymentResult.aspx"');
    });

    it('carries the environment suffix on the shared non-prod rows', () => {
      expect(v2.build(withAca('TEST')).query).toContain('"AGCY-TEST/Cap/PaymentResult.aspx"');
      expect(v2.build(withAca('NONPROD1')).query).toContain('"AGCY-NONPROD1/Cap/PaymentResult.aspx"');
    });

    it('applies to every payment provider, not just SecurePay', () => {
      expect(v2.build(withAca('PROD', 'forte')).query).toContain('/Cap/PaymentResult.aspx"');
    });

    it('is not added without Citizen Access, or outside the Payment scope', () => {
      expect(v2.build(securePay({ environment: 'PROD' })).query).not.toContain('PaymentResult.aspx');
      const docs = v2.build(
        securePay({ applications: ['Civic Platform', 'Citizen Access'], scope: { category: 'documents', fields: {} } })
      );
      expect(docs.query).not.toContain('PaymentResult.aspx');
    });

    it('does not turn on the broad IIS arm', () => {
      expect(v2.build(withAca('PROD')).query).not.toContain('*/AGCY/*');
    });

    it('Include IIS in STG now uses the bare segment, which is what STG writes', () => {
      const { query } = v2.build(
        securePay({ environment: 'STG', applications: ['Civic Platform', 'Citizen Access'], includeIis: true })
      );
      expect(query).toContain('(service:aca AND filename:u_ex* AND */AGCY/*)');
    });
  });

  describe('payment markers for lines with no payment word', () => {
    it('keeps the fee-change reversal that explains a charged-but-not-recorded payment', () => {
      const { query } = v2.build(securePay());
      expect(query).toContain('"total fee have changed"');
    });

    it('keeps it for every provider, not just SecurePay', () => {
      const { query } = v2.build(securePay({ scope: { category: 'payment', option: 'forte', fields: {} } }));
      expect(query).toContain('"total fee have changed"');
    });

    it('adds the two SecurePay biz warnings as exact phrases, not *securepay*', () => {
      const { query } = v2.build(securePay());
      expect(query).toContain('"SecurePay service fee not recorded"');
      expect(query).toContain('"HMAC key resolved empty"');
      expect(query.toLowerCase()).not.toContain('*securepay*');
    });
  });

  describe('SOP-term lints on Additional Parameters', () => {
    it('warns that status:error hides SecurePay declines', () => {
      const { warnings } = v2.build(securePay({ additionalParams: 'status:error' }));
      expect(warnings.some((w) => w.includes('status:error hides'))).toBe(true);
    });

    it('does not raise the status:error lint outside SecurePay', () => {
      const { warnings } = v2.build(
        securePay({ additionalParams: 'status:error', scope: { category: 'payment', option: 'forte', fields: {} } })
      );
      expect(warnings.some((w) => w.includes('status:error hides'))).toBe(false);
    });

    it('names the real field for each SOP term that does not exist', () => {
      expect(lintSecurePayTerms('JMSXDeliveryCount:2', false)[0]).toContain('delivery attempt: N');
      expect(lintSecurePayTerms('"redelivery-attempts"', false)[0]).toContain('redeliveries: n/5');
      expect(lintSecurePayTerms('payrixCode=15', false)[0]).toContain('payrixStatus');
      expect(lintSecurePayTerms('@merchant:"t1_mer_x"', false)[0]).toContain('Merchant ID');
      expect(lintSecurePayTerms('@serviceProviderCode:X', false)[0]).toContain('@SERV_PROV_CODE');
      expect(lintSecurePayTerms('service:secure-pay-hub-service', false)[0]).toContain('app-pci-payment-adapter');
      expect(lintSecurePayTerms('"GIACT BLOCK"', false)[0]).toContain('verdict=BLOCK');
    });

    it('does not flag the correct GIACT tokens', () => {
      expect(lintSecurePayTerms('GIACT_BLOCK', true)).toEqual([]);
      expect(lintSecurePayTerms('"verdict=BLOCK"', true)).toEqual([]);
    });

    it('flags a bare "delivery attempt" but not a queue-scoped one', () => {
      expect(lintSecurePayTerms('"delivery attempt: 2"', true).length).toBe(1);
      expect(lintSecurePayTerms('"delivery attempt: 2" "from queue: local-responses"', true)).toEqual([]);
      expect(lintSecurePayTerms('@camel.routeId:response-queue-listener "delivery attempt"', true)).toEqual([]);
    });

    it('never changes the query text', () => {
      const typed = 'JMSXDeliveryCount:2';
      const { query } = v2.build(securePay({ additionalParams: typed }));
      expect(query).toContain(typed);
    });

    it('is silent on an empty box', () => {
      expect(lintSecurePayTerms('', true)).toEqual([]);
    });

    it('has a message for every lint', () => {
      for (const l of SECUREPAY_LINTS) expect(l.message.length).toBeGreaterThan(20);
    });
  });

  describe('restart chatter in the facet-less adapter arm', () => {
    it('excludes the four restart phrases inside the facet-less arm only', () => {
      const { query } = v2.build(securePay());
      const arm =
        '(-@SERV_PROV_CODE:* AND (-env:eng-arch-pci OR status:(error OR warn))' +
        SECUREPAY_FACETLESS_RESTART_NOISE.map((p) => ` AND -${p}`).join('') +
        ')';
      expect(query).toContain(arm);
      // Not applied globally: each phrase appears exactly once.
      for (const p of SECUREPAY_FACETLESS_RESTART_NOISE) {
        expect(query.split(`-${p}`).length - 1).toBe(1);
      }
    });

    it('quotes every phrase, because a wildcard multi-word negation matches everything', () => {
      for (const p of SECUREPAY_FACETLESS_RESTART_NOISE) expect(p).toMatch(/^".+"$/);
    });

    it('keeps the queue-connection and expired-link lines', () => {
      const all = SECUREPAY_FACETLESS_RESTART_NOISE.join(' ');
      expect(all).not.toContain('JMS');
      expect(all).not.toContain('Transport connection');
      expect(all).not.toContain('payment intent');
    });
  });

  describe('guidance', () => {
    it('explains the service-fee rejection as not charged', () => {
      const notes = guidanceFor('payment', 'securepay')!.notes!;
      expect(notes.some((n) => n.includes('serviceFee') && n.includes('not charged'))).toBe(true);
    });

    it('lists SecurePay notes first, then the Payment notes', () => {
      const g = guidanceFor('payment', 'securepay')!;
      const base = findCategory('payment')!.guidance!;
      expect(g.notes![0]).toContain('Do not filter to errors');
      expect(g.notes!.slice(-base.notes!.length)).toEqual(base.notes!);
      expect(g.what).toBe(base.what);
    });

    it('leaves other options with the category guidance only', () => {
      expect(guidanceFor('payment', 'forte')).toEqual({
        ...findCategory('payment')!.guidance!,
        notes: findCategory('payment')!.guidance!.notes ?? [],
      });
    });

    it('returns null with no scope', () => {
      expect(guidanceFor(undefined, undefined)).toBeNull();
    });
  });
});
