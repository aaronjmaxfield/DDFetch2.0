import { TestBed } from '@angular/core/testing';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { LegacyQueryBuilderService } from './legacy-query-builder.service';
import { QueryInput } from './query-input.model';

/**
 * One test per audited defect. Each references the audit ID so it is obvious
 * what regression it guards.
 */
describe('QueryBuilderV2Service', () => {
    let v2: QueryBuilderV2Service;
    let legacy: LegacyQueryBuilderService;

    beforeEach(() => {
        TestBed.configureTestingModule({});
        v2 = TestBed.inject(QueryBuilderV2Service);
        legacy = TestBed.inject(LegacyQueryBuilderService);
    });

    function input(overrides: Partial<QueryInput> = {}): QueryInput {
        return {
            servProvCode: 'AGCY',
            host: 'US',
            environment: 'PROD',
            applications: ['Civic Platform'],
            additionalServices: [],
            additionalParams: '',
            ...overrides,
        };
    }

    // ------------------------------------------------- A1: service scoping

    it('A1: scopes additional services by agency', () => {
        const { query } = v2.build(input({ additionalServices: ['Forte'] }));

        expect(query).toContain('@agencycode:AGCY');
        expect(query).toContain('service:payment-adapter-service');
    });

    it('A1: uses the real ConfigStore service name', () => {
        // Confirmed against live Datadog: `config-store-service` returns zero
        // logs over any window. The real name has no hyphen after "config".
        const { query } = v2.build(input({ additionalServices: ['Forte'] }));

        expect(query).toContain('service:configstore-service');
        expect(query).not.toContain('config-store-service');
    });

    it('A1: never emits an unscoped bare service branch', () => {
        const { query } = v2.build(
            input({ applications: ['Civic Platform'], additionalServices: ['Forte'] })
        );

        // The legacy defect: `OR (service:… OR name:… OR service:…)` with nothing else.
        expect(query).not.toContain('OR (service:payment-adapter-service OR');
        // The payment-adapter sub-branch must carry both scopes.
        const branch = query.slice(query.indexOf('service:payment-adapter-service'));
        expect(branch).toContain('@agencycode:AGCY');
        expect(branch).toContain('env:prod');
    });

    it('A1: scopes ConfigStore by free text, because its JSON is not parsed', () => {
        // Reversed on evidence. ConfigStore does carry SERV_PROV_CODE, MODULE,
        // GUID and the trace IDs -- but inside an Azure App Service console-log
        // envelope that Datadog does not parse, so only ~0.4% of lines have a
        // promoted attribute and @SERV_PROV_CODE is not a facet at all. The
        // agency is reachable by free text and nothing else.
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['Forte'] })
        );

        const branch = query.slice(query.indexOf('service:configstore-service'));
        expect(branch).toContain('service:configstore-service AND *AGCY*');
        // Not the attribute scope -- those facets do not exist on these logs.
        expect(branch.slice(0, 60)).not.toContain('@agencycode');
    });

    it('A1: free-text agency uses one casing, unlike the facet scope', () => {
        // Facet values are case sensitive so @SERV_PROV_CODE needs both casings.
        // Free-text matching is case insensitive, so a second casing would only
        // pad the query. Confirmed live: *STANDARDTEST* and *standardtest*
        // return identical counts.
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['SecurePay'] })
        );

        const branch = query.slice(query.indexOf('service:app-pci-configstore'));
        expect(branch).toContain('service:app-pci-configstore');
        expect(branch).toContain('*AGCY*');
        expect(branch).not.toContain('*agcy*');
    });

    it('A1: does not AND the agency scope onto targets that carry no agency field', () => {
        // Confirmed: event-log-service and ConfigStore have no agency attribute
        // at all. AND-ing the agency scope across the whole branch excluded them
        // entirely, so the query looked right and returned a subset.
        const { query, warnings } = v2.build(
            input({ applications: [], additionalServices: ['Forte'] })
        );

        const eventLogBranch = query.slice(query.indexOf('name:event-log-service'));
        expect(eventLogBranch).not.toContain('@agencycode');
        expect(warnings.some((w) => w.includes('event-log-service logs carry no agency field'))).toBe(true);
    });

    it('A1: scopes a services-only search (no application selected)', () => {
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['ACDS'] })
        );

        expect(query).toContain('@agencycode:AGCY');
        expect(query).not.toBe('(service:acds OR service:edms-handler)');
    });

    it('A1: includes @SERV_PROV_CODE in both casings on the service branch', () => {
        // Confirmed against a working payment-adapter-service query: these logs
        // do carry @SERV_PROV_CODE, and facet values are case sensitive.
        const { query } = v2.build(input({ additionalServices: ['Forte'] }));

        expect(query).toContain('@SERV_PROV_CODE:*agcy*');
        expect(query).toContain('@SERV_PROV_CODE:*AGCY*');
    });

    it('A1: scopes payment services by environment using the platform env tag', () => {
        // The earlier attempt sent the @JNDI token (`prod`, `supp`, `auprod`)
        // and returned nothing. Confirmed live: payment-adapter-service carries
        // env values prod / stg / nonprod / qa / dev, with no region in them.
        expect(v2.build(input({ additionalServices: ['Forte'] })).query).toContain('env:prod');
        expect(
            v2.build(input({ environment: 'STG', additionalServices: ['Forte'] })).query
        ).toContain('env:stg');
        expect(
            v2.build(input({ environment: 'SUPP', additionalServices: ['Forte'] })).query
        ).toContain('env:nonprod');
    });

    it('A1: uses the regionalised non-prod env token where the service has one', () => {
        // event-log-service splits non-prod by region; payment-adapter-service
        // does not, so both tokens are OR'd.
        const { query } = v2.build(
            input({ host: 'AU', environment: 'SUPP', additionalServices: ['Forte'] })
        );
        expect(query).toContain('env:(au-nonprod OR nonprod)');
    });

    it('A1: scopes ACDS by the civp env tag, which is a different taxonomy', () => {
        // ACDS and ADS carry `civp_{jndi}_azure`, not the bare platform token.
        const { query } = v2.build(input({ additionalServices: ['ACDS'] }));
        expect(query).toContain('env:civp_prod_azure');
    });

    it('A1: reproduces the shape of the query confirmed to work', () => {
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['Forte'] })
        );

        // Working reference, now with the environment scope restored:
        //   ((service:payment-adapter-service AND env:prod AND (@agencycode:X OR ...)) OR ...)
        expect(query).toContain(
            '(service:payment-adapter-service AND env:prod AND (@agencycode:AGCY'
        );
    });

    it('A1: warns when a target has no known environment tag', () => {
        // US TEST has no confirmed civp_ token, so ACDS cannot be pinned to it.
        const { warnings } = v2.build(
            input({ environment: 'TEST', applications: [], additionalServices: ['ACDS'] })
        );
        expect(warnings.some((w) => w.includes('No environment tag is known'))).toBe(true);
    });

    // -------------------------------------------------------- A2/A3: CAPI

    it('A3: uses an exact CAPI environment name, not a wildcard', () => {
        const { query } = v2.build(input({ applications: ['CAPI'] }));

        expect(query).toContain('@Properties.log.EnvName:PROD');
        // *PROD* also matched NONPROD1-4, AUPROD and PRODCA.
        expect(query).not.toContain('@Properties.log.EnvName:*PROD*');
    });

    it('A3: a PROD CAPI query cannot match NONPROD by wildcard', () => {
        const prod = v2.build(input({ applications: ['CAPI'] })).query;
        const nonprod = v2.build(
            input({ applications: ['CAPI'], environment: 'NONPROD1' })
        ).query;

        expect(prod).toContain('@Properties.log.EnvName:PROD');
        expect(nonprod).toContain('@Properties.log.EnvName:NONPROD1');
        expect(prod).not.toContain('NONPROD');
    });

    it('A2: pins CAPI to the regions cluster', () => {
        // Confirmed: CAPI region lives in the cluster's env: tag. EnvName cannot
        // do this job -- the AU cluster also emits PROD, SUPP, TEST and NONPROD*.
        const us = v2.build(input({ applications: ['CAPI'] })).query;
        const au = v2.build(input({ host: 'AU', applications: ['CAPI'] })).query;

        expect(us).toContain('env:(construct_prod_central_azure');
        expect(au).toContain('env:construct_auprod_azure');
        expect(us).not.toContain('construct_auprod_azure');
    });

    it('A2: corrects the CAPI environment names that did not exist', () => {
        // US staging is STAGE, not STG. AU production is AUPROD, not PROD.
        expect(v2.build(input({ environment: 'STG', applications: ['CAPI'] })).query).toContain(
            '@Properties.log.EnvName:STAGE'
        );
        expect(
            v2.build(input({ host: 'AU', environment: 'PROD', applications: ['CAPI'] })).query
        ).toContain('@Properties.log.EnvName:AUPROD');
    });

    it('A2: warns where a region has no CAPI cluster of its own', () => {
        const ca = v2.build(input({ host: 'CA', applications: ['CAPI'] }));
        expect(ca.warnings.some((w) => w.includes('No Canadian CAPI cluster'))).toBe(true);

        const or = v2.build(input({ host: 'OREGON', applications: ['CAPI'] }));
        expect(or.warnings.some((w) => w.includes('emitted from the US clusters'))).toBe(true);
    });

    // ------------------------------------------------------- A4: US staging

    it('A4: US STG excludes the other regions staging hosts', () => {
        const { query } = v2.build(input({ environment: 'STG' }));

        expect(query).toContain('host:*stg*');
        expect(query).toContain('-host:*austg*');
        expect(query).toContain('-host:*castg*');
        expect(query).toContain('-host:*orstg*');
    });

    it('A4: legacy US STG really did leak other regions (baseline)', () => {
        const legacyQuery = legacy.build(input({ environment: 'STG' })).query;
        expect(legacyQuery).toContain('host:*stg*');
        expect(legacyQuery).not.toContain('-host:*austg*');
    });

    // ------------------------------------------------------ A5/A6/A7: Oregon

    it('A5: warns instead of silently dropping ACA for OREGON DEV', () => {
        const { query, warnings } = v2.build(
            input({ host: 'OREGON', environment: 'DEV', applications: ['Citizen Access'] })
        );

        expect(warnings.some((w) => w.includes('Citizen Access'))).toBe(true);
        expect(query).not.toContain('service:*aca*');
        // Still returns the biz-tier query rather than nothing.
        expect(query).toContain('@SERV_PROV_CODE:*AGCY*');
    });

    it('A5: warns for OREGON CONFIG too', () => {
        const { warnings } = v2.build(
            input({ host: 'OREGON', environment: 'CONFIG', applications: ['Citizen Access'] })
        );
        expect(warnings.some((w) => w.includes('Citizen Access'))).toBe(true);
    });

    it('A5: does not warn where ACA logs do exist', () => {
        const { warnings } = v2.build(
            input({ host: 'OREGON', environment: 'PROD', applications: ['Citizen Access'] })
        );
        expect(warnings.some((w) => w.includes('Citizen Access'))).toBe(false);
    });

    it('A6: OREGON TRAIN is single-tenant, so the filename stays hardcoded', () => {
        // Reversed on evidence. Parameterising this was wrong: the only ACA
        // debug log in civp_oregon-train_azure is oregon-oregon-train-aca_debug.log.
        // The legacy hardcoded literal was correct.
        const { query } = v2.build(
            input({ host: 'OREGON', environment: 'TRAIN', applications: ['Citizen Access'] })
        );

        expect(query).toContain('filename:*oregon-oregon-train-aca*');
        expect(query).not.toContain('agcy-ortrain');
    });

    it('A6: OREGON TRAIN searches the hosts that actually serve it', () => {
        // Confirmed: oregon-oregon-train-aca_debug.log is emitted only by
        // orsupp-aca-0/1. `host:*ortest*` alone matched one idle ACA node.
        const { query } = v2.build(input({ host: 'OREGON', environment: 'TRAIN' }));
        expect(query).toContain('(host:*orsupp* OR host:*ortest*)');
    });

    it('A7: OREGON STG collects no ACA logs, so it warns instead of filtering', () => {
        // Reversed on evidence. civp_orstg_azure contains av.biz, iis,
        // av.indexer and av.web only, and orstg-ACA-0 emits IIS access logs
        // alone -- there is no ACA debug log to match on.
        const { query, warnings } = v2.build(
            input({ host: 'OREGON', environment: 'STG', applications: ['Citizen Access'] })
        );

        expect(query).not.toContain('filename:');
        expect(warnings.some((w) => w.includes('Citizen Access'))).toBe(true);
    });

    it('A6/A7: OREGON omits @JNDI entirely', () => {
        const { query } = v2.build(input({ host: 'OREGON' }));
        expect(query).not.toContain('@JNDI');
    });

    // ---------------------------------------------- A8/A9: additional params

    it('A8: keeps a single quoted word that legacy silently dropped', () => {
        expect(legacy.formatAdditionalParams('"foo"')).toBe('');
        expect(v2.formatAdditionalParams('"foo"')).toBe('("foo")');
    });

    it('A8: still handles a multi-word quoted phrase', () => {
        expect(v2.formatAdditionalParams('"connection reset"')).toBe('("connection reset")');
    });

    it('A9: joins multiple parameters with AND so terms narrow the search', () => {
        expect(v2.formatAdditionalParams('timeout refused')).toBe('(*timeout* AND *refused*)');
        // Legacy widened instead.
        expect(legacy.formatAdditionalParams('timeout refused')).toBe('*timeout* OR *refused*');
    });

    it('A9: passes an explicit field filter through without wildcarding it', () => {
        expect(v2.formatAdditionalParams('@USER_ID:jsmith')).toBe('(@USER_ID:jsmith)');
        expect(v2.formatAdditionalParams('-status:info')).toBe('(-status:info)');
    });

    it('A9: mixes a quoted phrase with a bare term', () => {
        expect(v2.formatAdditionalParams('"connection reset" timeout')).toBe(
            '("connection reset" AND *timeout*)'
        );
    });

    it('A9: appends parameters with AND to the main query', () => {
        const { query } = v2.build(input({ additionalParams: 'NullPointerException' }));
        expect(query).toContain('AND (*NullPointerException*)');
    });

    it('A9: returns empty for whitespace-only parameters', () => {
        expect(v2.formatAdditionalParams('   ')).toBe('');
    });

    // -------------------------------------------------------- A10: agencycode

    it('A10: matches ACA lines via @agencycode as well as free text', () => {
        const { query } = v2.build(input({ applications: ['Citizen Access'] }));

        expect(query).toContain('@agencycode:AGCY');
        expect(query).toContain('filename:*agcy-prod*');
        // ACA needs the biz tier as well.
        expect(query).toContain('@SERV_PROV_CODE:*AGCY*');
    });

    // ------------------------------------------------- A12: grouped OR values

    it('A12: groups multiple values of one field', () => {
        const { query } = v2.build(input({ additionalServices: ['ACDS'] }));

        expect(query).toContain('service:(acds OR edms-handler)');
        expect(query).not.toContain('service:acds OR service:edms-handler');
    });

    it('A12: emits a single value unbracketed', () => {
        const { query } = v2.build(input({ additionalServices: ['Forte'] }));
        expect(query).toContain('name:event-log-service');
        expect(query).not.toContain('name:(event-log-service)');
    });

    it('A12: does not repeat a target shared by several services', () => {
        // event-log-service is listed under Forte, PayPal and SecurePay.
        const { query } = v2.build(input({ additionalServices: ['Forte', 'ACDS'] }));
        expect(query.match(/name:event-log-service/g)?.length).toBe(1);
    });

    // ---------------------------------------------------------- A13: SecurePay

    it('A13: supports SecurePay, which the tool could not search at all', () => {
        const { query, warnings } = v2.build(input({ additionalServices: ['SecurePay'] }));

        expect(query).toContain('app-pci-payment-adapter');
        expect(query).toContain('@agencycode:AGCY');
        // The PCI cluster caveat must surface to the user.
        expect(warnings.some((w) => w.includes('PCI'))).toBe(true);
    });

    it('A13: legacy had no SecurePay option', () => {
        const { query } = legacy.build(input({ additionalServices: ['SecurePay'] }));
        expect(query).not.toContain('app-pci-payment-adapter');
    });

    // -------------------------------------------------------------- selection

    it('rejects two payment services with a clear message', () => {
        const { errors, query } = v2.build(
            input({ additionalServices: ['Forte', 'Paypal Commerce'] })
        );

        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('payment');
        expect(query).toBe('');
    });

    it('rejects two document services', () => {
        const { errors } = v2.build(input({ additionalServices: ['ACDS', 'ADS'] }));
        expect(errors[0]).toContain('document');
    });

    it('allows one payment plus one document service together', () => {
        const { query, errors } = v2.build(
            input({ additionalServices: ['Forte', 'ACDS'] })
        );

        expect(errors).toEqual([]);
        expect(query).toContain('payment-adapter-service');
        expect(query).toContain('acds');
    });

    it('errors when nothing at all is selected', () => {
        const { errors } = v2.build(input({ applications: [], additionalServices: [] }));
        expect(errors.length).toBeGreaterThan(0);
    });

    it('errors on an environment that does not belong to the host', () => {
        // CVCN is US-only.
        const { errors } = v2.build(input({ host: 'CA', environment: 'CVCN' }));
        expect(errors[0]).toContain('not a valid environment');
    });

    // ------------------------------------------------- host/environment matrix

    it('maps AU and CA environment tokens onto their own hosts', () => {
        const au = v2.build(input({ host: 'AU', environment: 'PROD' })).query;
        expect(au).toContain('@JNDI:*agcy-auprod*');
        expect(au).toContain('@JNDI:*AGCY-AUPROD*');
        expect(au).toContain('host:*auprd*');

        const ca = v2.build(input({ host: 'CA', environment: 'PROD' })).query;
        expect(ca).toContain('@JNDI:*agcy-prodca*');
        expect(ca).toContain('host:*caprd*');
    });

    it('produces a distinct query for every host at PROD', () => {
        const queries = ['US', 'AU', 'CA', 'OREGON'].map(
            (host) => v2.build(input({ host, environment: 'PROD' })).query
        );
        expect(new Set(queries).size).toBe(4);
    });
});
