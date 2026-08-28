/**
 * Declarative host / environment / service tables used by the v2 engine.
 *
 * The legacy engine expressed all of this as nested switch statements, which is
 * where the Oregon special-cases hid. Keeping it as data makes the gaps visible
 * and turns a correction into a one-line edit.
 *
 * -------------------------------------------------------------------------
 * PROVENANCE
 * -------------------------------------------------------------------------
 * Values marked CONFIRMED were read from live Datadog on 2026-08-27 over a
 * 7-to-30-day window using a local Datadog API script, dd-query.ps1 (Measure-DDLogs
 * facet aggregation). Values still marked ASSUMPTION were not observed -- in
 * every case because that environment produced no logs in the window, not
 * because the query failed.
 *
 * The single most important discovery: **there is no one environment tag.**
 * Each log family carries its own taxonomy, and they do not overlap.
 *
 *   family        field    example values
 *   ------------  -------  --------------------------------------------------
 *   civp (biz,    env      civp_prod_azure, civp_auprod_azure, civp_orstg_azure
 *   ACDS, ADS)             -- i.e. civp_{jndi}_azure, so it tracks `jndi`
 *   platform      env      prod, stg, nonprod, au-nonprod, ca-nonprod, qa, dev
 *   (PAS, event-           -- region-agnostic for prod; regionalised only for
 *   log)                      non-prod, and only on some services
 *   pci           env      prod-pci, nonprod-pci, eng-arch-pci
 *   capi          env      construct_prod_central_azure, construct_auprod_azure
 *   Paypal UI     env      azureprod-{agency}-prod -- per tenant, so the env
 *                          tag doubles as the agency filter
 *
 * This is why the earlier single `envTag` field could never work: it held the
 * @JNDI token, which is correct for the civp family and wrong for every other.
 * Adding `env:prod` to a payment query returned zero results because the value
 * being sent was `supp`, `auprod`, `prodca` and so on -- tokens that exist in
 * the civp taxonomy and nowhere else.
 */

export interface EnvironmentDef {
  /** Value shown in the Environment dropdown. */
  ui: string;
  /** Token used inside @JNDI for the biz tier. Long-standing, load-bearing. */
  jndi: string;
  /**
   * Complete host clause for the biz tier.
   *
   * This is a full clause rather than a token because US STG cannot be
   * expressed as one: `host:*stg*` also matches austg, castg and orstg. The
   * exclusion form below is provably correct from the other regions' own
   * tokens, without needing to know the US staging hostname.
   */
  hostClause: string;
  /**
   * `env:` value carried by the civp log family -- biz tier, ACDS, edms-handler
   * and ADS. Always of the form `civp_{token}_azure`.
   *
   * `undefined` means no such tag was observed, in which case the v2 engine
   * warns rather than emitting a clause that would return nothing.
   */
  civpEnv?: string;
  /**
   * `env:` values carried by the payment platform family -- payment-adapter-service
   * and event-log-service. An array because the two services disagree: PAS uses a
   * bare `nonprod` while event-log-service regionalises it as `au-nonprod` /
   * `ca-nonprod`. Emitted as `env:(a OR b)`.
   */
  platformEnv?: string[];
  /**
   * `env:` values on the separate PCI clusters (SecurePay / Payrix / Worldpay).
   *
   * An array, and `eng-arch-pci` is deliberately included for every non-prod
   * environment. Measured over 30 days, that engineering cluster carries
   * 2,106,623 app-pci-payment-adapter lines against 3,369 on prod-pci and 2,749
   * on nonprod-pci -- 99.7% of the traffic. Scoping only to prod-pci and
   * nonprod-pci made a SecurePay search look empty when the data was there all
   * along.
   */
  pciEnv?: string[];
  /**
   * Exact @Properties.log.EnvName for CAPI.
   *
   * Note this is *not* interchangeable with the `env:` tag -- a single CAPI
   * cluster carries many EnvName values, so region comes from `capiRegionClause`
   * on the host and environment comes from here.
   */
  capiEnvName: string;
  /**
   * filename: token for the ACA tier. `undefined` means ACA logs are not
   * collected for this environment -- v2 raises a visible warning instead of
   * dropping the filter silently the way legacy did.
   */
  acaFilename?: (agencyLower: string) => string;
  /** Overrides the generic "not collected" warning where the truth is subtler. */
  acaNote?: string;
  /**
   * Set where the `jndi` token above matches nothing in the log estate.
   *
   * The token is kept rather than deleted so the row still documents what the
   * environment is called, but the engine stops emitting a clause that provably
   * returns zero and warns instead -- the same treatment `acaFilename:
   * undefined` already gets.
   */
  jndiDead?: boolean;
  /**
   * Set where emse.log is the only agency-attributed biz log in the environment,
   * which forces the EMSE arm on regardless of the user's preference.
   *
   * Oregon PROD is the extreme case: `host:*orprd* service:av.biz
   * @SERV_PROV_CODE:*` is 0, and emse.log is the sole av.biz file, so without the
   * arm a Civic Platform search returned index-builder lines and nothing else.
   */
  emseIsPrimaryBizLog?: boolean;
}

export interface HostDef {
  ui: string;
  /** OREGON does not use @JNDI at all. */
  usesJndi: boolean;
  /**
   * Extra clause pinning CAPI to this region.
   *
   * CONFIRMED: CAPI runs in a small number of named clusters, identified by the
   * `env:` tag, and that -- not @Properties.log.EnvName -- is what separates the
   * regions. `construct_auprod_azure` emits EnvName values PROD, AUPROD,
   * NONPROD1, NONPROD2, STAGE, SUPP and TEST, so EnvName alone cannot tell an
   * AU log from a US one.
   */
  capiRegionClause: string;
  /** Set when CAPI has no cluster of its own for this region. */
  capiRegionNote?: string;
  environments: EnvironmentDef[];
}

/** `AGCY-PROD` style suffix used by the generic ACA filename convention. */
const generic = (env: string) => (agencyLower: string) => `${agencyLower}-${env}`;
/** Oregon uses `{agency}-or{env}-aca`. CONFIRMED for PROD. */
const oregon = (env: string) => (agencyLower: string) => `${agencyLower}-or${env}-aca`;
/** Oregon TRAIN is genuinely one tenant -- see the note on that row. */
const literal = (value: string) => () => value;
/** Oregon CONFIG breaks the `or{env}` pattern and spells the environment out. */
const oregonConfig = (agencyLower: string) => `${agencyLower}-oregon-config-aca`;

const usNonProdHost = 'host:*mtsup*';

/** CAPI's US-region clusters. CONFIRMED: these three plus two perf clusters. */
const usCapiClusters =
  'env:(construct_prod_central_azure OR construct_staging_azure OR construct_qa_azure)';

export const HOSTS: HostDef[] = [
  {
    ui: 'US',
    usesJndi: true,
    capiRegionClause: usCapiClusters,
    environments: [
      { ui: 'PROD', jndi: 'prod', hostClause: 'host:*mtprd*', civpEnv: 'civp_prod_azure', platformEnv: ['prod'], pciEnv: ['prod-pci'], capiEnvName: 'PROD', acaFilename: generic('prod') },
      { ui: 'SUPP', jndi: 'supp', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'SUPP', acaFilename: generic('supp') },
      // ASSUMPTION (civpEnv): no `civp_test_azure` tag exists. US TEST biz logs
      // may be one of the civp_int*_azure clusters; not resolved.
      { ui: 'TEST', jndi: 'test', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'TEST', acaFilename: generic('test') },
      {
        ui: 'STG',
        jndi: 'stg',
        // See hostClause docs -- plain `host:*stg*` leaks every other region.
        hostClause: '(host:*stg* AND -host:*austg* AND -host:*castg* AND -host:*orstg*)',
        civpEnv: 'civp_stg_azure',
        platformEnv: ['stg'],
        pciEnv: ['nonprod-pci', 'eng-arch-pci'],
        // CORRECTED: the EnvName is STAGE, not STG. `STG` matches nothing.
        capiEnvName: 'STAGE',
        acaFilename: generic('stg'),
      },
      // ASSUMPTION (civpEnv) for all four: no civp_nonprod{n}_azure tag exists.
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', hostClause: usNonProdHost, civpEnv: 'civp_supp_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      // CORRECTED: the jndi token is `civcon`, not `cvcn`. `@JNDI:*cvcn*` matches
      // ZERO events estate-wide; `@JNDI:*civcon*` matches 112,629,484 over 7d.
      // For one real agency this was a 25x loss -- only the @SERV_PROV_CODE arm
      // was returning anything.
      // CONFIRMED (civpEnv): `env:civp_civcon_azure` is 16.2M/day and sits
      // entirely inside `host:*cvcn*`, with nothing outside. Promoted from
      // ASSUMPTION.
      // CONFIRMED ABSENT (acaFilename): `service:aca host:*cvcn*` = 0 over 30d.
      // The cluster logs 143M events of other services; the ACA tier does not
      // exist in it. Removed so the warning fires.
      // CONFIRMED ABSENT (capiEnvName): EnvName `CVCN` = 0 over the full 31-day
      // retention window.
      { ui: 'CVCN', jndi: 'civcon', hostClause: 'host:*cvcn*', civpEnv: 'civp_civcon_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'CVCN' },
    ],
  },
  {
    ui: 'AU',
    usesJndi: true,
    // CONFIRMED: AU CAPI has its own cluster.
    capiRegionClause: 'env:construct_auprod_azure',
    environments: [
      // CORRECTED: AU production CAPI is AUPROD. The AU cluster also emits PROD,
      // which is why the region clause above is doing the real work.
      { ui: 'PROD', jndi: 'auprod', hostClause: 'host:*auprd*', civpEnv: 'civp_auprod_azure', platformEnv: ['prod'], pciEnv: ['prod-pci'], capiEnvName: '(PROD OR AUPROD)', acaFilename: generic('auprod') },
      { ui: 'SUPP', jndi: 'ausupp', hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'SUPP', acaFilename: generic('ausupp') },
      // ASSUMPTION (civpEnv): no civp_autest_azure tag exists.
      // CONFIRMED DEAD, both tokens. @JNDI:*autest* = 0 estate-wide over 7d and
      // ilename:*-autest-aca* = 0 over 30d. The row shares host:*ausup* with AU
      // SUPP and NONPROD1-4, so it was silently serving THOSE environments'
      // logs labelled as TEST -- a non-empty, plausible, wrong result.
      { ui: 'TEST', jndi: 'autest', jndiDead: true, hostClause: 'host:*ausup*', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'TEST' },
      // CORRECTED: AUSTG, not STG.
      { ui: 'STG', jndi: 'austg', hostClause: 'host:*austg*', civpEnv: 'civp_austg_azure', platformEnv: ['stg'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: '(STAGE OR AUSTG)', acaFilename: generic('austg') },
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', jndiDead: true, hostClause: 'host:*ausup*', civpEnv: 'civp_ausupp_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
      // ASSUMPTION (capiEnvName): no CONV EnvName was observed.
      // CONFIRMED ABSENT (acaFilename): AU CONV ships IIS access logs only --
      // 100,813 over 7d, all filename:u_ex*, zero *aca_debug.log, zero
      // *aca_error.log, zero @agencycode, and free text for every AU tenant
      // returns 0. An ACA search here returned literally nothing, silently.
      { ui: 'CONV', jndi: 'auconv', hostClause: 'host:*auconv*', civpEnv: 'civp_auconv_azure', platformEnv: ['au-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'CONV', acaNote: 'AU CONV collects ACA access logs only (no debug or error log), so an ACA error cannot be traced here and the ACA filter was left out.' },
    ],
  },
  {
    ui: 'CA',
    usesJndi: true,
    // CORRECTED. There is genuinely no Canadian CAPI cluster and no PRODCA or
    // STGCA EnvName -- but the conclusion drawn from that was wrong. Canadian
    // CAPI runs on the shared US clusters: BARRIE, CGS, KINGSTON and NEWMARKET
    // alone are 1,685,242 lines over 30d, all in construct_prod_central_azure.
    // The old empty clause also let a CA search span the AU cluster.
    capiRegionClause: usCapiClusters,
    capiRegionNote:
      'Canadian CAPI runs on the shared US-region Construct clusters -- there is no separate CA cluster -- so results are pinned by agency code rather than by region.',
    environments: [
      { ui: 'PROD', jndi: 'prodca', hostClause: 'host:*caprd*', civpEnv: 'civp_prodca_azure', platformEnv: ['prod'], pciEnv: ['prod-pci'], capiEnvName: 'PROD', acaFilename: generic('prodca') },
      { ui: 'STG', jndi: 'stgca', hostClause: 'host:*castg*', civpEnv: 'civp_stgca_azure', platformEnv: ['stg'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'STAGE', acaFilename: generic('stgca') },
      // ASSUMPTION (civpEnv) for all four: `civp_suppca_azure` exists and is
      // busy, but there is no SUPP entry in this dropdown to map it to, and
      // guessing which NONPROD it corresponds to would break the others.
      { ui: 'NONPROD1', jndi: 'nonprod1', hostClause: 'host:*casup*', civpEnv: 'civp_suppca_azure', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD1', acaFilename: generic('nonprod1') },
      { ui: 'NONPROD2', jndi: 'nonprod2', hostClause: 'host:*casup*', civpEnv: 'civp_suppca_azure', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD2', acaFilename: generic('nonprod2') },
      { ui: 'NONPROD3', jndi: 'nonprod3', hostClause: 'host:*casup*', civpEnv: 'civp_suppca_azure', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD3', acaFilename: generic('nonprod3') },
      { ui: 'NONPROD4', jndi: 'nonprod4', jndiDead: true, hostClause: 'host:*casup*', civpEnv: 'civp_suppca_azure', platformEnv: ['ca-nonprod', 'nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'NONPROD4', acaFilename: generic('nonprod4') },
    ],
  },
  {
    ui: 'OREGON',
    usesJndi: false,
    // Oregon has no CAPI cluster of its own -- its EnvName values (CONFIG, DEV)
    // appear inside the US clusters, so the US region clause is the right one.
    capiRegionClause: usCapiClusters,
    capiRegionNote:
      'Oregon CAPI logs are emitted from the US clusters, and Oregon PROD shares the EnvName value PROD with US PROD, so an Oregon PROD CAPI search cannot be separated from a US one.',
    environments: [
      { ui: 'PROD', jndi: 'orprd', emseIsPrimaryBizLog: true, hostClause: 'host:*orprd*', civpEnv: 'civp_orprd_azure', platformEnv: ['prod'], pciEnv: ['prod-pci'], capiEnvName: 'PROD', acaFilename: oregon('prd') },
      {
        ui: 'TRAIN',
        jndi: 'ortest',
        // CORRECTED, twice over. TRAIN runs on `orsupp-*` hosts: the only host
        // emitting oregon-oregon-train-aca_debug.log is orsupp-aca-0/1. The old
        // `host:*ortest*` matched a single idle ACA node and missed the tier
        // entirely. `ortest` is kept in the OR because ortest-ACA-0 does log.
        hostClause: '(host:*orsupp* OR host:*ortest*)',
        civpEnv: 'civp_oregon-train_azure',
        platformEnv: ['nonprod'],
        pciEnv: ['nonprod-pci', 'eng-arch-pci'],
        // ASSUMPTION: no TRAIN EnvName was observed.
        capiEnvName: 'TRAIN',
        // CONFIRMED single-tenant. `oregon-oregon-train-aca_debug.log` is the
        // only ACA debug log in this environment, so the legacy hardcoded
        // literal was right and parameterising it on the agency code was wrong.
        acaFilename: literal('oregon-oregon-train-aca'),
      },
      // ACA logs are not collected in DEV/CONFIG -- acaFilename omitted so v2
      // warns instead of silently dropping the user's selection.
      { ui: 'DEV', jndi: 'ordev', hostClause: 'host:*ordev*', civpEnv: 'civp_oregon-dev_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'DEV' },
      // CORRECTED: Oregon CONFIG *does* collect ACA logs. The previous comment
      // lumped it in with DEV and told the user they were not collected, which
      // is the worst failure mode -- you stop looking. 21,478 events over 30d
      // including real ACA stack traces (ReportBll.GetReportLinkProperty).
      // Files: oregon-, or_mhods-, sws-, lane_co- prefixed `-oregon-config-aca`.
      { ui: 'CONFIG', jndi: 'orconf', hostClause: 'host:*orconf*', civpEnv: 'civp_orconf_azure', platformEnv: ['nonprod'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'CONFIG', acaFilename: oregonConfig },
      // CORRECTED: acaFilename removed. Oregon STG ships no ACA logs at all --
      // civp_orstg_azure contains av.biz, iis, av.indexer and av.web only, and
      // orstg-ACA-0 emits nothing but IIS access logs. The previous
      // `{agency}-orstg-aca` value would always have returned zero.
      { ui: 'STG', jndi: 'orstg', emseIsPrimaryBizLog: true, hostClause: 'host:*orstg*', civpEnv: 'civp_orstg_azure', platformEnv: ['stg'], pciEnv: ['nonprod-pci', 'eng-arch-pci'], capiEnvName: 'STAGE', acaNote: 'Oregon STG ships ACA access logs only, tagged service:iis on orstg-ACA-0 rather than service:aca. No ACA debug or error log is collected, so an ACA error cannot be traced here.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Additional services
// ---------------------------------------------------------------------------

/**
 * Resolves the environment clause for one family of service logs.
 *
 * Returns `undefined` when the environment cannot be expressed, which the
 * engine reports as a warning rather than emitting a clause that matches
 * nothing.
 */
export type EnvClause = (env: EnvironmentDef, agencyLower: string) => string | undefined;

const civpEnvClause: EnvClause = (env) => (env.civpEnv ? `env:${env.civpEnv}` : undefined);

const platformEnvClause: EnvClause = (env) =>
  env.platformEnv?.length
    ? env.platformEnv.length > 1
      ? `env:(${env.platformEnv.join(' OR ')})`
      : `env:${env.platformEnv[0]}`
    : undefined;

const pciEnvClause: EnvClause = (env) =>
  env.pciEnv?.length
    ? env.pciEnv.length > 1
      ? `env:(${env.pciEnv.join(' OR ')})`
      : `env:${env.pciEnv[0]}`
    : undefined;

/**
 * Paypal UI tags every log with `azure{cluster}-{agency}-{env}`, so its env tag
 * already carries the agency. That makes it the only service where one clause
 * covers both scopes.
 */
const paypalUiEnvClause: EnvClause = (env, agencyLower) =>
  `env:azure*-${agencyLower}-${env.jndi}`;

/**
 * How a target can be narrowed to one agency.
 *
 * - `attributes` -- the log carries a real agency facet, so filter on the six
 *   candidate fields. Facet values are case sensitive.
 * - `freetext` -- the agency is present but only inside an unparsed message
 *   body, so a bare `*AGENCY*` match is the only thing that works. Free-text
 *   matching is case *insensitive*, unlike facets, so one casing suffices.
 * - `none` -- the log carries no agency at all. Filtering excludes it entirely.
 */
export type AgencyScope = 'attributes' | 'freetext' | 'none';

export interface ServiceTarget {
  /** Whether these logs are identified by `service:` or by `name:`. */
  field: 'service' | 'name';
  values: string[];
  /** How to scope this target to an environment. */
  envClause: EnvClause;
  /**
   * `none` means AND-ing an agency filter would exclude the target completely,
   * which is how an earlier version silently dropped every event-log-service
   * and ADS line while still looking correct.
   */
  agencyScope: AgencyScope;
  /**
   * Overrides the default `*{AGENCY}*` term used by `agencyScope: 'freetext'`.
   *
   * The bare wildcard is too blunt on some targets -- it matches hex fragments
   * inside trace IDs for short agency codes, and matches script names rather
   * than tenants in event-log bodies. Where a precise token exists, use it.
   */
  freetextTerm?: (agencyLower: string, env: EnvironmentDef) => string;
  /** Surfaced to the user whenever this target is included. */
  note?: string;
}

export interface ServiceDef {
  /** Checkbox label. */
  ui: string;
  /** Grouping used to enforce "pick only one". */
  category: 'payment' | 'document';
  targets: ServiceTarget[];
}

/** payment-adapter-service. CONFIRMED to carry @SERV_PROV_CODE, both casings. */
const paymentAdapter: ServiceTarget = {
  field: 'service',
  values: ['payment-adapter-service'],
  envClause: platformEnvClause,
  agencyScope: 'attributes',
};

/**
 * ConfigStore.
 *
 * Two corrections here, the second reversing an earlier one of mine.
 *
 * 1. The service name is `configstore-service`, not `config-store-service`. The
 *    hyphenated form returns zero logs over any window, so every Forte, PayPal
 *    and SecurePay query built before this carried a dead clause.
 *
 * 2. It **does** carry the agency -- `SERV_PROV_CODE` is in the message, along
 *    with `MODULE` (the request path), `GUID`, `CLIENT_ADDR` and the trace IDs.
 *    An earlier note here claimed it carried no agency or environment at all.
 *    That was wrong, and wrong for an avoidable reason: the conclusion came
 *    from one sampled event that happened to be a Datadog tracer line rather
 *    than an application line, and its attribute list was taken as the whole
 *    service's shape.
 *
 * The catch is that the JSON arrives unparsed inside an Azure App Service
 * console-log envelope -- only ~0.4% of lines have a promoted `@logger_name`,
 * and `@SERV_PROV_CODE` is not a facet at all. So the agency is reachable by
 * free text and nothing else, which is why this target uses 'freetext'.
 *
 * What the logs are actually good for: they record which provider
 * configuration, action, template and response-mapping the adapter fetched --
 * `/payments/urn:provider-id:paypal-ppcp/configuration`,
 * `.../templates/paypal-registration-request.mustache`, and so on. That answers
 * "did the adapter read its config, and for which agency", which is a real
 * payment triage question.
 */
const configStore: ServiceTarget = {
  field: 'service',
  values: ['configstore-service'],
  // No env clause: the useful population is one staging App Service instance,
  // so there is no environment to choose between. See the note.
  envClause: () => undefined,
  agencyScope: 'freetext',
  note: 'ConfigStore only ships useful logs from staging (configstore-service-stg): request-level detail of which provider configuration and templates the adapter fetched. The production PCI instances emit nothing but a 5-minute "Evicting cached configurations" heartbeat, so a production ConfigStore search is effectively empty. Its agency is matched by free text because the JSON payload is not parsed into facets.',
};

/**
 * CORRECTED, and it was the A22 mistake repeated on a second service. The old
 * comment read "CONFIRMED: no @SERV_PROV_CODE and no agency attribute of any
 * kind" -- true of the facets, false of the data. Roughly half these lines are
 * Camel exchange bodies carrying `tenantId: urn:tenant-id:{agency}-{jndi}`,
 * plus `traceId` (joinable to av.biz), `eventId`, `serviceHost` and `userId`.
 *
 * Leaving it unscoped was the single worst noise source in the tool: an AU PROD,
 * CA PROD or any Oregon search emitted `name:event-log-service AND env:prod`,
 * returning ~8.3M US-production lines over 30d, none of them the selected
 * agency's -- there is no AU, CA or Oregon event-log instance at all.
 *
 * The `urn:tenant-id:` form is preferred over a bare `*{AGENCY}*` because the
 * bare form matches anywhere in the body; it was confirmed to pull in unrelated
 * tenants on script-name matches.
 */
const eventLog: ServiceTarget = {
  field: 'name',
  values: ['event-log-service'],
  envClause: platformEnvClause,
  agencyScope: 'freetext',
  freetextTerm: (agencyLower, env) => `"urn:tenant-id:${agencyLower}-${env.jndi}"`,
  note: 'event-log-service is matched on the tenantId inside the message body, since it carries no agency facet. Roughly half its lines are AMQP connection noise with no tenant at all and are therefore not returned.',
};

export const ADDITIONAL_SERVICES: ServiceDef[] = [
  {
    ui: 'Forte',
    category: 'payment',
    targets: [paymentAdapter, configStore, eventLog],
  },
  {
    ui: 'Paypal Commerce',
    category: 'payment',
    targets: [
      paymentAdapter,
      configStore,
      eventLog,
      {
        field: 'service',
        values: ['"Paypal UI"'],
        envClause: paypalUiEnvClause,
        // 'none' because the env clause above already pins the agency.
        agencyScope: 'none',
        note: 'Paypal UI is scoped by its own env tag, which embeds the agency, so it needs no separate agency filter.',
      },
    ],
  },
  {
    ui: 'SecurePay',
    category: 'payment',
    targets: [
      {
        // CONFIRMED: the service exists, runs on the PCI clusters, and carries
        // @SERV_PROV_CODE, @MODULE, @PLATFORM and @PROVIDER like PAS does.
        field: 'service',
        values: ['app-pci-payment-adapter'],
        envClause: pciEnvClause,
        agencyScope: 'attributes',
        note: 'SecurePay runs on separate PCI clusters. Almost all traffic (99.7% over 30 days) is on the engineering cluster eng-arch-pci rather than prod-pci, so non-production searches include it. A PROD search covers prod-pci only and will look sparse by comparison -- that is accurate, not a missing filter.',
      },
      {
        // The most informative target for SecurePay, and the reason this entry
        // is worth keeping: it logs both reads and writes of the adapter
        // configuration -- "Configuration details were requested for agency with
        // name '{agency}'", "Updating configuration for adapter with id
        // '{AGENCY}-PAYMENT-PAYMENT_ADAPTER_CONFIG_AA-...'" and
        // "retrieving resource for provider with id
        // 'urn:provider-id:payrix-multimerchant'".
        //
        // The agency appears as a bare name in the message and inside the
        // adapter id, but the literal string SERV_PROV_CODE never does, so free
        // text is the only thing that matches. Confirmed: @SERV_PROV_CODE is
        // absent as a facet and a "SERV_PROV_CODE" text search returns zero.
        field: 'service',
        values: ['app-pci-configstore'],
        envClause: pciEnvClause,
        agencyScope: 'freetext',
      },
      eventLog,
    ],
  },
  {
    ui: 'ACDS',
    category: 'document',
    targets: [
      {
        // CONFIRMED: both carry @SERV_PROV_CODE, and env is civp_{jndi}_azure.
        field: 'service',
        values: ['acds', 'edms-handler'],
        envClause: civpEnvClause,
        agencyScope: 'attributes',
      },
    ],
  },
  {
    ui: 'ADS',
    category: 'document',
    targets: [
      {
        field: 'service',
        values: ['av.ads'],
        envClause: civpEnvClause,
        // CONFIRMED: @SERV_PROV_CODE exists on av.ads but is always empty.
        agencyScope: 'none',
        note: 'ADS logs carry no populated agency field, so they are returned for the whole environment rather than just this agency.',
      },
    ],
  },
];

export function findHost(ui: string): HostDef | undefined {
  return HOSTS.find((h) => h.ui === ui);
}

export function findEnvironment(hostUi: string, envUi: string): EnvironmentDef | undefined {
  return findHost(hostUi)?.environments.find((e) => e.ui === envUi.toUpperCase());
}

export function environmentsFor(hostUi: string): string[] {
  return findHost(hostUi)?.environments.map((e) => e.ui) ?? [];
}
