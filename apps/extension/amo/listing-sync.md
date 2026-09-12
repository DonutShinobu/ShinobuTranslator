# Firefox store listing sync

After each successful Firefox submission, `release.yml` copies the public Chrome Web Store name, summary, description, icon, and screenshots to AMO. Version release notes come from the matching stable GitHub Release. It uses the existing `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` in the `browser-stores` environment.

To refresh an already submitted version without rebuilding or resubmitting either store:

```sh
gh workflow run release.yml --ref master -f listing_tag=v0.8.3
```

For a read-only preview:

```sh
gh release view v0.8.3 --json tagName,body,isDraft,isPrerelease > release.json
npx tsx scripts/sync-firefox-listing.ts release.json --dry-run
```

The Chrome API does not expose listing text or media, so the script reads the public page's embedded JSON. It verifies the extension ID, required text, screenshot layout, and Google image host before writing to AMO. A page-layout change stops the sync; it does not clear the listing. Chrome changes awaiting review are not visible to this sync. Locales without Chrome translations use Chrome's own fallback text.

Screenshots are replaced only after all source images are downloaded and all new uploads are accepted. A failed upload leaves previous screenshots intact; rerun the workflow after resolving the error. Listing sync runs serially to prevent overlapping replacements.

AMO can apply both minute and hourly upload limits. Explicit HTTP 429 responses respect `Retry-After` (up to one hour per wait, at most three retries), generating a fresh JWT for each attempt. Other failed uploads stop the job instead of risking duplicate submissions.

API references: [AMO listing, icons, previews and versions](https://mozilla.github.io/addons-server/topics/api/addons.html), [AMO authentication](https://mozilla.github.io/addons-server/topics/api/auth.html), [Chrome API methods](https://developer.chrome.com/docs/webstore/api/reference/rest).
