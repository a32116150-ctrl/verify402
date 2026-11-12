/* verify402 — browser panel for the free /inspect 402 inspector. */
(function () {
  "use strict";

  var form = document.getElementById("inspect-form");
  if (!form) return;

  var urlInput = document.getElementById("inspect-url");
  var methodInput = document.getElementById("inspect-method");
  var run = document.getElementById("inspect-run");
  var status = document.getElementById("inspect-status");
  var pasteForm = document.getElementById("inspect-paste-form");
  var pasteInput = document.getElementById("inspect-challenge");
  var pasteRun = document.getElementById("inspect-paste-run");
  var pasteStatus = document.getElementById("inspect-paste-status");

  var empty = document.getElementById("inspect-empty");
  var output = document.getElementById("inspect-output");
  var verdictEl = document.getElementById("inspect-verdict");
  var meta = document.getElementById("inspect-meta");
  var plain = document.getElementById("inspect-plain");
  var price = document.getElementById("inspect-price");
  var network = document.getElementById("inspect-network");
  var token = document.getElementById("inspect-token");
  var payee = document.getElementById("inspect-payee");
  var resource = document.getElementById("inspect-resource");
  var reasons = document.getElementById("inspect-reasons");
  var optionsWrap = document.getElementById("inspect-options-wrap");
  var optionsList = document.getElementById("inspect-options");
  var checked = document.getElementById("inspect-checked");
  var notChecked = document.getElementById("inspect-notchecked");
  var raw = document.getElementById("inspect-raw");
  var copy = document.getElementById("inspect-copy");
  var again = document.getElementById("inspect-again");

  var copyLabel = copy ? copy.textContent : "Copy JSON";
  var lastJson = "";

  function setStatus(node, text, busy) {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("busy", Boolean(busy));
  }

  function short(value, head, tail) {
    if (!value) return "—";
    var text = String(value);
    if (text.length <= head + tail + 1) return text;
    return text.slice(0, head) + "…" + text.slice(-tail);
  }

  function money(option) {
    if (!option) return "—";
    if (option.priceUsd != null) {
      var text = "$" + option.priceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      if (option.token) text += " " + option.token;
      if (option.priceBasis && option.priceBasis !== "canonical") text += " (parity assumed)";
      return text;
    }
    if (option.amount != null) return option.amount + " raw units";
    return "—";
  }

  function reasonItem(reason) {
    var li = document.createElement("li");
    li.className = reason.severity === "block" ? "bad" : "warn";
    var code = document.createElement("code");
    code.className = "inline";
    code.textContent = reason.code;
    li.appendChild(code);
    li.appendChild(document.createTextNode(" " + reason.message));
    return li;
  }

  function render(data) {
    lastJson = JSON.stringify(data, null, 2);
    var option = data.options && data.options[0] ? data.options[0] : null;
    var accept = option && option.accept ? option.accept : null;
    var verdict = data.verdict || "UNKNOWN";

    empty.hidden = true;
    output.hidden = false;

    verdictEl.textContent = verdict;
    verdictEl.className = "try-verdict " + (verdict === "PASS" ? "pass" : verdict === "BLOCK" ? "block" : "caution");

    meta.textContent = (data.status ? "HTTP " + data.status + " · " : "") +
      (data.challenge && data.challenge.acceptCount ? data.challenge.acceptCount + " option" + (data.challenge.acceptCount === 1 ? "" : "s") : "");

    plain.textContent = data.summary ||
      (verdict === "BLOCK"
        ? "Do not pay this challenge. At least one check failed."
        : verdict === "CAUTION"
          ? "Pay only after reading the reasons: the gate could not verify everything."
          : "The structural checks passed. This is not proof the seller controls the payee.");

    price.textContent = money(accept);
    network.textContent = accept && accept.network ? accept.network : "—";
    token.textContent = accept && accept.asset
      ? (accept.token ? accept.token + " · " : "") + short(accept.asset, 10, 6)
      : "—";
    payee.textContent = accept && accept.payTo ? short(accept.payTo, 10, 6) : "—";
    resource.textContent = data.challenge && data.challenge.resource ? data.challenge.resource : "—";

    reasons.textContent = "";
    var list = data.reasons || [];
    if (!list.length) {
      var ok = document.createElement("li");
      ok.className = "ok";
      ok.textContent = "No blocking or caution reasons.";
      reasons.appendChild(ok);
    } else {
      list.forEach(function (reason) { reasons.appendChild(reasonItem(reason)); });
    }

    optionsList.textContent = "";
    var options = data.options || [];
    optionsWrap.hidden = options.length <= 1;
    options.forEach(function (entry, index) {
      var li = document.createElement("li");
      li.className = entry.verdict === "BLOCK" ? "bad" : entry.verdict === "CAUTION" ? "warn" : "ok";
      li.textContent = "Option " + (index + 1) + ": " + money(entry.accept) + " on " +
        (entry.accept && entry.accept.network ? entry.accept.network : "unknown network") +
        " → " + entry.verdict;
      optionsList.appendChild(li);
    });

    checked.textContent = (data.checked || []).join(" · ") || "—";
    notChecked.textContent = (data.notChecked || []).join(" · ") || "—";
    raw.textContent = lastJson;
  }

  function fail(node, error) {
    empty.hidden = true;
    output.hidden = false;
    lastJson = JSON.stringify(error, null, 2);
    verdictEl.textContent = "ERROR";
    verdictEl.className = "try-verdict error";
    meta.textContent = error.code || "";
    plain.textContent = error.message || "The inspection failed.";
    price.textContent = network.textContent = token.textContent = payee.textContent = resource.textContent = "—";
    reasons.textContent = "";
    var li = document.createElement("li");
    li.className = "bad";
    li.textContent = error.message || error.code || "unknown error";
    reasons.appendChild(li);
    optionsWrap.hidden = true;
    checked.textContent = notChecked.textContent = "—";
    raw.textContent = lastJson;
  }

  function post(body, buttons) {
    buttons.forEach(function (button) { button.disabled = true; });
    return fetch("/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw payload;
        return payload;
      });
    }).finally(function () {
      buttons.forEach(function (button) { button.disabled = false; });
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var url = urlInput.value.trim();
    if (!url) {
      setStatus(status, "Paste an endpoint URL first");
      urlInput.focus();
      return;
    }
    setStatus(status, "Fetching the challenge…", true);
    post({ url: url, method: methodInput ? methodInput.value : "GET" }, [run]).then(function (data) {
      render(data);
      setStatus(status, data.verdict + " · " + (data.status || "ok"));
    }).catch(function (error) {
      fail(status, error);
      setStatus(status, error.code || "failed");
    });
  });

  if (pasteForm) {
    pasteForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = pasteInput.value.trim();
      if (!text) {
        setStatus(pasteStatus, "Paste a challenge first");
        pasteInput.focus();
        return;
      }
      var body;
      if (text.charAt(0) === "{") {
        try {
          body = { challenge: JSON.parse(text) };
        } catch (e) {
          setStatus(pasteStatus, "That is not valid JSON");
          return;
        }
      } else {
        body = { header: text };
      }
      setStatus(pasteStatus, "Checking…", true);
      post(body, [pasteRun]).then(function (data) {
        render(data);
        setStatus(pasteStatus, data.verdict);
      }).catch(function (error) {
        fail(pasteStatus, error);
        setStatus(pasteStatus, error.code || "failed");
      });
    });
  }

  if (copy) {
    copy.addEventListener("click", function () {
      if (!lastJson) return;
      var done = function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = copyLabel; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastJson).then(done, done);
      } else {
        done();
      }
    });
  }

  if (again) {
    again.addEventListener("click", function () {
      output.hidden = true;
      empty.hidden = false;
      setStatus(status, "Ready");
    });
  }
})();
