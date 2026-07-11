const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { hfToken = "", autoDetect = true } = await chrome.storage.sync.get({
    hfToken: "",
    autoDetect: true,
  });

  $("hfToken").value = hfToken;
  $("autoDetect").checked = autoDetect !== false;
  setTokenStatus(Boolean(hfToken));

  $("autoDetect").addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ autoDetect: e.target.checked });
  });

  $("saveToken").addEventListener("click", async () => {
    const token = $("hfToken").value.trim();
    await chrome.storage.sync.set({ hfToken: token });
    setTokenStatus(Boolean(token), true);
  });

  $("analyzeBtn").addEventListener("click", onAnalyze);
  $("imageUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAnalyze();
  });
});

function setTokenStatus(hasToken, justSaved = false) {
  const el = $("tokenStatus");
  if (!hasToken) {
    el.textContent = "No token saved — AI scores need a token.";
    el.className = "status err";
    return;
  }
  el.textContent = justSaved ? "Token saved." : "Token on file.";
  el.className = "status ok";
}

async function onAnalyze() {
  const url = $("imageUrl").value.trim();
  const resultEl = $("result");
  const btn = $("analyzeBtn");

  if (!url) {
    resultEl.hidden = false;
    resultEl.innerHTML = renderReportHTML({ error: "Paste an image URL first." });
    return;
  }

  btn.disabled = true;
  btn.textContent = "…";
  resultEl.hidden = false;
  resultEl.innerHTML = renderReportHTML(buildQuickReport(url, ""));

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({
      type: "ANALYZE_IMAGE",
      src: url,
      pageUrl: tab?.url || "",
    });
    resultEl.innerHTML = renderReportHTML(result);
    if (tab?.id) {
      chrome.tabs
        .sendMessage(tab.id, { type: "SHOW_RESULT", src: url, result, openCard: true })
        .catch(() => {});
    }
  } catch (err) {
    resultEl.innerHTML = renderReportHTML({ error: err.message || "Failed" });
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}
