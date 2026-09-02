# LaPis website

The LaPis landing page is a static site with no build step. It can be deployed from the repository root to either Cloudflare Workers Static Assets or Cloudflare Pages.

## Cloudflare Workers

The root [`wrangler.jsonc`](../wrangler.jsonc) points Workers Static Assets at this directory.

```bash
npx wrangler dev
npx wrangler deploy
```

For a Git-connected Worker, leave **Build command** empty and use `npx wrangler deploy` as the deploy command. The existing `wrangler.jsonc` supplies the asset directory.

## Cloudflare Pages

Use these build settings for a Git-connected Pages project:

- **Framework preset:** None
- **Build command:** leave empty
- **Build output directory:** `website`
- **Root directory:** `/`

## Local preview

Any static file server can preview the site:

```bash
npx serve website
```
