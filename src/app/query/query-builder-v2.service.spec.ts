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

    it('scopes the biz tier to the chosen category', () => {
        // The largest single reduction the engine makes. Measured on the busiest
        // Forte agency in US PROD over 24h: 2,138,287 lines and 218,581 errors
        // unscoped, against 74,696 and 74 with the payment markers -- and only
        // those 74 errors concerned payments at all.
        const { query, warnings } = v2.build(
            input({ scope: { category: 'payment', option: 'forte' } })
        );

        expect(query).toContain('*transaction-id*');
        expect(query).toContain('*invoice*');
        expect(warnings.some((w) => w.includes('limited to payment-related lines'))).toBe(true);
    });

    it('leaves the biz tier alone when no category is chosen', () => {
        // The fast path must not change. No scope means no marker clause.
        const { query } = v2.build(input({}));
        expect(query).not.toContain('*transaction-id*');
        expect(query).not.toContain('*invoice*');
    });

    it('uses different markers per category, and excludes the too-broad one', () => {
        const docs = v2.build(input({ scope: { category: 'documents' } })).query;
        expect(docs).toContain('*DocumentService*');
        expect(docs).not.toContain('*transaction-id*');

        const capi = v2.build(input({ scope: { category: 'construct' } })).query;
        expect(capi).toContain('*apis/v4*');
        // `*capi*` measured 262,391 lines -- too broad, it would undo the scoping.
        expect(capi).not.toContain('*capi*');
    });

    it('hides chronic warnings by default but says so', () => {
        // These are real warnings, so hiding them is announced. The slow-report
        // one alone was ~60,000 lines in 24h, 99.6% of everything left after
        // scoping.
        const on = v2.build(input({}));
        expect(on.query).toContain('-"report takes more than"');
        expect(on.warnings.some((w) => w.includes('constant in this environment'))).toBe(true);

        const off = v2.build(input({ showChronic: true }));
        expect(off.query).not.toContain('report takes more than');
    });

    it('never wildcard-wraps a multi-word exclusion', () => {
        /*
         * Guard on a trap that empties the query rather than failing loudly.
         * The rules for positive matching and negation are opposite:
         *
         *   -"report takes more than"   -> 14,048 rows   correct
         *   -*report takes more than*   ->      0 rows   matches everything
         *
         * Single-token wildcards in a negation are fine; multi-word ones are not.
         */
        const { query } = v2.build(input({ scope: { category: 'payment' } }));
        for (const m of query.matchAll(/-\*([^*]+)\*/g)) {
            expect(m[1], `negated wildcard "${m[1]}" contains a space`).not.toContain(' ');
        }
    });

    it('hides routine chatter by default, and can be turned off', () => {
        // Default on, because the useful default is the readable one. Measured on
        // a real Forte search: 1,817 lines to 574, retaining all 81 errors and
        // all 116 warnings.
        const on = v2.build(input({})).query;
        expect(on).toContain('-"BatchJobLog"');
        expect(on).toContain('-"Request URL:https"');

        const off = v2.build(input({ hideRoutineChatter: false })).query;
        expect(off).not.toContain('BatchJobLog');
    });

    it('never excludes a phrase that could match a real failure', () => {
        // Datadog ignores punctuation in a quoted phrase, so `"Request URL:"`
        // also matches `The Request URL /v4/settings got status 404` -- a real
        // API failure, 22 of them in the measured window. The scheme-anchored
        // form cannot, and counter-intuitively matches MORE noise: 178 lines
        // against 23. Guard the specific form so it is not "simplified" back.
        const { query } = v2.build(input({}));
        expect(query).toContain('-"Request URL:https"');
        expect(query).not.toContain('-"Request URL:"');
    });

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

    it('A1: does not AND the attribute agency scope onto targets that lack the facets', () => {
        // ConfigStore has no agency facet, so the six-field attribute scope would
        // exclude it entirely. It is matched by free text instead.
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['Forte'] })
        );

        const configStoreBranch = query.slice(query.indexOf('service:configstore-service'));
        expect(configStoreBranch.slice(0, 80)).not.toContain('@agencycode');
    });

    it('A1: scopes event-log-service by tenantId rather than returning the environment', () => {
        // Reversed on evidence. The old comment claimed "no agency attribute of
        // any kind", which was true of the facets and false of the data: half
        // these lines are Camel exchange bodies carrying
        // `tenantId: urn:tenant-id:{agency}-{jndi}`. Left unscoped, an AU PROD,
        // CA PROD or Oregon search returned ~8.3M US-production lines over 30d,
        // none of them the selected agency's.
        const { query } = v2.build(
            input({ applications: [], additionalServices: ['Forte'] })
        );

        expect(query).toContain('name:event-log-service AND env:prod AND "urn:tenant-id:agcy-prod"');
        // Not the bare wildcard -- it matches script names, not just tenants.
        const branch = query.slice(query.indexOf('name:event-log-service'));
        expect(branch).not.toContain('*AGCY*');
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

    it('A1: fills the civp env for the shared non-prod clusters', () => {
        // The civp env tag is CLUSTER level, not environment level: US TEST and
        // NONPROD1-4 all live under civp_supp_azure, established by bridging
        // through @JNDI, which IS per-environment. Previously left undefined, so
        // an ACDS or ADS search there was emitted with no env clause at all --
        // 14 of 29 rows returned the whole estate.
        for (const environment of ['TEST', 'NONPROD1', 'NONPROD4']) {
            const { query } = v2.build(
                input({ environment, applications: [], additionalServices: ['ACDS'] })
            );
            expect(query, environment).toContain('env:civp_supp_azure');
        }
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
        // US staging is STAGE, not STG.
        expect(v2.build(input({ environment: 'STG', applications: ['CAPI'] })).query).toContain(
            '@Properties.log.EnvName:STAGE'
        );
    });

    it('A2: AU production accepts PROD as well as AUPROD', () => {
        // Reversed on evidence, and this reverses my own A21 conclusion. On the
        // AU cluster, EnvName:AUPROD is ONE tenant (62,346 lines over 30d) while
        // EnvName:PROD is seven tenants including the largest, at 146,670. So
        // AUPROD is a tenant's self-declared label, not the platform value, and
        // an AU PROD search returned zero for the biggest AU tenant.
        //
        // Safe because env:construct_auprod_azure does the region separation.
        const au = v2.build(input({ host: 'AU', environment: 'PROD', applications: ['CAPI'] })).query;
        expect(au).toContain('@Properties.log.EnvName:(PROD OR AUPROD)');
        expect(au).toContain('env:construct_auprod_azure');
    });

    it('A2: CA CAPI is pinned to the US clusters, not left unscoped', () => {
        // Reversed on evidence. The old note said a CA CAPI search was unlikely
        // to return anything; Canadian tenants are 1,685,242 CAPI lines over 30d,
        // all in construct_prod_central_azure. The empty region clause also let a
        // CA search span the AU cluster.
        const ca = v2.build(input({ host: 'CA', applications: ['CAPI'] }));
        expect(ca.query).toContain('env:(construct_prod_central_azure');
        expect(ca.query).not.toContain('construct_auprod_azure');
        expect(ca.warnings.some((w) => w.includes('shared US-region Construct clusters'))).toBe(true);
    });

    it('A2: Oregon CAPI still warns that it cannot be separated from US', () => {
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

    it('A5: OREGON CONFIG does collect ACA logs and must not warn', () => {
        // Reversed on evidence, and this was the worst failure mode in the
        // branch: the user was affirmatively told the data did not exist, so
        // they stop looking. 21,478 events over 30d including real ACA stack
        // traces. CONFIG also breaks the `or{env}` naming pattern -- the files
        // are `{agency}-oregon-config-aca`, not `{agency}-orconf-aca`.
        const { query, warnings } = v2.build(
            input({ host: 'OREGON', environment: 'CONFIG', applications: ['Citizen Access'] })
        );

        expect(query).toContain('filename:agcy-oregon-config-aca*');
        expect(warnings.some((w) => w.includes('Citizen Access'))).toBe(false);
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

        // Anchored, not wrapped in wildcards -- see the A16 reversal.
        expect(query).toContain('filename:oregon-oregon-train-aca*');
        expect(query).not.toContain('agcy-ortrain');
    });

    it('A16: the ACA filename is anchored, because the leading wildcard leaked tenants', () => {
        // Reverses A16 for `filename` specifically. Every ACA log filename starts
        // with the agency code, so the leading wildcard bought no recall:
        // `filename:seattle-nonprod1*` and `*seattle-nonprod1*` return an
        // identical 517,149 lines. It did leak neighbours -- `*seattle-supp*`
        // returned 7,811 lines that were all `portseattle-supp`, and
        // `*port-prod*` matched northport, westport and sfport.
        //
        // A16 still holds for @JNDI, where the code genuinely sits mid-token.
        const { query } = v2.build(input({ applications: ['Citizen Access'] }));

        expect(query).toContain('filename:agcy-prod*');
        expect(query).not.toContain('filename:*agcy-prod*');
        expect(query).toContain('@JNDI:*agcy-prod*');
    });

    it('A6: OREGON TRAIN searches the hosts that actually serve it', () => {
        // Confirmed: oregon-oregon-train-aca_debug.log is emitted only by
        // orsupp-aca-0/1. `host:*ortest*` alone matched one idle ACA node.
        const { query } = v2.build(input({ host: 'OREGON', environment: 'TRAIN' }));
        expect(query).toContain('(host:*orsupp* OR host:*ortest*)');
    });

    it('A7: OREGON STG has no ACA debug log, and the warning now says why', () => {
        // The reversal holds -- there is no ACA debug or error log to match on --
        // but the old warning text overstated it. 441,371 IIS access-log events
        // DO exist on orstg-ACA-0; they are just tagged service:iis rather than
        // service:aca, so they are unreachable from this branch.
        const { query, warnings } = v2.build(
            input({ host: 'OREGON', environment: 'STG', applications: ['Citizen Access'] })
        );

        expect(query).not.toContain('filename:agcy');
        expect(warnings.some((w) => w.includes('access logs only'))).toBe(true);
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

    it('A10: the @agencycode and free-text ACA arms are pinned to the environment', () => {
        // Both arms are environment-agnostic on their own, and six US rows share
        // host:*mtsup*, so OR-ing them in unconstrained defeated the environment
        // selection: a US NONPROD1 search returned 7.5x the intended population,
        // and switching NONPROD1 to NONPROD3 changed the total by under 1%.
        //
        // A10's original rationale was also wrong and is corrected in the audit:
        // @agencycode does NOT reach agency-less lines. It is coextensive with
        // the filename clause (5 events outside it, out of 281M) and returns 0%
        // in all four Oregon environments. The free-text arm is what reaches the
        // agency-less population -- 62.4% of ACA volume, all IIS access logs.
        const { query } = v2.build(
            input({ environment: 'NONPROD1', applications: ['Citizen Access'] })
        );

        expect(query).toContain('service:aca AND @agencycode:AGCY AND filename:*-nonprod1*');
        expect(query).toContain('service:aca AND *AGCY* AND filename:*-nonprod1*');
        // ACA needs the biz tier as well.
        expect(query).toContain('@SERV_PROV_CODE:*AGCY*');
    });

    it('A10: service:aca is exact, not a wildcard', () => {
        // `service:*aca*` also matched `acaol` (Public Portal / dotCMS, 4.9M
        // lines) and `aca-stage-check` (Airflow). Neither reached results, but
        // only because the host clause happened to exclude them.
        const { query } = v2.build(input({ applications: ['Citizen Access'] }));
        expect(query).not.toContain('service:*aca*');
        expect(query).toContain('service:aca AND');
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
