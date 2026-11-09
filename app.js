/* Filmsammlung – Liquid Glass. Statische Web-App über dem bestehenden Apps Script. */
(function () {
  "use strict";

  const API = "https://script.google.com/macros/s/AKfycbw1l_K8sPp02cIPQjlzTwxGxG6Ce2B_oQ6KMKc6G6sQk6-MDACaYW71OlzWOaRWtibzqA/exec";
  const FORMATE_STD = ["DVD", "Blu-ray", "4K UHD", "Sonstiges"];
  const TABS = ["scan", "search", "lists", "stats"];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* egal */ } },
  };

  const state = {
    pin: null,
    formate: FORMATE_STD.slice(),
    tab: "scan",
    liste: "Sammlung",
    layout: store.get("fs_layout") || "grid",
    daten: { Sammlung: null, Wunschliste: null },
    postersSupported: true,
    posters: loadPosterCache(),
  };

  /* ------------------------------------------------------------ API */

  class ApiError extends Error { constructor(m, wrongPin) { super(m); this.wrongPin = !!wrongPin; } }

  async function api(action, daten = {}, pin = state.pin) {
    let res, json;
    try {
      res = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action, pin, ...daten }) });
      json = await res.json();
    } catch {
      throw new ApiError("Keine Verbindung. Prüf dein Netz und versuch es noch einmal.");
    }
    if (!json.ok) {
      const msg = json.fehler || "Unbekannter Fehler";
      const wrong = /falsche pin/i.test(msg);
      if (wrong && action !== "login") logout();
      throw new ApiError(msg, wrong);
    }
    return json;
  }

  /* ------------------------------------------------------------ Poster */

  function loadPosterCache() {
    try { return JSON.parse(store.get("fs_posters") || "{}"); } catch { return {}; }
  }
  function savePosterCache() {
    const keys = Object.keys(state.posters);
    if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach((k) => delete state.posters[k]);
    store.set("fs_posters", JSON.stringify(state.posters));
  }
  const pkey = (titel, jahr) => `${titel}|${jahr || ""}`;

  function posterHtml(titel, jahr, size, url) {
    const k = pkey(titel, jahr);
    const u = url || state.posters[k] || "";
    return `<div class="poster ${size}${u ? " has-img" : ""}" data-pk="${esc(k)}">
      ${u ? `<img src="${esc(u)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.parentNode.classList.remove('has-img');this.remove()">` : ""}
      <div class="ph">${size === "sm" ? icon("film") : esc(titel)}</div></div>`;
  }

  let posterQueue = new Map();
  let posterTimer = null;
  function wantPosters(items) {
    if (!state.postersSupported) return;
    items.forEach((x) => {
      const k = pkey(x.titel, x.jahr);
      if (!(k in state.posters)) posterQueue.set(k, { titel: x.titel, jahr: x.jahr || "" });
    });
    clearTimeout(posterTimer);
    posterTimer = setTimeout(flushPosters, 120);
  }
  async function flushPosters() {
    if (!posterQueue.size || !state.postersSupported) return;
    const batch = Array.from(posterQueue.values()).slice(0, 30);
    batch.forEach((f) => posterQueue.delete(pkey(f.titel, f.jahr)));
    try {
      const r = await api("posters", { filme: batch });
      Object.assign(state.posters, r.poster || {});
      savePosterCache();
      applyPosters();
    } catch (e) {
      if (/unbekannte aktion/i.test(e.message)) { state.postersSupported = false; posterQueue.clear(); return; }
    }
    if (posterQueue.size) setTimeout(flushPosters, 60);
  }
  function applyPosters() {
    $$(".poster:not(.has-img)").forEach((el) => {
      const u = state.posters[el.dataset.pk];
      if (!u) return;
      el.classList.add("has-img");
      const img = new Image();
      img.alt = ""; img.onload = () => img.classList.add("loaded");
      img.onerror = () => { el.classList.remove("has-img"); img.remove(); };
      img.src = u;
      el.prepend(img);
    });
  }

  /* ------------------------------------------------------------ Toast */

  let toastTimer;
  function toast(msg, kind = "ok") {
    const t = $("#toast");
    t.className = `toast glass ${kind}`;
    t.innerHTML = `${icon(kind === "ok" ? "check" : "x")}<span>${esc(msg)}</span>`;
    t.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("in")));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove("in"); setTimeout(() => (t.hidden = true), 400); }, kind === "ok" ? 2400 : 3800);
  }

  /* ------------------------------------------------------------ Sheet */

  let openSheet = null;
  function sheet({ title = "", body = "", foot = "", center = false, onClose } = {}) {
    closeSheet(true, true);
    const root = $("#sheet-root");
    const bd = document.createElement("div");
    bd.className = "backdrop";
    const el = document.createElement("div");
    el.className = `sheet glass${center ? " center" : ""}`;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `${center ? "" : '<div class="grabber"></div>'}
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="sheet-close" aria-label="Schließen">${icon("x")}</button></div>
      <div class="sheet-body"></div><div class="sheet-foot"></div>`;
    const b = $(".sheet-body", el), f = $(".sheet-foot", el);
    if (typeof body === "string") b.innerHTML = body; else b.append(body);
    if (typeof foot === "string") f.innerHTML = foot; else f.append(foot);
    if (!foot) f.remove();
    root.append(bd, el);
    const api = { el, body: b, foot: f, close: () => closeSheet(), onClose };
    openSheet = api;
    bd.addEventListener("click", () => closeSheet());
    $(".sheet-close", el).addEventListener("click", () => closeSheet());
    requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add("in"); el.classList.add("in"); }));
    enableSwipe(el);
    return api;
  }
  function closeSheet(instant, silent) {
    const s = openSheet;
    if (!s) return;
    openSheet = null;
    const bd = s.el.previousElementSibling;
    s.el.classList.remove("in");
    bd && bd.classList.remove("in");
    const rm = () => { s.el.remove(); bd && bd.remove(); };
    instant ? rm() : setTimeout(rm, 380);
    if (!silent && s.onClose) s.onClose();
  }
  function enableSwipe(el) {
    if (el.classList.contains("center")) return;
    let y0 = null, dy = 0;
    const head = [$(".grabber", el), $(".sheet-head", el)];
    head.forEach((h) => {
      if (!h) return;
      h.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; el.style.transition = "none"; }, { passive: true });
      h.addEventListener("touchmove", (e) => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); el.style.transform = `translateY(${dy}px)`; }, { passive: true });
      h.addEventListener("touchend", () => {
        el.style.transition = ""; el.style.transform = "";
        if (dy > 90) closeSheet();
        y0 = null; dy = 0;
      });
    });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  function spinner(text) { return `<div class="loading-line"><span class="spin"></span>${esc(text)}</div>`; }

  /* ------------------------------------------------------------ Login */

  function showLogin() {
    $("#app").hidden = true;
    $("#login").hidden = false;
    document.body.classList.remove("on-scan");
    stopScanner();
    const inp = $("#pin");
    inp.value = "";
    $("#login-btn").disabled = true;
    setTimeout(() => inp.focus(), 50);
  }

  $("#pin").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "");
    $("#login-btn").disabled = !e.target.value;
  });
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("#pin").value;
    const btn = $("#login-btn");
    if (!pin || btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Anmelden';
    try {
      const r = await api("login", {}, pin);
      state.pin = pin;
      store.set("fs_pin", pin);
      setFormate(r.formate);
      startApp();
    } catch (err) {
      toast(err.message, "err");
      $("#pin").select();
    } finally {
      btn.textContent = "Anmelden";
      btn.disabled = !$("#pin").value;
    }
  });

  function setFormate(list) {
    const f = (list || []).filter((x) => FORMATE_STD.includes(x));
    state.formate = f.length ? f : FORMATE_STD.slice();
  }

  function logout() {
    store.set("fs_pin", null);
    state.pin = null;
    state.daten = { Sammlung: null, Wunschliste: null };
    closeSheet(true);
    showLogin();
  }

  /* ------------------------------------------------------------ Tabs */

  function startApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    const fromHash = (location.hash || "").slice(1);
    switchTab(TABS.includes(fromHash) ? fromHash : "scan", true);
  }

  function switchTab(tab, force) {
    if (tab === state.tab && !force) {
      if (tab !== "scan") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    state.tab = tab;
    closeSheet(true, true);
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== tab));
    $$(".tabbar button").forEach((b, i) => {
      const on = b.dataset.tab === tab;
      b.toggleAttribute("aria-current", on);
      if (on) b.setAttribute("aria-current", "page");
      if (on) $(".tab-thumb").style.transform = `translateX(${i * 100}%)`;
    });
    document.body.classList.toggle("on-scan", tab === "scan");
    try { history.replaceState(null, "", tab === "scan" ? location.pathname : `#${tab}`); } catch { /* egal */ }
    window.scrollTo(0, 0);
    if (tab === "scan") startScanner(); else stopScanner();
    if (tab === "lists") renderLists(true);
    if (tab === "stats") renderStats(true);
  }
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  window.addEventListener("scroll", () => {
    const y = window.scrollY > 4;
    $$(".nav").forEach((n) => n.classList.toggle("scrolled", y));
  }, { passive: true });

  /* ------------------------------------------------------------ Scanner */

  let scanner = null, scanBusy = false, scannerStarting = false, torchOn = false;

  async function startScanner() {
    if (scanner || scannerStarting) { resumeScanner(); return; }
    if (!window.Html5Qrcode) { setTimeout(startScanner, 150); return; }
    scannerStarting = true;
    $("#scan-error").hidden = true;
    try {
      const F = window.Html5QrcodeSupportedFormats;
      const sc = new window.Html5Qrcode("reader", {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      await sc.start(
        { facingMode: "environment" },
        { fps: 12 },
        (text) => onScan(text),
        () => {},
      );
      scanner = sc;
      if (state.tab !== "scan") { stopScanner(); return; }
      try {
        const t = sc.getRunningTrackCameraCapabilities().torchFeature();
        $("#torch-btn").hidden = !t.isSupported();
      } catch { $("#torch-btn").hidden = true; }
    } catch (e) {
      const msg = String((e && e.message) || e);
      const err = $("#scan-error");
      err.innerHTML = /permission|notallowed/i.test(msg)
        ? "<strong>Kein Zugriff auf die Kamera</strong><span>Erlaube den Kamerazugriff für diese Seite in den Browser-Einstellungen, oder gib die EAN von Hand ein.</span>"
        : "<strong>Kamera startet nicht</strong><span>Du kannst die EAN-Nummer auch von Hand eingeben.</span>";
      err.hidden = false;
      $("#scan-hint").hidden = true;
    } finally {
      scannerStarting = false;
    }
  }

  function stopScanner() {
    const sc = scanner;
    scanner = null;
    torchOn = false;
    $("#torch-btn").classList.remove("on");
    if (!sc) return;
    try { sc.stop().then(() => sc.clear()).catch(() => {}); } catch { /* egal */ }
  }
  function pauseScanner() { try { scanner && scanner.pause(true); } catch { /* egal */ } }
  function resumeScanner() {
    scanBusy = false;
    $(".finder").classList.remove("hit");
    try { scanner && scanner.resume(); } catch { /* läuft schon */ }
  }

  async function setTorch(on) {
    try {
      await scanner.getRunningTrackCameraCapabilities().torchFeature().apply(on);
      torchOn = on;
      $("#torch-btn").classList.toggle("on", on);
    } catch { if (on) toast("Taschenlampe nicht verfügbar", "err"); }
  }
  $("#torch-btn").addEventListener("click", () => setTorch(!torchOn));

  function onScan(text) {
    if (scanBusy || openSheet) return;
    scanBusy = true;
    if (navigator.vibrate) navigator.vibrate(60);
    $(".finder").classList.add("hit");
    pauseScanner();
    if (torchOn) setTorch(false);
    lookupEan(text, { onDone: resumeScanner });
  }

  $("#manual-btn").addEventListener("click", () => {
    pauseScanner();
    eanDialog((ean) => lookupEan(ean, { onDone: resumeScanner }), resumeScanner);
  });

  function eanDialog(onEan, onCancel) {
    const form = document.createElement("form");
    form.innerHTML = `<input class="field ean-input" inputmode="numeric" maxlength="14" placeholder="4010232012345" aria-label="EAN-Nummer" autocomplete="off">`;
    const btn = document.createElement("button");
    btn.className = "btn btn-primary"; btn.textContent = "Prüfen"; btn.disabled = true;
    let submitted = false;
    const s = sheet({ title: "EAN eingeben", body: form, foot: btn, center: true, onClose: () => { if (!submitted && onCancel) onCancel(); } });
    const inp = $("input", form);
    inp.addEventListener("input", () => { inp.value = inp.value.replace(/\D/g, "").slice(0, 14); btn.disabled = inp.value.length < 8; });
    const go = (e) => { e && e.preventDefault(); if (inp.value.length < 8) return; submitted = true; const v = inp.value; s.close(); setTimeout(() => onEan(v), 60); };
    form.addEventListener("submit", go);
    btn.addEventListener("click", go);
    setTimeout(() => inp.focus(), 80);
  }

  /* ------------------------------------------------------------ Nachschlagen */

  async function lookupEan(ean, { onDone } = {}) {
    const s = sheet({ title: "Wird gesucht", body: spinner("Film wird gesucht …"), onClose: onDone });
    try {
      const r = await api("scan", { ean });
      if (openSheet !== s) return;
      const treffer = r.treffer || [];
      const code = r.ean || ean;
      if (!r.produkt && !treffer.length) return showUnknown(code, onDone);
      const p = r.produkt, first = treffer[0];
      showResult({
        titel: p ? p.titel : first.titel,
        jahr: p ? p.jahr : first.jahr,
        format: p ? p.format : first.format,
        quelle: p && p.quelle, rohname: p && p.rohname,
        poster: p && p.poster,
        ean: code, treffer,
      }, onDone);
    } catch (e) {
      s.close();
      toast(e.message, "err");
    }
  }

  function showUnknown(ean, onDone) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="state s-other" style="margin-top:0"><span class="badge">${icon("search")}</span><div><strong>Nicht erkannt</strong><span>EAN ${esc(ean)} kennt keine Datenbank. Such den Film über den Titel.</span></div></div>`;
    wrap.append(titleSearch((k) => checkTitle(k, ean, onDone)));
    sheet({ title: "Film suchen", body: wrap, onClose: onDone });
  }

  async function checkTitle(k, ean, onDone) {
    const s = sheet({ title: "Wird geprüft", body: spinner("Abgleich mit deinen Listen …"), onClose: onDone });
    try {
      const r = await api("check", { ean: ean || undefined, titel: k.titel, jahr: k.jahr || undefined });
      if (openSheet !== s) return;
      showResult({ titel: k.titel, jahr: k.jahr, format: "", poster: k.poster, ean: ean || "", eanEditable: !ean, treffer: r.treffer || [] }, onDone);
    } catch (e) { s.close(); toast(e.message, "err"); }
  }

  /** Titelsuche (TMDB) als wiederverwendbares Formular */
  function titleSearch(onPick) {
    const box = document.createElement("div");
    box.innerHTML = `<form class="cands" style="margin-top:16px">
        <label class="row-field"><span>Titel</span><input class="row-input" name="t" placeholder="Filmtitel" autocomplete="off" required></label>
        <label class="row-field"><span>Jahr</span><input class="row-input" name="j" inputmode="numeric" maxlength="4" placeholder="optional"></label>
      </form>
      <button class="btn btn-secondary" style="width:100%;margin-top:12px" type="button">Titel suchen</button>
      <div class="out"></div>`;
    const form = $("form", box), btn = $("button.btn", box), out = $(".out", box);
    const run = async (e) => {
      e && e.preventDefault();
      const t = form.t.value.trim();
      if (!t) { form.t.focus(); return; }
      out.innerHTML = spinner("Suche läuft …");
      try {
        const r = await api("searchTitle", { titel: t, jahr: form.j.value || undefined });
        out.innerHTML = "";
        out.append(candidateList(r.kandidaten || [], onPick));
      } catch (err) { out.innerHTML = ""; toast(err.message, "err"); }
    };
    form.addEventListener("submit", run);
    btn.addEventListener("click", run);
    form.j.addEventListener("input", () => (form.j.value = form.j.value.replace(/\D/g, "").slice(0, 4)));
    return box;
  }

  function candidateList(kandidaten, onPick) {
    const ul = document.createElement("div");
    ul.className = "cands";
    if (!kandidaten.length) { ul.innerHTML = `<div class="row secondary">Keine Treffer. Versuch einen kürzeren Titel.</div>`; return ul; }
    kandidaten.forEach((k) => {
      if (k.poster) state.posters[pkey(k.titel, k.jahr)] = k.poster;
      const b = document.createElement("button");
      b.className = "row row-btn film-row";
      b.innerHTML = `${posterHtml(k.titel, k.jahr, "sm", k.poster)}<div class="grow"><div class="t">${esc(k.titel)}</div>
        <div class="m">${esc(k.jahr || "")}${k.originaltitel && k.originaltitel !== k.titel ? ` · ${esc(k.originaltitel)}` : ""}</div></div>${icon("chev").replace("<svg", '<svg class="chev"')}`;
      b.addEventListener("click", () => onPick(k));
      ul.append(b);
    });
    savePosterCache();
    return ul;
  }

  /* ------------------------------------------------------------ Ergebnis */

  function showResult(d, onDone) {
    if (d.poster) { state.posters[pkey(d.titel, d.jahr)] = d.poster; savePosterCache(); }
    const tr = d.treffer || [];
    const eanHits = tr.filter((t) => t.art === "ean");
    const titleHits = tr.filter((t) => t.art === "titel" || !t.art);
    const otherYear = tr.filter((t) => t.art === "titel_anderes_jahr");
    const inColl = eanHits.find((t) => t.liste === "Sammlung");
    const onWish = eanHits.find((t) => t.liste === "Wunschliste");
    const titleWish = titleHits.find((t) => t.liste === "Wunschliste");
    let format = d.format && state.formate.includes(d.format) ? d.format : (d.format || "");
    let ean = d.ean || "";
    let busy = false;

    const body = document.createElement("div");
    const foot = document.createElement("div");
    foot.style.display = "grid"; foot.style.gap = "10px";

    let kind;
    if (inColl) kind = "ok";
    else if (onWish) kind = "wish";
    else if (titleHits.length) kind = "other";
    else kind = "miss";

    const states = {
      ok: ["check", "In deiner Sammlung", "Genau diese Ausgabe hast du schon."],
      wish: ["heart", "Auf deiner Wunschliste", "Diese Ausgabe wünschst du dir."],
      other: ["copy", "Andere Ausgabe vorhanden", "Den Titel hast du, aber mit anderer EAN."],
      miss: ["plus", "Noch nicht in deinen Listen", "Kaufen oder für später merken?"],
    };

    function render() {
      const [ic, h, sub] = states[kind];
      const hitRows = (list) => list.map((t) => `<div class="row">
          <div class="grow"><div class="lst">${esc(t.liste)}</div>
          <div class="m" style="font-size:14px;color:var(--label-2);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="chip">${esc(t.format || "–")}</span>${t.jahr ? `<span>${esc(t.jahr)}</span>` : ""}${t.ean ? `<span class="tnum">${esc(t.ean)}</span>` : ""}</div></div>
          ${ean && t.art !== "ean" ? `<button class="small-btn" data-rem="${t.zeile}" data-liste="${esc(t.liste)}">EAN merken</button>` : ""}
        </div>`).join("");

      const needsFormat = kind !== "ok";
      body.innerHTML = `
        <div class="res-head">
          ${posterHtml(d.titel, d.jahr, "lg", d.poster)}
          <div class="grow" style="min-width:0">
            <h3>${esc(d.titel)}</h3>
            <div class="meta">${d.jahr ? `<span>${esc(d.jahr)}</span>` : ""}${d.format ? `<span class="chip">${esc(d.format)}</span>` : ""}</div>
            ${ean && !d.eanEditable ? `<div class="src tnum">EAN ${esc(ean)}</div>` : ""}
            ${d.quelle || d.rohname ? `<div class="src">${esc([d.quelle && "Quelle: " + d.quelle, d.rohname].filter(Boolean).join(" · "))}</div>` : ""}
          </div>
        </div>
        <div class="state s-${kind}"><span class="badge">${icon(ic)}</span><div><strong>${h}</strong><span>${sub}</span></div></div>
        ${kind === "ok" && inColl ? `<div class="hits">${hitRows([inColl])}</div>` : ""}
        ${kind === "wish" && onWish ? `<div class="hits">${hitRows([onWish])}</div>` : ""}
        ${kind === "other" ? `<div class="hits">${hitRows(titleHits)}</div>` : ""}
        ${otherYear.length ? `<p class="field-label">Gleicher Titel, anderes Jahr – vielleicht ein Remake</p><div class="hits">${hitRows(otherYear)}</div>` : ""}
        ${needsFormat ? `<p class="field-label">Format</p>
          <div class="segmented" data-n="${state.formate.length === 4 ? 4 : 2}" role="radiogroup" id="fmt-seg" style="${state.formate.length === 4 ? "" : "grid-template-columns:repeat(" + state.formate.length + ",1fr)"}">
            ${state.formate.map((f) => `<button type="button" role="radio" data-f="${esc(f)}" aria-selected="${f === format}">${esc(f)}</button>`).join("")}
            <span class="seg-thumb" aria-hidden="true"></span></div>` : ""}
        ${d.eanEditable && needsFormat ? `<p class="field-label">EAN (falls bekannt)</p><input class="field tnum" id="res-ean" inputmode="numeric" maxlength="14" value="${esc(ean)}">` : ""}
      `;
      syncSeg($("#fmt-seg", body), format);
      $$("#fmt-seg button", body).forEach((b) => b.addEventListener("click", () => { format = b.dataset.f; syncSeg($("#fmt-seg", body), format); renderFoot(); }));
      const ei = $("#res-ean", body);
      if (ei) ei.addEventListener("input", () => { ei.value = ei.value.replace(/\D/g, "").slice(0, 14); ean = ei.value; });
      $$("[data-rem]", body).forEach((b) => b.addEventListener("click", () => {
        const t = tr.find((x) => String(x.zeile) === b.dataset.rem && x.liste === b.dataset.liste);
        act("rememberEan", { liste: t.liste, zeile: t.zeile, titel: t.titel, ean }, b);
      }));
      renderFoot();
      if (!d.poster) wantPosters([{ titel: d.titel, jahr: d.jahr }]);
    }

    function renderFoot() {
      const noFmt = !format;
      const B = (cls, label, fn, dis) => {
        const b = document.createElement("button");
        b.className = `btn ${cls}`; b.textContent = label; b.disabled = !!dis;
        b.addEventListener("click", () => fn(b));
        return b;
      };
      foot.innerHTML = "";
      if (kind === "ok") {
        foot.append(B("btn-primary", "Nächster Film", () => s.close()));
        return;
      }
      if (kind === "wish") {
        foot.append(B("btn-primary", "Gekauft – in die Sammlung", (b) => act("buy", buyData(onWish), b)));
      } else if (kind === "other" && titleWish) {
        foot.append(B("btn-primary", "Gekauft – in die Sammlung", (b) => act("buy", buyData(titleWish), b)));
      } else {
        foot.append(B("btn-primary", "Gekauft – in die Sammlung", (b) => act("add", addData("Sammlung"), b), noFmt));
        foot.append(B("btn-secondary", "Auf die Wunschliste", (b) => act("add", addData("Wunschliste"), b), noFmt));
      }
      if (noFmt && kind !== "wish" && !(kind === "other" && titleWish)) {
        const p = document.createElement("p");
        p.className = "secondary"; p.style.cssText = "margin:0;text-align:center;font-size:13px";
        p.textContent = "Wähle zuerst das Format.";
        foot.append(p);
      }
    }

    const addData = (liste) => ({ liste, ean: ean || undefined, titel: d.titel, jahr: d.jahr || undefined, format });
    const buyData = (t) => ({ zeile: t.zeile, titel: t.titel, ean: ean || undefined, jahr: t.jahr || d.jahr || undefined, format: format || undefined });

    async function act(action, data, btn) {
      if (busy) return;
      busy = true;
      const label = btn.textContent;
      btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
      try {
        const r = await api(action, data);
        state.daten = { Sammlung: null, Wunschliste: null };
        toast(r.meldung || "Gespeichert");
        done(r.meldung || "Gespeichert");
      } catch (e) {
        toast(e.message, "err");
        btn.textContent = label;
      } finally { busy = false; }
    }

    function done(msg) {
      $(".state", body).outerHTML = `<div class="state s-done"><span class="badge">${icon("check")}</span><div><strong>Gespeichert</strong><span>${esc(msg)}</span></div></div>`;
      $$(".field-label, #fmt-seg, #res-ean, .hits", body).forEach((x) => x.remove());
      foot.innerHTML = "";
      const b = document.createElement("button");
      b.className = "btn btn-primary"; b.textContent = state.tab === "scan" ? "Nächster Film" : "Fertig";
      b.addEventListener("click", () => s.close());
      foot.append(b);
    }

    render();
    const s = sheet({ title: d.eanEditable ? "Ergebnis" : "Scan-Ergebnis", body, foot, onClose: onDone });
  }

  function syncSeg(seg, value) {
    if (!seg) return;
    const btns = $$("button", seg);
    const i = btns.findIndex((b) => (b.dataset.f || b.dataset.liste) === value);
    btns.forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
    const th = $(".seg-thumb", seg);
    th.style.width = `calc(${100 / btns.length}% - ${4 / btns.length}px)`;
    th.style.opacity = i < 0 ? "0" : "1";
    if (i >= 0) th.style.transform = `translateX(${i * 100}%)`;
  }

  /* ------------------------------------------------------------ Suchen */

  const sForm = $("#search-form"), sBtn = $("#search-btn");
  function syncSearchBtn() { sBtn.disabled = !($("#s-titel").value.trim() || $("#s-ean").value.length >= 8); }
  $("#s-titel").addEventListener("input", syncSearchBtn);
  $("#s-jahr").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));
  $("#s-ean").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 14); syncSearchBtn(); });
  sForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sBtn.disabled) return;
    const ean = $("#s-ean").value;
    const out = $("#search-results");
    if (ean.length >= 8) { lookupEan(ean); return; }
    out.innerHTML = spinner("Suche läuft …");
    sBtn.disabled = true;
    try {
      const r = await api("searchTitle", { titel: $("#s-titel").value.trim(), jahr: $("#s-jahr").value || undefined });
      out.innerHTML = `<p class="section-title">Treffer</p>`;
      const list = candidateList(r.kandidaten || [], (k) => checkTitle(k, ""));
      list.style.margin = "0 16px";
      out.append(list);
      wantPosters((r.kandidaten || []).filter((k) => !k.poster));
    } catch (err) { out.innerHTML = ""; toast(err.message, "err"); }
    finally { syncSearchBtn(); }
  });

  /* ------------------------------------------------------------ Listen */

  async function loadLists(force) {
    if (!force && state.daten.Sammlung && state.daten.Wunschliste) return;
    const [a, b] = await Promise.all([api("list", { liste: "Sammlung" }), api("list", { liste: "Wunschliste" })]);
    state.daten.Sammlung = a.eintraege || [];
    state.daten.Wunschliste = b.eintraege || [];
  }

  function setLayoutIcon() { $("#layout-btn").innerHTML = icon(state.layout === "grid" ? "list" : "grid"); $("#layout-btn").setAttribute("aria-label", state.layout === "grid" ? "Als Liste zeigen" : "Als Raster zeigen"); }
  setLayoutIcon();
  $("#layout-btn").addEventListener("click", () => { state.layout = state.layout === "grid" ? "list" : "grid"; store.set("fs_layout", state.layout); setLayoutIcon(); drawList(); });
  $("#refresh-btn").addEventListener("click", () => renderLists(true, true));
  $$("#list-seg button").forEach((b) => b.addEventListener("click", () => { state.liste = b.dataset.liste; syncSeg($("#list-seg"), state.liste); $("#lists-title").textContent = state.liste; drawList(); }));
  let suchTimer;
  $("#l-suche").addEventListener("input", () => { clearTimeout(suchTimer); suchTimer = setTimeout(drawList, 120); });

  async function renderLists(show, force) {
    syncSeg($("#list-seg"), state.liste);
    const body = $("#list-body");
    if (!state.daten.Sammlung || force) {
      if (!state.daten.Sammlung) body.innerHTML = skeleton();
      $("#refresh-btn").classList.add("spinning");
      try { await loadLists(true); } catch (e) { toast(e.message, "err"); if (!state.daten.Sammlung) body.innerHTML = `<div class="empty"><strong>Listen nicht geladen</strong>${esc(e.message)}</div>`; return; }
      finally { $("#refresh-btn").classList.remove("spinning"); }
    }
    drawList();
  }

  function skeleton() {
    return `<div class="grid">${Array.from({ length: 9 }, () => `<div><div class="poster skeleton" style="width:100%"></div><div class="skeleton" style="height:12px;border-radius:6px;margin-top:8px;width:80%"></div></div>`).join("")}</div>`;
  }

  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss"); }

  function drawList() {
    const body = $("#list-body");
    const all = state.daten[state.liste];
    if (!all) return;
    const q = norm($("#l-suche").value.trim());
    const qd = q.replace(/\D/g, "");
    const items = !q ? all : all.filter((x) => norm(x.titel).includes(q) || (qd.length >= 3 && (String(x.ean).includes(qd) || String(x.weitereEans || "").includes(qd))));
    if (!all.length) { body.innerHTML = `<div class="empty"><strong>${state.liste === "Sammlung" ? "Noch keine Filme" : "Wunschliste ist leer"}</strong>Scanne einen Film, um ihn hinzuzufügen.</div>`; return; }
    if (!items.length) { body.innerHTML = `<div class="empty"><strong>Keine Treffer</strong>Nichts passt zu „${esc($("#l-suche").value)}“.</div>`; return; }
    const count = `<p class="count-line">${items.length === all.length ? `${all.length} ${all.length === 1 ? "Film" : "Filme"}` : `${items.length} von ${all.length}`}</p>`;
    if (state.layout === "grid") {
      body.innerHTML = count + `<div class="grid">${items.map((x, i) => `<button class="tile" data-i="${i}">${posterHtml(x.titel, x.jahr, "")}<div class="t">${esc(x.titel)}</div><div class="m">${esc([x.jahr, x.format].filter(Boolean).join(" · "))}</div></button>`).join("")}</div>`;
    } else {
      body.innerHTML = count + `<div class="group-card">${items.map((x, i) => `<button class="row row-btn film-row" data-i="${i}">${posterHtml(x.titel, x.jahr, "sm")}<div class="grow"><div class="t">${esc(x.titel)}</div><div class="m">${x.jahr ? `<span>${esc(x.jahr)}</span>` : ""}${x.format ? `<span class="chip">${esc(x.format)}</span>` : ""}</div></div></button>`).join("")}</div>`;
    }
    $$("[data-i]", body).forEach((b) => b.addEventListener("click", () => showEntry(items[+b.dataset.i])));
    wantPosters(items.slice(0, 120));
  }

  function showEntry(x) {
    const wish = x.liste === "Wunschliste";
    const body = `<div class="res-head">${posterHtml(x.titel, x.jahr, "lg")}<div class="grow" style="min-width:0"><h3>${esc(x.titel)}</h3>
        <div class="meta">${x.jahr ? `<span>${esc(x.jahr)}</span>` : ""}${x.format ? `<span class="chip">${esc(x.format)}</span>` : ""}</div></div></div>
      <div class="cands" style="background:var(--fill)">
        <div class="row"><span class="grow">Liste</span><span class="value">${esc(x.liste)}</span></div>
        ${x.ean ? `<div class="row"><span class="grow">EAN</span><span class="value tnum">${esc(x.ean)}</span></div>` : ""}
        ${x.weitereEans ? `<div class="row"><span class="grow">Weitere EANs</span><span class="value tnum" style="text-align:right">${esc(x.weitereEans)}</span></div>` : ""}
        ${x.hinzugefuegtAm ? `<div class="row"><span class="grow">Hinzugefügt</span><span class="value">${esc(x.hinzugefuegtAm)}</span></div>` : ""}
        ${x.notiz ? `<div class="row"><span class="grow">Notiz</span><span class="value">${esc(x.notiz)}</span></div>` : ""}
      </div>`;
    let foot = "";
    if (wish) {
      const b = document.createElement("button");
      b.className = "btn btn-primary"; b.textContent = "Gekauft – in die Sammlung";
      b.addEventListener("click", async () => {
        b.innerHTML = '<span class="spin"></span>Gekauft – in die Sammlung'; b.disabled = true;
        try {
          const r = await api("buy", { zeile: x.zeile, titel: x.titel, jahr: x.jahr || undefined, format: x.format || undefined });
          toast(r.meldung || "In die Sammlung übertragen");
          s.close();
          state.daten = { Sammlung: null, Wunschliste: null };
          renderLists(true, true);
        } catch (e) { toast(e.message, "err"); b.textContent = "Gekauft – in die Sammlung"; b.disabled = false; }
      });
      foot = b;
    }
    const s = sheet({ title: wish ? "Wunschliste" : "Sammlung", body, foot });
  }

  /* ------------------------------------------------------------ Übersicht */

  function parseDatum(s) { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s || ""); return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0; }

  async function renderStats() {
    const body = $("#stats-body");
    if (!state.daten.Sammlung) {
      body.innerHTML = spinner("Daten werden geladen …");
      try { await loadLists(true); } catch (e) { body.innerHTML = `<div class="empty"><strong>Daten nicht geladen</strong>${esc(e.message)}</div>`; return; }
    }
    if (state.tab !== "stats") return;
    const S = state.daten.Sammlung, W = state.daten.Wunschliste;
    const byFormat = {};
    S.forEach((x) => { const f = x.format || "Ohne Format"; byFormat[f] = (byFormat[f] || 0) + 1; });
    const fmtRows = Object.entries(byFormat).sort((a, b) => b[1] - a[1]);
    const byDec = {};
    S.forEach((x) => { const j = parseInt(x.jahr, 10); if (j > 1880) { const d = Math.floor(j / 10) * 10; byDec[d] = (byDec[d] || 0) + 1; } });
    const decRows = Object.entries(byDec).sort((a, b) => b[0] - a[0]);
    const recent = S.concat(W).filter((x) => parseDatum(x.hinzugefuegtAm)).sort((a, b) => parseDatum(b.hinzugefuegtAm) - parseDatum(a.hinzugefuegtAm)).slice(0, 12);
    const max = (rows) => Math.max(1, ...rows.map((r) => r[1]));
    const bars = (rows, label) => { const m = max(rows); return rows.map(([k, v]) => `<div class="bar-row"><span class="lbl">${esc(label(k))}</span><span class="bar"><i style="width:${(v / m) * 100}%"></i></span><span class="v">${v}</span></div>`).join(""); };

    body.innerHTML = `
      <div class="big-pair">
        <button class="big" data-go="Sammlung"><div class="n">${S.length}</div><div class="l"><span class="dot" style="background:var(--green)"></span>Sammlung</div></button>
        <button class="big" data-go="Wunschliste"><div class="n">${W.length}</div><div class="l"><span class="dot" style="background:var(--indigo)"></span>Wunschliste</div></button>
      </div>
      ${recent.length ? `<p class="section-title">Zuletzt hinzugefügt</p><div class="shelf">${recent.map((x, i) => `<button class="tile" data-r="${i}">${posterHtml(x.titel, x.jahr, "")}<div class="t">${esc(x.titel)}</div><div class="m">${esc(x.hinzugefuegtAm)}</div></button>`).join("")}</div>` : ""}
      ${fmtRows.length ? `<p class="section-title">Sammlung nach Format</p><div class="group-card">${bars(fmtRows, (k) => k)}</div>` : ""}
      ${decRows.length ? `<p class="section-title">Sammlung nach Jahrzehnt</p><div class="group-card">${bars(decRows, (k) => `${k}er`)}</div>` : ""}
      <p class="section-title">Einstellungen</p>
      <div class="group-card">
        <div class="row"><span class="grow">Cover-Bilder</span><span class="value">${state.postersSupported ? "Aktiv" : "Skript-Update nötig"}</span></div>
        <button class="row row-btn row-danger" id="logout-btn">Abmelden</button>
      </div>
      ${state.postersSupported ? "" : `<p class="section-note">Für Cover braucht dein Apps Script die Version 3 mit der Aktion „posters“.</p>`}
    `;
    $$("[data-go]", body).forEach((b) => b.addEventListener("click", () => { state.liste = b.dataset.go; $("#lists-title").textContent = state.liste; switchTab("lists"); }));
    $$("[data-r]", body).forEach((b) => b.addEventListener("click", () => showEntry(recent[+b.dataset.r])));
    $("#logout-btn").addEventListener("click", logout);
    wantPosters(recent);
  }

  /* ------------------------------------------------------------ Start */

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopScanner();
    else if (state.pin && state.tab === "scan" && !openSheet) startScanner();
  });

  const saved = store.get("fs_pin");
  if (saved) {
    state.pin = saved;
    startApp();
    api("login").then((r) => setFormate(r.formate)).catch((e) => { if (!e.wrongPin) toast(e.message, "err"); });
  } else {
    showLogin();
  }
})();
