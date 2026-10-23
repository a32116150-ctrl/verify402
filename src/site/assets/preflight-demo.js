/* verify402 — browser try-it panel for the free /preflight gate. */
(function () {
  "use strict";

  var form = document.getElementById("preflight-form");
  if (!form) return;

  var input = document.getElementById("preflight-request");
  var run = document.getElementById("preflight-run");
  var reset = document.getElementById("preflight-reset");
  var status = document.getElementById("preflight-status");
  var approvalForm = document.getElementById("approval-form");
  var approvalToken = document.getElementById("approval-token");
  var approvalSpender = document.getElementById("approval-spender");
  var approvalChain = document.getElementById("approval-chain");
  var approvalRun = document.getElementById("approval-run");
  var approvalSample = document.getElementById("approval-sample");
  var approvalStatus = document.getElementById("approval-status");
  var empty = document.getElementById("preflight-empty");
  var output = document.getElementById("preflight-output");
  var reasons = document.getElementById("preflight-reasons");
  var checked = document.getElementById("preflight-checked");
  var notChecked = document.getElementById("preflight-notchecked");
  var raw = document.getElementById("preflight-raw");
  var verdictEl = document.getElementById("preflight-verdict");
  var plain = document.getElementById("preflight-plain");
  var meta = document.getElementById("preflight-meta");
  var block = document.getElementById("preflight-block");
  var receipt = document.getElementById("preflight-receipt");
  var expires = document.getElementById("preflight-expires");
  var copy = document.getElementById("preflight-copy");
  var report = document.getElementById("preflight-report");
  var presets = Array.prototype.slice.call(document.querySelectorAll("[data-preflight-sample]"));

  var issueUrl = "https://github.com/a32116150-ctrl/verify402/issues/new?template=tester-feedback.yml";
  var copyLabel = copy ? copy.textContent : "Copy JSON";
  var activeSample = "payment";
  var lastJson = "";

  var samples = {
    payment: JSON.stringify({
      kind: "payment",
      payment: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "10000",
        payTo: "0xAeEF086DD4e436c69d6d0F684b4c9F43392df9cb",
        resource: "https://verify402.onrender.com/verify",
        maxTimeoutSeconds: 60
      },
      policy: { maxAmountUsd: 0.25, allowedResourceHosts: ["verify402.onrender.com"] }
    }, null, 2),
    block: JSON.stringify({
      kind: "transaction",
      chainId: 8453,
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      data: "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      value: "0",
      policy: { forbidUnlimitedApproval: true }
    }, null, 2)
  };

  function setStatusEl(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    if (isError) el.classList.add("is-error");
    else el.classList.remove("is-error");
  }

  function setStatus(text, isError) {
    setStatusEl(status, text, isError);
  }

  function isAddress(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(value);
  }

  function padAddress(value) {
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  }

  function plainSummary(data) {
    var verdict = String(data.verdict || "").toUpperCase();
    var codes = (Array.isArray(data.reasons) ? data.reasons : []).map(function (reason) {
      return reason && reason.code;
    });

    if (codes.indexOf("unlimited_approval") !== -1) {
      return "This approval is unlimited. If you sign it, the spender can move your entire balance of this token. Do not sign unless you trust the spender completely.";
    }
    if (codes.indexOf("target_not_contract") !== -1) {
      return "That token address has no contract on the selected network. Check the address and the network.";
    }
    if (verdict === "BLOCK") return "The gate says do not sign this. Read the reasons below.";
    if (verdict === "CAUTION") return "The gate says pause. Read the reasons before signing.";
    if (verdict === "PASS") return "The listed checks passed at this block. Read what was not checked before signing.";
    return "The gate returned a verdict. Read the reasons and the checks below.";
  }

  function setBusy(busy) {
    form.setAttribute("aria-busy", busy ? "true" : "false");
    approvalForm.setAttribute("aria-busy", busy ? "true" : "false");
    input.disabled = busy;
    run.disabled = busy;
    reset.disabled = busy;
    approvalToken.disabled = busy;
    approvalSpender.disabled = busy;
    approvalChain.disabled = busy;
    approvalRun.disabled = busy;
    approvalSample.disabled = busy;
    presets.forEach(function (btn) { btn.disabled = busy; });
    run.textContent = busy ? "Running…" : "Run free check";
    approvalRun.textContent = busy ? "Checking…" : "Check approval";
  }

  function clearResult(resetStatus) {
    empty.hidden = false;
    output.hidden = true;
    reasons.textContent = "";
    raw.textContent = "";
    plain.textContent = "";
    lastJson = "";
    if (resetStatus !== false) setStatus("Ready", false);
  }

  function selectSample(name) {
    activeSample = name;
    if (samples[name]) input.value = samples[name];
    presets.forEach(function (btn) {
      var on = btn.getAttribute("data-preflight-sample") === name;
      btn.classList.toggle("is-active", on);
    });
    clearResult();
  }

  function addReason(reason) {
    var li = document.createElement("li");
    li.className = "try-reason";

    var head = document.createElement("div");
    head.className = "try-reason-head";

    var code = document.createElement("code");
    code.textContent = reason.code || "reason";
    head.appendChild(code);

    if (reason.severity) {
      head.appendChild(document.createTextNode(" "));
      var sev = document.createElement("span");
      sev.className = "try-sev " + String(reason.severity).toLowerCase();
      sev.textContent = reason.severity;
      head.appendChild(sev);
    }

    var message = document.createElement("p");
    message.textContent = reason.message || "";

    li.appendChild(head);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(message);
    reasons.appendChild(li);
  }

  function render(data) {
    var verdict = String(data.verdict || "UNKNOWN").toUpperCase();

    lastJson = JSON.stringify(data, null, 2);
    empty.hidden = true;
    output.hidden = false;

    verdictEl.textContent = verdict;
    verdictEl.className = "try-verdict " + verdict.toLowerCase();
    plain.textContent = plainSummary(data);
    plain.className = "try-plain " + verdict.toLowerCase();
    meta.textContent = "sign_allowed: " + String(data.sign_allowed) + " · requires_ack: " + String(data.requires_ack);

    if (data.block && typeof data.block === "object" && data.block.number != null) {
      block.textContent = "#" + data.block.number + (data.block.ageSeconds != null ? " · " + data.block.ageSeconds + "s old" : "");
    } else {
      var testnetUnbound = Array.isArray(data.notChecked) && data.notChecked.indexOf("evm block binding (testnet chain)") !== -1;
      block.textContent = testnetUnbound ? "not bound (testnet payment)" : "not bound";
    }

    var r = data.receipt || {};
    receipt.textContent = r.id || "—";
    expires.textContent = r.expiresAt || "—";

    reasons.textContent = "";
    if (Array.isArray(data.reasons) && data.reasons.length) {
      data.reasons.forEach(addReason);
    } else {
      var none = document.createElement("li");
      none.className = "try-none";
      none.textContent = "No reasons returned.";
      reasons.appendChild(none);
    }

    checked.textContent = Array.isArray(data.checked) && data.checked.length ? data.checked.join(" · ") : "—";
    notChecked.textContent = Array.isArray(data.notChecked) && data.notChecked.length ? data.notChecked.join(" · ") : "—";
    raw.textContent = lastJson;
    report.href = issueUrl + "&title=" + encodeURIComponent("Preflight result: " + verdict);
    copy.disabled = false;
  }

  function showError(data, text, statusCode) {
    empty.hidden = true;
    output.hidden = false;

    verdictEl.textContent = "ERROR";
    verdictEl.className = "try-verdict error";
    plain.textContent = "The request did not return a verdict. Read the raw response or try again.";
    plain.className = "try-plain block";
    meta.textContent = statusCode ? "HTTP " + statusCode : "No response";
    block.textContent = "—";
    receipt.textContent = "—";
    expires.textContent = "—";

    reasons.textContent = "";
    addReason({
      code: (data && data.error) || "request_failed",
      severity: "error",
      message: (data && data.message) || "The gate did not return a verdict. Try again, or report this result."
    });

    checked.textContent = "—";
    notChecked.textContent = "—";
    lastJson = text || "";
    raw.textContent = lastJson || "No response body.";
    report.href = issueUrl + "&title=" + encodeURIComponent("Preflight request failed");
    copy.disabled = !lastJson;
  }

  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (err) {}
      document.body.removeChild(ta);
      done();
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function runCheck(payloadOverride, statusTarget) {
    var target = statusTarget || status;
    var payload;

    if (payloadOverride) {
      payload = payloadOverride;
    } else {
      var text = input.value.trim();
      if (!text) {
        clearResult();
        setStatusEl(target, "Paste a request first.", true);
        input.focus();
        return;
      }

      try {
        payload = JSON.parse(text);
      } catch (err) {
        clearResult();
        setStatusEl(target, "That is not valid JSON.", true);
        input.focus();
        return;
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        clearResult();
        setStatusEl(target, "The request must be a JSON object.", true);
        input.focus();
        return;
      }
    }

    if (typeof fetch !== "function") {
      setStatusEl(target, "This browser cannot call the gate. Use the curl examples below.", true);
      return;
    }

    clearResult(false);
    setBusy(true);
    setStatusEl(target, "Contacting the gate — a cold start can take ~30s.", false);

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 45000) : null;

    fetch("/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.text().then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    }).then(function (out) {
      if (timer) clearTimeout(timer);
      var data = null;
      try { data = JSON.parse(out.body); } catch (err) { data = null; }

      if (!out.ok) {
        setStatusEl(target, (data && (data.message || data.error)) || ("HTTP " + out.status + " from the gate."), true);
        showError(data, out.body, out.status);
        return;
      }

      if (!data || typeof data !== "object") {
        setStatusEl(target, "The gate returned a non-JSON response.", true);
        showError(null, out.body, out.status);
        return;
      }

      render(data);
      setStatusEl(target, "Live response" + (data.elapsedMs != null ? " · " + data.elapsedMs + " ms" : "") + ". Nothing was signed.", false);
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === "AbortError") {
        setStatusEl(target, "Timed out after 45s. The free host may be waking; try again.", true);
      } else {
        setStatusEl(target, "Network error. Check your connection and try again.", true);
      }
      showError(null, "", 0);
    }).then(function () {
      setBusy(false);
    });
  }

  function runApprovalCheck() {
    var token = approvalToken.value.trim();
    var spender = approvalSpender.value.trim();

    if (!isAddress(token)) {
      clearResult(false);
      setStatusEl(approvalStatus, "Enter the token contract address: 0x plus 40 hex characters.", true);
      approvalToken.focus();
      return;
    }

    if (!isAddress(spender)) {
      clearResult(false);
      setStatusEl(approvalStatus, "Enter the spender address: 0x plus 40 hex characters.", true);
      approvalSpender.focus();
      return;
    }

    var payload = {
      kind: "transaction",
      chainId: Number(approvalChain.value),
      to: token,
      data: "0x095ea7b3" + padAddress(spender) + "f".repeat(64),
      value: "0",
      policy: { forbidUnlimitedApproval: true }
    };

    input.value = JSON.stringify(payload, null, 2);
    runCheck(payload, approvalStatus);
  }

  function onApprovalEdit() {
    if (!output.hidden) {
      clearResult(false);
      setStatusEl(approvalStatus, "Edited — run the check again.", false);
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    runCheck();
  });

  approvalForm.addEventListener("submit", function (event) {
    event.preventDefault();
    runApprovalCheck();
  });

  approvalSample.addEventListener("click", function () {
    approvalToken.value = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    approvalSpender.value = "0x1111111111111111111111111111111111111111";
    approvalChain.value = "8453";
    clearResult(false);
    setStatusEl(approvalStatus, "Base USDC sample loaded. Run the check.", false);
  });

  [approvalToken, approvalSpender].forEach(function (field) {
    field.addEventListener("input", onApprovalEdit);
  });
  approvalChain.addEventListener("change", onApprovalEdit);

  presets.forEach(function (btn) {
    btn.addEventListener("click", function () {
      selectSample(btn.getAttribute("data-preflight-sample"));
    });
  });

  input.addEventListener("input", function () {
    presets.forEach(function (btn) { btn.classList.remove("is-active"); });
    if (!output.hidden) clearResult();
  });

  input.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runCheck();
    }
  });

  reset.addEventListener("click", function () {
    selectSample(activeSample);
    input.focus();
  });

  copy.addEventListener("click", function () {
    if (!lastJson) return;
    copyText(lastJson, function () {
      copy.textContent = "Copied ✓";
      setTimeout(function () { copy.textContent = copyLabel; }, 1600);
    });
  });

  selectSample("payment");
  setBusy(false);
})();
