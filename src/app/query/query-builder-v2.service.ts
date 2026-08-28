import { Injectable } from '@angular/core';
import {
  ADDITIONAL_SERVICES,
  EnvironmentDef,
  findEnvironment,
  findHost,
  HostDef,
  ServiceDef,
  ServiceTarget,
  acaUrlSegment,
  CAPI_SERVICES,
} from './environments.config';
import { activeScopeExtras, fieldsFor, findCategory, findOption } from './scopes.config';
import {
  chronicExclusion,
  chronicSummary,
  routineChatterExclusion,
} from './noise.config';
import { QueryEngine, QueryInput, QueryResult } from './query-input.model';

/**
 * Corrected query builder.
 *
 * The central change is structural. Accela's logs come in two shapes:
 *
 *   biz tier      -- VM hosts, scoped by @SERV_PROV_CODE / @JNDI / host:
 *   containerised -- AKS services, scoped by service: / env: / agency attribute
 *
 * The legacy engine OR'd these together as though they were scoped alike, which
 * is why selecting a payment service returned every tenant's payment logs in
 * every region: the service branch carried no agency, environment or host
 * filter at all. Here each model is scoped on its own terms and the agency
 * scope is applied to both.
 */
@Injectable({ providedIn: 'root' })
export class QueryBuilderV2Service implements QueryEngine {
  readonly id = 'v2' as const;
  readonly label = 'New (v2)';

  build(input: QueryInput): QueryResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    const host = findHost(input.host);
    if (!host) {
      errors.push(`Unknown host '${input.host}'.`);
      return { query: '', warnings, errors };
    }

    const env = findEnvironment(input.host, input.environment);
    if (!env) {
      errors.push(`'${input.environment}' is not a valid environment for ${host.ui}.`);
      return { query: '', warnings, errors };
    }

    /*
     * A scoped selection contributes the same additional service the checkboxes
     * used to, so the service branch is reused rather than reimplemented. The
     * union is deliberate: the checkbox path still works, which is what keeps
     * this additive rather than a migration.
     */
    const scopeOption = findOption(input.scope?.category, input.scope?.option);
    const requestedServices = [...input.additionalServices];
    if (scopeOption?.serviceUi && !requestedServices.includes(scopeOption.serviceUi)) {
      requestedServices.push(scopeOption.serviceUi);
    }

    const services = this.resolveServices(requestedServices, errors);
    if (errors.length) return { query: '', warnings, errors };

    const agency = input.servProvCode.trim();
    const branches: string[] = [];

    const biz = this.buildBizBranch(input, host, env, agency, warnings);
    if (biz) branches.push(biz);

    const capi = this.buildCapiBranch(input, host, env, agency, warnings);
    if (capi) branches.push(capi);

    const svc = this.buildServiceBranch(services, env, agency, warnings);
    if (svc) branches.push(svc);

    if (!branches.length) {
      errors.push('Select at least one application or additional service.');
      return { query: '', warnings, errors };
    }

    let query = branches.length > 1 ? `(${branches.join(' OR ')})` : branches[0];

    /*
     * Scoped clauses narrow the whole query rather than joining the OR, because
     * an identifier is a statement about which event you want, not about which
     * tier it came from. A CAP ID should cut across biz, ACA and the payment
     * adapter at once.
     */
    for (const clause of this.buildScopeClauses(input, env, agency, warnings)) {
      query = `${query} AND ${clause}`;
    }

    if (scopeOption?.providerUrn) {
      /*
       * `OR -@PROVIDER:*` is load-bearing. Only ~50% of payment-adapter lines
       * carry the attribute -- 11 of 20 on one measured transaction, 16 of 27 on
       * another -- so a bare AND would cut the trace in half. This form removed
       * exactly the other providers' lines and kept both Forte traces whole.
       */
      query = `${query} AND (@PROVIDER:"${scopeOption.providerUrn}" OR -@PROVIDER:*)`;
    }

    const params = this.formatAdditionalParams(input.additionalParams);
    if (params) query = `${query} AND ${params}`;

    /*
     * Routine chatter goes last, so it applies to everything above it including
     * the scoped clauses. Default on -- see the note on QueryInput. Every
     * pattern in the list was measured to remove zero errors and zero warnings.
     */
    if (input.hideRoutineChatter !== false) {
      // The selected scope may depend on a chatter pattern as evidence -- a
      // payment investigation needs the sequence-allocation lines that
      // `lSeqRemaining` otherwise removes.
      const { chatterExceptions } = activeScopeExtras(
        input.scope?.category,
        input.scope?.option,
        input.scope?.fields
      );
      const exclusion = routineChatterExclusion(chatterExceptions);
      if (exclusion) query = `${query} AND ${exclusion}`;
    }

    /*
     * Chronic conditions are real warnings, so hiding them is announced rather
     * than silent. On the busiest Forte agency the slow-report warning alone is
     * ~60,000 lines in 24 hours and 99.6% of everything left after scoping --
     * it buries the payment failures it sits next to.
     */
    if (input.showChronic !== true) {
      const exclusion = chronicExclusion();
      if (exclusion) {
        query = `${query} AND ${exclusion}`;
        warnings.push(
          `Hidden because they are constant in this environment rather than related to your search: ${chronicSummary()}. These are real warnings -- turn on "Show chronic warnings" to include them.`
        );
      }
    }

    return { query, warnings, errors };
  }

  /** One clause per filled-in scoped field, plus any warnings they raise. */
  private buildScopeClauses(
    input: QueryInput,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string[] {
    const values = input.scope?.fields;
    if (!values) return [];

    const ctx = {
      agencyUpper: agency.toUpperCase(),
      agencyLower: agency.toLowerCase(),
      env,
    };

    const clauses: string[] = [];
    for (const field of fieldsFor(input.scope?.category, input.scope?.option)) {
      const raw = values[field.id];
      if (!raw || !raw.trim()) continue;

      const warning = field.warn?.(raw);
      if (warning) warnings.push(warning);

      const clause = field.clause(raw, ctx);
      if (clause) clauses.push(clause);
    }
    return clauses;
  }

  // ------------------------------------------------------------------ biz tier

  private buildBizBranch(
    input: QueryInput,
    host: HostDef,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    const wantsAca = input.applications.includes('Citizen Access');
    // ACA is the front end and Civic Platform the back end, so an ACA search
    // always needs the biz tier too. Preserved from legacy deliberately.
    const wantsBiz = input.applications.includes('Civic Platform') || wantsAca;
    if (!wantsBiz) return '';

    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();
    const identity: string[] = [];

    if (host.usesJndi && !env.jndiDead) {
      // Facet values are case sensitive, so both casings are needed. Real values
      // are {lower}-{lower} or {UPPER}-{UPPER}; no mixed pair was observed.
      identity.push(`@JNDI:*${lower}-${env.jndi}*`, `@JNDI:*${upper}-${env.jndi.toUpperCase()}*`);

      /*
       * @SERV_PROV_CODE is a FALLBACK here, not a peer of @JNDI, and that
       * subordination is the single largest noise fix in this engine.
       *
       * As a peer it defeated the environment selection outright. Six US rows
       * share `host:*mtsup*` and @JNDI is the only thing that separates them, so
       * OR-ing in an environment-free @SERV_PROV_CODE clause put every
       * neighbouring environment back in. Measured on a real agency at US SUPP:
       * 64% of the result set was TEST logs, and switching NONPROD1 to NONPROD3
       * changed the total by under 1%.
       *
       * It also caused cross-tenant bleed: the trailing wildcard means a
       * two-character agency code is a mid-token substring of at least ten
       * longer, unrelated codes, and 20% of that agency's results were other
       * tenants'.
       *
       * Nothing is lost by demoting it. On US PROD, @SERV_PROV_CODE present
       * while @JNDI is absent is 9,661 lines/day out of 135M estate-wide, and
       * exactly 0 for a given agency -- so the `-@JNDI:*` guard keeps the whole
       * population the arm was there for.
       */
      identity.push(`(@SERV_PROV_CODE:*${upper}* AND -@JNDI:*)`);
      identity.push(`(@SERV_PROV_CODE:*${lower}* AND -@JNDI:*)`);
    } else {
      // Oregon has no @JNDI at all -- every value is EMPTY -- so the agency
      // attribute is the only identity available and stands on its own. Both
      // casings: values are overwhelmingly uppercase but not exclusively, and
      // the biz branch used to emit only the upper form while the service
      // branch emitted both.
      identity.push(`@SERV_PROV_CODE:*${upper}*`, `@SERV_PROV_CODE:*${lower}*`);

      if (host.usesJndi && env.jndiDead) {
        warnings.push(
          `No @JNDI environment exists for ${host.ui} ${env.ui} -- the token matches nothing in the log estate -- so results cannot be pinned to this environment and may include neighbouring ones.`
        );
      }
    }

    /*
     * The EMSE log carries NEITHER @SERV_PROV_CODE nor @JNDI, anywhere, in any
     * environment, so without an arm of its own the whole of emse.log is
     * invisible -- 14.9% of US PROD av.biz.
     *
     * But it is bulk. Measured on one agency at US SUPP over 6h it is 7,525
     * lines, all `status:info`, against 1,052 for the rest of the biz branch
     * combined. Including it unconditionally more than undid the noise work
     * above, so it is off by default and on where it is the ONLY thing there.
     *
     * On Oregon PROD emse.log is the sole av.biz file -- `host:*orprd*
     * service:av.biz @SERV_PROV_CODE:*` is 0 -- so without it a Civic Platform
     * search returned index-builder lines and nothing else. Oregon STG is 46%
     * emse. Those rows opt in via `emseIsPrimaryBizLog`.
     *
     * Free text rather than the "Agency ID:" phrase on purpose -- the phrase form
     * drops the EMSE exception and blob-upload lines, which are the ones worth
     * having, and on Oregon it returns 92x less. Free text is case insensitive
     * here, so one casing suffices.
     */
    if (input.includeEmse || env.emseIsPrimaryBizLog) {
      identity.push(`(filename:emse.log AND *${upper}*)`);
    } else {
      warnings.push(
        'EMSE script logs are excluded: they carry neither @SERV_PROV_CODE nor @JNDI, so they need a free-text arm, and they are high-volume and info-only. Enable "Include EMSE" if you are chasing script behaviour.'
      );
    }

    if (wantsAca) {
      if (env.acaFilename) {
        /*
         * Anchored, not `*token*`. Every ACA log filename starts with the agency
         * code, so the leading wildcard bought no recall and leaked other
         * tenants: `*seattle-supp*` returned 7,811 lines that were all
         * `portseattle-supp`, and `*port-prod*` matched northport, westport and
         * sfport. Anchoring is byte-identical on the codes that were already
         * unambiguous. `filename` is case sensitive and must be lowercase.
         */
        const acaToken = env.acaFilename(lower);
        identity.push(`filename:${acaToken}*`);

        /*
         * These two are environment-agnostic on their own, and where a host
         * clause is shared between rows they defeated the environment selection
         * the same way the old @SERV_PROV_CODE peer did -- a US NONPROD1 search
         * returned 7.5x the intended population. Constraining both to the
         * environment's own filename shape fixes that without losing recall.
         *
         * The free-text arm earns its place despite the noise: it is the only
         * route to Oregon child agencies, whose ACA filenames are site names
         * rather than agency codes.
         *
         * It does NOT reach the IIS access logs. This comment used to claim it
         * was "the only route" to them, which was wrong and hid the largest
         * blind spot in the tool: both arms are gated on a `filename:` shape,
         * and the IIS logs are written to `u_ex{date}_x.log`, so
         * `filename:u_ex*` AND `filename:*-prod*` is 0 by construction. They are
         * reachable only via the URL path -- see the `includeIis` arm below.
         *
         * The shape is derived from the filename token, NOT from `env.jndi`.
         * They diverge: Oregon TRAIN's jndi is `ortest` but its file is
         * `oregon-oregon-train-aca`, and Oregon CONFIG's is `orconf` against
         * `{agency}-oregon-config-aca`. Keying off jndi would have silently
         * broken both.
         */
        const envShape = acaToken.startsWith(`${lower}-`)
          ? `filename:*${acaToken.slice(lower.length)}*`
          : `filename:${acaToken}*`;
        identity.push(`(service:aca AND @agencycode:${upper} AND ${envShape})`);
        identity.push(`(service:aca AND *${upper}* AND ${envShape})`);

        /*
         * Page requests. Opt-in, because this population is enormous: LEECO
         * alone is 1,891,225 IIS lines in 24 hours, which would bury everything
         * else in a default search. Under the payment scope the category markers
         * cut that to 16,766, and only 1,172 of those are non-200 -- so it is
         * usable when asked for and ruinous when not.
         *
         * Worth having because it is the only place the HTTP status and the page
         * duration live. In one real case the evidence that a payment page took
         * 121 seconds and returned a 302 existed ONLY on an IIS line, and the
         * tool could not return it at any setting.
         */
        if (input.includeIis) {
          identity.push(
            `(service:aca AND filename:u_ex* AND ${acaUrlSegment(upper, env)})`
          );
          /*
           * Announced, because the counts mislead. Adding these took a measured
           * LEECO payment search from 37,226 lines to 53,960 while the error
           * count stayed at 136: Datadog classes every IIS line as `info`
           * regardless of the HTTP status it records, so a page that returned
           * 500 does not appear as an error. Someone filtering on error status
           * would conclude the page was fine.
           */
          warnings.push(
            'Page requests are included. Note that these lines are all logged as "info" even when the page failed -- the HTTP status is inside the message text, so filtering by error status will hide a 500. Look for the status code near the end of the line, along with the time taken in milliseconds.'
          );
        }
      } else {
        warnings.push(
          env.acaNote ??
            `Citizen Access logs are not collected for ${host.ui} ${env.ui}, so the ACA filter was left out. Only Civic Platform logs will be returned.`
        );
      }
    }

    /*
     * The search indexer is excluded by default.
     *
     * It is agency-tagged, so it passes the identity filter and lands in every
     * biz-tier search -- and it dominates them. On a real AA PayPal payment
     * investigation it was 2,445 of 4,285 returned lines, 57% of the result set,
     * and it cannot contain the answer: every one of those lines was
     * `status:info`, with zero warns and zero errors in the window.
     *
     * Excluded rather than removed, because a search or indexing investigation
     * genuinely wants it -- see `includeIndexer` on QueryInput.
     */
    const scopeParts = [env.hostClause];
    if (!input.includeIndexer) scopeParts.push('-service:av.indexer');

    /*
     * Restrict the biz tier to the chosen category. This is the largest single
     * reduction the engine makes -- see the bizMarkers note in scopes.config.ts
     * for the measurements. Without it, picking "Payment" added a payment
     * service branch and left the entire biz tier wide open, so a busy
     * production tenant returned over two million lines of which 74 errors
     * were actually about payments.
     *
     * Markers are wildcard form deliberately; quoted phrases under-match on
     * these logs. Note this is a POSITIVE clause, where wildcards are the
     * dependable shape -- the opposite rule applies to the exclusions.
     */
    const category = findCategory(input.scope?.category);
    if (category?.bizMarkers?.length && input.scopeBizTier !== false) {
      /*
       * Fields that currently hold a value can add markers of their own. That is
       * how the Construct trace ID reaches the biz-tier response line: 21.8M
       * lines a day, unaffordable as a category marker, free once a trace ID has
       * narrowed the search to one request.
       */
      const extra = activeScopeExtras(
        input.scope?.category,
        input.scope?.option,
        input.scope?.fields
      ).bizMarkers;
      const markers = [...category.bizMarkers, ...extra];
      scopeParts.push(`(${markers.join(' OR ')})`);
      warnings.push(
        `The Civic Platform results are limited to ${category.label.toLowerCase()}-related lines. Clear the Scope dropdown to see the whole tier.`
      );
    }

    return `((${identity.join(' OR ')}) AND ${scopeParts.join(' AND ')})`;
  }

  // ---------------------------------------------------------------------- CAPI

  private buildCapiBranch(
    input: QueryInput,
    host: HostDef,
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    if (!input.applications.includes('CAPI')) return '';

    const upper = agency.toUpperCase();

    const parts = [
      /*
       * Construct is a family of seven services, not one, and `service:capi`
       * alone missed the most valuable member. Measured over 7 days: capi
       * 193,111,731, coauth 29,425,993, cdocapi 5,845,988, cadmin 136,071,
       * cuser 62,620, cdeveloper 2,287.
       *
       * `coauth` is Construct's auth service and carries exactly the tickets a
       * frontline user brings -- locked-out accounts, expired tokens, bad
       * credentials, invalid signature -- at 766,127 errors a week, 46% of all
       * Construct error volume. It is also the best-attributed service in the
       * family: 80% of its error lines carry the agency facet against 3.9% on
       * capi.
       *
       * `gateway` is deliberately excluded: 8,952 lines, staging only, and
       * entirely `status:debug`.
       */
      `service:(${CAPI_SERVICES.join(' OR ')})`,
      /*
       * MATCH-OR-ABSENT, and this is the single largest correction in the file.
       *
       * Both of these used to be hard ANDs, which silently discarded almost
       * every Construct error. CAPI logs errors from the response path with
       * `Agency: null, AppId: null, EnvName: null, UserName: null`, so the
       * attributes the clause required are simply not there. Measured over 7
       * days on `service:capi status:error`: 858,957 lines, of which 4,857
       * carry EnvName (0.57%) and 33,315 carry Agency (3.88%).
       *
       * Errors and warns over 7 days, old clause against this one:
       *
       *   ARLINGTONCO      0 / 0      ->  121,551 / 76,527
       *   LEECO            0 / 0      ->      660 / 155,442
       *   FDNY           498 / 9      ->   24,750 / 6,704
       *   MECKLENBURG     22 / 8      ->    1,332 / 9,106
       *
       * Two of those four reported NO Construct errors at all.
       */
      `(@Properties.log.EnvName:${env.capiEnvName} OR -@Properties.log.EnvName:*)`,
      /*
       * Front-anchored, plus the AZ sibling, plus a free-text fallback for the
       * unattributed lines.
       *
       * The old `*{AGENCY}*` was both too broad and too narrow. For agency `DC`
       * it matched seven tenants over 7 days -- DC 6,683,059, AZDC 2,847,783,
       * OAKLANDCO 270,388, AZMERCEDCO 33,330, LADCR 2,014, LOVELANDCO 1,403,
       * MERCEDCO 3 -- while still missing every line where the attribute is
       * absent. Anchoring keeps DC and AZDC and drops the other five.
       *
       * Front-anchoring is lossless for the real sibling shapes, which are
       * suffixes: `{AGENCY}-TEST` and `{AGENCY}_MOBILE` still match.
       *
       * The AZ prefix being the same tenant is a HYPOTHESIS, not measured. Drop
       * that arm if it turns out otherwise.
       */
      `(@Properties.log.Agency:(${upper}* OR AZ${upper}*) OR (-@Properties.log.Agency:* AND *${upper}*))`,
    ];

    // Region comes from the cluster's env: tag, not from EnvName -- the AU
    // cluster emits PROD, NONPROD1, NONPROD2, STAGE, SUPP and TEST alongside
    // AUPROD, so EnvName on its own cannot separate the regions.
    if (host.capiRegionClause) parts.push(host.capiRegionClause);
    if (host.capiRegionNote) warnings.push(host.capiRegionNote);

    /*
     * Said out loud, because the match-or-absent form has a real cost and the
     * user cannot see it. An unattributed Construct error names no environment
     * anywhere in the event, so keeping those lines necessarily keeps them for
     * every environment this tenant has.
     */
    warnings.push(
      'Construct error lines usually record no agency and no environment -- CAPI logs them with those fields null. To avoid hiding them the query keeps unattributed lines, which means some Construct results may come from this tenant\'s other environments. The Request half of each pair is where the URL and body are, so check those to confirm.'
    );

    return `(${parts.join(' AND ')})`;
  }

  // ---------------------------------------------------- containerised services

  /**
   * One sub-branch per service target, OR'd together.
   *
   * A single shared branch is not expressible. The selected services do not
   * agree on either scope:
   *
   *   - Environment lives on a different tag per family. `env:civp_prod_azure`
   *     is right for ACDS and returns nothing for payment-adapter-service,
   *     where the value is a bare `prod`.
   *   - Some targets carry no agency field at all. AND-ing the agency scope
   *     across the whole branch silently excluded every event-log-service, ADS
   *     and ConfigStore line -- the query looked correct and returned a subset.
   *
   * So each target contributes `(identity AND env? AND agency?)` on its own
   * terms, and anything that cannot be scoped says so in a warning instead of
   * emitting a clause that matches nothing.
   */
  private buildServiceBranch(
    services: ServiceDef[],
    env: EnvironmentDef,
    agency: string,
    warnings: string[]
  ): string {
    if (!services.length) return '';

    const lower = agency.toLowerCase();
    const seen = new Set<string>();
    const branches: string[] = [];
    const unscopedByEnv: string[] = [];
    const notes = new Set<string>();

    for (const target of services.flatMap((s) => s.targets)) {
      // The same target object appears under several services (event-log-service
      // is shared by all three payment providers), so dedupe on identity.
      const key = `${target.field}:${target.values.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const branch = this.buildTargetBranch(target, env, agency, lower, unscopedByEnv);
      if (branch) branches.push(branch);
      if (target.note) notes.add(target.note);
    }

    if (unscopedByEnv.length) {
      warnings.push(
        `No environment tag is known for ${this.listPhrase(unscopedByEnv)} in ${env.ui}, so those logs are returned across all environments. See the ASSUMPTION comments in environments.config.ts.`
      );
    }
    for (const note of notes) warnings.push(note);

    if (!branches.length) return '';
    return branches.length > 1 ? `(${branches.join(' OR ')})` : branches[0];
  }

  private buildTargetBranch(
    target: ServiceTarget,
    env: EnvironmentDef,
    agency: string,
    agencyLower: string,
    unscopedByEnv: string[]
  ): string {
    // service:(a OR b) rather than service:a OR service:b -- the grouped form
    // is Datadog's documented pattern for multiple values of one field.
    const identity =
      target.values.length > 1
        ? `${target.field}:(${target.values.join(' OR ')})`
        : `${target.field}:${target.values[0]}`;

    const clauses = [identity];

    const envClause = target.envClause(env, agencyLower);
    if (envClause) {
      clauses.push(envClause);
    } else if (!target.note) {
      // A target with its own note already explains why it cannot be scoped;
      // adding the generic warning too just says the same thing twice.
      unscopedByEnv.push(target.values.join(', ').replace(/"/g, ''));
    }

    if (target.agencyScope === 'attributes') {
      clauses.push(this.agencyScopeForServices(agency));
    } else if (target.agencyScope === 'freetext') {
      // The agency is inside an unparsed message body, so there is no facet to
      // filter on. Free-text matching is case insensitive -- unlike facets --
      // so a single casing is enough here.
      //
      // A target can supply a precise token instead of the bare wildcard, which
      // matters: `*{AGENCY}*` matches hex fragments inside trace IDs for short
      // codes, and matches script names rather than tenants in event-log bodies.
      clauses.push(target.freetextTerm ? target.freetextTerm(agencyLower, env) : `*${agency.toUpperCase()}*`);
    }

    return clauses.length > 1 ? `(${clauses.join(' AND ')})` : clauses[0];
  }

  private listPhrase(items: string[]): string {
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  /**
   * Which agency field is populated varies by service, so all of them are OR'd
   * rather than betting on one.
   *
   * @SERV_PROV_CODE is included in both casings. It was originally left out on
   * the assumption that containerised services do not carry it; a working
   * payment-adapter-service query confirmed they do, and that facet values are
   * case sensitive, so both are needed.
   */
  private agencyScopeForServices(agency: string): string {
    const upper = agency.toUpperCase();
    const lower = agency.toLowerCase();
    return (
      `(@agencycode:${upper}` +
      ` OR @Agency:*${upper}*` +
      ` OR @Properties.log.Agency:*${upper}*` +
      ` OR @usr.agency:*${upper}*` +
      ` OR @SERV_PROV_CODE:*${lower}*` +
      ` OR @SERV_PROV_CODE:*${upper}*)`
    );
  }

  // ----------------------------------------------------------------- selection

  private resolveServices(selected: string[], errors: string[]): ServiceDef[] {
    const defs = selected
      .map((ui) => ADDITIONAL_SERVICES.find((s) => s.ui === ui))
      .filter((s): s is ServiceDef => !!s);

    for (const category of ['payment', 'document'] as const) {
      const inCategory = defs.filter((d) => d.category === category);
      if (inCategory.length > 1) {
        errors.push(
          `Select only one ${category} service (${inCategory.map((d) => d.ui).join(', ')} are all selected).`
        );
      }
    }

    return defs;
  }

  // -------------------------------------------------------- additional params

  /**
   * Tokenise additional parameters, joining with AND.
   *
   * Two changes from legacy. Terms are AND'd, so adding a term narrows the
   * search as users expect, rather than widening it. And the tokeniser handles
   * a single quoted word: legacy checked startsWith('"') before
   * endsWith('"') in an else-if chain, so `"foo"` opened a quote that never
   * closed and the term was silently discarded.
   */
  formatAdditionalParams(raw: string): string {
    const text = raw.trim();
    if (!text) return '';

    const terms: string[] = [];
    // Quoted phrases stay intact; everything else splits on whitespace.
    const pattern = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      if (match[1] !== undefined) {
        const phrase = match[1].trim();
        // Wildcards do not work inside quotes, so a quoted phrase is passed
        // through verbatim.
        if (phrase) terms.push(`"${phrase}"`);
      } else if (match[2]) {
        const term = match[2];
        // Already a field filter or negation -- pass through untouched rather
        // than wrapping it in wildcards and breaking it.
        terms.push(this.looksLikeFilter(term) ? term : `*${term}*`);
      }
    }

    if (!terms.length) return '';
    return terms.length > 1 ? `(${terms.join(' AND ')})` : `(${terms[0]})`;
  }

  private looksLikeFilter(term: string): boolean {
    return term.includes(':') || term.startsWith('-');
  }
}
