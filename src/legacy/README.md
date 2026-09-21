# Frozen legacy pages

These 21 root HTML files were copied byte-for-byte from the existing generated `public/` directory before the acquisition rebuild replaced any generated route. `manifest.json` records their original route, size, SHA-256, capture time and provenance. The legacy home remains `/`; authored `/apprentice` overrides only its frozen counterpart in generated output.

Normal `node build.mjs` performs **no network requests**. It validates every source manifest checksum before recreating generated output, then renders the intentional global-attribution include replacement in the legacy pages and copies current brand assets, native join flow, acquisition pages/assets, and authenticated dashboard shell. The manifest and raw frozen HTML are not themselves published; only individual HTML pages are copied.

The freeze retains existing brand injection, old join attribution and the thank-you joined beacon byte-for-byte as rollback evidence. Generated HTML intentionally replaces only the old `/join/attribution.js` include with `/acquisition/attribution.js` and standalone consent styles. Body-end scripts retain execution order so the existing joined beacon can read attribution; head-loaded join pages defer the helper until the body exists. The beacon and other automation calls remain intact. The new helper/compatibility adapter preserve legacy first-touch payloads while maintaining the new journey. This tracking change is recorded separately from automation cutover; it does not certify the old automations. External CSS, scripts, images, embeds and links still depend on their providers; offline build means no build-time network, not a fully offline website. No channel redirect cutover is part of this change.

For a deliberate refresh only, after recording the current Git commit and verifying that the source still serves the **old** site:

```sh
node build.mjs --refresh-legacy --legacy-origin=https://THE-VERIFIED-LEGACY-HOST
```

The origin must be explicitly supplied; there is no default refresh host. Never use the replacement deployment as the refresh source, which would recursively ingest the new site. Review and commit the refreshed HTML and manifest together. To edit an individual frozen file deliberately, update its manifest hash/size only after reviewing the exact change and recording why it is required. Otherwise checksum mismatch stops the build.

Rollback: restore `build.mjs` and the frozen-source revision from Git, rebuild, and restore the appropriate deployment. New application data and the database are separate and must not be rolled back by overwriting live records.
