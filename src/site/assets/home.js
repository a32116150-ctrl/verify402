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
        ["expires", "90 seconds"]
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
        ["expires", "90 seconds"]
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

  // Live npm counters: one same-origin fetch, one server cache. A dash beats a
  // made-up number when the registry is slow.
  var npmWeek = document.querySelector("[data-npm-week]");
  var npmMonth = document.querySelector("[data-npm-month]");
  if (npmWeek || npmMonth) {
    fetch("/npm-stats")
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        var fmt = function (value) {
          return typeof value === "number" ? value.toLocaleString("en-US") : "—";
        };
        if (npmWeek) npmWeek.textContent = fmt(data.lastWeek);
        if (npmMonth) npmMonth.textContent = fmt(data.lastMonth);
      })
      .catch(function () {});
  }

  // Live paid-usage counters: one same-origin /stats fetch, refreshed once a
  // minute. A dash is better than a made-up number while the chain read runs.
  var statEls = document.querySelectorAll("[data-stat]");
  if (statEls.length) {
    var fmtStat = function (value) {
      if (typeof value === "number") return value.toLocaleString("en-US");
      if (typeof value === "string" && value) return value;
      return "—";
    };
    var paintStats = function (data) {
      var mainnet = data && data.mainnet;
      var testnet = data && data.testnet;
      var total = (mainnet && testnet)
        ? mainnet.paidCalls + testnet.paidCalls
        : null;
      var values = {
        "mainnet-paid": mainnet && mainnet.paidCalls,
        "mainnet-usdc": mainnet && mainnet.usdc,
        "testnet-paid": testnet && testnet.paidCalls,
        "outside-payers": mainnet && mainnet.outsidePayers,
        "outside-usdc": mainnet && mainnet.outsideUsdc,
        "free-calls": data && data.freeCalls,
        "total-paid": total
      };
      Object.keys(values).forEach(function (key) {
        var els = document.querySelectorAll('[data-stat="' + key + '"]');
        Array.prototype.forEach.call(els, function (el) {
          el.textContent = fmtStat(values[key]);
        });
      });
      var updated = document.querySelector("[data-stat-updated]");
      if (updated && data && data.fetchedAt) {
        var date = new Date(data.fetchedAt);
        updated.textContent = isNaN(date.getTime()) ? "—" : date.toISOString().slice(11, 16) + " UTC";
      }
    };
    var loadStats = function () {
      fetch("/stats", { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(paintStats)
        .catch(function () {});
    };
    loadStats();
    window.setInterval(loadStats, 60000);
  }

})();
