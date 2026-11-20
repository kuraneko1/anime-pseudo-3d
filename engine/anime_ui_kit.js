/* Anime Pseudo-3D Reusable Modular UI Component Library (`window.AnimeUIKit`)
 *
 * 100% Pixel-Art Compliant (zero native range/select inputs, zero emojis, zero rounded corners).
 * Supports:
 *   - Arbitrary-N animations (1 static model, 2, 4, 9, 16, 24, 50+ motions) with dynamic grid,
 *     scrollable motion shelf, optional category filter pills, and PREV/NEXT (`[` / `]`) stepping.
 *   - Reusable individual widgets (`createPixelSlider`, `createMotionShelf`, `createTimelineScrubber`,
 *     `createFileIOControls`) OR turnkey full studio shell (`mountStudioUI`).
 *   - Live `.ap3d` Load / Append-Merge / Export + Drag-and-Drop onto the 3D stage.
 */
(function (global) {
  "use strict";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function createPixelSlider({ id, label, min, max, step, getVal, setVal, formatVal, actionText, actionId, onAction, ariaLabel }) {
    const row = el("div", "slider-row");
    const lbl = el("span", "slider-label", label);

    const slider = el("div", "px-slider");
    if (id) slider.id = id;
    slider.setAttribute("role", "slider");
    slider.setAttribute("tabindex", "0");
    slider.setAttribute("aria-label", ariaLabel || label);
    slider.setAttribute("aria-valuemin", String(min));
    slider.setAttribute("aria-valuemax", String(max));

    const track = el("div", "px-slider-track");
    const fill = el("div", "px-slider-fill");
    const ticks = el("div", "px-slider-ticks");
    track.appendChild(fill);
    track.appendChild(ticks);
    const thumb = el("div", "px-slider-thumb");
    slider.appendChild(track);
    slider.appendChild(thumb);

    const valSpan = el("span", "slider-val");
    if (id) valSpan.id = id.replace(/^sl/, "val");

    const actBtn = el("button", "px-btn slider-action", actionText || "");
    actBtn.type = "button";
    if (actionId) actBtn.id = actionId;
    if (onAction) actBtn.addEventListener("click", onAction);

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(valSpan);
    row.appendChild(actBtn);

    function sync() {
      let v;
      try { v = getVal(); } catch (_) { return; }
      if (typeof v !== "number" || Number.isNaN(v)) return;
      const pct = Math.max(0, Math.min(1, (v - min) / Math.max(1e-6, max - min))) * 100;
      fill.style.width = pct.toFixed(2) + "%";
      thumb.style.left = pct.toFixed(2) + "%";
      slider.setAttribute("aria-valuenow", String(v));
      valSpan.textContent = formatVal ? formatVal(v) : String(v);
    }

    function setFromClientX(clientX) {
      const rect = slider.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      let v = min + ratio * (max - min);
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      setVal(v);
      sync();
    }

    slider.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      slider.setPointerCapture(e.pointerId);
      slider.classList.add("dragging");
      setFromClientX(e.clientX);
    });
    slider.addEventListener("pointermove", (e) => {
      if (!slider.classList.contains("dragging")) return;
      setFromClientX(e.clientX);
    });
    const endDrag = () => slider.classList.remove("dragging");
    slider.addEventListener("pointerup", endDrag);
    slider.addEventListener("pointercancel", endDrag);
    slider.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setVal(Math.max(min, getVal() - step));
        sync();
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setVal(Math.min(max, getVal() + step));
        sync();
      }
    });

    sync();
    return { el: row, slider, valSpan, actionBtn: actBtn, sync };
  }

  function createTimelineScrubber({ onScrub }) {
    const wrap = el("div", "timeline-wrap");
    const head = el("div", "timeline-head");
    const headLbl = el("span", "", "TIMELINE (SCRUB)");
    const tlVal = el("span", "val", "F01 / 24");
    tlVal.id = "tlVal";
    head.appendChild(headLbl);
    head.appendChild(tlVal);

    const bar = el("div", "timeline-bar");
    bar.id = "timelineBar";
    bar.setAttribute("role", "slider");
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-label", "Animation Timeline");
    bar.setAttribute("aria-valuemin", "1");

    wrap.appendChild(head);
    wrap.appendChild(bar);

    let cells = [];
    let frameCount = 24;

    function rebuild(count) {
      frameCount = Math.max(1, count | 0);
      bar.innerHTML = "";
      bar.style.gridTemplateColumns = `repeat(${frameCount}, 1fr)`;
      bar.setAttribute("aria-valuemax", String(frameCount));
      cells = [];
      for (let i = 0; i < frameCount; i++) {
        const c = el("div", "tl-cell" + (i === 0 ? " cur" : ""));
        bar.appendChild(c);
        cells.push(c);
      }
    }
    rebuild(24);

    function update(fIdx, count) {
      const fc = Math.max(1, (count || frameCount) | 0);
      if (cells.length !== fc) rebuild(fc);
      const safeF = Math.max(0, Math.min(fc - 1, fIdx | 0));
      for (let i = 0; i < fc; i++) {
        cells[i].className = i === safeF ? "tl-cell cur" : (i < safeF ? "tl-cell past" : "tl-cell");
      }
      tlVal.textContent = `F${String(safeF + 1).padStart(2, "0")} / ${fc}`;
      bar.setAttribute("aria-valuenow", String(safeF + 1));
    }

    let dragging = false;
    function scrubAt(clientX) {
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / Math.max(1, rect.width)));
      const f = Math.floor(ratio * frameCount);
      if (onScrub) onScrub(f);
    }
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      bar.setPointerCapture(e.pointerId);
      scrubAt(e.clientX);
    });
    bar.addEventListener("pointermove", (e) => { if (dragging) scrubAt(e.clientX); });
    bar.addEventListener("pointerup", () => { dragging = false; });
    bar.addEventListener("pointercancel", () => { dragging = false; });

    return { el: wrap, bar, valSpan: tlVal, update };
  }

  function createMotionShelf({ onSelect, onStep, getAssetSrc }) {
    const section = el("div", "panel-section");
    const head = el("div", "sec-head");
    const headLeft = el("div", "sec-head-left");
    const headIco = el("img", "px-ico");
    headIco.setAttribute("data-ico", "ico_anim");
    headIco.alt = "motions";
    const headTitle = el("span", "", "MOTIONS");
    headTitle.id = "motionHead";
    headLeft.appendChild(headIco);
    headLeft.appendChild(headTitle);

    const nav = el("div", "motion-nav-inline");
    const btnPrev = el("button", "px-btn motion-nav-btn", "<");
    btnPrev.type = "button";
    btnPrev.id = "btnMotionPrev";
    btnPrev.title = "Previous Motion ([)";
    const countBadge = el("span", "motion-count-badge", "1/1");
    countBadge.id = "motionCounter";
    const btnNext = el("button", "px-btn motion-nav-btn", ">");
    btnNext.type = "button";
    btnNext.id = "btnMotionNext";
    btnNext.title = "Next Motion (])";
    btnPrev.addEventListener("click", () => { if (onStep) onStep(-1); });
    btnNext.addEventListener("click", () => { if (onStep) onStep(1); });
    nav.appendChild(btnPrev);
    nav.appendChild(countBadge);
    nav.appendChild(btnNext);

    head.appendChild(headLeft);
    head.appendChild(nav);
    section.appendChild(head);

    const catBar = el("div", "motion-cat-bar");
    catBar.id = "motionCatBar";
    section.appendChild(catBar);

    const shelf = el("div", "motion-shelf");
    const grid = el("div", "motion-grid");
    grid.id = "motionGrid";
    shelf.appendChild(grid);
    section.appendChild(shelf);

    let allMotions = [];
    let activeMotionId = "";
    let activeCategory = "ALL";

    function renderGrid() {
      const visible = activeCategory === "ALL"
        ? allMotions
        : allMotions.filter((m) => (m.category || "GENERAL").toUpperCase() === activeCategory);

      grid.innerHTML = "";
      grid.className = "motion-grid";
      if (visible.length <= 1) grid.classList.add("cols-1");
      else if (visible.length <= 4) grid.classList.add("cols-2");

      visible.forEach((m) => {
        const globalIdx = allMotions.indexOf(m);
        const btn = el("button", "px-btn motion-btn");
        btn.type = "button";
        if (m.accent && m.accent !== "default") btn.classList.add("accent-" + m.accent);
        if (m.id === activeMotionId) btn.classList.add("active");
        btn.setAttribute("data-motion", m.id);

        const top = el("span", "motion-btn-top");
        if (m.icon) {
          const ico = el("img", "px-ico");
          ico.setAttribute("data-ico", m.icon);
          ico.alt = "";
          if (getAssetSrc) {
            const src = getAssetSrc(m.icon);
            if (src) ico.src = src;
          }
          top.appendChild(ico);
        }
        top.appendChild(el("span", "", `${globalIdx + 1}.${m.label}`));
        btn.appendChild(top);
        if (m.subtitle) {
          btn.appendChild(el("span", "motion-btn-sub", m.subtitle));
        }
        btn.addEventListener("click", () => { if (onSelect) onSelect(m.id); });
        grid.appendChild(btn);
      });
    }

    function refresh(motions, activeId) {
      allMotions = Array.isArray(motions) ? motions : [];
      activeMotionId = activeId || (allMotions[0] ? allMotions[0].id : "");

      const curIdx = Math.max(0, allMotions.findIndex((m) => m.id === activeMotionId));
      const curM = allMotions[curIdx];
      const fc = curM ? (curM.frames || 24) : 1;
      if (allMotions.length === 0) {
        headTitle.textContent = "NO MODEL LOADED";
      } else if (allMotions.length === 1 && fc === 1) {
        headTitle.textContent = "STATIC 3D MODEL";
      } else {
        headTitle.textContent = `${allMotions.length} MOTIONS (${fc}F)`;
      }
      nav.style.display = allMotions.length > 1 ? "flex" : "none";
      countBadge.textContent = allMotions.length > 0 ? `${curIdx + 1}/${allMotions.length}` : "0/0";

      // Build optional category filter pills whenever 2+ distinct categories exist
      const cats = [];
      const catSet = new Set();
      for (const m of allMotions) {
        if (m.category) {
          const c = String(m.category).toUpperCase();
          if (!catSet.has(c)) { catSet.add(c); cats.push(c); }
        }
      }
      if (cats.length >= 2) {
        if (activeCategory !== "ALL" && !catSet.has(activeCategory)) activeCategory = "ALL";
        catBar.style.display = "flex";
        catBar.innerHTML = "";
        ["ALL", ...cats].forEach((c) => {
          const pill = el("button", "cat-pill" + (c === activeCategory ? " active" : ""), c);
          pill.type = "button";
          pill.setAttribute("data-cat", c);
          pill.addEventListener("click", () => {
            activeCategory = c;
            catBar.querySelectorAll(".cat-pill").forEach((p) => p.classList.toggle("active", p.getAttribute("data-cat") === c));
            renderGrid();
          });
          catBar.appendChild(pill);
        });
      } else {
        activeCategory = "ALL";
        catBar.style.display = "none";
        catBar.innerHTML = "";
      }

      renderGrid();
    }

    function setActive(activeId) {
      const changed = (activeId !== activeMotionId);
      activeMotionId = activeId;
      const curIdx = Math.max(0, allMotions.findIndex((m) => m.id === activeMotionId));
      countBadge.textContent = allMotions.length > 0 ? `${curIdx + 1}/${allMotions.length}` : "0/0";
      grid.querySelectorAll("[data-motion]").forEach((btn) => {
        const isAct = btn.getAttribute("data-motion") === activeMotionId;
        btn.classList.toggle("active", isAct);
        if (changed && isAct) {
          // Scroll ONLY the inner .motion-shelf container so mobile .panel scroll never jumps!
          const top = btn.offsetTop - shelf.offsetTop;
          const bot = top + btn.offsetHeight;
          if (top < shelf.scrollTop) shelf.scrollTop = top;
          else if (bot > shelf.scrollTop + shelf.clientHeight) shelf.scrollTop = bot - shelf.clientHeight;
        }
      });
    }

    return { el: section, refresh, setActive };
  }

  function createFileIOControls({ onLoadFile, onMergeFile, onExport }) {
    const section = el("div", "panel-section");
    const head = el("div", "sec-head");
    const headLeft = el("div", "sec-head-left");
    const ico = el("img", "px-ico");
    ico.setAttribute("data-ico", "ico_layers");
    ico.alt = "package";
    const headTitle = el("span", "", "PACKAGE & EXPORT");
    headLeft.appendChild(ico);
    headLeft.appendChild(headTitle);
    head.appendChild(headLeft);
    section.appendChild(head);

    const fmtBar = el("div", "motion-cat-bar");
    fmtBar.id = "exportFmtBar";
    fmtBar.style.display = "none";
    section.appendChild(fmtBar);

    const row = el("div", "file-io-row");

    const inputLoad = el("input", "hidden-file-input");
    inputLoad.type = "file";
    inputLoad.id = "ap3dLoadInput";
    inputLoad.accept = ".ap3d,.json,application/octet-stream";
    inputLoad.addEventListener("change", () => {
      if (inputLoad.files && inputLoad.files[0] && onLoadFile) {
        onLoadFile(inputLoad.files[0]);
      }
      inputLoad.value = "";
    });

    const inputMerge = el("input", "hidden-file-input");
    inputMerge.type = "file";
    inputMerge.id = "ap3dMergeInput";
    inputMerge.accept = ".ap3d,.json,application/octet-stream";
    inputMerge.addEventListener("change", () => {
      if (inputMerge.files && inputMerge.files[0] && onMergeFile) {
        onMergeFile(inputMerge.files[0]);
      }
      inputMerge.value = "";
    });

    const btnLoad = el("button", "px-btn teal", "LOAD");
    btnLoad.type = "button";
    btnLoad.id = "btnLoadAp3d";
    btnLoad.title = "Load .ap3d character package";
    btnLoad.addEventListener("click", () => inputLoad.click());

    const btnMerge = el("button", "px-btn", "+MOTION");
    btnMerge.type = "button";
    btnMerge.id = "btnMergeAp3d";
    btnMerge.title = "Append motions from another .ap3d file";
    btnMerge.addEventListener("click", () => inputMerge.click());

    const btnExport = el("button", "px-btn gold", "EXPORT");
    btnExport.type = "button";
    btnExport.id = "btnExportAp3d";
    btnExport.title = "Export in selected format";
    let selectedFormat = "ap3d";
    let currentFormats = [];
    let currentCanLoad = true;
    btnExport.addEventListener("click", () => { if (onExport) onExport(selectedFormat); });

    row.appendChild(btnLoad);
    row.appendChild(btnMerge);
    row.appendChild(btnExport);
    section.appendChild(row);
    section.appendChild(inputLoad);
    section.appendChild(inputMerge);

    function updateExportLabel() {
      const active = currentFormats.find((f) => f.id === selectedFormat);
      btnExport.textContent = (!currentCanLoad && active) ? ("EXPORT " + active.label) : "EXPORT";
    }

    function syncCapabilities(formats, canLoad) {
      currentFormats = Array.isArray(formats) ? formats : [];
      currentCanLoad = Boolean(canLoad);
      if (currentFormats.length === 0 && !currentCanLoad) {
        section.style.display = "none";
        return;
      }
      section.style.display = "";
      headTitle.textContent = currentCanLoad ? "PACKAGE & EXPORT" : "EXPORT 3D / IMAGE";
      btnLoad.style.display = currentCanLoad ? "" : "none";
      btnMerge.style.display = currentCanLoad ? "" : "none";
      row.classList.toggle("export-only", !currentCanLoad);

      if (currentFormats.length > 0 && !currentFormats.some((f) => f.id === selectedFormat)) {
        selectedFormat = currentFormats[0].id;
      }
      fmtBar.innerHTML = "";
      if (currentFormats.length >= 2) {
        fmtBar.style.display = "flex";
        currentFormats.forEach((f) => {
          const pill = el("button", "cat-pill" + (f.id === selectedFormat ? " active" : ""), f.label);
          pill.type = "button";
          pill.setAttribute("data-expfmt", f.id);
          pill.addEventListener("click", () => {
            selectedFormat = f.id;
            fmtBar.querySelectorAll(".cat-pill").forEach((p) => p.classList.toggle("active", p.getAttribute("data-expfmt") === selectedFormat));
            updateExportLabel();
          });
          fmtBar.appendChild(pill);
        });
      } else {
        fmtBar.style.display = "none";
      }
      updateExportLabel();
    }

    return {
      el: section,
      btnLoad,
      btnMerge,
      btnExport,
      syncCapabilities,
      getSelectedFormat: () => selectedFormat,
      triggerLoad: () => inputLoad.click(),
    };
  }

  function mountStudioUI(rootEl, engine, options) {
    const opts = Object.assign(
      {
        showFileIO: true,
        showRenderModes: true,
        showViewAngles: true,
        showSliders: true,
        showToggles: true,
      },
      options || {}
    );

    rootEl.innerHTML = "";
    if (!rootEl.style.width) rootEl.style.width = "100%";
    if (!rootEl.style.height) rootEl.style.height = "100%";
    const shell = el("div", "app-shell");

    // === LEFT STAGE ===
    const stageWrap = el("div", "stage-wrap");
    const canvas = el("canvas");
    canvas.id = "stageCanvas";
    stageWrap.appendChild(canvas);

    const dropOverlay = el("div", "drop-overlay");
    dropOverlay.appendChild(el("div", "", "DROP .AP3D PACKAGE TO LOAD"));
    dropOverlay.appendChild(el("div", "drop-overlay-sub", "HOLD SHIFT WHILE DROPPING TO +MERGE MOTIONS"));
    stageWrap.appendChild(dropOverlay);

    const emptyBanner = el("div", "empty-stage-banner");
    emptyBanner.id = "emptyStageBanner";
    emptyBanner.style.display = "none";
    emptyBanner.appendChild(el("h2", "", "ANIME PSEUDO-3D PLAYER (.AP3D)"));
    emptyBanner.appendChild(el("p", "", "DROP ANY .AP3D FILE HERE OR CLICK LOAD"));
    const emptyLoadBtn = el("button", "px-btn teal", "LOAD .AP3D FILE");
    emptyLoadBtn.type = "button";
    emptyBanner.appendChild(emptyLoadBtn);
    stageWrap.appendChild(emptyBanner);

    const badge = el("div", "stage-badge");
    const badgeIcon = el("img", "px-ico px-ico-lg");
    badgeIcon.id = "badgeIcon";
    badgeIcon.setAttribute("data-ico", "ico_brand");
    badgeIcon.alt = "brand";
    const badgeText = el("div");
    const badgeTitle = el("div", "stage-badge-title", "ANIME PSEUDO-3D");
    badgeTitle.id = "badgeTitle";
    const badgeSub = el("div", "stage-badge-sub", "WEBGL 2-PASS SPRITE STACK ENGINE");
    badgeSub.id = "badgeSub";
    badgeText.appendChild(badgeTitle);
    badgeText.appendChild(badgeSub);
    badge.appendChild(badgeIcon);
    badge.appendChild(badgeText);
    stageWrap.appendChild(badge);

    const hudChip = el("div", "hud-chip", "F01/24 | 24 FPS | 020 DEG");
    hudChip.id = "hudChip";
    stageWrap.appendChild(hudChip);

    const toastEl = el("div", "status-toast");
    toastEl.id = "statusToast";
    stageWrap.appendChild(toastEl);

    let toastTimer = null;
    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
    }

    const footer = el("div", "stage-footer");
    const hintBox = el("div", "hint-box", "1-9 / [ ]: MOTION | DRAG: 360 | F: FACE | B: BOUNCE | SPACE: PLAY");
    hintBox.id = "hintBox";
    const rotGrp = el("div", "touch-rot-group");
    const btnBounce = el("button", "px-btn pink", "BOUNCE");
    btnBounce.type = "button";
    btnBounce.id = "btnBounce";
    const btnRotL = el("button", "px-btn", "<3D");
    btnRotL.type = "button";
    btnRotL.id = "btnRotL";
    const btnRotR = el("button", "px-btn", "3D>");
    btnRotR.type = "button";
    btnRotR.id = "btnRotR";
    rotGrp.appendChild(btnBounce);
    rotGrp.appendChild(btnRotL);
    rotGrp.appendChild(btnRotR);
    footer.appendChild(hintBox);
    footer.appendChild(rotGrp);
    stageWrap.appendChild(footer);

    // === RIGHT STUDIO PANEL ===
    const panel = el("aside", "panel");

    // 1. Arbitrary-N Motion Shelf + Dynamic Timeline
    const motionShelf = createMotionShelf({
      onSelect: (id) => engine.selectMotion(id),
      onStep: (d) => engine.stepMotion(d),
      getAssetSrc: (k) => engine.getAssetSrc(k),
    });
    const timeline = createTimelineScrubber({
      onScrub: (f) => engine.setFrame(f),
    });
    motionShelf.el.appendChild(timeline.el);
    panel.appendChild(motionShelf.el);

    // 2. Render Style & Pixel Feel
    let dotSlider = null;
    if (opts.showRenderModes) {
      const sec = el("div", "panel-section");
      const sh = el("div", "sec-head");
      const sl = el("div", "sec-head-left");
      const ic = el("img", "px-ico"); ic.setAttribute("data-ico", "ico_outline"); ic.alt = "render";
      sl.appendChild(ic);
      sl.appendChild(el("span", "", "RENDER STYLE & PIXEL FEEL"));
      sh.appendChild(sl);
      sec.appendChild(sh);

      const mgrid = el("div", "mode-grid");
      [
        ["0", "PIXEL+AA"],
        ["1", "RETRO PX"],
        ["2", "SMOOTH AA"],
        ["3", "SILKY 3D"],
      ].forEach(([rm, txt]) => {
        const b = el("button", "px-btn", txt);
        b.type = "button";
        b.setAttribute("data-rmode", rm);
        b.addEventListener("click", () => engine.setRenderMode(Number(rm)));
        mgrid.appendChild(b);
      });
      sec.appendChild(mgrid);

      dotSlider = createPixelSlider({
        id: "slDotSize",
        label: "DOT SIZE",
        min: 1.0, max: 2.6, step: 0.05,
        getVal: () => engine.getState().dotSize,
        setVal: (v) => engine.setDotSize(v),
        formatVal: (v) => v.toFixed(2),
        actionText: "1:1",
        actionId: "btnDotReset",
        onAction: () => engine.toggleDotPreset(),
      });
      dotSlider.el.style.paddingTop = "6px";
      dotSlider.el.style.paddingBottom = "0";
      dotSlider.el.style.borderBottom = "none";
      sec.appendChild(dotSlider.el);
      panel.appendChild(sec);
    }

    // 3. View Angles
    if (opts.showViewAngles) {
      const sec = el("div", "panel-section");
      const sh = el("div", "sec-head");
      const sl = el("div", "sec-head-left");
      const ic = el("img", "px-ico"); ic.setAttribute("data-ico", "ico_cam"); ic.alt = "camera";
      sl.appendChild(ic);
      sl.appendChild(el("span", "", "VIEW ANGLES"));
      sh.appendChild(sl);
      sec.appendChild(sh);

      const pgrid = el("div", "preset-grid");
      [
        ["0", "FRONT"], ["24", "3/4 L"], ["90", "L SIDE"],
        ["180", "BACK"], ["270", "R SIDE"], ["336", "3/4 R"],
      ].forEach(([deg, txt]) => {
        const b = el("button", "px-btn", txt);
        b.type = "button";
        b.setAttribute("data-angle", deg);
        b.addEventListener("click", () => engine.setAngleDeg(Number(deg)));
        pgrid.appendChild(b);
      });
      sec.appendChild(pgrid);
      panel.appendChild(sec);
    }

    // 4. Anim & 3D Controls
    let fpsSlider, pitchSlider, spacingSlider, zoomSlider;
    if (opts.showSliders) {
      const sec = el("div", "panel-section");
      const sh = el("div", "sec-head");
      const sl = el("div", "sec-head-left");
      const ic = el("img", "px-ico"); ic.setAttribute("data-ico", "ico_layers"); ic.alt = "controls";
      sl.appendChild(ic);
      sl.appendChild(el("span", "", "ANIM & 3D CONTROLS"));
      sh.appendChild(sl);
      sec.appendChild(sh);

      fpsSlider = createPixelSlider({
        id: "slFps", label: "ANIM FPS", min: 6, max: 36, step: 1,
        getVal: () => engine.getState().animFps,
        setVal: (v) => engine.setFps(v),
        formatVal: (v) => String(Math.round(v)),
        actionText: "PLAY", actionId: "btnPlayAnim",
        onAction: () => engine.togglePlay(),
      });
      pitchSlider = createPixelSlider({
        id: "slSquash", label: "PITCH", ariaLabel: "Camera Pitch Angle", min: 15, max: 90, step: 1,
        getVal: () => engine.getState().pitchDeg,
        setVal: (v) => engine.setPitchDeg(v),
        formatVal: (v) => String(Math.round(v)) + "°",
        actionText: "TOP", actionId: "btnTopView",
        onAction: () => engine.toggleTopView(),
      });
      spacingSlider = createPixelSlider({
        id: "slSpacing", label: "SPACING", min: 0.5, max: 2.2, step: 0.05,
        getVal: () => engine.getState().spacing,
        setVal: (v) => engine.setSpacing(v),
        formatVal: (v) => v.toFixed(2),
        actionText: "SPREAD", actionId: "btnSpread",
        onAction: () => engine.toggleSpread(),
      });
      zoomSlider = createPixelSlider({
        id: "slZoom", label: "ZOOM", min: 0.8, max: 3.2, step: 0.05,
        getVal: () => engine.getState().zoom,
        setVal: (v) => engine.setZoom(v),
        formatVal: (v) => v.toFixed(2) + "x",
        actionText: "FACE", actionId: "btnFaceZoom",
        onAction: () => engine.toggleFaceFocus(),
      });

      sec.appendChild(fpsSlider.el);
      sec.appendChild(pitchSlider.el);
      sec.appendChild(spacingSlider.el);
      sec.appendChild(zoomSlider.el);
      panel.appendChild(sec);
    }

    // 5. Display & Effects Toggles
    let btnAutoSpin, btnFx, btnOutline, btnTheme, txtTheme, btnSpring, btnReset;
    if (opts.showToggles) {
      const sec = el("div", "panel-section");
      const sh = el("div", "sec-head");
      const sl = el("div", "sec-head-left");
      const ic = el("img", "px-ico"); ic.setAttribute("data-ico", "ico_theme"); ic.alt = "style";
      sl.appendChild(ic);
      sl.appendChild(el("span", "", "DISPLAY & EFFECTS"));
      sh.appendChild(sl);
      sec.appendChild(sh);

      const trow = el("div", "toggle-row");
      btnAutoSpin = el("button", "px-btn active"); btnAutoSpin.type = "button"; btnAutoSpin.id = "btnAutoSpin";
      btnAutoSpin.appendChild(el("span", "", "SPIN: ON"));
      btnAutoSpin.addEventListener("click", () => engine.toggleFlag("autoSpin"));

      btnFx = el("button", "px-btn active"); btnFx.type = "button"; btnFx.id = "btnFx";
      btnFx.appendChild(el("span", "", "FX: ON"));
      btnFx.addEventListener("click", () => engine.toggleFlag("fxOn"));

      btnOutline = el("button", "px-btn active"); btnOutline.type = "button"; btnOutline.id = "btnOutline";
      const icOut = el("img", "px-ico"); icOut.setAttribute("data-ico", "ico_outline"); icOut.alt = "";
      btnOutline.appendChild(icOut);
      btnOutline.appendChild(el("span", "", "OUTLINE: ON"));
      btnOutline.addEventListener("click", () => engine.toggleFlag("outlineOn"));

      btnTheme = el("button", "px-btn"); btnTheme.type = "button"; btnTheme.id = "btnTheme";
      const icTh = el("img", "px-ico"); icTh.setAttribute("data-ico", "ico_theme"); icTh.alt = "";
      txtTheme = el("span", "", "ICE LAB"); txtTheme.id = "txtTheme";
      btnTheme.appendChild(icTh);
      btnTheme.appendChild(txtTheme);
      btnTheme.addEventListener("click", () => engine.cycleTheme());

      btnSpring = el("button", "px-btn active"); btnSpring.type = "button"; btnSpring.id = "btnSpring";
      btnSpring.appendChild(el("span", "", "SPRING: ON"));
      btnSpring.addEventListener("click", () => engine.toggleFlag("springOn"));

      btnReset = el("button", "px-btn gold"); btnReset.type = "button"; btnReset.id = "btnReset";
      const icRs = el("img", "px-ico"); icRs.setAttribute("data-ico", "ico_reset"); icRs.alt = "";
      btnReset.appendChild(icRs);
      btnReset.appendChild(el("span", "", "RESET"));
      btnReset.addEventListener("click", () => engine.resetAll());

      [btnAutoSpin, btnFx, btnOutline, btnTheme, btnSpring, btnReset].forEach((b) => trow.appendChild(b));
      sec.appendChild(trow);
      panel.appendChild(sec);
    }

    // 6. Portable Package (.ap3d) Load / Merge & Selectable Format Export (.ap3d / .glb / .png)
    let fileIO = null;
    if (opts.showFileIO) {
      fileIO = createFileIOControls({
        onLoadFile: async (file) => {
          try {
            await engine.loadAP3DFile(file, { merge: false });
            showToast(`LOADED: ${file.name}`);
          } catch (err) {
            showToast(`LOAD ERROR: ${err.message || err}`);
          }
        },
        onMergeFile: async (file) => {
          try {
            const added = await engine.loadAP3DFile(file, { merge: true });
            showToast(`MERGED +${added} MOTIONS FROM ${file.name}`);
          } catch (err) {
            showToast(`MERGE ERROR: ${err.message || err}`);
          }
        },
        onExport: async (fmt) => {
          try {
            const info = (typeof engine.exportByFormat === "function")
              ? await engine.exportByFormat(fmt)
              : await engine.exportAP3D();
            if (info && info.filename) {
              const kb = info.bytes ? ` (${Math.max(1, Math.round(info.bytes / 1024))} KB)` : "";
              showToast(`EXPORTED ${info.filename}${kb}`);
            }
          } catch (err) {
            showToast(`EXPORT ERROR: ${err.message || err}`);
          }
        },
      });
      panel.appendChild(fileIO.el);
      emptyLoadBtn.addEventListener("click", () => fileIO.triggerLoad());
    }

    shell.appendChild(stageWrap);
    shell.appendChild(panel);
    rootEl.appendChild(shell);

    function canAcceptAp3dDrop() {
      const cap = engine.supportsAP3DLoad && engine.supportsAP3DLoad();
      return cap !== undefined ? Boolean(cap) : Boolean(global.AP3DCodec);
    }

    // Attach stage drag-and-drop for .ap3d files (active only when engine supports .ap3d loading)
    let dragCounter = 0;
    stageWrap.addEventListener("dragenter", (e) => {
      if (!canAcceptAp3dDrop()) return;
      e.preventDefault();
      dragCounter++;
      dropOverlay.classList.add("active");
    });
    stageWrap.addEventListener("dragover", (e) => { if (canAcceptAp3dDrop()) e.preventDefault(); });
    stageWrap.addEventListener("dragleave", () => {
      if (!canAcceptAp3dDrop()) return;
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) dropOverlay.classList.remove("active");
    });
    stageWrap.addEventListener("drop", async (e) => {
      if (!canAcceptAp3dDrop()) return;
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove("active");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      try {
        if (e.shiftKey) {
          const added = await engine.loadAP3DFile(file, { merge: true });
          showToast(`MERGED +${added} MOTIONS FROM ${file.name}`);
        } else {
          await engine.loadAP3DFile(file, { merge: false });
          showToast(`LOADED: ${file.name}`);
        }
      } catch (err) {
        showToast(`DROP ERROR: ${err.message || err}`);
      }
    });

    // Wire hold buttons & canvas interactions
    btnBounce.addEventListener("click", () => engine.triggerBounce());
    function bindHold(btn, dir) {
      const start = (e) => { e.preventDefault(); engine.setHoldRotDir(dir); };
      const stop = () => { if (engine.getState().holdRotDir === dir) engine.setHoldRotDir(0); };
      btn.addEventListener("pointerdown", start);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    }
    bindHold(btnRotL, -1);
    bindHold(btnRotR, 1);

    function hydrateIcons() {
      rootEl.querySelectorAll("[data-ico]").forEach((img) => {
        const key = img.getAttribute("data-ico");
        const src = engine.getAssetSrc(key);
        if (src) {
          img.src = src;
          img.style.visibility = "visible";
        } else {
          img.style.visibility = "hidden";
        }
      });
    }

    function syncAll() {
      const st = engine.getState();
      if (!st) return;
      const cfg = engine.getConfig() || {};
      const motions = engine.getMotions() || [];

      emptyBanner.style.display = motions.length === 0 ? "block" : "none";
      badgeTitle.textContent = cfg.title || "ANIME PSEUDO-3D";
      badgeSub.textContent = cfg.subtitle || "WEBGL 2-PASS SPRITE STACK ENGINE";
      if (cfg.badge_icon) badgeIcon.setAttribute("data-ico", cfg.badge_icon);
      if (cfg.title) document.title = cfg.title;

      motionShelf.setActive(st.motion);

      rootEl.querySelectorAll("[data-rmode]").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.getAttribute("data-rmode")) === st.renderMode);
      });

      if (dotSlider) dotSlider.sync();
      if (fpsSlider) {
        fpsSlider.sync();
        fpsSlider.actionBtn.textContent = st.animPlaying ? "PLAY" : "STOP";
        fpsSlider.actionBtn.classList.toggle("active", st.animPlaying);
      }
      if (pitchSlider) {
        pitchSlider.sync();
        pitchSlider.actionBtn.classList.toggle("active", st.pitchDeg >= 89);
      }
      if (spacingSlider) {
        spacingSlider.sync();
        spacingSlider.actionBtn.classList.toggle("active", st.spacing >= 1.80);
      }
      if (zoomSlider) {
        zoomSlider.sync();
        zoomSlider.actionBtn.classList.toggle("active", st.faceFocus);
      }

      if (btnAutoSpin) {
        btnAutoSpin.classList.toggle("active", st.autoSpin);
        btnAutoSpin.querySelector("span").textContent = st.autoSpin ? "SPIN: ON" : "SPIN: OFF";
      }
      if (btnFx) {
        btnFx.classList.toggle("active", st.fxOn);
        btnFx.querySelector("span").textContent = st.fxOn ? "FX: ON" : "FX: OFF";
      }
      if (btnOutline) {
        btnOutline.classList.toggle("active", st.outlineOn);
        btnOutline.querySelector("span").textContent = st.outlineOn ? "OUTLINE: ON" : "OUTLINE: OFF";
      }
      if (btnSpring) {
        btnSpring.classList.toggle("active", st.springOn);
        btnSpring.querySelector("span").textContent = st.springOn ? "SPRING: ON" : "SPRING: OFF";
      }
      if (txtTheme) {
        txtTheme.textContent = engine.getThemeName();
      }
    }

    function syncScene() {
      const st = engine.getState();
      const motions = engine.getMotions();
      motionShelf.refresh(motions, st.motion);
      const curM = engine.getActiveMotion();
      timeline.update(st.manualFrame, curM ? (curM.frames || 24) : 1);
      if (fileIO) {
        const fmts = (engine.getExportFormats && engine.getExportFormats()) || (global.AP3DCodec ? [{ id: "ap3d", label: ".AP3D" }] : []);
        fileIO.syncCapabilities(fmts, canAcceptAp3dDrop());
      }
      syncAll();
      hydrateIcons();
    }

    function updateHud(text) {
      hudChip.textContent = text;
    }

    function updateTimeline(fIdx, fc) {
      timeline.update(fIdx, fc);
    }

    return {
      canvas,
      stageWrap,
      hudChip,
      showToast,
      syncScene,
      syncAll,
      updateHud,
      updateTimeline,
      hydrateIcons,
    };
  }

  global.AnimeUIKit = {
    createPixelSlider,
    createMotionShelf,
    createTimelineScrubber,
    createFileIOControls,
    mountStudioUI,
  };
})(window);
