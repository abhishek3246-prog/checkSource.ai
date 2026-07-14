# checkSource.ai

Chrome extension that checks whether images (and selected text) look original or AI-made — as you browse.

**Website:** [https://www.checksource.ai](https://www.checksource.ai)  
**Developers:** Abhi & Sathwika

## Install (free)

1. Download the zip from the website, or use `website/download/checkSource.ai-extension.zip` in this repo.
2. Unzip the folder.
3. Open Chrome → `chrome://extensions`
4. Enable **Developer mode**
5. **Load unpacked** → select the unzipped extension folder
6. Pin the extension and hover any image

## What’s in the report

- AI probability
- Edited / metadata signals
- Deepfake risk tier
- Reverse image search links
- Source credibility (site-level, separate from the image score)
- Reasoning bullets
- Text selection → quick verification searches

Signals are probabilistic — not forensic proof.

## Repo layout

```
manifest.json, background.js, content.js, popup.*   → Chrome extension
lib/                                                → shared helpers
icons/                                              → extension icons
website/                                            → https://www.checksource.ai homepage
website/download/*.zip                              → public download package
```

## Chrome Web Store

This release is distributed free via direct download (Load unpacked). A Chrome Web Store listing can be submitted from the same package when you’re ready (developer account required).

## License

Copyright © Abhi & Sathwika — checkSource.ai. Free for worldwide use of this extension release.
