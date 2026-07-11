/**
 * checkSource.ai — background service worker
 * Fast path: cache + downsample before HF inference.
 */

importScripts("lib/signals.js", "lib/report.js");

const MODEL_PRIMARY = "dima806/deepfake_vs_real_image_detection";
// sdxl-detector over-fires on real news/Getty photos — replaced
const MODEL_SECONDARY = "capcheck/ai-human-generated-image-detection";
const MODELS = [MODEL_PRIMARY, MODEL_SECONDARY];

const AI_THRESHOLD = 0.5;
const REAL_CONFIDENT = 0.2; // primary Fake score below this = confident real
const CACHE_VERSION = "v6";

function modelUrl(modelId, legacy = false) {
  if (legacy) return `https://api-inference.huggingface.co/models/${modelId}`;
  return `https://router.huggingface.co/hf-inference/models/${modelId}`;
}

const MEMORY_CACHE = new Map();
const INFLIGHT = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const INFER_MAX_EDGE = 384; // model native ~224; smaller = faster, enough for vit

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "checksource-analyze-image",
      title: "Analyze with checkSource.ai",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "checksource-analyze-selection",
      title: "Check selection with checkSource.ai",
      contexts: ["selection"],
    });
  });

  chrome.storage.sync.get({ autoDetect: true }, (cfg) => {
    if (cfg.autoDetect === undefined) chrome.storage.sync.set({ autoDetect: true });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "checksource-analyze-image" && info.srcUrl) {
    try {
      const result = await analyzeImage(info.srcUrl, { pageUrl: tab.url || "" });
      chrome.tabs
        .sendMessage(tab.id, { type: "SHOW_RESULT", src: info.srcUrl, result, openCard: true })
        .catch(() => {});
    } catch (err) {
      console.error("[checkSource.ai]", err);
    }
    return;
  }

  if (info.menuItemId === "checksource-analyze-selection" && info.selectionText) {
    const result = buildTextReport(info.selectionText, tab.url || "");
    chrome.tabs
      .sendMessage(tab.id, { type: "SHOW_TEXT_RESULT", result, openCard: true })
      .catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ANALYZE_IMAGE") {
    const pageUrl = message.pageUrl || sender?.tab?.url || "";
    analyzeImage(message.src, {
      pageUrl,
      pageHints: message.pageHints || null,
    })
      .then(sendResponse)
      .catch((err) =>
        sendResponse(
          buildAuthenticityReport({
            src: message.src,
            pageUrl,
            error: err.message || "Analysis failed",
          })
        )
      );
    return true;
  }

  if (message?.type === "ANALYZE_TEXT") {
    sendResponse(buildTextReport(message.text || "", message.pageUrl || sender?.tab?.url || ""));
    return false;
  }

  if (message?.type === "GET_STATUS") {
    chrome.storage.sync.get(["hfToken", "autoDetect"], (cfg) => {
      sendResponse({
        hasToken: Boolean(cfg.hfToken),
        autoDetect: cfg.autoDetect !== false,
      });
    });
    return true;
  }

  return false;
});

async function analyzeImage(src, { pageUrl = "", pageHints = null } = {}) {
  if (!src || typeof src !== "string") {
    return buildAuthenticityReport({ src, pageUrl, error: "Invalid image URL" });
  }

  const cacheKey = `${CACHE_VERSION}|${src}`;
  const cached = MEMORY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return calibrateResult(cached.result, pageUrl, pageHints);
  }

  if (INFLIGHT.has(cacheKey)) {
    const result = await INFLIGHT.get(cacheKey);
    return calibrateResult(result, pageUrl, pageHints);
  }

  const promise = runAnalyze(src, pageUrl, cacheKey);
  INFLIGHT.set(cacheKey, promise);
  try {
    const result = await promise;
    return calibrateResult(result, pageUrl, pageHints);
  } finally {
    INFLIGHT.delete(cacheKey);
  }
}

/**
 * Post-process. Publisher never changes AI score.
 * Page text about fakes may raise concern.
 */
function calibrateResult(result, pageUrl, pageHints) {
  if (!result || result.error) return result;

  const out = {
    ...result,
    reasoning: [...(result.reasoning || [])],
    deepfake: result.deepfake ? { ...result.deepfake } : result.deepfake,
    overallRisk: result.overallRisk ? { ...result.overallRisk } : result.overallRisk,
  };

  let score = clamp01(out.score ?? (out.aiProbability ?? 0) / 100);
  let uncertain = Boolean(out.uncertain);
  let isAI = Boolean(out.isAI);

  if (pageHints?.mentionsAIFake) {
    out.pageContextFlag = true;
    out.reasoning.unshift(
      "Page/caption discusses AI-generated or fake imagery — raising concern"
    );
    if (score < 0.5) {
      score = Math.max(score, 0.62);
      isAI = true;
      uncertain = false;
    }
  }

  if (pageHints?.hasWireCredit) {
    out.reasoning.push(
      "Wire-style credit noted (AP/Getty/Reuters) — credit is not proof; models decide"
    );
  }

  const aiProbability = Math.round(score * 100);

  if (uncertain) {
    out.overallRisk = {
      level: "Uncertain",
      label: "Inconclusive — check reverse search links below",
    };
    out.deepfake = {
      level: "Medium",
      score: aiProbability,
      detail: "Models not confident enough for a hard call",
    };
  } else if (isAI) {
    out.overallRisk = {
      level: aiProbability >= 70 ? "Critical" : "Elevated",
      label:
        aiProbability >= 70
          ? "High risk — treat as synthetic / manipulated"
          : "Elevated AI signal — verify before sharing",
    };
    out.deepfake = {
      level: aiProbability >= 70 ? "High" : "Medium",
      score: aiProbability,
      detail: "Detector indicates synthetic patterns",
    };
  } else {
    out.overallRisk = {
      level: "Low",
      label: "Likely original photograph — still not forensic proof",
    };
    out.deepfake = {
      level: "Low",
      score: aiProbability,
      detail: "No strong synthetic signal",
    };
  }

  out.score = score;
  out.aiProbability = aiProbability;
  out.isAI = isAI;
  out.uncertain = uncertain;
  return out;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

async function runAnalyze(src, pageUrl, cacheKey) {
  try {
    const sk = `cs:${hashKey(cacheKey)}`;
    const stored = await chrome.storage.session.get(sk);
    const entry = stored[sk];
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
      MEMORY_CACHE.set(cacheKey, entry);
      return entry.result;
    }
  } catch {
    /* ignore */
  }

  const { hfToken } = await chrome.storage.sync.get({ hfToken: "" });
  if (!hfToken) {
    return buildAuthenticityReport({
      src,
      pageUrl,
      error: "Add your Hugging Face token in the extension popup.",
    });
  }

  let imageBytes;
  try {
    imageBytes = await fetchImageBytes(src);
  } catch (err) {
    return buildAuthenticityReport({
      src,
      pageUrl,
      error: `Could not fetch image: ${err.message}`,
    });
  }

  // Metadata from original bytes (fast, local)
  const signals = probeImageSignals(imageBytes, src);

  // Smaller JPEG for faster HF upload/inference
  const inferBytes = await downsampleForInference(imageBytes);

  // Ensemble: agreement-aware blend (never let one alarmist model dominate)
  const hf = await runEnsemble(inferBytes, hfToken);

  if (hf?.error && hf.score == null) {
    return buildAuthenticityReport({ src, pageUrl, signals, error: hf.error });
  }

  const result = buildAuthenticityReport({ src, pageUrl, hf, signals });
  const entry = { at: Date.now(), result };
  MEMORY_CACHE.set(cacheKey, entry);
  try {
    await chrome.storage.session.set({ [`cs:${hashKey(cacheKey)}`]: entry });
  } catch {
    /* ignore */
  }
  return result;
}

async function runEnsemble(inferBytes, token) {
  const results = await Promise.all(
    MODELS.map(async (modelId) => {
      try {
        return await callHuggingFace(inferBytes, token, modelUrl(modelId), modelId);
      } catch (err) {
        try {
          return await callHuggingFace(inferBytes, token, modelUrl(modelId, true), modelId);
        } catch (err2) {
          return { error: err2.message || err.message, modelId, score: null };
        }
      }
    })
  );

  const ok = results.filter((r) => r && r.score != null && !r.error);
  if (!ok.length) {
    return { error: results[0]?.error || "All detectors failed", score: null };
  }

  const primary =
    ok.find((r) => r.modelId === MODEL_PRIMARY) || ok[0];
  const secondary = ok.find((r) => r !== primary) || null;

  const p = primary.score; // AI/Fake probability from primary
  const s = secondary ? secondary.score : null;

  let score;
  let agreement;
  let label;
  let uncertain = false;
  let notes = [];

  if (!secondary) {
    score = p;
    agreement = "single";
    label = p >= AI_THRESHOLD ? "Fake" : "Real";
    uncertain = p >= 0.35 && p < AI_THRESHOLD;
  } else if (p < REAL_CONFIDENT && s >= 0.75) {
    // Classic false-positive pattern: primary sure it's real, secondary alone screams AI
    // Trust primary — this was breaking every CNN/Getty photo with sdxl-detector
    score = p;
    agreement = "primary_override";
    label = "Real";
    uncertain = false;
    notes.push(
      `Secondary model alone flagged AI (${Math.round(s * 100)}%) while primary is confident real (${Math.round((1 - p) * 100)}%) — using primary`
    );
  } else if (p >= AI_THRESHOLD && s >= AI_THRESHOLD) {
    // Both say AI
    score = (p + s) / 2;
    agreement = "agree";
    label = "Fake";
    uncertain = false;
  } else if (p >= AI_THRESHOLD) {
    // Primary says AI; secondary softer — still lean AI from primary
    score = p * 0.7 + s * 0.3;
    agreement = "primary_ai";
    label = "Fake";
    uncertain = score < 0.55;
  } else if (s >= AI_THRESHOLD && p >= 0.25) {
    // Secondary AI + primary somewhat elevated → raise toward AI
    score = (p + s) / 2;
    agreement = "elevated";
    label = score >= AI_THRESHOLD ? "Fake" : "Uncertain";
    uncertain = score < AI_THRESHOLD;
  } else if (p < REAL_CONFIDENT && s < AI_THRESHOLD) {
    // Both lean real
    score = (p + s) / 2;
    agreement = "agree";
    label = "Real";
    uncertain = false;
  } else {
    // Mild disagreement — primary-weighted, clear Real/AI when possible
    score = p * 0.75 + s * 0.25;
    agreement = "weighted";
    if (score >= AI_THRESHOLD) {
      label = "Fake";
      uncertain = false;
    } else if (score < REAL_CONFIDENT) {
      label = "Real";
      uncertain = false;
    } else {
      label = "Uncertain";
      uncertain = true;
    }
  }

  score = clamp01(score);
  const isAI = !uncertain && score >= AI_THRESHOLD;

  return {
    isAI,
    score,
    label,
    uncertain,
    threshold: AI_THRESHOLD,
    modelAgreement: agreement,
    disagreement: secondary ? Math.round(Math.abs(p - s) * 100) : 0,
    ensembleNotes: notes,
    ensemble: ok.map((r) => ({
      model: r.modelId,
      label: r.label,
      aiScore: Math.round(r.score * 100),
      realScore: r.realScore != null ? Math.round(r.realScore * 100) : null,
    })),
    avgScore: secondary ? (p + s) / 2 : p,
    raw: primary.raw,
  };
}

function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

async function fetchImageBytes(src) {
  if (src.startsWith("data:")) {
    const base64 = src.split(",")[1];
    if (!base64) throw new Error("Empty data URL");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image too large");
    return bytes.buffer;
  }

  if (src.startsWith("blob:")) {
    throw new Error("Blob images aren’t supported — try right-click on a normal image.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(src, {
      method: "GET",
      credentials: "omit",
      cache: "force-cache",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error("Empty image");
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image too large (max 5MB)");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function downsampleForInference(arrayBuffer) {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return arrayBuffer;
    }
    const blob = new Blob([arrayBuffer]);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, INFER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    return await out.arrayBuffer();
  } catch (err) {
    console.warn("[checkSource.ai] downsample skipped", err);
    return arrayBuffer;
  }
}

async function callHuggingFace(imageBytes, token, endpoint, modelId = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: imageBytes,
      signal: controller.signal,
    });

    if (response.status === 503) {
      const body = await response.json().catch(() => ({}));
      const wait = body.estimated_time ? ` (~${Math.ceil(body.estimated_time)}s)` : "";
      throw new Error(`Model is loading${wait}. Try again in a moment.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid Hugging Face token. Update it in the popup.");
    }
    if (response.status === 429) {
      throw new Error("Rate limited by Hugging Face. Wait a bit and retry.");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HF API ${response.status}: ${text.slice(0, 160) || response.statusText}`);
    }
    const normalized = normalizeHfResponse(await response.json());
    normalized.modelId = modelId;
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Correct scoring:
 * - Fake/AI class score = AI probability
 * - Real class score = real probability
 * - Top label = highest score overall (never contradict AI %)
 * - Threshold lowered for older models (concept drift)
 */
function normalizeHfResponse(data) {
  if (data?.error) return { error: data.error, isAI: false, score: null };

  let rows = data;
  if (Array.isArray(data) && Array.isArray(data[0])) rows = data[0];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: "Unexpected model response", isAI: false, score: null };
  }

  const normalized = rows.map((r) => ({
    label: String(r.label || ""),
    score: Number(r.score) || 0,
  }));

  const aiRe = /fake|ai|generated|deepfake|synthetic|artificial|gan|diffusion/i;
  const realRe = /real|authentic|human|original|live|photo/i;

  let fakeScore = null;
  let realScore = null;

  for (const row of normalized) {
    if (aiRe.test(row.label)) fakeScore = Math.max(fakeScore ?? 0, row.score);
    if (realRe.test(row.label)) realScore = Math.max(realScore ?? 0, row.score);
  }

  // Top class by raw score
  const top = [...normalized].sort((a, b) => b.score - a.score)[0];

  let aiScore;
  if (fakeScore != null && realScore != null) {
    // Prefer explicit Fake probability (not 1-Real), then reconcile with top class
    aiScore = fakeScore;
  } else if (fakeScore != null) {
    aiScore = fakeScore;
  } else if (realScore != null) {
    aiScore = 1 - realScore;
  } else if (aiRe.test(top.label)) {
    aiScore = top.score;
  } else if (realRe.test(top.label)) {
    aiScore = 1 - top.score;
  } else {
    aiScore = top.score;
  }

  aiScore = Math.min(1, Math.max(0, aiScore));

  // Label shown to user must match decision
  let displayLabel;
  if (aiScore >= AI_THRESHOLD) {
    displayLabel = fakeScore != null ? findLabel(normalized, aiRe) || "Fake" : top.label;
  } else {
    displayLabel = realScore != null ? findLabel(normalized, realRe) || "Real" : top.label;
  }

  return {
    isAI: aiScore >= AI_THRESHOLD,
    score: aiScore,
    realScore: realScore != null ? realScore : 1 - aiScore,
    label: displayLabel,
    topLabel: top.label,
    topScore: top.score,
    raw: normalized,
  };
}

function findLabel(rows, re) {
  const hit = rows.find((r) => re.test(r.label));
  return hit?.label || "";
}
