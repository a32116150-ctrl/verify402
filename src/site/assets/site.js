/* verify402 site — small, dependency-free behaviours. */
(function () {
  // Mark the current page in the shared masthead and close the phone menu.
  var path = location.pathname.replace(/\/+$/, "") || "/";
  document.querySelectorAll(".site-nav a, .site-menu nav a").forEach(function (link) {
    var href = link.getAttribute("href") || "";
    if (href === path) link.setAttribute("aria-current", "page");
    link.addEventListener("click", function () {
      var menu = link.closest("details");
      if (menu) menu.removeAttribute("open");
    });
  });

  // Section entrances for reading pages. The home page has its own reveal layer.
  document.documentElement.classList.add("js");
  if (!document.body.classList.contains("home")) {
    var reveal = document.querySelectorAll(".page-head h1, .page-head .lead, .page-head .btn-row, .page-head .small, section h2, section .lead, .sec-head, .pcard2, .callout, .table-wrap, .try-shell, .vcard, .proof-grid, .step");
    if (!("IntersectionObserver" in window)) {
      reveal.forEach(function (el) { el.classList.add("is-in"); });
    } else {
      var revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          revealIO.unobserve(entry.target);
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      reveal.forEach(function (el, i) {
        el.classList.add("reveal-ready");
        el.style.transitionDelay = (i % 4) * 60 + "ms";
        revealIO.observe(el);
      });
      window.setTimeout(function () {
        reveal.forEach(function (el) { el.classList.add("is-in"); });
      }, 2600);
    }
  }

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

  // Hairline figures. The bundle is local and tree-shaken; the import stays
  // lazy so text-only pages pay nothing. Reduced motion is handled by the
  // library; each figure still answers the pointer.
  var figureEls = document.querySelectorAll("[data-hairline-figure]");
  if (figureEls.length) {
    import("/assets/hairline.js").then(function (figures) {
      figureEls.forEach(function (el) {
        var draw = figures[el.getAttribute("data-hairline-figure")];
        if (typeof draw !== "function") return;
        var intensity = parseFloat(el.getAttribute("data-intensity"));
        draw(el, {
          theme: "light",
          intensity: isFinite(intensity) ? intensity : 0.55,
          play: el.getAttribute("data-play") === "true",
          label: el.getAttribute("data-label") || undefined
        });
      });
    }).catch(function () {});
  }

  // Live free verdicts: fill any [data-findings] list from GET /findings.
  // The nav block label is updated on every page, with or without a card.
  // One retry covers a cold free-tier instance; after that, say so honestly.
  var lists = document.querySelectorAll("[data-findings]");
  var statuses = document.querySelectorAll("[data-block]");
  if (!lists.length && !statuses.length) return;

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
