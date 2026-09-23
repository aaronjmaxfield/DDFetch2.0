/**
 * Exact agency matching. Every identity arm builds its agency test here.
 *
 * -------------------------------------------------------------------------
 * WHY, measured 2026-09-23 (research/AGENCY_MATCHING_FINDINGS.md)
 * -------------------------------------------------------------------------
 * The arms used to match the agency code as a SUBSTRING -- `*X*`, `*x-env*`,
 * `*X-*` -- in both engines. 458 real agency codes sit inside a longer one, so
 * searching the shorter pulled the longer in: 67% of LARA's agency-code result
 * was MILARA and SANTACLARA, 62% of CFW's JNDI result was ACFW, 99% of POL's
 * Construct result was POLKCO, and the bogus code PAY returned 1.17M lines a
 * day. CRC with no AU environment returned 21 lines, all ECAN script names
 * ending in "...DETAILSCRC".
 *
 * Each form below covers every value SHAPE seen in a census of the field, and
 * was measured against the substring form on clean agencies (must be identical)
 * and on containment pairs (only the other agency may disappear). Own lines
 * lost: zero, checked on fixed windows across US PROD, US non-prod, AU and CA.
 *
 * -------------------------------------------------------------------------
 * DATADOG MATCHING RULES THESE DEPEND ON (all measured)
 * -------------------------------------------------------------------------
 *   - Facet values are case sensitive; free text is not.
 *   - A value containing `:` or `|` matches exactly when escaped: `*\:X`.
 *     A leading `*` followed by `\:` is a COLON anchor, not a substring: it
 *     matches any prefix ending in a colon, so `SERV_PROV_CODE:X` and the rare
 *     `JNDI:JNDI:x-env` are reached, but `MILARA` cannot be.
 *   - Hyphens and dots are IGNORED inside free-text wildcards: `*X-*` behaves
 *     as "a word ending in X", `*.x.*` exactly as `*X*`.
 *   - `"Agency ID"` matches nothing, but `"ID:X"` matches `Agency ID:X,Script`.
 *   - An apostrophe breaks a phrase, but `"N'X'"` matches the SQL literal
 *     `SERV_PROV_CODE = N'X'` exactly.
 */

/**
 * @SERV_PROV_CODE. Census shapes by line volume: `X` 80.5%,
 * `SERV_PROV_CODE:X` 19.4%, `SERV_PROV_CODE:SERV_PROV_CODE:X|` 0.1%, `X-ENV`
 * 0.02% (COSA-NONPROD2), plus 36 lower-case values. `X-*` catches only the
 * agency's own environment suffixes: no agency code contains a hyphen.
 */
export function spcExact(upper: string, lower: string): string {
  return `@SERV_PROV_CODE:(${upper} OR ${lower} OR *\\:${upper} OR *\\:${lower} OR *\\:${upper}\\| OR ${upper}-* OR ${lower}-*)`;
}

/**
 * @JNDI for one environment. Shapes: `x-env` 77.4%, `JNDI:x-env` 13.7%, the
 * rest empty; `JNDI:JNDI:x-env` seen once a day. The substring form only ever
 * leaked codes ENDING in the agency's (MILARA for LARA, ACFW for CFW,
 * PORTSEATTLE for SEATTLE) and CFW lost 62% of its result to ACFW.
 */
export function jndiExact(upper: string, lower: string, jndi: string): string {
  const J = jndi.toUpperCase();
  return `@JNDI:(${lower}-${jndi} OR ${upper}-${J} OR *\\:${lower}-${jndi} OR *\\:${upper}-${J})`;
}

/**
 * Biz-tier free text, for lines that carry neither @JNDI nor @SERV_PROV_CODE
 * (EMSE dumps and SQL that name the agency only in the body -- the SANTAANA
 * case). Three phrases, each a whole-word match:
 *   `"X"`      CAP IDs (`SANTAANA-PWK26-00000`) and plain mentions
 *   `"ID:X"`   script lines `Agency ID:X,Script name:...`, which Datadog reads as
 *              one word, so `"X"` alone missed 30-73% of real lines
 *   `"N'X'"`   SQL literals `SERV_PROV_CODE = N'X'` -- without it CRC lost 22 of
 *              its own SQL lines a week
 * Never adds a line over `*X-*`; every line it drops was classified as another
 * agency's (MILARA, ACFW, PORTSEATTLE, ECAN's `...DETAILSCRC`) or random token
 * noise. KNOWN GAP, shared with the old form: SQL logged under the agency's DB
 * user (`LEECO.MALYALS`) is one word and stays unreachable; a prefix wildcard
 * would reach it but adds millions of lines for short codes.
 */
export function bizFreeText(upper: string): string {
  return `("${upper}" OR "ID:${upper}" OR "N'${upper}'")`;
}

/**
 * EMSE event-log blob names: `blob {x}-{env}-{Script}-...zip`. The phrase is a
 * whole-word match, so `milara-prod` no longer answers for `lara-prod`; the
 * wildcard also matched lines that did not contain the string at all.
 */
export function emseBlob(lower: string, jndi: string): string {
  return `"${lower}-${jndi}"`;
}

/**
 * Construct API @Properties.log.Agency. Shapes: `X`, `X-ENV`, `QA-INTG-X`, and
 * the `X_MOBILE` / `AZX` siblings recorded for this service. Replaces the front
 * anchor `(X* OR AZX*)`, which still leaked codes STARTING with the agency's
 * (POLKCO: 99% of POL's result) and missed `QA-INTG-X` (76,301 STDTESTAUTO
 * lines a week). Residual: `X_*` also reaches LINCOLN_CO for LINCOLN and the
 * X_DEV / X_TEST sibling tenants.
 */
export function capiAgency(upper: string): string {
  return `@Properties.log.Agency:(${upper} OR ${upper}-* OR ${upper}_* OR *-${upper} OR AZ${upper} OR AZ${upper}-* OR AZ${upper}_*)`;
}

/**
 * The remaining agency attributes, by facet. @Properties.log.Agency outside
 * Construct uses the same shapes minus the Construct-only siblings. @usr.agency
 * values are 98.8% LOWER case -- the old upper-case wildcard matched nothing --
 * though it only exists on mobile-browser services the tool does not search.
 * @Agency exists only on Paypal UI.
 */
export function agencyAttrExact(facet: string, upper: string, lower: string): string {
  switch (facet) {
    case '@SERV_PROV_CODE':
      return spcExact(upper, lower);
    case '@Properties.log.Agency':
      return `@Properties.log.Agency:(${upper} OR ${upper}-* OR *-${upper})`;
    case '@usr.agency':
      return `@usr.agency:(${lower} OR ${lower}-* OR *-${lower})`;
    case '@Agency':
      return `@Agency:(${upper} OR ${lower})`;
    case '@agencycode':
      return `@agencycode:${upper}`;
    default:
      // An unknown facet gets both casings, exact, rather than a substring.
      return `${facet}:(${upper} OR ${lower})`;
  }
}
