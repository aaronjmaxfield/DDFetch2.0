import { Injectable } from '@angular/core';
import {
  ADDITIONAL_SERVICES,
  EnvironmentDef,
  findEnvironment,
  findHost,
  HostDef,
  ServiceDef,
  ServiceTarget,
} from './environments.config';
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

    const services = this.resolveServices(input.additionalServices, errors);
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

    const params = this.formatAdditionalParams(input.additionalParams);
    if (params) query = `${query} AND ${params}`;

    return { query, warnings, errors };
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
         * route to the IIS access logs, which are 62.4% of all ACA volume and
         * carry the tenant in neither `filename` nor `@agencycode`, and the only
         * route to Oregon child agencies, whose ACA filenames are site names
         * rather than agency codes.
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
    const scope = input.includeIndexer
      ? env.hostClause
      : `${env.hostClause} AND -service:av.indexer`;

    return `((${identity.join(' OR ')}) AND ${scope})`;
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

    const parts = [
      'service:capi',
      // Exact value, not *ENV*. The legacy wildcard also matched NONPROD1-4,
      // AUPROD and PRODCA, so every CAPI production search was contaminated.
      `@Properties.log.EnvName:${env.capiEnvName}`,
      `@Properties.log.Agency:*${agency.toUpperCase()}*`,
    ];

    // Region comes from the cluster's env: tag, not from EnvName -- the AU
    // cluster emits PROD, NONPROD1, NONPROD2, STAGE, SUPP and TEST alongside
    // AUPROD, so EnvName on its own cannot separate the regions.
    if (host.capiRegionClause) parts.push(host.capiRegionClause);
    if (host.capiRegionNote) warnings.push(host.capiRegionNote);

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
