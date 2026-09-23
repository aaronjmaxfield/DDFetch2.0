# Deploying DDFetch 2.0

Everything here needs a person. The code side is done and verified; what remains is publishing and the two checks that need eyes.

## The release itself

```powershell
cd DDFetch2.0
npm run release        # runs the tests, then builds into docs/ with the right base href
```

`npm run release` fails if a single test fails, which is the point — `docs/` should never be built from a red tree.

Then:

```powershell
git add -A
git commit -m "Build docs for release"
git push origin <branch>          # currently proto/scoped-search
```

Merge to `main`, then: **Settings → Pages → Source: Deploy from a branch → `main` → `/docs`**.

Enabling Pages publishes the site publicly. That is the point of no return, and it is the only step here that cannot be undone quietly.

## Why `docs/` must be rebuilt every time

`docs/` is the published artifact and it is committed. It goes stale the moment any source file changes, and nothing warns you — the site just keeps serving the old bundle. Before this document existed, the committed bundle was `main-3GT5Y6U6.js` while the source built to `main-SSLGEQUX.js`, so the published site was missing a day of fixes.

If you change one line of code, rebuild `docs/`.

## Two checks that need a human

**One non-Chrome browser.** The dropdown work uses `appearance: base-select` and `::picker(select)`. Both are correctly gated behind `@supports`, with a fallback, so nothing should break — but the "always open downwards" fix only applies in the supported branch. Open the form in Firefox, expand Scope and Advanced, and confirm the dropdowns still open downwards and the card has no scrollbar.

**Three real tickets, someone who is not the author.** Where they hesitate is the actual defect list. In particular watch whether they notice the Scope chip under the Scope dropdown and open it — its notes say what the search hid and why, and several of them are the difference between a correct reading and a wrong one. And for anything older than 15 days, whether they take the `use Raw logs?` offer on the rehydration tag.

## What to tell the first users

Four things, because each one turns a silently wrong answer into a correct one:

1. **The window is not the query.** The Time range box states the window before you Fetch, and hovering it gives the same window in UTC. A search that returns nothing is far more often a window that ended before the event than a bad query. This has already happened once in testing.

2. **ADS results are not agency-specific.** ADS records no agency anywhere — not in a field, not in the message text. Those results cover every agency in the environment, and all of the ADS errors sit in a file with no agency at all, so "narrow ADS to my agency and look for errors" cannot work. The tool says so in the Scope chip's notes.

3. **A thin ACDS result outside Asia-Pacific is expected.** Australian production carries roughly 99 times US production, and Canada and Oregon record none. Empty does not mean nothing happened.

4. **Rehydrating? Use Raw logs.** A search older than 15 days rehydrates from archive, and the query goes into the rehydration itself — whatever a filter removed is never pulled. The rehydration tag beside the Time range offers `use Raw logs?`; take it, then narrow in Datadog. Raw logs is also the answer whenever an error you expected to see is missing.

## Known gaps, deliberately shipped

Recorded in full in the project's `OPEN_ITEMS.md` notes. The two worth knowing at release:

- **`op-prod` / `op-nonprod` are unreachable.** These carry on-premise tenants — `dd` (18,864 lines) and `tob` (665) on the payment adapter. They are NOT a missing `platformEnv` value as previously recorded: those tenants have no biz-tier presence under `@SERV_PROV_CODE` at all, so attaching the env to a cloud host row would mix two estates. It needs a host row and a decision about what else belongs in it.
- **Oregon has no `@logger.name` facet**, so the custom-adapter scope and adapter discovery both fail there specifically.

## Rolling back

Pages serves `main` at `/docs`. To revert the published site without reverting the code, restore `docs/` from the previous commit and push:

```powershell
git checkout <previous-good-sha> -- docs/
git commit -m "Revert published bundle to <sha>"
git push
```
