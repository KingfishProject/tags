# Ghost tags

The tags on our Ghost site, managed as files in this repo.

Each tag is a YAML file in [`tags/`](tags/). Change a file, merge the pull request, and publish a release. The release updates Ghost to match. If someone edits a tag directly in Ghost, this repo notices within the hour and opens a pull request so you can decide whether to keep the change.

## How it works

| What happens | Result |
| --- | --- |
| You edit, add, or delete a file in `tags/` and merge to `main` | Nothing changes in Ghost yet. |
| You **publish a release** | Ghost is updated to match the files in that release. Tags are created, updated, and deleted. |
| Someone edits, adds, or deletes a tag **in Ghost** | Within an hour, a pull request called **"Changes made in Ghost"** opens (or updates) showing exactly what changed. |
| You **merge** that pull request | The Ghost changes become part of this repo. Ghost is left as it is. |
| You **close** that pull request without merging | The changes it lists are undone in Ghost straight away. Ghost goes back to how it was at the last sync. GitHub edits that haven't been released yet still wait for the next release. |

A release won't go out while Ghost has changes that nobody has reviewed, because it would silently overwrite them. Deal with the "Changes made in Ghost" pull request first:

- If you **close** it, re-run the deploy.
- If you **merge** it, publish a **new** release from `main`. The blocked release was made before the merge, so deploying it would undo the Ghost changes you just kept.

Pre-releases don't deploy. Promoting a pre-release to a full release does.

### Keeping some Ghost changes but not others

Merge the "Changes made in Ghost" pull request, then open a normal pull request that undoes the parts you don't want. Ghost gets the final version at the next release. Don't push edits to the `ghost-sync/drift` branch itself: it's rewritten automatically every hour.

### Things to know before deleting a tag

Deleting a tag in Ghost also removes it from every post that uses it. Closing a "Changes made in Ghost" pull request deletes any tag that was *created* in Ghost, and the pull request says how many posts that tag is on. If the tag comes back later, those posts have to be re-tagged by hand. The release summary shows how many posts each deleted tag was on.

As a safety net, a release stops without changing anything if it would:

- delete more than half of the tags in Ghost, or all of them, or
- delete a tag and create a new one with the same slug or name. That usually means a renamed file that couldn't be matched up, and it would take the tag off its posts.

If you really mean it, run the deploy by hand with **force** ticked.

## Tag file format

The file name is the tag's handle in this repo. It doesn't have to match the slug. You can change the slug inside the file and Ghost will rename the existing tag instead of making a new one. Renaming the file is fine too, as long as the slug or the name stays the same in the same release. Change the file name and the slug/name in two separate releases.

```yaml
# tags/local-news.yaml
name: Local news
slug: local-news
description: |-
  Reporting from around the parish.
  Descriptions can span several lines.
color: "#1f6feb"
image: https://example.com/content/images/local-news.jpg

meta:
  title: Local news from Central Louisiana
  description: Reporting on government, schools and public safety.
  canonical_url: https://example.com/tag/local-news/

x:
  image: https://example.com/content/images/local-news-x.jpg
  title: Local news
  description: Reporting from around the parish.

facebook:
  image: https://example.com/content/images/local-news-fb.jpg
  title: Local news
  description: Reporting from around the parish.
```

Only `name` and `slug` are required. Leave out anything you don't use.

| Field | Ghost label | Limit |
| --- | --- | --- |
| `name` | Name | Required. Start it with `#` to make an internal tag. |
| `slug` | Slug | Required. Lowercase letters, numbers, hyphens, and underscores. |
| `description` | Description | 500 characters |
| `color` | Color | Hex color like `"#1f6feb"` |
| `image` | Image | Full URL (`https://…`) |
| `meta.title` | Meta title | 70 characters |
| `meta.description` | Meta description | 156 characters |
| `meta.canonical_url` | Canonical URL | Full URL |
| `x.image` | X image | Full URL |
| `x.title` | X title | 70 characters |
| `x.description` | X description | 125 characters |
| `facebook.image` | Facebook image | Full URL |
| `facebook.title` | Facebook title | 100 characters |
| `facebook.description` | Facebook description | 65 characters |

**Put quotes around any value that starts with `#`**, like `color: "#1f6feb"` or `name: "#internal"`. Without quotes, YAML treats everything after `#` as a comment and the value comes out empty. The checks catch this.

Internal tags (names starting with `#`) usually have a slug starting with `hash-`, which is what Ghost generates for them.

When a "Changes made in Ghost" pull request rewrites a file, it rewrites the whole file in the standard layout, so any comments you added to that file are lost.

## Setup

1. **Create a Ghost integration.** In Ghost Admin, go to Settings → Integrations → Add custom integration. Copy the **Admin API key** and the **API URL**.
2. **Add repository secrets** under Settings → Secrets and variables → Actions:
   - `GHOST_API_URL`: your site address, such as `https://example.com`
   - `GHOST_ADMIN_API_KEY`: the Admin API key (it looks like `abc123…:def456…`)
   - `CLOUDFLARE_BYPASS_TOKEN` (optional): only needed if Cloudflare blocks the jobs. See [Cloudflare](#cloudflare) below.
3. **Let Actions open pull requests.** Settings → Actions → General → Workflow permissions: tick **Allow GitHub Actions to create and approve pull requests**. If the option is greyed out, it has to be turned on in the organization's settings first.
4. **Import the current tags.** Go to Actions → **Pull changes from Ghost** → Run workflow. It opens a pull request adding a file for every tag in Ghost. Review and merge it.
   If some Ghost tags break the rules (a meta title over 70 characters, say), the pull request lists them. Fix them in a follow-up pull request. Releases are blocked until every file passes.
5. **Publish the first release** (for example `v1.0.0`). Ghost already matches, so nothing changes unless you fixed something in step 4.

From then on, the hourly check and releases take care of themselves.

### Cloudflare

If Ghost sits behind Cloudflare, Cloudflare may challenge requests from GitHub Actions as bots. A challenge shows up as `HTTP 403 from "cloudflare", not a response from Ghost`. The jobs can't solve a challenge, so tell Cloudflare to let them through. To keep the admin API protected from everyone else, allow only requests that carry a secret header:

1. Make a long random value, for example with `openssl rand -hex 32`.
2. Save it as a repository secret named `CLOUDFLARE_BYPASS_TOKEN`. The jobs send it in an `X-Ghost-Tags-Sync` header.
3. In Cloudflare, open the zone → Security → Security rules (WAF custom rules). Cloudflare won't let one Skip rule skip both "all remaining custom rules" and other security features, so make two rules with the same expression. Use "Edit expression" and put in your own host and token:
   ```
   (http.host eq "ghost.kingfish.la" and starts_with(http.request.uri.path, "/ghost/api/admin/") and any(http.request.headers["x-ghost-tags-sync"][*] eq "PASTE-THE-TOKEN-HERE"))
   ```
   - **Rule 1, "Ghost tags sync: skip protections"**: action **Skip**. Tick every product or phase offered (for example Security Level, Super Bot Fight Mode, managed rules, rate limiting, Browser Integrity Check), but **not** "All remaining custom rules".
   - **Rule 2, "Ghost tags sync: skip custom rules"**: action **Skip**, ticking only **All remaining custom rules**.
   - Order them Rule 1, then Rule 2, at the **top** of the list. Rule 2 skips every custom rule after it, so Rule 1 has to come first.
4. Re-run the failed job.

To find out what issued the challenge, open Security → Events and click the blocked request. The **Service** field says which feature it was. The free plan's **Bot Fight Mode** can't be skipped by a rule. If that's what is challenging, either turn it off for the zone or point `GHOST_API_URL` at an address for Ghost that isn't proxied through Cloudflare.

## The workflows

| Workflow | Runs when | Does |
| --- | --- | --- |
| [Check tags](.github/workflows/validate.yml) | Every pull request and push to `main` | Checks the files against the rules above, and previews what the next release would change in Ghost. |
| [Pull changes from Ghost](.github/workflows/pull.yml) | Every hour, or by hand | Opens or updates the "Changes made in Ghost" pull request, or closes it if Ghost matches again. |
| [Deploy tags to Ghost](.github/workflows/deploy.yml) | A release is published (not pre-releases), or by hand | Makes Ghost match the release. Run it by hand to retry, preview with **dry run**, or override the safety checks with **force**. |
| [Revert Ghost changes](.github/workflows/revert.yml) | The "Changes made in Ghost" pull request is closed without merging | Undoes the changes listed in that pull request. |
| [Record merged Ghost changes](.github/workflows/accept.yml) | The "Changes made in Ghost" pull request is merged | Records the merged changes as the new starting point. Doesn't touch Ghost. |

The jobs wait for each other, so two of them never change Ghost at the same time.

GitHub switches off hourly jobs in a repo that has had no commits for 60 days. Each deploy switches **Pull changes from Ghost** back on. If you go two months without a release, check that it's still enabled on the Actions tab.

Pull requests opened by the hourly job don't run **Check tags** on their own, because GitHub doesn't start workflows from pull requests that a workflow opened. Problems found are listed in the pull request description instead. Publishing a release always runs the checks before touching Ghost.

### How it tells Ghost edits from GitHub edits

After each release, and after each merged or closed "Changes made in Ghost" pull request, CI records what Ghost should look like, including each tag's Ghost ID, on the `ghost-state` branch. That's the "last sync". CI writes that branch, so don't edit it by hand.

The hourly check compares three versions of every tag: the last sync, what Ghost has now, and what `main` has. A field counts as a Ghost change only when Ghost differs from both of the others. So edits you've merged but not yet released aren't mistaken for Ghost changes, and Ghost changes you've already merged stop being reported.

Tracking Ghost IDs is also what makes slug renames on either side update the same tag rather than delete one and create another.

## Working locally

```bash
npm install
```

```bash
npm test
```

```bash
npm run validate
```

To preview a release against the live site without changing anything:

```bash
GHOST_API_URL=https://example.com GHOST_ADMIN_API_KEY=... node scripts/deploy.js --dry-run
```
