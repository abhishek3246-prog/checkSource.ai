/**
 * checkSource.ai — authenticity report builder + HTML renderer
 */

const CS_TRUSTED_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "npr.org",
  "nature.com",
  "nasa.gov",
  "who.int",
  "cnn.com",
  "gov",
];

const CS_LOW_TRUST = [
  "blogspot.",
  "wordpress.com",
  "tumblr.com",
  "medium.com",
  "reddit.com",
  "4chan",
  "imgflip",
  "9gag",
];

/** Instant report (no network) — show immediately on hover */
function buildQuickReport(src, pageUrl = "") {
  const platform = detectPlatform(pageUrl || src);
  const domain = extractDomain(pageUrl || src);
  const sourceCredibility = scoreCredibility(domain, platform, null);

  return {
    pending: true,
    kind: "image",
    isAI: false,
    score: 0,
    aiProbability: null,
    edited: { value: "…", detail: "Checking file metadata…" },
    deepfake: { level: "…", score: 0, detail: "Model running…" },
    reverseImageSearch: {
      status: "Ready",
      detail: "Open reverse search while the model runs.",
      links: src ? reverseSearchLinks(src) : {},
    },
    firstPublished: { value: "…", source: "none", detail: "" },
    sourceCredibility,
    c2pa: { present: false, detail: "Checking…" },
    platform,
    domain,
    format: "…",
    overallRisk: { level: "Moderate", label: "Scanning… instant source checks ready" },
    reasoning: [
      `Page source: ${domain || "unknown"}`,
      `Credibility preview: ${sourceCredibility.level}`,
      "AI model running in background — this card will update",
    ],
    src,
    analyzedAt: new Date().toISOString(),
  };
}

/** Text / claim selection report (fast, no HF required) */
function buildTextReport(text, pageUrl = "") {
  const platform = detectPlatform(pageUrl);
  const domain = extractDomain(pageUrl);
  const sourceCredibility = scoreCredibility(domain, platform, null);
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const words = cleaned ? cleaned.split(" ").length : 0;

  const sensational =
    /breaking|shocking|unbelievable|they don't want you|must see|gone wrong|destroyed|secret/i.test(
      cleaned
    );
  const allCapsRatio = cleaned.length
    ? (cleaned.replace(/[^A-Z]/g, "").length / Math.max(1, cleaned.replace(/[^a-zA-Z]/g, "").length))
    : 0;
  const hasUrl = /https?:\/\//i.test(cleaned);
  const questionHeavy = (cleaned.match(/\?/g) || []).length >= 2;

  let claimRisk = "Low";
  const reasoning = [];
  if (sensational) {
    claimRisk = "Elevated";
    reasoning.push("Sensational wording detected");
  }
  if (allCapsRatio > 0.45 && cleaned.length > 40) {
    claimRisk = "Elevated";
    reasoning.push("Heavy capitalization (common in misleading posts)");
  }
  if (questionHeavy) reasoning.push("Multiple rhetorical questions — verify claims separately");
  if (hasUrl) reasoning.push("Contains a URL — open and verify the destination");
  if (sourceCredibility.level === "High") {
    reasoning.push("Published on a generally reputable domain — still check primary sources");
  } else if (sourceCredibility.level === "Low") {
    claimRisk = claimRisk === "Low" ? "Moderate" : claimRisk;
    reasoning.push("Low source credibility host — treat carefully");
  }
  if (!reasoning.length) reasoning.push("No strong manipulation markers in the selected wording");

  const q = encodeURIComponent(cleaned.slice(0, 180));
  const links = {
    google: `https://www.google.com/search?q=${q}`,
    news: `https://news.google.com/search?q=${q}`,
    factcheck: `https://www.google.com/search?q=${encodeURIComponent(cleaned.slice(0, 120) + " fact check")}`,
  };

  return {
    kind: "text",
    pending: false,
    isAI: false,
    score: 0,
    aiProbability: null,
    claimRisk,
    selectedText: cleaned.slice(0, 500),
    wordCount: words,
    edited: { value: "n/a", detail: "Text selection" },
    deepfake: { level: "n/a", score: 0, detail: "Not an image" },
    reverseImageSearch: { status: "n/a", detail: "", links: {} },
    firstPublished: { value: "n/a", source: "none", detail: "" },
    sourceCredibility,
    c2pa: { present: false, detail: "n/a" },
    platform,
    domain,
    format: "text",
    overallRisk: {
      level: claimRisk,
      label:
        claimRisk === "Elevated"
          ? "Selected text looks sensational — verify before sharing"
          : claimRisk === "Moderate"
            ? "Cross-check this claim with primary sources"
            : "No strong red flags in wording — still verify facts",
    },
    reasoning,
    textLinks: links,
    analyzedAt: new Date().toISOString(),
  };
}

function buildAuthenticityReport({
  src,
  pageUrl = "",
  hf = null,
  signals = null,
  error = null,
}) {
  if (error) {
    return {
      error,
      kind: "image",
      isAI: false,
      score: 0,
      aiProbability: 0,
      platform: detectPlatform(pageUrl || src),
      domain: extractDomain(pageUrl || src),
    };
  }

  const score = clamp01(hf?.score ?? 0);
  const aiProbability = Math.round(score * 100);
  // Prefer ensemble decision (includes primary-override for secondary false positives)
  const uncertain = Boolean(hf?.uncertain);
  const isAI = !uncertain && (hf?.isAI != null ? Boolean(hf.isAI) : score >= 0.5);
  const platform = detectPlatform(pageUrl || src);
  const domain = extractDomain(pageUrl || src);

  const deepfake = scoreDeepfake(score, signals);
  const edited = {
    value: signals?.edited || "Unknown",
    detail: editedDetail(signals),
  };

  const reverseImageSearch = {
    status: "Ready",
    detail: "Open reverse search to check if this image appeared earlier elsewhere.",
    links: reverseSearchLinks(src),
  };

  const firstPublished = deriveFirstPublished(signals);
  const sourceCredibility = scoreCredibility(domain, platform, signals);
  const c2pa = {
    present: Boolean(signals?.c2pa?.present),
    detail: signals?.c2pa?.detail || "Not checked",
  };

  const reasoning = buildReasoning({
    score,
    aiProbability,
    isAI,
    signals,
    deepfake,
    edited,
    sourceCredibility,
    c2pa,
    hf,
  });

  const overallRisk = computeOverallRisk({
    aiProbability,
    deepfake,
    edited,
    sourceCredibility,
    c2pa,
  });

  return {
    pending: false,
    kind: "image",
    isAI,
    uncertain,
    score,
    aiProbability,
    label: hf?.label || "",
    topLabel: hf?.topLabel || "",
    ensemble: hf?.ensemble || null,
    ensembleNotes: hf?.ensembleNotes || [],
    threshold: hf?.threshold ?? 0.5,
    modelAgreement: hf?.modelAgreement || null,
    disagreement: hf?.disagreement ?? null,
    raw: hf?.raw || null,
    edited,
    deepfake,
    reverseImageSearch,
    firstPublished,
    sourceCredibility,
    c2pa,
    platform,
    domain,
    format: signals?.format || "unknown",
    overallRisk,
    reasoning,
    analyzedAt: new Date().toISOString(),
    src,
  };
}

function scoreDeepfake(score, signals) {
  // Align tiers with lowered detector threshold (~0.12)
  let level = "Low";
  if (score >= 0.55) level = "High";
  else if (score >= 0.12) level = "Medium";

  if (signals?.socialCdn && signals?.metadataRemoved && score >= 0.08 && level === "Low") {
    level = "Medium";
  }

  return {
    level,
    score: Math.round(score * 100),
    detail:
      level === "High"
        ? "Strong synthetic / face-manipulation signals"
        : level === "Medium"
          ? "Some patterns consistent with AI generation (threshold tuned for modern gens)"
          : "No strong deepfake indicators",
  };
}

function editedDetail(signals) {
  if (!signals) return "Could not inspect file bytes";
  if (signals.editedSoftware) return `Editing software: ${signals.software}`;
  if (signals.socialCdn && signals.metadataRemoved)
    return "Social CDN delivery — original metadata usually stripped";
  if (signals.metadataRemoved) return "EXIF / camera metadata missing";
  if (signals.make || signals.model)
    return `Camera tags present (${[signals.make, signals.model].filter(Boolean).join(" ")})`;
  return "No clear edit signature";
}

function deriveFirstPublished(signals) {
  if (signals?.datetime) {
    const pretty = formatExifDate(signals.datetime);
    return {
      value: pretty || signals.datetime,
      source: "EXIF",
      detail: "From embedded DateTimeOriginal / DateTime",
    };
  }
  return {
    value: "Unknown",
    source: "none",
    detail: "No capture date in file — use reverse image search",
  };
}

function formatExifDate(raw) {
  const m = String(raw).match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return raw;
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = months[Number(m[2]) - 1] || m[2];
  return `${month} ${m[1]}`;
}

function scoreCredibility(domain, platform, signals) {
  let level = "Medium";
  const reasons = [];

  if (!domain) {
    return { level: "Unknown", domain: "", reasons: ["No source domain"] };
  }

  if (CS_TRUSTED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`) || domain.endsWith(d))) {
    level = "High";
    reasons.push("Known reputable publisher / TLD");
  } else if (CS_LOW_TRUST.some((d) => domain.includes(d))) {
    level = "Low";
    reasons.push("User-generated or low-signal hosting");
  } else if (/instagram|facebook|tiktok|twitter|x\.com|reddit|snapchat/i.test(platform)) {
    level = "Medium";
    reasons.push("Social platform — authenticity varies by poster");
  }

  if (signals?.c2pa?.present) {
    level = level === "Low" ? "Medium" : "High";
    reasons.push("Content Credentials present");
  }

  if (signals?.socialCdn) reasons.push("Image served via social CDN");
  if (!reasons.length) reasons.push("Neutral domain reputation");

  return { level, domain, reasons };
}

function computeOverallRisk({ aiProbability, deepfake, edited, sourceCredibility, c2pa }) {
  let points = 0;
  if (aiProbability >= 55) points += 3;
  else if (aiProbability >= 20) points += 2;
  else if (aiProbability >= 12) points += 1;

  if (deepfake.level === "High") points += 2;
  else if (deepfake.level === "Medium") points += 1;

  if (edited.value === "Yes") points += 1;
  if (sourceCredibility.level === "Low") points += 1;
  if (c2pa.present) points = Math.max(0, points - 2);

  if (points >= 5) return { level: "Critical", label: "High risk — treat as synthetic / manipulated" };
  if (points >= 3) return { level: "Elevated", label: "Elevated risk — verify before sharing" };
  if (points >= 1) return { level: "Moderate", label: "Some concerns — cross-check sources" };
  return { level: "Low", label: "Low risk signals — still not proof of authenticity" };
}

function buildReasoning(ctx) {
  const reasons = [];
  const { aiProbability, isAI, signals, deepfake, edited, sourceCredibility, c2pa, hf } = ctx;

  if (isAI) reasons.push(`Verdict: likely AI/synthetic (${aiProbability}% Fake score)`);
  else if (hf?.uncertain) reasons.push(`Verdict: inconclusive (${aiProbability}% Fake score)`);
  else reasons.push(`Verdict: likely real (${100 - aiProbability}% confidence)`);

  if (hf?.ensembleNotes?.length) {
    for (const n of hf.ensembleNotes) reasons.push(n);
  }

  if (hf?.ensemble?.length) {
    for (const m of hf.ensemble) {
      reasons.push(
        `${shortModel(m.model)}: ${m.label} · Fake ${m.aiScore}%` +
          (m.realScore != null ? ` / Real ${m.realScore}%` : "")
      );
    }
  } else if (hf?.label) {
    reasons.push(`Classifier label: ${hf.label} (Fake score ${aiProbability}%)`);
  }

  if (hf?.modelAgreement === "primary_override") {
    reasons.push("Ignored secondary false-positive — primary detector was confident real");
  } else if (hf?.modelAgreement === "disagree") {
    reasons.push(
      `Detectors disagree by ${hf.disagreement ?? "?"}% — blended carefully`
    );
  }

  if (hf?.topLabel && hf.topLabel !== hf.label) {
    reasons.push(`Highest raw class: ${hf.topLabel} (${Math.round((hf.topScore || 0) * 100)}%)`);
  }

  if (deepfake.level === "High") reasons.push("Face manipulation score: elevated");
  else if (deepfake.level === "Medium") reasons.push("Face manipulation score: moderate");
  else reasons.push("Face manipulation score: low");

  if (signals?.metadataRemoved) reasons.push("Metadata removed or absent");
  if (signals?.editedSoftware) reasons.push(`Editing signature: ${signals.software}`);
  if (edited.value === "Yes") reasons.push("File shows edit / retouch software tags");
  if (edited.value === "Likely") reasons.push("Likely re-encoded by a social platform");

  if (signals?.make || signals?.model) {
    reasons.push(
      `Camera metadata present: ${[signals.make, signals.model].filter(Boolean).join(" ")}`
    );
  }

  if (c2pa.present) reasons.push("C2PA Content Credentials detected");
  else reasons.push("No Content Credentials (C2PA) attached");

  if (signals?.socialCdn) {
    reasons.push("Lighting / compression cues unreliable after CDN re-encode");
  }

  if (sourceCredibility.level === "Low") {
    reasons.push("Publisher credibility: low (does not decide if the image is AI)");
  } else if (sourceCredibility.level === "High") {
    reasons.push(
      "Publisher credibility: high — news sites can still publish AI images; score is model-based"
    );
  }

  return unique(reasons).slice(0, 10);
}

function shortModel(id) {
  if (!id) return "model";
  const part = String(id).split("/").pop() || id;
  return part.length > 28 ? part.slice(0, 26) + "…" : part;
}

function reverseSearchLinks(src) {
  const encoded = encodeURIComponent(src);
  return {
    google: `https://lens.google.com/uploadbyurl?url=${encoded}`,
    tineye: `https://tineye.com/search?url=${encoded}`,
    yandex: `https://yandex.com/images/search?rpt=imageview&url=${encoded}`,
    bing: `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encoded}`,
  };
}

function detectPlatform(url) {
  if (!url) return "Unknown";
  const u = url.toLowerCase();
  if (/instagram\.|cdninstagram/.test(u)) return "Instagram";
  if (/facebook\.|fbcdn\./.test(u)) return "Facebook";
  if (/tiktok\.|tiktokcdn/.test(u)) return "TikTok";
  if (/twitter\.|x\.com|twimg\./.test(u)) return "X / Twitter";
  if (/youtube\.|ytimg\./.test(u)) return "YouTube";
  if (/reddit\.|redd\.it/.test(u)) return "Reddit";
  if (/linkedin\./.test(u)) return "LinkedIn";
  if (/pinterest\.|pinimg\./.test(u)) return "Pinterest";
  if (/cnn\./.test(u)) return "CNN";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web";
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

function unique(arr) {
  return [...new Set(arr)];
}

function renderReportHTML(report, { compact = false } = {}) {
  if (!report) return "";
  if (report.error) {
    return `<div class="cs-report cs-error"><div class="cs-brand">checkSource.ai</div><p>${escapeHtml(
      report.error
    )}</p></div>`;
  }

  if (report.kind === "text") {
    return renderTextReportHTML(report);
  }

  const riskClass = String(report.overallRisk?.level || "Moderate").toLowerCase();
  const links = report.reverseImageSearch?.links || {};
  const aiLabel =
    report.aiProbability == null ? (report.pending ? "Scanning…" : "—") : `${report.aiProbability}%`;

  const rows = [
    ["AI Probability", aiLabel, report.aiProbability == null ? null : riskTone(report.aiProbability)],
    ["Edited", report.edited?.value || "Unknown", null],
    ["Deepfake", report.deepfake?.level || "—", null],
    ["Reverse Image Search", report.reverseImageSearch?.status || "Ready", null],
    ["First Published", report.firstPublished?.value || "Unknown", null],
    [
      "Source Credibility",
      `${report.sourceCredibility?.level || "Unknown"} (site, not image)`,
      null,
    ],
  ];

  if (report.uncertain) {
    rows.unshift(["Verdict", "Uncertain", "cs-warm"]);
  } else if (report.isAI) {
    rows.unshift(["Verdict", "Likely AI / synthetic", "cs-hot"]);
  } else if (!report.pending) {
    rows.unshift(["Verdict", "Likely original / real", "cs-cool"]);
  }

  const rowsHtml = rows
    .map(
      ([k, v, tone]) =>
        `<div class="cs-row"><span class="cs-k">${escapeHtml(k)}</span><span class="cs-v ${
          tone || ""
        }">${escapeHtml(String(v))}</span></div>`
    )
    .join("");

  const reasons = (report.reasoning || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");

  const linkHtml = [
    ["Google Lens", links.google],
    ["TinEye", links.tineye],
    ["Yandex", links.yandex],
    ["Bing", links.bing],
  ]
    .filter(([, href]) => href)
    .map(
      ([label, href]) =>
        `<a class="cs-link" href="${escapeAttr(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    )
    .join("");

  const meterWidth = report.aiProbability == null ? 15 : report.aiProbability;

  return `
    <div class="cs-report cs-risk-${escapeAttr(riskClass)} ${report.pending ? "cs-pending" : ""}">
      <div class="cs-head">
        <div class="cs-brand">checkSource.ai</div>
        <div class="cs-platform">${escapeHtml(report.platform || "")}</div>
      </div>
      <div class="cs-verdict">${escapeHtml(report.overallRisk?.label || "")}</div>
      <div class="cs-meter" aria-hidden="true">
        <div class="cs-meter-fill ${report.pending ? "cs-pulse" : ""}" style="width:${meterWidth}%"></div>
      </div>
      <div class="cs-rows">${rowsHtml}</div>
      ${
        report.edited?.detail
          ? `<p class="cs-note">${escapeHtml(report.edited.detail)}</p>`
          : ""
      }
      <div class="cs-section">
        <div class="cs-section-title">Reasoning</div>
        <ul class="cs-reasons">${reasons}</ul>
      </div>
      ${
        !compact
          ? `<div class="cs-section">
        <div class="cs-section-title">Reverse search</div>
        <div class="cs-links">${linkHtml}</div>
      </div>
      <div class="cs-section">
        <div class="cs-section-title">Extras</div>
        <div class="cs-rows">
          <div class="cs-row"><span class="cs-k">C2PA</span><span class="cs-v">${
            report.c2pa?.present ? "Found" : report.pending ? "…" : "Not found"
          }</span></div>
          <div class="cs-row"><span class="cs-k">Format</span><span class="cs-v">${escapeHtml(
            String(report.format || "").toUpperCase()
          )}</span></div>
          <div class="cs-row"><span class="cs-k">Domain</span><span class="cs-v">${escapeHtml(
            report.domain || "—"
          )}</span></div>
        </div>
      </div>`
          : `<div class="cs-links" style="margin-top:10px">${linkHtml}</div>`
      }
      <p class="cs-disclaimer">AI probability comes from image models only. Publisher trust is separate — CNN and others can still post AI images. Not forensic proof.</p>
    </div>
  `;
}

function renderTextReportHTML(report) {
  const riskClass = String(report.overallRisk?.level || "Moderate").toLowerCase();
  const links = report.textLinks || {};
  const reasons = (report.reasoning || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const linkHtml = [
    ["Web search", links.google],
    ["News search", links.news],
    ["Fact check", links.factcheck],
  ]
    .filter(([, href]) => href)
    .map(
      ([label, href]) =>
        `<a class="cs-link" href="${escapeAttr(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    )
    .join("");

  return `
    <div class="cs-report cs-risk-${escapeAttr(riskClass)}">
      <div class="cs-head">
        <div class="cs-brand">checkSource.ai</div>
        <div class="cs-platform">Text · ${escapeHtml(report.platform || "")}</div>
      </div>
      <div class="cs-verdict">${escapeHtml(report.overallRisk?.label || "")}</div>
      <div class="cs-quote">“${escapeHtml(report.selectedText || "")}”</div>
      <div class="cs-rows">
        <div class="cs-row"><span class="cs-k">Claim risk</span><span class="cs-v">${escapeHtml(
          report.claimRisk || "—"
        )}</span></div>
        <div class="cs-row"><span class="cs-k">Words</span><span class="cs-v">${escapeHtml(
          String(report.wordCount || 0)
        )}</span></div>
        <div class="cs-row"><span class="cs-k">Source Credibility</span><span class="cs-v">${escapeHtml(
          report.sourceCredibility?.level || "Unknown"
        )}</span></div>
        <div class="cs-row"><span class="cs-k">Domain</span><span class="cs-v">${escapeHtml(
          report.domain || "—"
        )}</span></div>
      </div>
      <div class="cs-section">
        <div class="cs-section-title">Reasoning</div>
        <ul class="cs-reasons">${reasons}</ul>
      </div>
      <div class="cs-section">
        <div class="cs-section-title">Verify</div>
        <div class="cs-links">${linkHtml}</div>
      </div>
      <p class="cs-disclaimer">Wording heuristics only — not a full fact-check.</p>
    </div>
  `;
}

function riskTone(pct) {
  if (pct >= 40) return "cs-hot";
  if (pct >= 12) return "cs-warm";
  return "cs-cool";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

if (typeof self !== "undefined") {
  self.buildAuthenticityReport = buildAuthenticityReport;
  self.buildQuickReport = buildQuickReport;
  self.buildTextReport = buildTextReport;
  self.renderReportHTML = renderReportHTML;
  self.reverseSearchLinks = reverseSearchLinks;
  self.detectPlatform = detectPlatform;
}
