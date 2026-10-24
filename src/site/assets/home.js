/* verify402 home — the receipt switcher, section reveals, and copy feedback. */
(function () {
  document.documentElement.classList.add("js");

  var receipts = {
    payment: {
      verdict: "PASS",
      cls: "pass",
      id: "pf_7d2a…c91",
      reason: "Canonical USDC · payee and amount match",
      detail: "A known payment request at a fresh block. Settlement is not verified.",
      rows: [
        ["intent", "x402 payment"],
        ["amount", "0.01 USDC"],
        ["block", "21,492,881"],
        ["expires", "90 seconds"]
      ]
    },
    approval: {
      verdict: "BLOCK",
      cls: "block",
      id: "pf_3f8c…a12",
      reason: "unlimited_approval",
      detail: "The spender can move the full token balance. No expiry, no cap.",
      rows: [
        ["intent", "approve"],
        ["spender", "0x4e…91c"],
        ["allowance", "unlimited"],
        ["block", "21,492,881"]
      ]
    },
    swap: {
      verdict: "CAUTION",
      cls: "caution",
      id: "pf_9b1e…7d0",
      reason: "quote age 41s · route changed",
      detail: "The transaction still simulates, but the quoted output no longer clears costs.",
      rows: [
        ["intent", "swap"],
        ["pair", "USDC / WETH"],
        ["quote age", "41 seconds"],
        ["block", "21,492,881"]
      ]
    }
  };

  var tabs = document.querySelectorAll("[data-receipt-tab]");
  var receipt = document.querySelector("[data-receipt]");
  function select(name) {
    var data = receipts[name];
    if (!data || !receipt) return;
    var verdict = receipt.querySelector("[data-receipt-verdict]");
    var reason = receipt.querySelector("[data-receipt-reason]");
    var detail = receipt.querySelector("[data-receipt-detail]");
    var id = receipt.querySelector("[data-receipt-id]");
    var rows = receipt.querySelector("[data-receipt-rows]");
    if (verdict) {
      verdict.textContent = data.verdict;
      verdict.className = "receipt-verdict " + data.cls;
    }
    if (reason) reason.textContent = data.reason;
    if (detail) detail.textContent = data.detail;
    if (id) id.textContent = data.id;
    if (rows) {
      rows.innerHTML = data.rows.map(function (row) {
        return '<div class="receipt-row"><span>' + row[0] + "</span><b>" + row[1] + "</b></div>";
      }).join("");
    }
    tabs.forEach(function (tab) {
      tab.setAttribute("aria-selected", tab.getAttribute("data-receipt-tab") === name ? "true" : "false");
    });
  }
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { select(tab.getAttribute("data-receipt-tab")); });
  });

  var revealEls = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
    revealEls.forEach(function (el, i) {
      el.style.setProperty("--d", String(i % 4));
      io.observe(el);
    });
    // Never leave a section hidden if the observer misses a layout change.
    window.setTimeout(function () {
      revealEls.forEach(function (el) { el.classList.add("is-in"); });
    }, 2500);
  }

})();
