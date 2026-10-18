/* verify402 site — small, dependency-free behaviours. */
(function () {
  // Copy-to-clipboard for wallet addresses (a mistyped address is a lost donation).
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var label = btn.textContent;
      var done = function () {
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.textContent = label; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else { fallback(); }
      function fallback() {
        var id = btn.getAttribute("data-copy-target");
        var el = id && document.getElementById(id);
        if (el) {
          var r = document.createRange(); r.selectNodeContents(el);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        }
        done();
      }
    });
  });

  // Live free verdicts: fill any [data-findings] list from GET /findings.
  // One retry covers a cold free-tier instance; after that, say so honestly.
  var lists = document.querySelectorAll("[data-findings]");
  var statuses = document.querySelectorAll("[data-block]");
  if (!lists.length) return;

  function render(d) {
    var block = d.blockNumber || "—";
    var label = "block " + block;
    if (d.ageSeconds > 90) label += " · cached";
    statuses.forEach(function (s) { s.textContent = label; });
    var items = d.results || [];
    lists.forEach(function (list) {
      list.innerHTML = items.slice(0, 6).map(function (m) {
        var v = m.verdict || "—";
        var cls = v === "no_edge" ? "verdict" : "verdict warn";
        var meta = v === "unavailable"
          ? "no quote this pass"
          : "net " + (m.netBps != null ? m.netBps + " bps" : "—");
        return '<div class="vrow"><span class="pair">' + (m.target || "pair") +
          '</span><span class="' + cls + '">' + v +
          '</span><span class="meta">' + meta + "</span></div>";
      }).join("");
    });
  }

  function offline() {
    lists.forEach(function (list) {
      list.innerHTML = '<div class="vrow"><span class="pair">status</span>' +
        '<span class="verdict warn">cold start</span>' +
        '<span class="meta">free tier is waking — reload in ~20s</span></div>';
    });
  }

  function load(attempt) {
    fetch("/findings", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("http " + r.status)); })
      .then(render)
      .catch(function () {
        if (attempt < 1) { setTimeout(function () { load(attempt + 1); }, 4000); return; }
        offline();
      });
  }
  load(0);
})();
