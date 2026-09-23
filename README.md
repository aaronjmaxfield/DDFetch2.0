# DDFETCH 2.0

**Live: https://aaronjmaxfield.github.io/DDFetch2.0/**

DDFetch builds Datadog log searches for Accela environments. Fill in the agency, environment and what you are investigating, press Fetch, and it opens the right query over the right time window in your own Datadog session.

It only assembles a URL. There is no backend, it never calls the Datadog API, and it never sees your credentials.

## How to use it

1. Enter the agency code (ServProvCode), then pick the host and environment.
2. Choose the time window: a Timeframe preset, or exact dates and times in the Time range picker. A preset always overwrites a calendar pick.
3. Tick the applications to search. Civic Platform is on by default.
4. Optionally pick a Scope (see below) and fill in any identifier you have, such as a CAP ID, trace ID or document name.
5. Press Fetch. The search opens in a new Datadog tab.

The Time range box always states the exact window being searched, with UTC on hover. An empty result is far more often a window that ended before the event than a bad query.

## Features

- **Scopes.** Seven categories narrow the search to one kind of problem: Batch jobs, Documents, EMSE scripts, GIS / Parcels, Payment, Records, Reports. Each offers its own fields: a CAP ID, trace ID, document ID or name, batch job name, report name, parcel number, payment provider, and so on.
- **Unscoped means unfiltered.** With Scope left on `-- none --` you get everything for that agency and environment, so a later filter can never miss lines that were already removed. Picking a Scope is what cuts the noise.
- **Noise reduction you can see.** A scoped search hides routine chatter and constant background errors. The chip under the Scope dropdown says what the search filters; click it to see exactly what was hidden and why, and turn the real warnings back on in one click.
- **Every log family, correctly tagged.** Accela's logs use several different environment tag schemes (biz tier, payment adapters, PCI, Construct API and more). DDFetch applies the right one to each service, so a service is never silently dropped by the wrong tag.
- **Failures that name no agency.** The lines that explain a failure often carry no agency tag at all. DDFetch deliberately reaches payment-adapter errors, stack-trace-only error lines and script dumps that an agency filter would otherwise hide.
- **Trace ID search.** Paste a back-office (`W-...`) or Citizen Access (`aca-...`) trace ID under Advanced and DDFetch works out the date, sets the window and finds every line for that request.
- **Rehydration aware.** Windows older than 15 days need rehydrating from archive. DDFetch flags it beside the Time range before you search and offers **use Raw logs?** in one click, because the query becomes the rehydration's own filter and anything it excludes is never pulled.
- **Raw logs.** Turns every filter off. Use it when the error or log line you expected is missing, and for anything older than 15 days.
- **Also include.** Opt back in to populations held out by default: slow-report warnings, the search indexer, EMSE script logs and ACA page requests.

## Worth knowing

- **ADS results are not agency-specific.** ADS records no agency anywhere, so those results cover every agency in the environment.
- **A thin ACDS result outside Asia-Pacific is expected.** Canada and Oregon record none. Empty does not mean nothing happened.
- **Severity is not reliable across these logs.** Real failures are often logged as `info` or `warn`, so be careful filtering to `status:error`.

## Development

Requires Node.js 24 or later.

```
npm ci
npm start              # dev server at http://localhost:4200
npm test               # unit and characterization tests
npm run release        # runs the tests, then builds the site into docs/
```

GitHub Pages serves `main` from `/docs`, so the site only changes when `docs/` is rebuilt with `npm run release` and committed.

The query logic lives in `src/app/query/`. `query-builder-v2.service.ts` is the engine, `scopes.config.ts` defines the scopes and their fields, `noise.config.ts` the hidden patterns, and `environments.config.ts` the hosts and environment tags. Every marker and noise pattern was measured against live Datadog on several agencies before it was added. The comments record the numbers, so check them before changing anything.

## Credits

A fork of [snorman2/DDFetch](https://github.com/snorman2/DDFetch), upgraded to Angular 22 with a rebuilt query engine. Not affiliated with or endorsed by Datadog.
