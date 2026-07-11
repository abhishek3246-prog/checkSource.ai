# Website → Vercel

Static homepage for **https://www.checksource.ai**

## Deploy on Vercel (GitHub connected)

1. Open [vercel.com/dream-coders1](https://vercel.com/dream-coders1)
2. **Add New… → Project**
3. Import `abhishek3246-prog/checkSource.ai`
4. Configure:
   - **Framework Preset:** Other
   - **Root Directory:** `website`
   - **Build Command:** leave empty
   - **Output Directory:** leave empty (or `.`)
5. Deploy

### Custom domain

1. Project → **Settings → Domains**
2. Add `www.checksource.ai` and `checksource.ai`
3. At your DNS provider:
   - `www` → CNAME to `cname.vercel-dns.com`
   - Apex `@` → A record `76.76.21.21` (or follow Vercel’s exact DNS panel)

## Local preview

Open `index.html` or run any static server from this folder.
