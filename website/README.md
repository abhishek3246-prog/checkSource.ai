# checkSource.ai website

Static homepage for https://www.checksource.ai

## Deploy

### GitHub Pages
1. Repo Settings → Pages
2. Source: Deploy from a branch
3. Folder: `/website` (or use a GitHub Action to publish `website/`)
4. Point domain `www.checksource.ai` DNS (CNAME) to GitHub Pages

### Cloudflare Pages / Netlify / Vercel
- Build: none (static)
- Publish directory: `website`

DNS: add CNAME `www` → your host. Apex `checksource.ai` via ALIAS/ANAME or redirect to `www`.
