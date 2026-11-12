/* verify402 activity — render the live settlement list from /explorer. */
(function () {
  var tbody = document.querySelector("[data-settlements]");
  if (!tbody) return;

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

  fetch("/explorer")
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (data) {
      var net = document.querySelector("[data-net]");
      if (net) net.textContent = "● " + data.chain + (data.stale ? " · cached" : "");

      var address = document.querySelector("[data-address]");
      if (address) {
        address.textContent = short(data.address);
        address.href = data.explorer + "/address/" + data.address;
      }

      var total = document.querySelector("[data-total]");
      if (total) {
        total.textContent =
          data.totals.count + " payment" + (data.totals.count === 1 ? "" : "s") +
          " · " + data.totals.amount + " " + data.totals.symbol;
      }

      if (!data.settlements.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No payments yet.</td></tr>';
        return;
      }

      tbody.innerHTML = data.settlements.map(function (row) {
        var link = row.url
          ? '<a class="textlink" href="' + esc(row.url) + '" target="_blank" rel="noopener">' + esc(short(row.txHash)) + "</a>"
          : esc(short(row.txHash));
        return (
          "<tr>" +
          '<td class="mono">' + esc(utc(row.timestamp)) + "</td>" +
          '<td class="mono">' + esc(row.amount) + " " + esc(row.symbol) + "</td>" +
          '<td class="mono">' + esc(short(row.from)) + "</td>" +
          '<td class="mono">' + link + "</td>" +
          "</tr>"
        );
      }).join("");
    })
    .catch(function () {
      var net = document.querySelector("[data-net]");
      if (net) net.textContent = "● unavailable";
      tbody.innerHTML =
        '<tr><td colspan="4" class="muted">The chain indexer did not answer. Retry in a moment; nothing is cached in your browser.</td></tr>';
    });
})();
