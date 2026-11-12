/* verify402 activity — a testnet explorer for payments and published verdicts.
   One fetch to /explorer, then tabs + a client-side search over the rows. */
(function () {
  var paymentsBody = document.querySelector("[data-settlements]");
  var verdictsBody = document.querySelector("[data-verdicts]");
  if (!paymentsBody && !verdictsBody) return;

  var state = { data: null, tab: "payments", query: "" };
  var input = document.querySelector("[data-search]");
  var lookup = document.querySelector("[data-lookup]");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"));
  var panels = Array.prototype.slice.call(document.querySelectorAll("[data-panel]"));
  var countPayments = document.querySelector("[data-count-payments]");
  var countVerdicts = document.querySelector("[data-count-verdicts]");

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function short(address) {
    if (!address) return "—";
    return address.slice(0, 6) + "…" + address.slice(-4);
  }
  function utc(timestamp) {
    var date = new Date(timestamp);
    if (isNaN(date.getTime())) return "—";
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
  function bps(value) {
    if (typeof value !== "number" || !isFinite(value)) return "—";
    return (value > 0 ? "+" : "") + value.toFixed(2);
  }
  function chip(verdict) {
    return '<span class="chip ' + esc(verdict) + '">' + esc(verdict) + "</span>";
  }
  function matches(haystack, query) {
    return !query || haystack.indexOf(query) !== -1;
  }

  function paymentHaystack(row) {
    return [row.timestamp, row.amount, row.symbol, row.from, row.to, row.txHash, "testnet", "base sepolia"]
      .join(" ")
      .toLowerCase();
  }
  function verdictHaystack(row) {
    return [row.pair, row.verdict, row.netBps, row.grossBps, row.blockNumber, row.measuredAt]
      .join(" ")
      .toLowerCase();
  }

  function emptyRow(cols, total) {
    return (
      '<tr><td colspan="' + cols + '" class="muted">' +
      (total === 0 ? "No rows yet." : "No rows match that search.") +
      "</td></tr>"
    );
  }

  function renderPayments(query) {
    var all = state.data.settlements;
    var rows = all.filter(function (row) {
      return matches(paymentHaystack(row), query);
    });
    if (countPayments) countPayments.textContent = String(rows.length);
    if (!rows.length) {
      paymentsBody.innerHTML = emptyRow(4, all.length);
      return;
    }
    paymentsBody.innerHTML = rows.map(function (row) {
      var link = row.url
        ? '<a class="textlink" href="' + esc(row.url) + '" target="_blank" rel="noopener">' + esc(short(row.txHash)) + "</a>"
        : esc(short(row.txHash));
      return (
        "<tr>" +
        '<td class="mono">' + esc(utc(row.timestamp)) + "</td>" +
        '<td class="mono">' + esc(row.amount) + " " + esc(row.symbol) + ' <span class="chip testnet">testnet</span></td>' +
        '<td class="mono">' + esc(short(row.from)) + "</td>" +
        '<td class="mono">' + link + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderVerdicts(query) {
    var all = state.data.verdicts || [];
    var rows = all.filter(function (row) {
      return matches(verdictHaystack(row), query);
    });
    if (countVerdicts) countVerdicts.textContent = String(rows.length);
    if (!rows.length) {
      verdictsBody.innerHTML = emptyRow(6, all.length);
      return;
    }
    verdictsBody.innerHTML = rows.map(function (row) {
      var block = row.blockNumber
        ? '<a class="textlink" href="https://etherscan.io/block/' + encodeURIComponent(row.blockNumber) + '" target="_blank" rel="noopener">' + esc(row.blockNumber) + "</a>"
        : "—";
      return (
        "<tr>" +
        '<td class="mono">' + esc(row.pair) + "</td>" +
        "<td>" + chip(row.verdict) + "</td>" +
        '<td class="mono">' + esc(bps(row.netBps)) + "</td>" +
        '<td class="mono">' + esc(bps(row.grossBps)) + "</td>" +
        '<td class="mono">' + block + "</td>" +
        '<td><a class="textlink" href="' + esc(row.url) + '">recompute</a></td>' +
        "</tr>"
      );
    }).join("");
  }

  function renderLookup(query) {
    if (!lookup) return;
    if (/^0x[0-9a-fA-F]{64}$/.test(query)) {
      lookup.hidden = false;
      lookup.innerHTML =
        "Transaction hash detected. " +
        '<a class="textlink" href="' + esc(state.data.explorer + "/tx/" + query) + '" target="_blank" rel="noopener">Open it on BaseScan →</a>';
      return;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(query)) {
      lookup.hidden = false;
      lookup.innerHTML =
        "Address detected. " +
        '<a class="textlink" href="' + esc(state.data.explorer + "/address/" + query) + '" target="_blank" rel="noopener">Open it on BaseScan →</a>';
      return;
    }
    lookup.hidden = true;
    lookup.innerHTML = "";
  }

  function render() {
    if (!state.data) return;
    var query = state.query.trim().toLowerCase();
    renderLookup(state.query.trim());
    renderPayments(query);
    renderVerdicts(query);

    var total = document.querySelector("[data-total]");
    if (total) {
      total.textContent =
        state.data.totals.count + " payment" + (state.data.totals.count === 1 ? "" : "s") +
        " · " + state.data.totals.amount + " " + state.data.totals.symbol + " (testnet)";
    }
    var verdictCount = document.querySelector("[data-verdict-count]");
    if (verdictCount) {
      var n = (state.data.verdicts || []).length;
      verdictCount.textContent = n + " verdict" + (n === 1 ? "" : "s") + (n ? " published" : "");
    }
  }

  function selectTab(name) {
    state.tab = name;
    tabs.forEach(function (tab) {
      tab.setAttribute("aria-selected", tab.getAttribute("data-tab") === name ? "true" : "false");
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-panel") !== name;
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      selectTab(tab.getAttribute("data-tab"));
    });
  });

  if (input) {
    input.addEventListener("input", function () {
      state.query = input.value;
      render();
    });
  }

  fetch("/explorer")
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (data) {
      state.data = data;

      var net = document.querySelector("[data-net]");
      if (net) net.textContent = "● " + data.chain + (data.stale ? " · cached" : "");

      var address = document.querySelector("[data-address]");
      if (address) {
        address.textContent = short(data.address);
        address.href = data.explorer + "/address/" + data.address;
      }

      var meta = document.querySelector("[data-verdicts-meta]");
      if (meta) {
        meta.textContent = data.verdictsMeasuredAt
          ? "● measured " + utc(data.verdictsMeasuredAt)
          : "● —";
      }

      render();
    })
    .catch(function () {
      var net = document.querySelector("[data-net]");
      if (net) net.textContent = "● unavailable";
      var message =
        '<tr><td colspan="4" class="muted">The chain indexer did not answer. Retry in a moment; nothing is cached in your browser.</td></tr>';
      paymentsBody.innerHTML = message;
      if (verdictsBody) {
        verdictsBody.innerHTML =
          '<tr><td colspan="6" class="muted">The chain indexer did not answer. Retry in a moment.</td></tr>';
      }
    });
})();
