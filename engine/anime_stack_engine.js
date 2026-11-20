/* Anime Pseudo-3D WebGL 2-Pass Sprite-Stack Engine (Character-Agnostic & Data-Driven)
 *
 * Reads declarative `window.SCENE_CONFIG` (motion_pack.json) and `window.SPRITE_ASSETS`.
 * Supports:
 *   - Continuous 0.001-deg GPU rotation + 2x interleaved sub-slices (zero gaps/flicker)
 *   - 2x-SSAA offscreen FBO + 4 live render modes (SMOOTH AA, PIXEL+AA, RETRO PX, SILKY 3D + DOT SIZE)
 *   - Eye-level anime defaults (SQUASH 0.35, ICE LAB studio background, SMOOTH AA)
 *   - Multi-object 3D companion sprite-stack FBOs with exact camera-angle Z-sorting
 *   - Floating billboard overlays (thought bubbles, emblems) anchored cleanly to head height
 *   - Declarative 3D world-space particle & shockwave FX emitters strictly depth-sorted
 */
(() => {
  "use strict";

  const CFG = window.SCENE_CONFIG || {};
  const ASSET_MAP = window.SPRITE_ASSETS || {};
  const ASSET_LINEAR = CFG.assetLinear || {};
  const CHAR = Object.assign(
    { sliceW: 100, sliceH: 112, sliceCount: 160, atlasCols: 16, atlasRows: 10, yOffset: 0.0, fboVirtW: 196, fboVirtH: 440, fboPivotYOffset: 92, faceFocusZ: 104.0 },
    CFG.character || {}
  );
  const COMPANION_DEFS = CFG.companions || {};
  const MOTION_LIST = CFG.motions || [];
  const MOTION_BY_ID = {};
  for (const m of MOTION_LIST) {
    MOTION_BY_ID[m.id] = m;
  }

  const DEFAULTS = Object.assign(
    { motion: MOTION_LIST[0] ? MOTION_LIST[0].id : "idle", animFps: 24, renderMode: 2, dotSize: 1.35, squash: 0.35, spacing: 1.0, zoom: 1.45, themeIdx: 1, angleDeg: 20.0 },
    CFG.defaults || {}
  );

  const TWO_PI = Math.PI * 2;
  const THEMES = [
    { name: "DEEP SEA", bg: [13/255, 22/255, 48/255], grid: [24/255, 39/255, 80/255], star: [100/255, 181/255, 246/255], starHi: [212/255, 240/255, 255/255], outline: [34/255, 38/255, 82/255] },
    { name: "ICE LAB",  bg: [223/255, 233/255, 248/255], grid: [198/255, 214/255, 238/255], star: [107/255, 143/255, 212/255], starHi: [1, 1, 1], outline: [36/255, 42/255, 88/255] },
    { name: "MIDNIGHT", bg: [18/255, 15/255, 36/255], grid: [34/255, 28/255, 66/255], star: [129/255, 140/255, 248/255], starHi: [254/255, 240/255, 138/255], outline: [24/255, 20/255, 56/255] },
  ];

  const state = {
    motion: DEFAULTS.motion,
    motionSwitchTime: 0,
    animPlaying: true,
    animFps: DEFAULTS.animFps,
    animPhase: 0.0,
    manualFrame: 0,
    lastFrameIdx: 0,

    renderMode: DEFAULTS.renderMode,
    dotSize: DEFAULTS.dotSize,
    springOn: true,
    fxOn: true,
    sqX: 1.0,
    sqY: 1.0,
    sqVx: 0.0,
    sqVy: 0.0,

    angle: (DEFAULTS.angleDeg * Math.PI) / 180,
    autoSpin: true,
    spinSpeed: 0.42,
    squash: DEFAULTS.squash,
    spacing: DEFAULTS.spacing,
    zoom: DEFAULTS.zoom,
    faceFocus: false,
    outlineOn: true,
    stageOn: true,
    themeIdx: DEFAULTS.themeIdx,

    dragActive: false,
    dragLastX: 0,
    dragId: null,
    holdRotDir: 0,
  };

  const keys = { left: false, right: false };
  const canvas = document.getElementById("stageCanvas");
  const hudChip = document.getElementById("hudChip");
  const tlVal = document.getElementById("tlVal");

  function curMotionDef() {
    return MOTION_BY_ID[state.motion] || MOTION_LIST[0] || { id: "idle", label: "IDLE", frames: 24, keyPrefix: "anim_idle_" };
  }

  function curFrameCount() {
    return curMotionDef().frames || 24;
  }

  // Hydrate title, badge, and dynamic motion grid from SCENE_CONFIG
  if (CFG.title) {
    document.title = CFG.title;
    document.getElementById("badgeTitle").textContent = CFG.title;
  }
  if (CFG.subtitle) {
    document.getElementById("badgeSub").textContent = CFG.subtitle;
  }
  if (CFG.badge_icon) {
    document.getElementById("badgeIcon").setAttribute("data-ico", CFG.badge_icon);
  }
  const fcInit = curFrameCount();
  document.getElementById("motionHead").textContent = (MOTION_LIST.length === 1 && fcInit === 1)
    ? "STATIC 3D MODEL"
    : `${MOTION_LIST.length} MOTIONS (${fcInit} FRAMES EACH)`;
  const mGrid = document.getElementById("motionGrid");
  if (MOTION_LIST.length <= 4) mGrid.classList.add("cols-2");
  MOTION_LIST.forEach((m, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const accentCls = m.accent && m.accent !== "default" ? ` accent-${m.accent}` : "";
    btn.className = "px-btn motion-btn" + accentCls + (m.id === state.motion ? " active" : "");
    btn.setAttribute("data-motion", m.id);
    const icoHtml = m.icon ? `<img class="px-ico" data-ico="${m.icon}" alt="" />` : "";
    const subHtml = m.subtitle ? `<span class="motion-btn-sub">${m.subtitle}</span>` : "";
    btn.innerHTML = `<span class="motion-btn-top">${icoHtml}<span>${idx + 1}.${m.label}</span></span>${subHtml}`;
    mGrid.appendChild(btn);
  });

  // =========================================================================
  // WEBGL CONTEXT & SHADERS
  // =========================================================================
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });

  if (!gl) {
    document.getElementById("badgeSub").textContent = "WEBGL UNAVAILABLE IN THIS BROWSER";
    return;
  }

  const hasDeriv = !!gl.getExtension("OES_standard_derivatives");

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile error: " + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function createProgram(vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const bgProg = createProgram(
    `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
    `,
    `
    precision mediump float;
    varying vec2 vUv;
    uniform vec2 uRes;
    uniform vec3 uBg;
    uniform vec3 uGrid;
    uniform vec3 uStar;
    uniform vec3 uStarHi;
    uniform float uTime;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 px = vUv * uRes;
      vec2 dv = vUv - vec2(0.5, 0.5);
      float vig = 1.0 - dot(dv, dv) * 0.28;
      vec3 col = uBg * clamp(vig, 0.80, 1.05);

      float stepPx = 32.0;
      vec2 g = mod(px - 0.5 * mod(uRes, stepPx), stepPx);
      if (g.x < 1.2 || g.y < 1.2) {
        col = mix(col, uGrid, 0.65);
      }

      vec2 cell = floor(px / 48.0);
      vec2 loc = fract(px / 48.0) * 48.0;
      float h = hash21(cell);
      if (h > 0.82) {
        vec2 spos = vec2(8.0 + hash21(cell + 7.1) * 32.0, 8.0 + hash21(cell + 19.3) * 32.0);
        float sz = (h > 0.94) ? 2.6 : 1.6;
        if (abs(loc.x - spos.x) < sz * 0.5 && abs(loc.y - spos.y) < sz * 0.5) {
          float tw = 0.65 + 0.35 * sin(uTime * 2.4 + h * 40.0);
          col = mix(col, (h > 0.92) ? uStarHi : uStar, tw);
        }
      }
      gl_FragColor = vec4(col, 1.0);
    }
    `
  );

  const stackProg = createProgram(
    `
    attribute vec2 aCorner;
    attribute vec3 aSlice;

    uniform vec2 uFboSize;
    uniform vec2 uPivot;
    uniform vec2 uSliceDim;
    uniform float uAngle;
    uniform float uSquash;
    uniform float uSpacing;
    uniform vec2 uSpring;

    varying vec2 vLocalUV;
    varying vec2 vTileOrigin;

    void main() {
      vec2 p = aCorner * uSliceDim;
      float ca = cos(uAngle);
      float sa = sin(uAngle);
      vec2 rot = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
      vec2 stacked = vec2(rot.x, rot.y * uSquash - aSlice.x * uSpacing);
      stacked *= uSpring;

      vec2 pos = uPivot + stacked;
      vec2 ndc = (pos / uFboSize) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      gl_Position = vec4(ndc, 0.0, 1.0);

      vLocalUV = aCorner + 0.5;
      vTileOrigin = aSlice.yz;
    }
    `,
    (hasDeriv ? "#extension GL_OES_standard_derivatives : enable\n" : "") +
    `
    precision highp float;
    uniform sampler2D uAtlas;
    uniform vec2 uSliceDim;
    uniform vec2 uAtlasGrid;
    uniform int uMode;

    varying vec2 vLocalUV;
    varying vec2 vTileOrigin;

    vec4 fetchTexel(vec2 tc) {
      vec2 c = clamp(tc, vec2(0.0), uSliceDim - vec2(1.0));
      vec2 uv = (vTileOrigin + (c + 0.5) / uSliceDim) / uAtlasGrid;
      return texture2D(uAtlas, uv);
    }

    void main() {
      vec2 tCoord = vLocalUV * uSliceDim - 0.5;
      if (uMode == 2) {
        vec4 c = fetchTexel(floor(tCoord + 0.5));
        if (c.a < 0.5) discard;
        gl_FragColor = vec4(c.rgb, 1.0);
        return;
      }

      vec2 fl = floor(tCoord);
      vec2 fr = fract(tCoord);
      vec2 w;
      if (uMode == 0) {
        ` + (hasDeriv ? `
        vec2 fw = clamp(fwidth(tCoord), vec2(0.05), vec2(0.95));
        w = clamp((fr - 0.5) / fw + 0.5, 0.0, 1.0);
        ` : `
        w = smoothstep(0.28, 0.72, fr);
        `) + `
      } else {
        w = fr * fr * (3.0 - 2.0 * fr);
      }

      vec4 c00 = fetchTexel(fl);
      vec4 c10 = fetchTexel(fl + vec2(1.0, 0.0));
      vec4 c01 = fetchTexel(fl + vec2(0.0, 1.0));
      vec4 c11 = fetchTexel(fl + vec2(1.0, 1.0));

      float w00 = (1.0 - w.x) * (1.0 - w.y);
      float w10 = w.x * (1.0 - w.y);
      float w01 = (1.0 - w.x) * w.y;
      float w11 = w.x * w.y;

      float a = c00.a * w00 + c10.a * w10 + c01.a * w01 + c11.a * w11;
      if (a < 0.06) discard;

      vec3 rgbSum = c00.rgb * (c00.a * w00) + c10.rgb * (c10.a * w10)
                  + c01.rgb * (c01.a * w01) + c11.rgb * (c11.a * w11);
      vec3 rgb = rgbSum / max(a, 1e-4);

      float outA = (uMode == 0) ? smoothstep(0.24, 0.72, a) : smoothstep(0.18, 0.78, a);
      if (outA < 0.02) discard;

      gl_FragColor = vec4(rgb * outA, outA);
    }
    `
  );

  const spriteProg = createProgram(
    `
    attribute vec2 aPos;
    uniform vec4 uRect;
    uniform vec2 uRes;
    uniform float uRot;
    varying vec2 vUv;
    void main() {
      vec2 local = aPos * (uRect.zw * 0.5);
      float cr = cos(uRot);
      float sr = sin(uRot);
      vec2 rot = vec2(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
      vec2 p = uRect.xy + rot;
      vec2 ndc = (p / uRes) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUv = aPos * 0.5 + 0.5;
    }
    `,
    `
    precision mediump float;
    uniform sampler2D uTex;
    uniform float uAlpha;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(uTex, vUv);
      if (c.a < 0.01) discard;
      float a = c.a * uAlpha;
      gl_FragColor = vec4(c.rgb * uTint * a, a);
    }
    `
  );

  const compProg = createProgram(
    `
    attribute vec2 aPos;
    uniform vec4 uRect;
    uniform vec2 uRes;
    varying vec2 vUv;
    void main() {
      vec2 p = uRect.xy + aPos * (uRect.zw * 0.5);
      vec2 ndc = (p / uRes) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
    }
    `,
    (hasDeriv ? "#extension GL_OES_standard_derivatives : enable\n" : "") +
    `
    precision highp float;
    uniform sampler2D uFboTex;
    uniform vec2 uTexel;
    uniform vec2 uVirtSize;
    uniform float uOutRad;
    uniform float uOutOn;
    uniform vec3 uOutCol;
    uniform int uCompMode;
    uniform float uDotSize;
    varying vec2 vUv;

    vec4 sampleCell(vec2 cellIdx, vec2 gridDim) {
      vec2 uv = (clamp(cellIdx, vec2(0.0), gridDim - vec2(1.0)) + 0.5) / gridDim;
      return texture2D(uFboTex, uv);
    }

    vec4 samplePixelAA(vec2 pCoord, vec2 gridDim) {
      vec2 fl = floor(pCoord - 0.5);
      vec2 fr = fract(pCoord - 0.5);
      ` + (hasDeriv ? `
      vec2 fw = clamp(fwidth(pCoord) * 1.15, vec2(0.04), vec2(0.42));
      vec2 w = clamp((fr - 0.5) / fw + 0.5, 0.0, 1.0);
      ` : `
      vec2 w = smoothstep(0.36, 0.64, fr);
      `) + `
      vec4 c00 = sampleCell(fl, gridDim);
      vec4 c10 = sampleCell(fl + vec2(1.0, 0.0), gridDim);
      vec4 c01 = sampleCell(fl + vec2(0.0, 1.0), gridDim);
      vec4 c11 = sampleCell(fl + vec2(1.0, 1.0), gridDim);
      return mix(mix(c00, c10, w.x), mix(c01, c11, w.x), w.y);
    }

    void main() {
      if (uCompMode == 0 || uCompMode == 1) {
        vec2 gridDim = uVirtSize / max(uDotSize, 1.0);
        vec2 pCoord = vUv * gridDim;
        vec2 cell = floor(pCoord);

        vec4 fg;
        float outA = 0.0;
        if (uCompMode == 1) {
          fg = sampleCell(cell, gridDim);
          float solid = step(0.42, fg.a);
          if (solid > 0.5) {
            vec3 rgb = fg.rgb / max(fg.a, 1e-4);
            rgb = floor(rgb * 28.0 + 0.5) / 28.0;
            fg = vec4(rgb, 1.0);
          } else {
            fg = vec4(0.0);
          }
          if (uOutOn > 0.5) {
            float m = max(
              max(sampleCell(cell + vec2( 1.0,  0.0), gridDim).a, sampleCell(cell + vec2(-1.0,  0.0), gridDim).a),
              max(sampleCell(cell + vec2( 0.0,  1.0), gridDim).a, sampleCell(cell + vec2( 0.0, -1.0), gridDim).a)
            );
            outA = step(0.42, m);
          }
        } else {
          fg = samplePixelAA(pCoord, gridDim);
          float aFirm = smoothstep(0.16, 0.68, fg.a);
          vec3 rgb = fg.rgb / max(fg.a, 1e-4);
          rgb = mix(rgb, floor(rgb * 42.0 + 0.5) / 42.0, 0.35);
          fg = vec4(rgb * aFirm, aFirm);

          if (uOutOn > 0.5) {
            float m = aFirm;
            m = max(m, samplePixelAA(pCoord + vec2( 1.0,  0.0), gridDim).a);
            m = max(m, samplePixelAA(pCoord + vec2(-1.0,  0.0), gridDim).a);
            m = max(m, samplePixelAA(pCoord + vec2( 0.0,  1.0), gridDim).a);
            m = max(m, samplePixelAA(pCoord + vec2( 0.0, -1.0), gridDim).a);
            float md = max(
              max(samplePixelAA(pCoord + vec2( 0.72,  0.72), gridDim).a, samplePixelAA(pCoord + vec2(-0.72,  0.72), gridDim).a),
              max(samplePixelAA(pCoord + vec2( 0.72, -0.72), gridDim).a, samplePixelAA(pCoord + vec2(-0.72, -0.72), gridDim).a)
            );
            m = max(m, md * 0.82);
            outA = smoothstep(0.22, 0.64, m);
          }
        }
        if (fg.a < 0.01 && outA < 0.01) discard;
        vec3 outPremul = uOutCol * outA;
        gl_FragColor = vec4(fg.rgb + outPremul * (1.0 - fg.a), fg.a + outA * (1.0 - fg.a));
        return;
      }

      vec4 fg = texture2D(uFboTex, vUv);
      if (uOutOn < 0.5) {
        if (fg.a < 0.01) discard;
        gl_FragColor = fg;
        return;
      }

      vec2 d = uTexel * uOutRad;
      vec2 dd = d * 0.70710678;
      float m = fg.a;
      m = max(m, texture2D(uFboTex, vUv + vec2( d.x,  0.0)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2(-d.x,  0.0)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2( 0.0,  d.y)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2( 0.0, -d.y)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2( dd.x,  dd.y)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2(-dd.x,  dd.y)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2( dd.x, -dd.y)).a);
      m = max(m, texture2D(uFboTex, vUv + vec2(-dd.x, -dd.y)).a);

      float outA = smoothstep(0.18, 0.62, m);
      if (outA < 0.01) discard;
      vec3 outPremul = uOutCol * outA;
      gl_FragColor = vec4(fg.rgb + outPremul * (1.0 - fg.a), fg.a + outA * (1.0 - fg.a));
    }
    `
  );

  // =========================================================================
  // BUFFERS & FBOs (DYNAMICALLY SIZED FROM SCENE_CONFIG)
  // =========================================================================
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]), gl.STATIC_DRAW);

  function buildStackVBO(sliceCount, cols, subLayersPerSlice) {
    const totalQuads = sliceCount * subLayersPerSlice;
    const data = new Float32Array(totalQuads * 6 * 5);
    const corners = [
      [-0.5, -0.5], [ 0.5, -0.5], [-0.5,  0.5],
      [-0.5,  0.5], [ 0.5, -0.5], [ 0.5,  0.5],
    ];
    let ptr = 0;
    for (let z = 0; z < sliceCount; z++) {
      const col = z % cols;
      const row = (z / cols) | 0;
      for (let s = 0; s < subLayersPerSlice; s++) {
        const zf = z + (s / subLayersPerSlice);
        for (let k = 0; k < 6; k++) {
          data[ptr++] = corners[k][0];
          data[ptr++] = corners[k][1];
          data[ptr++] = zf;
          data[ptr++] = col;
          data[ptr++] = row;
        }
      }
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { buf, count: totalQuads * 6 };
  }

  function createFboTarget(virtW, virtH, ss) {
    const pxW = virtW * ss;
    const pxH = virtH * ss;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pxW, pxH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fboObj = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboObj);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: fboObj, tex, virtW, virtH, ss, pxW, pxH };
  }

  const charVBO1x = buildStackVBO(CHAR.sliceCount, CHAR.atlasCols, 1);
  const charVBO2x = buildStackVBO(CHAR.sliceCount, CHAR.atlasCols, 2);
  const charFbo = createFboTarget(CHAR.fboVirtW, CHAR.fboVirtH, 2);
  const CHAR_PIVOT_X = charFbo.virtW * 0.5;
  const CHAR_PIVOT_Y = charFbo.virtH - CHAR.fboPivotYOffset;

  // Build reusable VBOs & FBOs for any declared 3D companions
  const companionGpu = {};
  for (const [cid, cdef] of Object.entries(COMPANION_DEFS)) {
    const vw = cdef.fboVirtW || 96;
    const vh = cdef.fboVirtH || 132;
    companionGpu[cid] = {
      def: cdef,
      vbo1x: buildStackVBO(cdef.sliceCount, cdef.atlasCols, 1),
      vbo2x: buildStackVBO(cdef.sliceCount, cdef.atlasCols, 2),
      fbo: createFboTarget(vw, vh, 2),
      pivotX: vw * 0.5,
      pivotY: vh - Math.round(vh * 0.28),
    };
  }

  // =========================================================================
  // PRIORITIZED ASSET LOADER & LRU GPU TEXTURE CACHE
  // =========================================================================
  const images = {};
  const loadedKeys = new Set();
  const loadingKeys = new Set();
  const gpuTexCache = new Map();
  const staticTex = {};

  function createStaticTexture(img, linear) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function ensureImageLoaded(key, onReady) {
    if (!ASSET_MAP[key]) return;
    if (loadedKeys.has(key)) {
      if (onReady) onReady(images[key]);
      return;
    }
    if (loadingKeys.has(key)) return;
    loadingKeys.add(key);
    const img = new Image();
    img.onload = () => {
      images[key] = img;
      loadedKeys.add(key);
      loadingKeys.delete(key);
      if (onReady) onReady(img);
    };
    img.src = ASSET_MAP[key];
  }

  function preloadMotion(motionId) {
    const m = MOTION_BY_ID[motionId];
    if (!m) return;
    const fc = m.frames || 24;
    for (let f = 0; f < fc; f++) {
      ensureImageLoaded(`${m.keyPrefix}${String(f).padStart(2, "0")}`);
    }
    if (m.companion && COMPANION_DEFS[m.companion.id]) {
      const cd = COMPANION_DEFS[m.companion.id];
      const cfc = cd.frames || 24;
      for (let f = 0; f < cfc; f++) {
        ensureImageLoaded(`${cd.keyPrefix}${String(f).padStart(2, "0")}`);
      }
    }
  }

  function getAtlasTexture(key) {
    if (gpuTexCache.has(key)) {
      const tex = gpuTexCache.get(key);
      gpuTexCache.delete(key);
      gpuTexCache.set(key, tex);
      return tex;
    }
    if (!loadedKeys.has(key)) {
      ensureImageLoaded(key);
      return null;
    }
    const img = images[key];
    if (!img) return null;
    const tex = createStaticTexture(img, false);
    if (gpuTexCache.size >= 72) {
      const oldestKey = gpuTexCache.keys().next().value;
      gl.deleteTexture(gpuTexCache.get(oldestKey));
      gpuTexCache.delete(oldestKey);
    }
    gpuTexCache.set(key, tex);
    return tex;
  }

  function getStaticTex(key) {
    if (!key) return null;
    if (staticTex[key]) return staticTex[key];
    if (loadedKeys.has(key) && images[key]) {
      staticTex[key] = createStaticTexture(images[key], !!ASSET_LINEAR[key]);
      return staticTex[key];
    }
    ensureImageLoaded(key, (img) => {
      staticTex[key] = createStaticTexture(img, !!ASSET_LINEAR[key]);
    });
    return null;
  }

  function loadAssets() {
    document.querySelectorAll("img[data-ico]").forEach((el) => {
      const k = el.getAttribute("data-ico");
      if (ASSET_MAP[k]) el.src = ASSET_MAP[k];
    });

    // Warm non-atlas static sprites (stage, billboards, FX)
    const atlasPrefixes = MOTION_LIST.map((m) => m.keyPrefix);
    for (const cd of Object.values(COMPANION_DEFS)) {
      atlasPrefixes.push(cd.keyPrefix);
    }
    for (const key of Object.keys(ASSET_MAP)) {
      if (key.startsWith("ico_")) continue;
      if (atlasPrefixes.some((p) => key.startsWith(p))) continue;
      getStaticTex(key);
    }

    preloadMotion(state.motion);
    const others = MOTION_LIST.map((m) => m.id).filter((id) => id !== state.motion);
    let idx = 0;
    function warmNext() {
      if (idx >= others.length) return;
      preloadMotion(others[idx++]);
      setTimeout(warmNext, 90);
    }
    setTimeout(warmNext, 120);
  }

  // =========================================================================
  // SPRING PHYSICS & TIMELINE
  // =========================================================================
  function impulseSquash(sx, sy) {
    if (!state.springOn) return;
    state.sqX = sx;
    state.sqY = sy;
    state.sqVx = 0;
    state.sqVy = 0;
  }

  function stepSpring(dt) {
    if (!state.springOn) {
      state.sqX = 1.0;
      state.sqY = 1.0;
      state.sqVx = 0;
      state.sqVy = 0;
      return;
    }
    const kSpring = 160;
    const kDamp = 16;
    state.sqVx += ((1 - state.sqX) * kSpring - state.sqVx * kDamp) * dt;
    state.sqVy += ((1 - state.sqY) * kSpring - state.sqVy * kDamp) * dt;
    state.sqX = Math.max(0.76, Math.min(1.26, state.sqX + state.sqVx * dt));
    state.sqY = Math.max(0.76, Math.min(1.26, state.sqY + state.sqVy * dt));
  }

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.floor(rect.width * dpr));
    const ch = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    return dpr;
  }

  const tlBar = document.getElementById("timelineBar");
  let tlCells = [];
  function rebuildTimelineCells(count) {
    tlBar.innerHTML = "";
    tlBar.style.gridTemplateColumns = `repeat(${count}, 1fr)`;
    tlBar.setAttribute("aria-valuemax", String(count));
    tlCells = [];
    for (let i = 0; i < count; i++) {
      const cell = document.createElement("div");
      cell.className = "tl-cell" + (i === 0 ? " cur" : "");
      tlBar.appendChild(cell);
      tlCells.push(cell);
    }
  }
  rebuildTimelineCells(curFrameCount());

  function updateTimelineUI(fIdx) {
    const fc = curFrameCount();
    if (tlCells.length !== fc) rebuildTimelineCells(fc);
    for (let i = 0; i < fc; i++) {
      const c = tlCells[i];
      if (i === fIdx) c.className = "tl-cell cur";
      else if (i < fIdx) c.className = "tl-cell past";
      else c.className = "tl-cell";
    }
    const fStr = String(fIdx + 1).padStart(2, "0");
    tlVal.textContent = `F${fStr} / ${fc}`;
    tlBar.setAttribute("aria-valuenow", String(fIdx + 1));
  }

  // Uniform caches
  const bgLoc = {
    aPos: gl.getAttribLocation(bgProg, "aPos"),
    uRes: gl.getUniformLocation(bgProg, "uRes"),
    uBg: gl.getUniformLocation(bgProg, "uBg"),
    uGrid: gl.getUniformLocation(bgProg, "uGrid"),
    uStar: gl.getUniformLocation(bgProg, "uStar"),
    uStarHi: gl.getUniformLocation(bgProg, "uStarHi"),
    uTime: gl.getUniformLocation(bgProg, "uTime"),
  };
  const stLoc = {
    aCorner: gl.getAttribLocation(stackProg, "aCorner"),
    aSlice: gl.getAttribLocation(stackProg, "aSlice"),
    uFboSize: gl.getUniformLocation(stackProg, "uFboSize"),
    uPivot: gl.getUniformLocation(stackProg, "uPivot"),
    uSliceDim: gl.getUniformLocation(stackProg, "uSliceDim"),
    uAngle: gl.getUniformLocation(stackProg, "uAngle"),
    uSquash: gl.getUniformLocation(stackProg, "uSquash"),
    uSpacing: gl.getUniformLocation(stackProg, "uSpacing"),
    uSpring: gl.getUniformLocation(stackProg, "uSpring"),
    uAtlas: gl.getUniformLocation(stackProg, "uAtlas"),
    uAtlasGrid: gl.getUniformLocation(stackProg, "uAtlasGrid"),
    uMode: gl.getUniformLocation(stackProg, "uMode"),
  };
  const spLoc = {
    aPos: gl.getAttribLocation(spriteProg, "aPos"),
    uRect: gl.getUniformLocation(spriteProg, "uRect"),
    uRes: gl.getUniformLocation(spriteProg, "uRes"),
    uRot: gl.getUniformLocation(spriteProg, "uRot"),
    uTex: gl.getUniformLocation(spriteProg, "uTex"),
    uAlpha: gl.getUniformLocation(spriteProg, "uAlpha"),
    uTint: gl.getUniformLocation(spriteProg, "uTint"),
  };
  const cpLoc = {
    aPos: gl.getAttribLocation(compProg, "aPos"),
    uRect: gl.getUniformLocation(compProg, "uRect"),
    uRes: gl.getUniformLocation(compProg, "uRes"),
    uFboTex: gl.getUniformLocation(compProg, "uFboTex"),
    uTexel: gl.getUniformLocation(compProg, "uTexel"),
    uVirtSize: gl.getUniformLocation(compProg, "uVirtSize"),
    uOutRad: gl.getUniformLocation(compProg, "uOutRad"),
    uOutOn: gl.getUniformLocation(compProg, "uOutOn"),
    uOutCol: gl.getUniformLocation(compProg, "uOutCol"),
    uCompMode: gl.getUniformLocation(compProg, "uCompMode"),
    uDotSize: gl.getUniformLocation(compProg, "uDotSize"),
  };

  function drawQuadSprite(tex, cx, cy, w, h, alpha, rotRad, tint) {
    if (!tex || alpha <= 0.01) return;
    gl.useProgram(spriteProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(spLoc.aPos);
    gl.vertexAttribPointer(spLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(spLoc.uTex, 0);
    gl.uniform4f(spLoc.uRect, cx, cy, w, h);
    gl.uniform2f(spLoc.uRes, canvas.width, canvas.height);
    gl.uniform1f(spLoc.uRot, rotRad || 0.0);
    gl.uniform1f(spLoc.uAlpha, alpha);
    const t = tint || [1, 1, 1];
    gl.uniform3f(spLoc.uTint, t[0], t[1], t[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(spLoc.aPos);
  }

  function renderStackToFbo(target, vbo, atlasTex, sliceW, sliceH, cols, rows, pivotX, pivotY, angleRad, squash, spacing, sxMul, syMul) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.pxW, target.pxH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(stackProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo.buf);
    gl.enableVertexAttribArray(stLoc.aCorner);
    gl.enableVertexAttribArray(stLoc.aSlice);
    gl.vertexAttribPointer(stLoc.aCorner, 2, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(stLoc.aSlice, 3, gl.FLOAT, false, 20, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(stLoc.uAtlas, 0);
    gl.uniform2f(stLoc.uFboSize, target.virtW, target.virtH);
    gl.uniform2f(stLoc.uPivot, pivotX, pivotY);
    gl.uniform2f(stLoc.uSliceDim, sliceW, sliceH);
    gl.uniform2f(stLoc.uAtlasGrid, cols, rows);
    gl.uniform1f(stLoc.uAngle, angleRad);
    gl.uniform1f(stLoc.uSquash, squash);
    gl.uniform1f(stLoc.uSpacing, spacing);
    gl.uniform2f(stLoc.uSpring, sxMul, syMul);
    gl.uniform1i(stLoc.uMode, (state.renderMode === 3) ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, vbo.count);

    gl.disableVertexAttribArray(stLoc.aCorner);
    gl.disableVertexAttribArray(stLoc.aSlice);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function compositeFbo(target, screenPivotX, screenPivotY, pivotX, pivotY, unitPx, outlineCol, outRadScale) {
    const dispW = target.virtW * unitPx;
    const dispH = target.virtH * unitPx;
    const rectCx = screenPivotX + (target.virtW * 0.5 - pivotX) * unitPx;
    const rectCy = screenPivotY + (target.virtH * 0.5 - pivotY) * unitPx;

    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(compProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(cpLoc.aPos);
    gl.vertexAttribPointer(cpLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(cpLoc.uFboTex, 0);
    gl.uniform4f(cpLoc.uRect, rectCx, rectCy, dispW, dispH);
    gl.uniform2f(cpLoc.uRes, canvas.width, canvas.height);
    gl.uniform2f(cpLoc.uTexel, 1.0 / target.pxW, 1.0 / target.pxH);
    gl.uniform2f(cpLoc.uVirtSize, target.virtW, target.virtH);
    gl.uniform1f(cpLoc.uOutRad, target.ss * (outRadScale || 1.12));
    gl.uniform1f(cpLoc.uOutOn, state.outlineOn ? 1.0 : 0.0);
    gl.uniform3fv(cpLoc.uOutCol, outlineCol);
    gl.uniform1i(cpLoc.uCompMode, state.renderMode);
    gl.uniform1f(cpLoc.uDotSize, state.dotSize);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(cpLoc.aPos);
  }

  function hash1(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  // =========================================================================
  // DECLARATIVE 3D PARTICLE & SHOCKWAVE ENGINE (100% DATA-DRIVEN)
  // =========================================================================
  function collectDeclarativeFX(motionDef, phaseF, project3D, baseUnitPx, charDepth) {
    const back = [];
    const front = [];
    if (!state.fxOn || !motionDef.fx) return { back, front };

    const fc = motionDef.frames || 24;
    const t = (phaseF % fc) / fc;
    const ph = t * TWO_PI;

    function push3D(wx, wy, wz, texKey, sizeVirt, alpha, rotRad, tint) {
      const tex = getStaticTex(texKey);
      if (!tex || alpha <= 0.02) return;
      const p = project3D(wx, wy, wz);
      const item = {
        tex,
        sx: p.sx,
        sy: p.sy,
        w: sizeVirt * baseUnitPx,
        h: sizeVirt * baseUnitPx,
        alpha,
        rot: rotRad || 0,
        tint: tint || [1, 1, 1],
        depth: p.depth,
      };
      if (p.depth < charDepth) back.push(item);
      else front.push(item);
    }

    for (const fx of motionDef.fx) {
      if (fx.type === "sparkle_perimeter") {
        const startF = fx.startFrame ?? 4;
        const durF = fx.durationFrames ?? 15;
        const glowW = Math.max(0, Math.sin(Math.max(0, Math.min(1, (phaseF - startF) / durF)) * Math.PI));
        const coords = fx.points || [
          [-30, 14, 112], [32, 14, 116], [-38, 6, 86], [36, 10, 88],
          [-22, 18, 132], [22, 18, 130], [-32, -8, 104], [32, -10, 100],
        ];
        const sp0 = fx.sprite0 || "fxSpark_0";
        const sp1 = fx.sprite1 || "fxSpark_1";
        for (let i = 0; i < coords.length; i++) {
          const [bx, by, bz] = coords[i];
          const beat = (t * 2.0 + i * 0.19) % 1.0;
          const pop = Math.sin(beat * Math.PI);
          const sz = (7.2 + 6.0 * pop) * (0.45 + 0.55 * glowW);
          const alpha = pop * (0.35 + 0.65 * glowW);
          const tint = (i % 3 === 0) ? [0.65, 0.94, 1.0] : [1.0, 0.96, 0.78];
          push3D(bx, by, bz + beat * 9.0, beat < 0.55 ? sp0 : sp1, sz, alpha, 0, tint);
        }
      } else if (fx.type === "orbit_trail") {
        const count = fx.count || 18;
        const rx = fx.rx ?? 54.0;
        const ry = fx.ry ?? 42.0;
        const zBase = fx.zBase ?? 86.0;
        const zSin1 = fx.zSin1 ?? -20.0;
        const zSin2 = fx.zSin2 ?? 8.0;
        const spA = fx.primarySprite || "fxHeart";
        const spB = fx.secondarySprite || "fxBubble";
        for (let i = 0; i < count; i++) {
          const lag = (i / count) * (fx.phaseLag ?? 0.42);
          const pLag = ph - lag * TWO_PI;
          const wx = rx * Math.cos(pLag) + (hash1(i * 3.1) - 0.5) * 14.0;
          const wy = ry * Math.sin(pLag) + (hash1(i * 5.7) - 0.5) * 14.0;
          const life = i / count;
          const wz = zBase + zSin1 * Math.sin(pLag) + zSin2 * Math.sin(2.0 * pLag) + life * 22.0;
          const isA = (i % 3 === 0);
          const sz = isA ? (10.5 * (1.0 - life * 0.45)) : (7.5 + 3.5 * hash1(i * 9.3));
          push3D(wx, wy, wz, isA ? spA : spB, sz, Math.sin((1.0 - life) * Math.PI) * 0.95, 0);
        }
      } else if (fx.type === "burst_above") {
        const startF = fx.startFrame ?? 2.5;
        const durF = fx.durationFrames ?? 10.5;
        const w = Math.max(0, Math.sin(Math.max(0, Math.min(1, (phaseF - startF) / durF)) * Math.PI));
        if (w > 0.05) {
          const count = fx.count || 5;
          const sp = fx.sprite || "fxHeart";
          for (let k = 0; k < count; k++) {
            const prog = (t * 2.4 + k * 0.21) % 1.0;
            const hx = (k - (count - 1) * 0.5) * 12.5;
            const hy = (fx.y ?? 24.0) + Math.sin(k * 2.1) * 8.0;
            const hz = (fx.zBase ?? 92.0) + prog * 38.0;
            push3D(hx, hy, hz, sp, 11.5 * Math.sin(prog * Math.PI), Math.sin(prog * Math.PI) * w, 0);
          }
        }
      } else if (fx.type === "forward_slash_fan") {
        const startF = fx.startFrame ?? 5.0;
        const durF = fx.durationFrames ?? 15.0;
        const atkF = phaseF - startF;
        if (atkF >= 0 && atkF <= durF) {
          const u = atkF / durF;
          const slashPrefix = fx.slashPrefix || "fxSlash_";
          if (u <= 0.76) {
            const su = u / 0.76;
            const slFrame = Math.min((fx.slashFrames || 4) - 1, Math.floor(su * (fx.slashFrames || 4)));
            const slTex = getStaticTex(`${slashPrefix}${slFrame}`);
            if (slTex) {
              const pSl = project3D(0, 30 + su * 50, (fx.slashZ ?? 70) + Math.sin(su * Math.PI) * 7);
              const fwdX = -Math.sin(state.angle);
              const fwdY = Math.cos(state.angle) * state.squash;
              const slashRot = Math.atan2(fwdY, fwdX);
              const slScale = (1.22 + 0.80 * su) * baseUnitPx;
              const item = {
                tex: slTex, sx: pSl.sx, sy: pSl.sy,
                w: (fx.slashW ?? 84) * slScale, h: (fx.slashH ?? 44) * slScale,
                alpha: (1.0 - su * 0.40) * 0.98, rot: slashRot, tint: [0.95, 1.0, 1.0], depth: pSl.depth + 8,
              };
              if (pSl.depth < charDepth) back.push(item);
              else front.push(item);
            }
          }
          const count = fx.count || 72;
          const sp0 = fx.dropletSprite || "fxDroplet";
          const sp1 = fx.bubbleSprite || "fxBubble";
          const sp2 = fx.foamSprite || "fxFoam";
          for (let i = 0; i < count; i++) {
            const delay = hash1(i * 1.7) * 0.24;
            const lu = (u - delay) / Math.max(0.15, 1.0 - delay);
            if (lu <= 0.0 || lu >= 1.0) continue;
            const spreadAng = (hash1(i * 3.9) - 0.5) * 1.65;
            const speed = 52.0 + hash1(i * 7.3) * 74.0;
            const dist = 22.0 + speed * Math.pow(lu, 0.68);
            const wx = Math.sin(spreadAng) * dist + (hash1(i * 11.1) - 0.5) * 10.0;
            const wy = Math.cos(spreadAng) * dist;
            const vz = 28.0 + hash1(i * 13.7) * 48.0;
            const wz = Math.max(2.0, (fx.originZ ?? 68.0) + vz * lu - 76.0 * lu * lu);
            const kind = i % 3;
            const texKey = kind === 0 ? sp0 : (kind === 1 ? sp1 : sp2);
            const sz = (kind === 2 ? 10.0 : 9.2) * (0.72 + 0.65 * hash1(i * 17.3)) * (1.0 - lu * 0.30);
            const tint = kind === 0 ? [0.68, 0.92, 1.0] : [0.92, 0.99, 1.0];
            push3D(wx, wy, wz, texKey, sz, Math.sin(lu * Math.PI) * 0.96, lu * (hash1(i * 5.3) - 0.5) * 2.5, tint);
          }
        }
      } else if (fx.type === "helix_vortex") {
        const count = fx.count || 108;
        const slamStart = fx.slamFrame ?? 8.5;
        const slamProg = Math.max(0.0, Math.min(1.0, (phaseF - slamStart) / 11.0));
        const burst = Math.sin(slamProg * Math.PI);
        const chg = Math.max(0.0, Math.min(1.0, phaseF / slamStart)) * (1.0 - Math.max(0.0, Math.min(1.0, (phaseF - slamStart + 0.5) / 3.0)));
        const sp0 = fx.dropletSprite || "fxDroplet";
        const sp1 = fx.bubbleSprite || "fxBubble";
        const sp2 = fx.foamSprite || "fxFoam";
        const maxH = fx.maxHeight ?? (CHAR.sliceCount * 0.74);
        for (let i = 0; i < count; i++) {
          const stream = i % 2;
          const seedA = hash1(i * 2.31);
          const seedB = hash1(i * 6.73);
          const seedC = hash1(i * 11.17);
          const hFrac = (seedA + t * (1.35 + 0.4 * seedB)) % 1.0;
          const wz = 4.0 + hFrac * (maxH + 28.0 * burst);
          const spinTheta = stream * Math.PI + hFrac * TWO_PI * 2.1 + ph * 2.0 + (seedC - 0.5) * 0.55;
          const baseR = (fx.baseRadius ?? 30.0) + 18.0 * hFrac + (seedB - 0.5) * 14.0;
          const rad = baseR * (0.86 + 0.14 * chg + 0.68 * burst * (0.55 + 0.65 * hFrac));
          const kind = i % 4;
          const texKey = (kind === 0 || kind === 1) ? sp0 : (kind === 2 ? sp1 : sp2);
          const sz = (kind === 3 ? 11.0 : 9.0) * (0.68 + 0.62 * seedC) * (0.8 + 0.42 * burst);
          const alpha = Math.sin(hFrac * Math.PI) * (0.65 + 0.35 * Math.max(chg, burst));
          const tint = (kind === 0) ? [0.46 + 0.45 * hFrac, 0.78 + 0.22 * hFrac, 1.0] : [0.85, 0.98, 1.0];
          push3D(Math.cos(spinTheta) * rad, Math.sin(spinTheta) * rad, wz, texKey, sz, alpha, 0, tint);
        }
      }
    }

    back.sort((a, b) => a.depth - b.depth);
    front.sort((a, b) => a.depth - b.depth);
    return { back, front };
  }

  // =========================================================================
  // MAIN WEBGL RENDER LOOP
  // =========================================================================
  function renderWebGL(nowSec) {
    const dpr = resizeCanvas();
    const cw = canvas.width;
    const ch = canvas.height;
    const theme = THEMES[state.themeIdx];
    const mDef = curMotionDef();
    const fc = mDef.frames || 24;

    const phaseF = state.animPlaying ? state.animPhase : state.manualFrame;
    const fIdx = Math.floor(phaseF) % fc;
    const assetKey = `${mDef.keyPrefix}${String(fIdx).padStart(2, "0")}`;
    const atlasTex = getAtlasTexture(assetKey);

    let baseUnitPx;
    if (state.faceFocus) {
      baseUnitPx = Math.min(cw / 108, ch / 118) * (state.zoom / 2.2);
    } else {
      const needW = CHAR.fboVirtW;
      const needH = CHAR.sliceCount * state.spacing + CHAR.sliceH * 1.1 * state.squash + 44;
      const fitScale = Math.min(cw / needW, ch / needH);
      baseUnitPx = fitScale * (state.zoom / 1.45);
    }
    baseUnitPx = Math.max(0.75 * dpr, baseUnitPx);

    const sxMul = state.sqX;
    const syMul = state.sqY;

    // PASS 1A: Main 3D character stack -> charFbo
    if (atlasTex) {
      const vbo = (state.spacing > 1.32) ? charVBO1x : charVBO2x;
      renderStackToFbo(
        charFbo, vbo, atlasTex,
        CHAR.sliceW, CHAR.sliceH, CHAR.atlasCols, CHAR.atlasRows,
        CHAR_PIVOT_X, CHAR_PIVOT_Y,
        state.angle, state.squash, state.spacing, sxMul, syMul
      );
    }

    // PASS 1B: Optional 3D companion sprite stack -> companion FBO
    let compDraw = null;
    if (state.fxOn && mDef.companion && companionGpu[mDef.companion.id]) {
      const cg = companionGpu[mDef.companion.id];
      const cd = cg.def;
      const orb = mDef.companion;
      const cfc = cd.frames || fc;
      const cfIdx = Math.floor(phaseF) % cfc;
      const cTex = getAtlasTexture(`${cd.keyPrefix}${String(cfIdx).padStart(2, "0")}`);
      if (cTex) {
        const orbitPh = (phaseF / fc) * TWO_PI;
        const rx = orb.rx ?? 50.0;
        const ry = orb.ry ?? 40.0;
        const wx = rx * Math.cos(orbitPh);
        const wy = ry * Math.sin(orbitPh);
        const wz = (orb.zBase ?? 72.0) + (orb.zSin1 ?? -18.0) * Math.sin(orbitPh) + (orb.zSin2 ?? 8.0) * Math.sin(2.0 * orbitPh);
        const vx = -rx * Math.sin(orbitPh);
        const vy = ry * Math.cos(orbitPh);
        const compAngle = (orb.faceTangent !== false) ? (state.angle + Math.atan2(-vx, vy)) : state.angle;
        const cVbo = (state.spacing > 1.32) ? cg.vbo1x : cg.vbo2x;
        renderStackToFbo(
          cg.fbo, cVbo, cTex,
          cd.sliceW, cd.sliceH, cd.atlasCols, cd.atlasRows,
          cg.pivotX, cg.pivotY,
          compAngle, state.squash, state.spacing, 1.0, 1.0
        );
        compDraw = { cg, wx, wy, wz, scale: cd.scale ?? 0.92, outRgb: cd.outlineRgb || theme.outline };
      }
    }

    // PASS 2: Main screen composite
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);

    gl.useProgram(bgProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(bgLoc.aPos);
    gl.vertexAttribPointer(bgLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(bgLoc.uRes, cw, ch);
    gl.uniform3fv(bgLoc.uBg, theme.bg);
    gl.uniform3fv(bgLoc.uGrid, theme.grid);
    gl.uniform3fv(bgLoc.uStar, theme.star);
    gl.uniform3fv(bgLoc.uStarHi, theme.starHi);
    gl.uniform1f(bgLoc.uTime, nowSec);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(bgLoc.aPos);

    const screenCx = cw * 0.5;
    let screenGroundY;
    if (state.faceFocus) {
      screenGroundY = ch * 0.56 + CHAR.faceFocusZ * state.spacing * baseUnitPx;
    } else {
      const totalH = (CHAR.sliceCount * state.spacing + 70.0 * state.squash) * baseUnitPx;
      screenGroundY = ch * 0.50 + totalH * 0.36;
    }

    const ca = Math.cos(state.angle);
    const sa = Math.sin(state.angle);
    const charDepth = CHAR.yOffset * ca;

    function project3D(wx, wy, wz) {
      const px = wx;
      const py = wy + CHAR.yOffset;
      const rx = px * ca - py * sa;
      const ry = px * sa + py * ca;
      return {
        sx: screenCx + rx * sxMul * baseUnitPx,
        sy: screenGroundY + (ry * state.squash - wz * state.spacing) * syMul * baseUnitPx,
        depth: ry,
      };
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 2B. Turntable Ring, Floor Shockwave Rings & Contact Shadow
    if (state.stageOn) {
      const airRange = mDef.airFrames;
      const isAir = airRange && fIdx >= airRange[0] && fIdx <= airRange[1];
      const airScale = isAir ? 0.80 : 1.0;

      const ringTex = getStaticTex("turntableRing");
      if (ringTex) {
        const rw = 132 * baseUnitPx;
        const rh = 132 * state.squash * baseUnitPx;
        drawQuadSprite(ringTex, screenCx, screenGroundY, rw, rh, 0.94, 0);
      }

      // Declarative floor_wave_rings FX
      if (state.fxOn && mDef.fx) {
        for (const fx of mDef.fx) {
          if (fx.type !== "floor_wave_rings") continue;
          const wTex = getStaticTex(fx.sprite || "fxWaveRing");
          if (!wTex) continue;
          const rings = fx.count || 1;
          const startF = fx.startFrame ?? 6.0;
          const durF = fx.durationFrames ?? 12.0;
          const stagger = fx.staggerFrames ?? 4.0;
          for (let r = 0; r < rings; r++) {
            const rp = (phaseF - startF + r * stagger) / durF;
            if (rp > 0.0 && rp < 1.0) {
              const pRing = fx.forwardOffset ? project3D(0, fx.forwardOffset + rp * 28, 1.0) : { sx: screenCx, sy: screenGroundY };
              const sc = (fx.startScale ?? 0.60) + rp * (fx.expandScale ?? 1.50);
              drawQuadSprite(wTex, pRing.sx, pRing.sy, 128 * sc * baseUnitPx, 128 * sc * state.squash * baseUnitPx, Math.sin(rp * Math.PI) * 0.86, 0, [0.85, 0.98, 1.0]);
            }
          }
        }
      }

      const shTex = getStaticTex("shadowDither");
      if (shTex) {
        const sw = 74 * airScale * sxMul * baseUnitPx;
        const sh = 52 * airScale * (state.squash / 0.70) * baseUnitPx;
        drawQuadSprite(shTex, screenCx, screenGroundY, sw, sh, 0.92, 0);
      }
    }

    const { back, front } = collectDeclarativeFX(mDef, phaseF, project3D, baseUnitPx, charDepth);
    const compProj = compDraw ? project3D(compDraw.wx, compDraw.wy, compDraw.wz) : null;

    // 2C. BACK 3D LAYER
    for (let i = 0; i < back.length; i++) {
      const pt = back[i];
      drawQuadSprite(pt.tex, pt.sx, pt.sy, pt.w, pt.h, pt.alpha, pt.rot, pt.tint);
    }
    if (compProj && compProj.depth < charDepth) {
      const shTex = getStaticTex("shadowDither");
      if (state.stageOn && shTex) {
        const ws = project3D(compDraw.wx, compDraw.wy, 0);
        drawQuadSprite(shTex, ws.sx, ws.sy, 32 * baseUnitPx, 22 * (state.squash / 0.70) * baseUnitPx, 0.42, 0);
      }
      compositeFbo(compDraw.cg.fbo, compProj.sx, compProj.sy, compDraw.cg.pivotX, compDraw.cg.pivotY, baseUnitPx * compDraw.scale, compDraw.outRgb, 1.05);
    }

    // 2D. MAIN 3D CHARACTER
    if (atlasTex) {
      compositeFbo(charFbo, screenCx, screenGroundY, CHAR_PIVOT_X, CHAR_PIVOT_Y, baseUnitPx, theme.outline, 1.12);
    }

    // 2E. FRONT 3D LAYER
    if (compProj && compProj.depth >= charDepth) {
      const shTex = getStaticTex("shadowDither");
      if (state.stageOn && shTex) {
        const ws = project3D(compDraw.wx, compDraw.wy, 0);
        drawQuadSprite(shTex, ws.sx, ws.sy, 32 * baseUnitPx, 22 * (state.squash / 0.70) * baseUnitPx, 0.42, 0);
      }
      compositeFbo(compDraw.cg.fbo, compProj.sx, compProj.sy, compDraw.cg.pivotX, compDraw.cg.pivotY, baseUnitPx * compDraw.scale, compDraw.outRgb, 1.05);
    }
    for (let i = 0; i < front.length; i++) {
      const pt = front[i];
      drawQuadSprite(pt.tex, pt.sx, pt.sy, pt.w, pt.h, pt.alpha, pt.rot, pt.tint);
    }

    // 2F. DECLARATIVE FLOATING BILLBOARD OVERLAY (e.g., thought bubbles)
    if (state.fxOn && mDef.billboard) {
      const bb = mDef.billboard;
      const bbTex = getStaticTex(bb.assetKey);
      if (bbTex) {
        const age = Math.max(0.0, nowSec - state.motionSwitchTime);
        const pop = age < 0.25 ? (1.0 + 0.14 * Math.sin((age / 0.25) * Math.PI)) * (age / 0.25) : 1.0;
        const bobY = Math.sin((phaseF / fc) * TWO_PI) * (bb.bobAmp ?? 3.8) * baseUnitPx;
        const anchor = project3D(0, 0, bb.anchorZ ?? (CHAR.sliceCount * 0.80));
        const bScale = Math.max(1.05 * dpr, Math.min(2.35 * dpr, baseUnitPx * 0.62)) * Math.max(0.1, pop);
        const bw = (bb.width || 112) * bScale;
        const bh = (bb.height || 92) * bScale;
        let bx = anchor.sx + (bb.offsetX ?? -64) * bScale;
        let by = anchor.sy + (bb.offsetY ?? -30) * bScale + bobY;
        bx = Math.max(bw * 0.52 + 10 * dpr, Math.min(cw - bw * 0.52 - 10 * dpr, bx));
        by = Math.max(bh * 0.52 + 54 * dpr, Math.min(ch - bh * 0.52 - 12 * dpr, by));
        drawQuadSprite(bbTex, bx, by, bw, bh, 0.98, 0);
      }
    }

    const deg = Math.round((((state.angle % TWO_PI) + TWO_PI) % TWO_PI) * (180 / Math.PI)) % 360;
    const fStr = String(fIdx + 1).padStart(2, "0");
    if (window.innerWidth <= 860) {
      hudChip.textContent = `${mDef.label} F${fStr} ${String(deg).padStart(3, "0")}D`;
    } else {
      hudChip.textContent = `${mDef.label} F${fStr}/${fc} | ${state.animFps} FPS | ${String(deg).padStart(3, "0")} DEG`;
    }
  }

  // =========================================================================
  // UI BINDING
  // =========================================================================
  function bindPixelSlider(elId, min, max, step, getVal, setVal, formatVal) {
    const el = document.getElementById(elId);
    const fill = el.querySelector(".px-slider-fill");
    const thumb = el.querySelector(".px-slider-thumb");

    function updateVisual() {
      const v = getVal();
      const pct = Math.max(0, Math.min(1, (v - min) / (max - min))) * 100;
      fill.style.width = pct.toFixed(2) + "%";
      thumb.style.left = pct.toFixed(2) + "%";
      el.setAttribute("aria-valuenow", v.toFixed(2));
      formatVal(v);
    }

    function setFromClientX(clientX) {
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      let v = min + ratio * (max - min);
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      setVal(v);
      updateVisual();
    }

    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      setFromClientX(e.clientX);
    });
    el.addEventListener("pointermove", (e) => {
      if (!el.classList.contains("dragging")) return;
      setFromClientX(e.clientX);
    });
    const endDrag = () => el.classList.remove("dragging");
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setVal(Math.max(min, getVal() - step));
        updateVisual();
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setVal(Math.min(max, getVal() + step));
        updateVisual();
      }
    });

    updateVisual();
    return updateVisual;
  }

  let syncDotSize, syncFps, syncSquash, syncSpacing, syncZoom;

  function syncButtons() {
    document.querySelectorAll("[data-motion]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-motion") === state.motion);
    });
    document.querySelectorAll("[data-rmode]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.getAttribute("data-rmode")) === state.renderMode);
    });

    const bPlay = document.getElementById("btnPlayAnim");
    bPlay.textContent = state.animPlaying ? "PLAY" : "STOP";
    bPlay.classList.toggle("active", state.animPlaying);

    const bSpin = document.getElementById("btnAutoSpin");
    bSpin.classList.toggle("active", state.autoSpin);
    bSpin.querySelector("span").textContent = state.autoSpin ? "SPIN: ON" : "SPIN: OFF";

    const bFx = document.getElementById("btnFx");
    bFx.classList.toggle("active", state.fxOn);
    bFx.querySelector("span").textContent = state.fxOn ? "FX: ON" : "FX: OFF";

    const bSpr = document.getElementById("btnSpring");
    bSpr.classList.toggle("active", state.springOn);
    bSpr.querySelector("span").textContent = state.springOn ? "SPRING: ON" : "SPRING: OFF";

    const bOut = document.getElementById("btnOutline");
    bOut.classList.toggle("active", state.outlineOn);
    bOut.querySelector("span").textContent = state.outlineOn ? "OUTLINE: ON" : "OUTLINE: OFF";

    document.getElementById("txtTheme").textContent = THEMES[state.themeIdx].name;
    document.getElementById("btnTopView").classList.toggle("active", state.squash >= 0.98);
    document.getElementById("btnSpread").classList.toggle("active", state.spacing >= 1.80);
    document.getElementById("btnFaceZoom").classList.toggle("active", state.faceFocus);
  }

  function selectMotion(motionId) {
    const m = MOTION_BY_ID[motionId];
    if (!m) return;
    preloadMotion(motionId);
    state.motion = motionId;
    state.motionSwitchTime = performance.now() * 0.001;
    state.animPhase = 0;
    state.manualFrame = 0;
    state.lastFrameIdx = 0;
    state.animPlaying = true;
    const imp = m.impulse || [1.04, 0.96];
    impulseSquash(imp[0], imp[1]);
    updateTimelineUI(0);
    syncButtons();
  }

  function toggleFaceFocus() {
    state.faceFocus = !state.faceFocus;
    if (state.faceFocus) {
      state.zoom = 2.25;
      state.spacing = 1.0;
      state.squash = DEFAULTS.squash;
      syncSpacing();
      syncSquash();
    } else {
      state.zoom = DEFAULTS.zoom;
    }
    syncZoom();
    syncButtons();
  }

  function wireUI() {
    const valDotSize = document.getElementById("valDotSize");
    const valFps = document.getElementById("valFps");
    const valSquash = document.getElementById("valSquash");
    const valSpacing = document.getElementById("valSpacing");
    const valZoom = document.getElementById("valZoom");

    syncDotSize = bindPixelSlider(
      "slDotSize", 1.0, 2.6, 0.05,
      () => state.dotSize,
      (v) => { state.dotSize = v; if (state.renderMode > 1) { state.renderMode = 0; syncButtons(); } },
      (v) => { valDotSize.textContent = v.toFixed(2); }
    );
    document.getElementById("btnDotReset").addEventListener("click", () => {
      state.dotSize = state.dotSize <= 1.05 ? 1.35 : 1.0;
      if (state.renderMode > 1) state.renderMode = 0;
      syncDotSize();
      syncButtons();
    });

    syncFps = bindPixelSlider("slFps", 6, 36, 1, () => state.animFps, (v) => { state.animFps = Math.round(v); }, (v) => { valFps.textContent = String(Math.round(v)); });
    syncSquash = bindPixelSlider("slSquash", 0.35, 1.0, 0.01, () => state.squash, (v) => { state.squash = v; syncButtons(); }, (v) => { valSquash.textContent = v.toFixed(2); });
    syncSpacing = bindPixelSlider("slSpacing", 0.5, 2.2, 0.05, () => state.spacing, (v) => { state.spacing = v; syncButtons(); }, (v) => { valSpacing.textContent = v.toFixed(2); });
    syncZoom = bindPixelSlider("slZoom", 0.8, 3.2, 0.05, () => state.zoom, (v) => { state.zoom = v; }, (v) => { valZoom.textContent = v.toFixed(2) + "x"; });

    let tlDrag = false;
    function scrubTimeline(clientX) {
      const rect = tlBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / Math.max(1, rect.width)));
      const f = Math.floor(ratio * curFrameCount());
      state.animPlaying = false;
      state.manualFrame = f;
      state.animPhase = f;
      updateTimelineUI(f);
      syncButtons();
    }
    tlBar.addEventListener("pointerdown", (e) => { e.preventDefault(); tlDrag = true; tlBar.setPointerCapture(e.pointerId); scrubTimeline(e.clientX); });
    tlBar.addEventListener("pointermove", (e) => { if (tlDrag) scrubTimeline(e.clientX); });
    tlBar.addEventListener("pointerup", () => { tlDrag = false; });
    tlBar.addEventListener("pointercancel", () => { tlDrag = false; });

    document.querySelectorAll("[data-motion]").forEach((btn) => {
      btn.addEventListener("click", () => selectMotion(btn.getAttribute("data-motion")));
    });
    document.querySelectorAll("[data-rmode]").forEach((btn) => {
      btn.addEventListener("click", () => { state.renderMode = Number(btn.getAttribute("data-rmode")) || 0; syncButtons(); });
    });
    document.querySelectorAll("[data-angle]").forEach((btn) => {
      btn.addEventListener("click", () => { state.angle = ((Number(btn.getAttribute("data-angle")) || 0) * Math.PI) / 180; state.autoSpin = false; syncButtons(); });
    });

    function togglePlayAnim() {
      if (state.animPlaying) {
        state.manualFrame = Math.floor(state.animPhase) % curFrameCount();
        state.animPlaying = false;
        updateTimelineUI(state.manualFrame);
      } else {
        state.animPhase = state.manualFrame;
        state.animPlaying = true;
      }
      syncButtons();
    }

    document.getElementById("btnPlayAnim").addEventListener("click", togglePlayAnim);
    document.getElementById("btnTopView").addEventListener("click", () => { state.faceFocus = false; state.squash = state.squash >= 0.98 ? DEFAULTS.squash : 1.0; syncSquash(); syncButtons(); });
    document.getElementById("btnSpread").addEventListener("click", () => { state.faceFocus = false; state.spacing = state.spacing >= 1.80 ? 1.0 : 2.0; syncSpacing(); syncButtons(); });
    document.getElementById("btnFaceZoom").addEventListener("click", toggleFaceFocus);
    document.getElementById("btnBounce").addEventListener("click", () => impulseSquash(0.84, 1.20));
    document.getElementById("btnAutoSpin").addEventListener("click", () => { state.autoSpin = !state.autoSpin; syncButtons(); });
    document.getElementById("btnFx").addEventListener("click", () => { state.fxOn = !state.fxOn; syncButtons(); });
    document.getElementById("btnSpring").addEventListener("click", () => { state.springOn = !state.springOn; syncButtons(); });
    document.getElementById("btnOutline").addEventListener("click", () => { state.outlineOn = !state.outlineOn; syncButtons(); });
    document.getElementById("btnTheme").addEventListener("click", () => { state.themeIdx = (state.themeIdx + 1) % THEMES.length; syncButtons(); });

    function resetAll() {
      state.motion = DEFAULTS.motion;
      state.animPlaying = true;
      state.animFps = DEFAULTS.animFps;
      state.animPhase = 0;
      state.manualFrame = 0;
      state.renderMode = DEFAULTS.renderMode;
      state.dotSize = DEFAULTS.dotSize;
      state.angle = (DEFAULTS.angleDeg * Math.PI) / 180;
      state.autoSpin = true;
      state.springOn = true;
      state.fxOn = true;
      state.squash = DEFAULTS.squash;
      state.spacing = DEFAULTS.spacing;
      state.zoom = DEFAULTS.zoom;
      state.faceFocus = false;
      state.outlineOn = true;
      state.stageOn = true;
      state.themeIdx = DEFAULTS.themeIdx;
      impulseSquash(1.10, 0.90);
      syncDotSize();
      syncFps();
      syncSquash();
      syncSpacing();
      syncZoom();
      updateTimelineUI(0);
      syncButtons();
    }
    document.getElementById("btnReset").addEventListener("click", resetAll);

    function bindHoldButton(id, dir) {
      const btn = document.getElementById(id);
      const start = (e) => { e.preventDefault(); state.holdRotDir = dir; state.autoSpin = false; syncButtons(); };
      const stop = () => { if (state.holdRotDir === dir) state.holdRotDir = 0; };
      btn.addEventListener("pointerdown", start);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    }
    bindHoldButton("btnRotL", -1);
    bindHoldButton("btnRotR", 1);

    canvas.addEventListener("pointerdown", (e) => {
      state.dragActive = true;
      state.dragId = e.pointerId;
      state.dragLastX = e.clientX;
      state.autoSpin = false;
      canvas.classList.add("dragging");
      canvas.setPointerCapture(e.pointerId);
      syncButtons();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!state.dragActive || e.pointerId !== state.dragId) return;
      const dx = e.clientX - state.dragLastX;
      state.dragLastX = e.clientX;
      state.angle = (state.angle + dx * 0.011) % TWO_PI;
    });
    const endCanvasDrag = (e) => {
      if (state.dragActive && e.pointerId === state.dragId) {
        state.dragActive = false;
        state.dragId = null;
        canvas.classList.remove("dragging");
      }
    };
    canvas.addEventListener("pointerup", endCanvasDrag);
    canvas.addEventListener("pointercancel", endCanvasDrag);

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      state.zoom = Math.max(0.8, Math.min(3.2, Math.round((state.zoom + delta) * 20) / 20));
      syncZoom();
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyQ" || e.code === "ArrowLeft") keys.left = true;
      if (e.code === "KeyE" || e.code === "ArrowRight") keys.right = true;
      const num = Number(e.key);
      if (num >= 1 && num <= MOTION_LIST.length) {
        selectMotion(MOTION_LIST[num - 1].id);
      }
      if (e.code === "KeyF") toggleFaceFocus();
      if (e.code === "KeyB") impulseSquash(0.84, 1.20);
      if (e.code === "Space") { e.preventDefault(); togglePlayAnim(); }
      if (e.code === "KeyR") resetAll();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "KeyQ" || e.code === "ArrowLeft") keys.left = false;
      if (e.code === "KeyE" || e.code === "ArrowRight") keys.right = false;
    });

    syncButtons();
  }

  let lastTs = performance.now();
  function loop(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    stepSpring(dt);

    if (state.animPlaying) {
      const fc = curFrameCount();
      state.animPhase = (state.animPhase + dt * state.animFps) % fc;
      const curF = Math.floor(state.animPhase) % fc;
      if (curF !== state.lastFrameIdx) {
        const mDef = curMotionDef();
        if (mDef.springBeats) {
          for (const b of mDef.springBeats) {
            if (b.frame === curF) impulseSquash(b.sx, b.sy);
          }
        }
        state.lastFrameIdx = curF;
        updateTimelineUI(curF);
      }
    }

    if (keys.left || state.holdRotDir < 0) {
      state.angle -= 1.85 * dt;
    } else if (keys.right || state.holdRotDir > 0) {
      state.angle += 1.85 * dt;
    } else if (state.autoSpin && !state.dragActive) {
      state.angle += state.spinSpeed * dt;
    }

    renderWebGL(ts * 0.001);
    requestAnimationFrame(loop);
  }

  loadAssets();
  wireUI();
  updateTimelineUI(0);
  requestAnimationFrame(loop);
})();
