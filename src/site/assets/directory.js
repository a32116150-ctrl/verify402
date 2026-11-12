/* verify402 — live table for the 402 directory (GET /directory.json). */
(function () {
  "use strict";

  var rows = document.getElementById("dir-rows");
  if (!rows) return;

  var status = document.getElementById("dir-status");
  var modeChip = document.getElementById("dir-mode");
  var entriesEl = document.getElementById("dir-entries");
  var protocolEl = document.getElementById("dir-protocol");
  var signEl = document.getElementById("dir-sign");
  var changesEl = document.getElementById("dir-changes");
  var nextEl = document.getElementById("dir-next");

  function short(value, head, tail) {
    if (value == null || value === "") return "—";
    var text = String(value);
    if (text.length <= head + tail + 1) return text;
    return text.slice(0, head) + "…" + text.slice(-tail);
  }

  function money(value, amount) {
    if (value != null) return "$" + Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    if (amount != null) return String(amount) + " raw units";
    return "—";
  }

  function chip(verdict) {
    var span = document.createElement("span");
    var v = verdict || "—";
    span.className = "dchip " + (v === "PASS" ? "pass" : v === "BLOCK" ? "block" : v === "CAUTION" ? "caution" : "");
    span.textContent = v;
    return span;
  }

  function relative(iso) {
    if (!iso) return "—";
    var then = Date.parse(iso);
    if (!Number.isFinite(then)) return "—";
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return seconds + "s ago";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.round(hours / 24) + "d ago";
  }

  function textCell(text, mono) {
    var td = document.createElement("td");
    if (mono) td.className = "dmono";
    td.textContent = text == null || text === "" ? "—" : String(text);
    return td;
  }

  function render(payload) {
    var entries = payload.entries || [];
    rows.textContent = "";

    if (!entries.length) {
      var empty = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "small muted";
      cell.textContent = "The directory has no entries yet.";
      empty.appendChild(cell);
      rows.appendChild(empty);
      return;
    }

    var protocolCount = { PASS: 0, CAUTION: 0, BLOCK: 0 };
    var signCount = { PASS: 0, CAUTION: 0, BLOCK: 0 };
    var totalChanges = 0;

    entries.forEach(function (entry) {
      var current = entry.current || {};
      var protocol = current.protocol || {};
      var sign = current.sign || {};
      if (protocolCount[protocol.verdict] != null) protocolCount[protocol.verdict] += 1;
      if (signCount[sign.verdict] != null) signCount[sign.verdict] += 1;
      totalChanges += (entry.changes || []).length;

      var tr = document.createElement("tr");

      var nameCell = document.createElement("td");
      var link = document.createElement("a");
      link.href = current.url || entry.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "dmono";
      link.textContent = current.method || entry.method || "GET";
      nameCell.appendChild(link);
      var nameLine = document.createElement("div");
      nameLine.style.marginTop = "4px";
      nameLine.textContent = entry.name || entry.id;
      nameCell.appendChild(nameLine);
      if (current.error) {
        var err = document.createElement("div");
        err.className = "small";
        err.style.color = "var(--red)";
        err.textContent = current.error;
        nameCell.appendChild(err);
      }
      tr.appendChild(nameCell);

      tr.appendChild(textCell(money(current.price, current.amount)));
      tr.appendChild(textCell(short(current.network, 18, 8), true));
      tr.appendChild(textCell(short(current.payee, 8, 6), true));

      var protocolCell = document.createElement("td");
      protocolCell.appendChild(chip(protocol.verdict));
      tr.appendChild(protocolCell);

      var signCell = document.createElement("td");
      signCell.appendChild(chip(sign.verdict));
      tr.appendChild(signCell);

      var when = document.createElement("td");
      when.className = "small muted";
      when.textContent = relative(current.measuredAt);
      when.title = current.measuredAt || "";
      tr.appendChild(when);

      var changesCell = document.createElement("td");
      var list = entry.changes || [];
      if (!list.length) {
        changesCell.className = "small muted";
        changesCell.textContent = "no changes yet";
      } else {
        var ul = document.createElement("ul");
        ul.className = "dchanges";
        list.slice(0, 4).forEach(function (change) {
          var li = document.createElement("li");
          li.textContent = change.field + ": " + (change.from == null ? "—" : change.from) + " → " + (change.to == null ? "—" : change.to);
          ul.appendChild(li);
        });
        changesCell.appendChild(ul);
      }
      tr.appendChild(changesCell);

      rows.appendChild(tr);
    });

    entriesEl.textContent = entries.length + " endpoint" + (entries.length === 1 ? "" : "s");
    protocolEl.textContent = protocolCount.PASS + " PASS";
    signEl.textContent = signCount.PASS + " PASS";
    changesEl.textContent = String(totalChanges);
    if (modeChip) modeChip.textContent = payload.mode === "file" ? "file-backed" : "memory";
    if (status) {
      status.textContent = payload.lastRunAt ? "● live" : "● starting";
    }
    if (nextEl) {
      nextEl.textContent = payload.lastRunAt
        ? "Last run " + new Date(payload.lastRunAt).toUTCString() + " · next in ~" + payload.intervalMinutes + " min"
        : "First inspection runs on boot";
    }
  }

  function load() {
    return fetch("/directory.json", { headers: { accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("directory answered " + response.status);
        return response.json();
      })
      .then(render)
      .catch(function (error) {
        rows.textContent = "";
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 8;
        td.className = "small";
        td.style.color = "var(--red)";
        td.textContent = "Could not load the directory: " + error.message;
        tr.appendChild(td);
        rows.appendChild(tr);
      });
  }

  load();
  setInterval(load, 60_000);
})();
