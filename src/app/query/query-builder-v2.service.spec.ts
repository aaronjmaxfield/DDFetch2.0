import { TestBed } from '@angular/core/testing';
import { QueryBuilderV2Service } from './query-builder-v2.service';
import { LegacyQueryBuilderService } from './legacy-query-builder.service';
import { QueryInput } from './query-input.model';
import { SCOPES } from './scopes.config';
import { ROUTINE_CHATTER } from './noise.config';

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

        const records = v2.build(input({ scope: { category: 'records' } })).query;
        expect(records).toContain('*B1PERMIT*');
        expect(records).not.toContain('*DocumentService*');
    });

    it('hides chronic warnings under a scope but says so', () => {
        // These are real warnings, so hiding them is announced. The slow-report
        // one alone was ~60,000 lines in 24h, 99.6% of everything left after
        // scoping. Scope-gated as of 2026-08-28: an unscoped search filters
        // nothing, so this needs a category to exercise.
        const on = v2.build(input({ scope: { category: 'payment' } }));
        expect(on.query).toContain('-"report takes more than"');
        expect(on.warnings.some((w) => w.includes('constant in this environment'))).toBe(true);

        const off = v2.build(input({ scope: { category: 'payment' }, showChronic: true }));
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

    it('hides routine chatter under a scope, and can be turned off', () => {
        // Default on, because the useful default is the readable one. Measured on
        // a real Forte search: 1,817 lines to 574, retaining all 81 errors and
        // all 116 warnings.
        // Gating changed 2026-08-28: filtering by default meant a user
        // narrowing down afterwards could miss a line already removed -- on
        // LEECO PROD over 24h, 3,948 of 390,750 CAP-ID-bearing lines match
        // "Request URL:https" alone.
        // Asserted on a pattern that is still in the ROUTINE tier. BatchJobLog
        // moved to chronic, so it survives hideRoutineChatter:false and would
        // make this test pass for the wrong reason.
        const on = v2.build(input({ scope: { category: 'payment' } })).query;
        expect(on).toContain('-"Request URL:https"');
        expect(on).toContain('-"Response Headers:"');

        const off = v2.build(
            input({ scope: { category: 'payment' }, hideRoutineChatter: false })
        ).query;
        expect(off).not.toContain('Request URL:https');
    });

    it('never excludes a phrase that could match a real failure', () => {
        // Datadog ignores punctuation in a quoted phrase, so `"Request URL:"`
        // also matches `The Request URL /v4/settings got status 404` -- a real
        // API failure, 22 of them in the measured window. The scheme-anchored
        // form cannot, and counter-intuitively matches MORE noise: 178 lines
        // against 23. Guard the specific form so it is not "simplified" back.
        const { query } = v2.build(input({ scope: { category: 'payment' } }));
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
    // ------------------------------------------- signal-loss regression suite
    //
    // Each case below corresponds to a fingerprint that a real closed
    // investigation turned on, and that the engine was measured to be dropping
    // on 2026-08-28. They exist so that a future noise or scoping change cannot
    // quietly remove the evidence again. The measured loss is named in each
    // test; if you change a marker list, these are the tests that should fail
    // first.

    describe("recovered fingerprints", () => {
        function paymentQuery() {
            return v2.build(input({ scope: { category: "payment", option: "forte" } })).query;
        }

        it("can see the production webhook error, which carries no payment token", () => {
            // "AccelaAdapter webhook not recieved for transactionId :{guid}" is
            // the most common "I paid and got no receipt" error in production.
            // Measured over 7 days, the pre-fix marker set returned 0 of
            // HOLLYWOOD 53, LEECO 262 and SANTAANA 5.
            expect(paymentQuery()).toContain("*AccelaAdapter*");
        });

        it("can see CONV_FEE, which convFee provably cannot match", () => {
            // Measured intersection of *convFee* and *CONV_FEE* is exactly 0:
            // underscore is not a Datadog token separator. 2,662 lines existed
            // estate-wide in 24h and 8 were visible. Not a casing issue --
            // *CONVFEE* matches the convFee set, *conv_fee* the CONV_FEE set.
            const query = paymentQuery();
            expect(query).toContain("*CONV_FEE*");
            expect(query).toContain("*convFee*");
        });

        it("can see the postback-data fingerprint", () => {
            // The absence of "log postback data begin" is the fingerprint of
            // the platform-wide ACA postback 400/302 case. 2,890 lines existed
            // in 24h estate-wide; 97 were visible to the old markers.
            expect(paymentQuery()).toContain("*log postback data begin*");
        });

        it("keeps the sequence-allocation lines when investigating a payment", () => {
            // lSeqRemaining passes the routine-chatter admission test -- zero
            // errors, zero warns -- and still destroys evidence, because the
            // sequence lines are INFO. Excluding it takes *ETRANSACTION_SEQ2*
            // from 21,095 to 2. It is the proof-of-initiation fingerprint in
            // five closed cases.
            expect(paymentQuery()).not.toContain("-\"lSeqRemaining\"");
        });

        it("also carries the marker the sequence lines need", () => {
            // Dropping the chatter pattern was NOT sufficient: those lines are
            // gated twice, and no original marker contains "etransaction".
            // Measured on LEECO PROD over 24h, *ETRANSACTION_SEQ2* went 0 -> 38
            // only once this marker was added, at a cost of 89 lines and zero
            // new errors.
            expect(paymentQuery()).toContain("*ETRANSACTION*");
        });

        it("still excludes lSeqRemaining under a scope that does not need it", () => {
            // 1.9M lines a day, so the exception is per-category rather than
            // global. Payment and Documents both except it -- payment for the
            // ETRANSACTION/F4PAYMENT sequences, documents for BDOCUMENT_SEQ --
            // so this checks a scope that genuinely does not need it.
            const query = v2.build(input({ scope: { category: "reporting" } })).query;
            expect(query).toContain("-\"lSeqRemaining\"");
        });

        it("no longer hides EDMS Config silently, because it contains real errors", () => {
            // 60,471,081 info lines over 7 days AND 373 status:error. It broke
            // the routine tier rule, so it moved to the announced tier.
            const { query, warnings } = v2.build(input({ scope: { category: "payment" } }));
            expect(query).toContain("-\"EDMS Config=\"");
            expect(warnings.some((w) => w.includes("EDMS configuration dumps"))).toBe(true);
        });

        it("includes EDMS Config when chronic patterns are turned on", () => {
            const query = v2.build(
                input({ scope: { category: "payment" }, showChronic: true })
            ).query;
            expect(query).not.toContain("EDMS Config=");
        });

        it("can reach the IIS access logs, which no filename gate can match", () => {
            // 475,261,009 lines over 7 days and unreachable from every UI
            // selection: they are written to u_ex{date}_x.log and carry no
            // @agencycode, so every filename-gated ACA arm returns 0 by
            // construction. Measured: filename:u_ex* AND filename:*-prod* = 0.
            const { query } = v2.build(
                input({ applications: ["Civic Platform", "Citizen Access"], includeIis: true })
            );
            expect(query).toContain("filename:u_ex*");
            // Scoped by URL path, because the host does not separate
            // environments here: 6,758 of LEECO's PROD-path lines are served
            // from mtsup hosts.
            expect(query).toContain("*/AGCY/*");
        });

        it("appends the environment to the URL segment outside production", () => {
            // PROD is bare (*/LEECO/* 9,355,177 vs */LEECO-PROD/* 387); every
            // other environment carries it (*/BALTCO-NONPROD1/* 2,395).
            const { query } = v2.build(
                input({
                    environment: "NONPROD1",
                    applications: ["Civic Platform", "Citizen Access"],
                    includeIis: true,
                })
            );
            expect(query).toContain("*/AGCY-NONPROD1/*");
        });

        it("warns that page requests are logged as info even when the page failed", () => {
            // Measured: adding them took LEECO from 37,226 lines to 53,960 with
            // the error count unchanged at 136. Datadog classes every IIS line
            // as info regardless of the HTTP status it records, so filtering by
            // error status hides a 500 outright.
            const { warnings } = v2.build(
                input({ applications: ["Civic Platform", "Citizen Access"], includeIis: true })
            );
            expect(warnings.some((w) => w.includes('logged as "info"'))).toBe(true);
        });

        it("leaves the IIS logs out unless asked", () => {
            // Opt-in on purpose: one agency is 1,891,225 of these in 24 hours.
            const { query } = v2.build(
                input({ applications: ["Civic Platform", "Citizen Access"] })
            );
            expect(query).not.toContain("filename:u_ex*");
        });

        // -------------------------------------------------- Construct family

        function capiQuery(overrides = {}) {
            return v2.build(input({ applications: ["CAPI"], ...overrides })).query;
        }

        it("searches the whole Construct family, not just capi", () => {
            // Seven services, not one. coauth is 29,425,993 lines over 7 days
            // and 766,127 errors -- 46% of all Construct error volume, and
            // exactly the frontline tickets: locked accounts, expired tokens,
            // bad credentials. It was entirely unsearchable.
            const query = capiQuery();
            expect(query).toContain("coauth");
            expect(query).toContain("cdocapi");
            // Staging-only and 100% status:debug.
            expect(query).not.toContain("gateway");
        });

        it("keeps Construct lines whose environment and agency are absent", () => {
            // The single largest correction. CAPI logs errors from the response
            // path with Agency, AppId and EnvName all null, so hard ANDs
            // discarded them. Of 858,957 capi error lines over 7 days, 4,857
            // carry EnvName (0.57%) and 33,315 carry Agency (3.88%).
            //
            // Errors/warns over 7d, old clause -> new: ARLINGTONCO 0/0 ->
            // 121,551/76,527; LEECO 0/0 -> 660/155,442; FDNY 498/9 ->
            // 24,750/6,704. Two of four reported no errors at all.
            const query = capiQuery();
            expect(query).toContain("-@Properties.log.EnvName:*");
            expect(query).toContain("-@Properties.log.Agency:*");
        });

        it("front-anchors the Construct agency and keeps the AZ sibling", () => {
            // *DC* matched seven tenants over 7 days -- DC, AZDC, OAKLANDCO,
            // AZMERCEDCO, LADCR, LOVELANDCO, MERCEDCO. Anchoring keeps DC and
            // AZDC and drops the rest. Lossless for the real sibling shapes,
            // which are suffixes: {AGENCY}-TEST and {AGENCY}_MOBILE still match.
            const query = capiQuery();
            expect(query).toContain("@Properties.log.Agency:(AGCY* OR AZAGCY*)");
            expect(query).not.toContain("@Properties.log.Agency:*AGCY*");
        });

        it("says out loud that unattributed Construct lines span environments", () => {
            const { warnings } = v2.build(input({ applications: ["CAPI"] }));
            expect(warnings.some((w) => w.includes("no agency and no environment"))).toBe(true);
        });

        it("adds field-level markers and exceptions only while the field has a value", () => {
            /*
             * The mechanism this covers was built for the Construct trace ID,
             * whose biz-tier join was broken by two independent gates: of
             * 21,850,112 biz lines carrying "TraceId is", 40 survived the
             * Construct markers and 0 survived the response-size chatter
             * pattern.
             *
             * That category has since been removed, so the join is DORMANT --
             * nothing currently emits `"TraceId is"`. The mechanism itself is
             * still load-bearing for EMSE (bizMarkers) and GIS
             * (chatterExceptions), which is what this now guards.
             */
            const emseBare = v2.build(input({ scope: { category: "emse", fields: {} } })).query;
            const emseWithTrace = v2.build(
                input({ scope: { category: "emse", fields: { emseTraceId: "W-2026" } } })
            ).query;
            expect(emseBare).not.toContain('"THROW"');
            expect(emseWithTrace).toContain('"THROW"');

            const gisBare = v2.build(input({ scope: { category: "gis", fields: {} } })).query;
            const gisWithParcel = v2.build(
                input({ scope: { category: "gis", fields: { parcelNumber: "04704452" } } })
            ).query;
            expect(gisBare).toContain('-"Request path is:"');
            expect(gisWithParcel).not.toContain('-"Request path is:"');
        });

        // ---------------------------------------------- the seven categories
        //
        // RESTORED 2026-09-02. These eleven tests were silently deleted by a
        // slice-based patch script that replaced everything between two
        // anchors, and the loss went unnoticed because the suite still passed --
        // the count simply fell from 167 to 147. Hence the guard at the end of
        // this block, and hence the rule in HANDOFF.md that a green suite does
        // not prove a patch did what you meant.

        function scoped(category: string, fields: Record<string, string> = {}) {
            return v2.build(input({ scope: { category, fields } }));
        }

        it("offers the scope categories in alphabetical order", () => {
            // Sorted at the source so the array and the dropdown cannot drift.
            // Construct is deliberately absent: its lines live in service:capi,
            // reached by the Construct API checkbox, and a category's bizMarkers
            // only narrow the BIZ tier -- so it did nothing while implying it did.
            expect(SCOPES.map((c) => c.label)).toEqual([
                "Batch jobs",
                "Documents",
                "EMSE scripts",
                "GIS / Parcels",
                "Payment",
                "Records",
                "Reports",
            ]);
            expect(SCOPES.map((c) => c.id)).not.toContain("construct");
        });

        it("GIS excludes the APO marker that would make it 96% wrong", () => {
            // *APO* adds 196,579 errors of which 169,097 are IJ000453 ... FROM
            // RSERV_PROV, a generic agency-registry query caught through one
            // incidental column name.
            const { query } = scoped("gis");
            expect(query).toContain("*parcel*");
            expect(query).not.toContain("*APO*");
        });

        it("GIS recovers the record-to-parcel line the chatter tier removes", () => {
            // Parcel 04704452 has 6 lines; 0 survive the scope without this, 4 with.
            expect(scoped("gis", { parcelNumber: "04704452" }).query).not.toContain(
                '-"Request path is:"'
            );
        });

        it("EMSE keeps THROW off the category markers", () => {
            // Platform-wide, not EMSE: outside EMSE it is 729,425 lines and
            // 724,702 errors. As a category marker it injected 183,605 unrelated
            // errors against one agency's 2,726 real ones.
            expect(scoped("emse").query).not.toContain('"THROW"');
            expect(scoped("emse", { emseTraceId: "W-20260101120000000" }).query).toContain(
                '"THROW"'
            );
        });

        it("EMSE and Batch force the emse.log arm on", () => {
            // +1.0% to +40.0% lines and exactly zero errors on four agencies,
            // because emse.log is 100% status:info even though 1,905,251 of its
            // lines carry an aa_exception block.
            expect(scoped("emse").query).toContain("filename:emse.log");
            expect(scoped("batch").query).toContain("filename:emse.log");
            expect(scoped("payment").query).not.toContain("filename:emse.log");
        });

        it("Records keeps the null-CAP-type family off the category markers", () => {
            // As a category marker *getCapTypeByPK* drags in 164,754 lines a day
            // of getCapTypeByPK(:null/null/null/null). On the recordType field it
            // drops to 20 while still answering the question asked.
            expect(scoped("records").query).not.toContain("*getCapTypeByPK*");
            expect(scoped("records", { recordType: "ABC_GENERAL" }).query).toContain(
                "*getCapTypeByPK*"
            );
        });

        it("Batch searches the underscore twin, which holds most of the errors", () => {
            // *BATCH_JOB* AND NOT *batchjob* is 467,843 lines with 439,277
            // errors -- more errors than *batchjob* finds in total. Error-level
            // intersection is exactly 0 on all six agencies tested.
            const { query } = scoped("batch");
            expect(query).toContain("*batchjob*");
            expect(query).toContain("*BATCH_JOB*");
        });

        it("Batch un-hides BatchJobLog, and says it kept it", () => {
            // Hidden: CGS 28 errors instead of 879, and the warn count is zero
            // on six of six agencies -- and the warns carry the job dump.
            const { query, warnings } = scoped("batch");
            expect(query).not.toContain('-"BatchJobLog"');
            expect(
                warnings.some((w) => w.includes("Kept because this scope is about them"))
            ).toBe(true);
        });

        it("Reporting un-hides the slow-report warning it exists to find", () => {
            // Before this the tool returned 1 warning for one agency, 1 for
            // another and zero for three more. Three real tickets: 0 rows -> 331,
            // 0 -> 857, 128 -> 12,985.
            const { query } = scoped("reporting");
            expect(query).not.toContain('-"report takes more than"');
            // But NOT the record-search pattern the brief wrongly assumed was
            // reporting: 35,636 lines, zero carrying any reporting marker.
            expect(query).toContain('-"It is risky to retrieve too many records"');
        });

        it("Reporting scopes on message shapes, not engine names", () => {
            // The engine names contribute 0 unique biz-tier lines, and one agency
            // is 100% Crystal while another is 100% SSRS -- so an engine-name
            // marker set discards one of them entirely.
            const { query } = scoped("reporting");
            expect(query).toContain('"report takes more than"');
            expect(query).not.toContain("*ReportServer*");
            expect(query).not.toContain("*CReport*");
        });

        it("does not name a kept chronic pattern as hidden", () => {
            // chronicSummary must take the same exceptions as chronicExclusion,
            // or the warning sends the user hunting for a toggle to recover data
            // already on screen.
            const hidden = scoped("reporting").warnings.find((w) =>
                w.includes("constant in this environment")
            );
            expect(hidden).toBeDefined();
            expect(hidden).not.toContain("Slow-report warnings");
        });

        // ------------------------------------- the CRC-TEST upload, 2026-09-02

        it("keeps the two lines that explain where a document went", () => {
            /*
             * From a real investigation. An upload could not be found: the ADS
             * file key returns zero anywhere (the full key and its tail both),
             * and ADS had no lines under that environment's own agency code.
             *
             * Four lines were the evidence and this scope dropped two. The
             * `{AGENCY}-{ENV}_BDOCUMENT_SEQ lSeqRemaining` line -- the row
             * actually being written -- was in routine chatter, and `EDMS
             * Config=`, which showed the environment files its documents under a
             * DIFFERENT agency code on a different server, was in the chronic
             * tier. Without the second one the search returns zero and reads as
             * "nothing happened".
             */
            const { query } = scoped("documents");
            expect(query).not.toContain('-"lSeqRemaining"');
            expect(query).not.toContain('-"EDMS Config="');
            // Still excluded for a scope that does not need them.
            expect(scoped("payment").query).toContain('-"EDMS Config="');
        });

        it("offers document name, and prefers the wildcard form", () => {
            // 6.7M lines a day carry a document or file name, across biz, ACA,
            // indexer and ACDS. Wildcard beats quoted on recall -- 378 against
            // 336 on a multi-word name, 6 against 2 with an extension -- which is
            // the opposite of the usual advice, so it is measured not assumed.
            const { query } = scoped("documents", { documentName: "MyDocument.pdf" });
            expect(query).toContain("*MyDocument.pdf*");
            expect(query).not.toContain('"MyDocument.pdf"');
        });

        it("warns when a document name is too short to be distinctive", () => {
            // A bare four-character name matched 2,830 lines in a day against 6
            // for the same name with its extension.
            const { warnings } = scoped("documents", { documentName: "Doc1" });
            expect(warnings.some((w) => w.includes("match unrelated documents"))).toBe(true);
        });

        /*
         * THE TIER RULE, enforced structurally. Also restored 2026-09-02.
         *
         * Scope-field clauses and option extraClauses are AND-ed onto the WHOLE
         * query, across every tier, so a clause that positively requires
         * something only one tier carries deletes all the others silently.
         *
         * This has happened twice for real: the custom-adapter clause began
         * `service:aca` and deleted the biz tier on every agency, and the
         * Construct endpoint field required @Properties.log.MethodName, taking
         * one agency's 2,280,288 in-scope biz lines to zero.
         *
         * LIMIT: this catches STRUCTURAL tier-exclusivity only. Free text that
         * happens to live in one tier passes and can still delete the others --
         * the ADS `*FileKey=...*` clause passes here and is safe only because
         * FileKey was measured present across eight services.
         */
        it("has no globally-ANDed clause that can delete a whole tier", () => {
            const ctx = {
                agencyUpper: "AGCY",
                agencyLower: "agcy",
                env: { ui: "PROD", jndi: "prod" } as never,
            };

            const offenders: string[] = [];
            const check = (label: string, clause: string) => {
                const requiresService = /(^|\s|\()service:/.test(clause);
                const requiresFacet = /(^|\s|\()@[A-Za-z_.]+:/.test(clause);
                if (!requiresService && !requiresFacet) return;
                const hasNegatedArm = /OR\s+-(@[A-Za-z_.]+|service):/.test(clause);
                // A bare free-text term is satisfiable in any tier. The
                // lookbehind distinguishes `OR *VALUE*` from `@FACET:*VALUE*`.
                const hasFreeTextArm = /(?<![:\w])\*[^*\s()]+\*/.test(clause);
                if (!hasNegatedArm && !hasFreeTextArm) offenders.push(`${label}: ${clause}`);
            };

            for (const category of SCOPES) {
                for (const option of category.options) {
                    if (option.extraClause) {
                        // Check the form the BUILDER emits -- it wraps every
                        // extraClause with an escape for the other tiers.
                        check(
                            `${category.id}/${option.id} extraClause`,
                            `((${option.extraClause}) OR -service:aca)`
                        );
                    }
                }
                const allFields = [
                    ...(category.fields ?? []).map((f) => [category.id, f] as const),
                    ...category.options.flatMap((o) =>
                        (o.fields ?? []).map((f) => [`${category.id}/${o.id}`, f] as const)
                    ),
                ];
                for (const [scope, field] of allFields) {
                    check(`${scope}/${field.id}`, field.clause("VALUE", ctx));
                }
            }

            expect(
                offenders,
                `these clauses can delete a tier:\n${offenders.join("\n")}`
            ).toEqual([]);
        });

        it("has no chatterException that does not match a real pattern", () => {
            // A typo in chatterExceptions silently does nothing, which would
            // look like the fix working.
            const phrases = ROUTINE_CHATTER.map((p) => p.phrase);
            for (const category of SCOPES) {
                for (const exception of category.chatterExceptions ?? []) {
                    expect(phrases).toContain(exception);
                }
                // Field-level exceptions are conditional, and just as silent
                // when misspelled.
                const fields = [
                    ...(category.fields ?? []),
                    ...category.options.flatMap((o) => o.fields ?? []),
                ];
                for (const field of fields) {
                    for (const exception of field.chatterExceptions ?? []) {
                        expect(phrases).toContain(exception);
                    }
                }
            }
        });
    });
});
