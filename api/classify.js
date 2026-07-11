/**
 * checkSource.ai — server-side image classify proxy
 * HF token lives only in Vercel env (HF_TOKEN), never in the extension.
 */

const MODEL_PRIMARY = "dima806/deepfake_vs_real_image_detection";
const MODEL_SECONDARY = "capcheck/ai-human-generated-image-detection";
const MODELS = [MODEL_PRIMARY, MODEL_SECONDARY];
const AI_THRESHOLD = 0.5;
const REAL_CONFIDENT = 0.2;

function modelUrl(modelId, legacy = false) {
  if (legacy) return `https://api-inference.huggingface.co/models/${modelId}`;
  return `https://router.huggingface.co/hf-inference/models/${modelId}`;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.HF_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Analysis service is not configured yet." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { imageBase64 } = body;
    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    const raw = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "Empty image" });
      return;
    }
    if (buffer.length > 5 * 1024 * 1024) {
      res.status(413).json({ error: "Image too large" });
      return;
    }

    const hf = await runEnsemble(buffer, token);
    res.status(200).json(hf);
  } catch (err) {
    res.status(500).json({ error: err.message || "Classify failed", score: null });
  }
};

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

  const primary = ok.find((r) => r.modelId === MODEL_PRIMARY) || ok[0];
  const secondary = ok.find((r) => r !== primary) || null;
  const p = primary.score;
  const s = secondary ? secondary.score : null;

  let score;
  let agreement;
  let label;
  let uncertain = false;
  const notes = [];

  if (!secondary) {
    score = p;
    agreement = "single";
    label = p >= AI_THRESHOLD ? "Fake" : "Real";
    uncertain = p >= 0.35 && p < AI_THRESHOLD;
  } else if (p < REAL_CONFIDENT && s >= 0.75) {
    score = p;
    agreement = "primary_override";
    label = "Real";
    notes.push("Secondary detector over-fired; primary confident real — using primary");
  } else if (p >= AI_THRESHOLD && s >= AI_THRESHOLD) {
    score = (p + s) / 2;
    agreement = "agree";
    label = "Fake";
  } else if (p >= AI_THRESHOLD) {
    score = p * 0.7 + s * 0.3;
    agreement = "primary_ai";
    label = "Fake";
    uncertain = score < 0.55;
  } else if (s >= AI_THRESHOLD && p >= 0.25) {
    score = (p + s) / 2;
    agreement = "elevated";
    label = score >= AI_THRESHOLD ? "Fake" : "Uncertain";
    uncertain = score < AI_THRESHOLD;
  } else if (p < REAL_CONFIDENT && s < AI_THRESHOLD) {
    score = (p + s) / 2;
    agreement = "agree";
    label = "Real";
  } else {
    score = p * 0.75 + s * 0.25;
    agreement = "weighted";
    if (score >= AI_THRESHOLD) label = "Fake";
    else if (score < REAL_CONFIDENT) label = "Real";
    else {
      label = "Uncertain";
      uncertain = true;
    }
  }

  score = Math.min(1, Math.max(0, score));
  return {
    isAI: !uncertain && score >= AI_THRESHOLD,
    score,
    label,
    uncertain,
    threshold: AI_THRESHOLD,
    modelAgreement: agreement,
    disagreement: secondary ? Math.round(Math.abs(p - s) * 100) : 0,
    ensembleNotes: notes,
    ensemble: ok.map((r) => ({
      model: "detector",
      label: r.label,
      aiScore: Math.round(r.score * 100),
      realScore: r.realScore != null ? Math.round(r.realScore * 100) : null,
    })),
    avgScore: secondary ? (p + s) / 2 : p,
    raw: primary.raw,
  };
}

async function callHuggingFace(imageBytes, token, endpoint, modelId) {
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
      throw new Error("Analysis service auth failed.");
    }
    if (response.status === 429) {
      throw new Error("Rate limited. Wait a bit and retry.");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`API ${response.status}: ${text.slice(0, 120) || response.statusText}`);
    }
    const normalized = normalizeHfResponse(await response.json());
    normalized.modelId = modelId;
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

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

  const top = [...normalized].sort((a, b) => b.score - a.score)[0];
  let aiScore;
  if (fakeScore != null) aiScore = fakeScore;
  else if (realScore != null) aiScore = 1 - realScore;
  else if (aiRe.test(top.label)) aiScore = top.score;
  else if (realRe.test(top.label)) aiScore = 1 - top.score;
  else aiScore = top.score;

  aiScore = Math.min(1, Math.max(0, aiScore));
  return {
    isAI: aiScore >= AI_THRESHOLD,
    score: aiScore,
    realScore: realScore != null ? realScore : 1 - aiScore,
    label: aiScore >= AI_THRESHOLD ? "Fake" : "Real",
    topLabel: top.label,
    topScore: top.score,
    raw: normalized,
  };
}
