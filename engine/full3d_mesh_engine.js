/* Reusable Character-Agnostic Full-3D WebGL 2-Pass Mesh Engine (`window.Full3DMeshEngine`)
 *
 * Works seamlessly with `engine/anime_ui_kit.js` + `engine/anime_ui_theme.css` UNMODIFIED!
 * Architecture (Zero False Internal Outlines!):
 *   - Pass 1: Renders solid 3D meshes with hardware DEPTH_TEST & camera-aligned studio cel lighting
 *     into a 2x-SSAA transparent RGBA FBO (`a=1.0` main char, `a=0.65` companion, `a=0.0` background).
 *   - Pass 2: Draws crisp uniform screen-space 16-direction silhouette outlines strictly around real
 *     exterior boundaries & inter-object contours — NEVER bleeding dark scribbles into concave grooves!
 */
(function (global) {
  "use strict";

  const TWO_PI = Math.PI * 2;
  const THEMES = [
    { name: "DEEP SEA", bg: [13/255, 22/255, 48/255], grid: [24/255, 39/255, 80/255], star: [100/255, 181/255, 246/255], starHi: [212/255, 240/255, 255/255], outline: [24/255, 28/255, 62/255] },
    { name: "ICE LAB",  bg: [223/255, 233/255, 248/255], grid: [198/255, 214/255, 238/255], star: [107/255, 143/255, 212/255], starHi: [1, 1, 1], outline: [30/255, 36/255, 76/255] },
    { name: "MIDNIGHT", bg: [18/255, 15/255, 36/255], grid: [34/255, 28/255, 66/255], star: [129/255, 140/255, 248/255], starHi: [254/255, 240/255, 138/255], outline: [18/255, 14/255, 44/255] },
  ];

  function mat4Mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c*4] + a[4+r] * b[c*4+1] + a[8+r] * b[c*4+2] + a[12+r] * b[c*4+3];
      }
    }
    return o;
  }

  function mat4Ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
    return o;
  }

  function mat4LookAt(eye, ctr, up) {
    let zx = eye[0] - ctr[0], zy = eye[1] - ctr[1], zz = eye[2] - ctr[2];
    let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    let xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
    ]);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function decompressMeshPayload(payload) {
    const raw = b64ToBytes(payload.b64);
    if (!payload.gzip) return raw;
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter(); w.write(raw); w.close();
    const chunks = []; const r = ds.readable.getReader(); let total = 0;
    while (true) { const { value, done } = await r.read(); if (done) break; chunks.push(value); total += value.byteLength; }
    const merged = new Uint8Array(total); let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return merged;
  }

  function buildGlbBytes(parts) {
    const pad4 = (n) => (n + 3) & ~3;
    const binChunks = []; let binLen = 0;
    const bufferViews = [], accessors = [], meshes = [], nodes = [];
    function pushBuf(u8, target) {
      const byteOffset = binLen, padded = pad4(u8.byteLength), chunk = new Uint8Array(padded);
      chunk.set(u8); binChunks.push(chunk); binLen += padded;
      const bvIdx = bufferViews.length, bv = { buffer: 0, byteOffset, byteLength: u8.byteLength };
      if (target) bv.target = target; bufferViews.push(bv); return bvIdx;
    }
    for (let pi = 0; pi < parts.length; pi++) {
      const pt = parts[pi], rv = pt.rawV, ri = pt.rawI, vc = (rv.length / 14) | 0;
      const ox = pt.offset ? pt.offset[0] : 0, oy = pt.offset ? pt.offset[1] : 0, oz = pt.offset ? pt.offset[2] : 0;
      const sc = pt.scale ?? 1.0;
      const pos = new Float32Array(vc * 3), nrm = new Float32Array(vc * 3), col = new Uint8Array(vc * 4);
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      for (let i = 0; i < vc; i++) {
        const b = i * 14;
        const gx = (rv[b+0] * sc + ox) * 0.01, gy = (rv[b+2] * sc + oz) * 0.01, gz = -(rv[b+1] * sc + oy) * 0.01;
        pos[i*3] = gx; pos[i*3+1] = gy; pos[i*3+2] = gz;
        if (gx < minX) minX = gx; if (gy < minY) minY = gy; if (gz < minZ) minZ = gz;
        if (gx > maxX) maxX = gx; if (gy > maxY) maxY = gy; if (gz > maxZ) maxZ = gz;
        let nx = rv[b+3], ny = rv[b+5], nz = -rv[b+4]; const nl = Math.hypot(nx, ny, nz) || 1.0;
        nrm[i*3] = nx / nl; nrm[i*3+1] = ny / nl; nrm[i*3+2] = nz / nl;
        col[i*4] = Math.max(0, Math.min(255, Math.round(rv[b+6] * 255)));
        col[i*4+1] = Math.max(0, Math.min(255, Math.round(rv[b+7] * 255)));
        col[i*4+2] = Math.max(0, Math.min(255, Math.round(rv[b+8] * 255)));
        col[i*4+3] = 255;
      }
      const bvP = pushBuf(new Uint8Array(pos.buffer), 34962), bvN = pushBuf(new Uint8Array(nrm.buffer), 34962);
      const bvC = pushBuf(new Uint8Array(col.buffer), 34962), bvI = pushBuf(new Uint8Array(ri.buffer, ri.byteOffset, ri.byteLength), 34963);
      const aP = accessors.length; accessors.push({ bufferView: bvP, componentType: 5126, count: vc, type: "VEC3", min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
      const aN = accessors.length; accessors.push({ bufferView: bvN, componentType: 5126, count: vc, type: "VEC3" });
      const aC = accessors.length; accessors.push({ bufferView: bvC, componentType: 5121, count: vc, type: "VEC4", normalized: true });
      const aI = accessors.length; accessors.push({ bufferView: bvI, componentType: 5123, count: ri.length, type: "SCALAR" });
      const mIdx = meshes.length;
      meshes.push({ name: pt.name || ("Mesh_" + pi), primitives: [{ attributes: { POSITION: aP, NORMAL: aN, COLOR_0: aC }, indices: aI, material: 0 }] });
      nodes.push({ name: pt.name || ("Node_" + pi), mesh: mIdx });
    }
    const gltf = {
      asset: { version: "2.0", generator: "anime-pseudo-3d Full-3D Engine" },
      scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes,
      materials: [{ name: "AnimeVertexToon", pbrMetallicRoughness: { metallicFactor: 0.0, roughnessFactor: 0.85 }, doubleSided: true }],
      meshes, buffers: [{ byteLength: binLen }], bufferViews, accessors,
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf)), jsonPad = pad4(jsonBytes.byteLength);
    const totalLen = 12 + 8 + jsonPad + 8 + binLen, out = new Uint8Array(totalLen), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, totalLen, true);
    dv.setUint32(12, jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20); for (let i = jsonBytes.byteLength; i < jsonPad; i++) out[20 + i] = 0x20;
    const binHead = 20 + jsonPad; dv.setUint32(binHead, binLen, true); dv.setUint32(binHead + 4, 0x004e4942, true);
    let off = binHead + 8; for (const c of binChunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function createEngine(options) {
    const opts = options || {};
    const canvas = opts.canvas;
    const gl = canvas.getContext("webgl", {
      alpha: false, antialias: true, depth: true, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL unavailable");

    function compileShader(type, src) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("Shader error: " + gl.getShaderInfoLog(sh));
      return sh;
    }
    function createProgram(vs, fs) {
      const p = gl.createProgram(); gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Link error: " + gl.getProgramInfoLog(p));
      return p;
    }

    const bgProg = createProgram(
      `attribute vec2 aPos; varying vec2 vUv; void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
      `precision mediump float; varying vec2 vUv;
       uniform vec2 uRes; uniform vec3 uBg; uniform vec3 uGrid; uniform vec3 uStar; uniform vec3 uStarHi; uniform float uTime;
       float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
       void main() {
         vec2 px = vUv * uRes; vec2 dv = vUv - vec2(0.5);
         vec3 col = uBg * clamp(1.0 - dot(dv, dv) * 0.28, 0.80, 1.05);
         vec2 g = mod(px - 0.5 * mod(uRes, 32.0), 32.0);
         if (g.x < 1.2 || g.y < 1.2) col = mix(col, uGrid, 0.65);
         vec2 cell = floor(px / 48.0), loc = fract(px / 48.0) * 48.0;
         float h = hash21(cell);
         if (h > 0.82) {
           vec2 sp = vec2(8.0 + hash21(cell + 7.1) * 32.0, 8.0 + hash21(cell + 19.3) * 32.0);
           float sz = (h > 0.94) ? 2.6 : 1.6;
           if (abs(loc.x - sp.x) < sz * 0.5 && abs(loc.y - sp.y) < sz * 0.5) {
             col = mix(col, (h > 0.92) ? uStarHi : uStar, 0.65 + 0.35 * sin(uTime * 2.4 + h * 40.0));
           }
         }
         gl_FragColor = vec4(col, 1.0);
       }`
    );

    // Pass 1: Solid 3D mesh into transparent RGBA+Depth FBO (encodes object ID in alpha)
    const meshProg = createProgram(
      `precision highp float;
       attribute vec3 aPos; attribute vec3 aNorm; attribute vec4 aCol; attribute vec4 aRig;
       uniform mat4 uMVP;
       uniform vec3 uCenter; uniform vec3 uOffset; uniform float uYawRad; uniform float uScale;
       uniform vec2 uSpring; uniform float uExplode;
       varying vec3 vNorm; varying vec4 vCol;
       vec3 rotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x*c - v.y*s, v.x*s + v.y*c, v.z); }
       void main() {
         vec3 nrm = normalize(aNorm);
         float spZ = max(0.35, uExplode);
         vec3 p = (aPos - uCenter) * uScale;
         p.xy *= uSpring.x; p.z *= uSpring.y;
         p = rotZ(p, uYawRad) + uCenter + uOffset;
         p.z *= spZ;
         vec3 rn = rotZ(nrm, uYawRad);
         vNorm = normalize(vec3(rn.xy, rn.z / spZ)); vCol = aCol;
         gl_Position = uMVP * vec4(p, 1.0);
       }`,
      `precision highp float;
       varying vec3 vNorm; varying vec4 vCol;
       uniform vec3 uLightDir; uniform vec3 uViewDir;
       uniform int uRenderMode; uniform float uPreLit; uniform float uObjAlpha;
       void main() {
         vec3 n = normalize(vNorm); vec3 base = vCol.rgb;
         float ndotl = dot(n, normalize(uLightDir));
         vec3 col = base;
         if (uPreLit > 0.5) {
           float shade = (uRenderMode == 3) ? (0.90 + 0.16 * smoothstep(-0.35, 0.55, ndotl)) : (ndotl > 0.55 ? 1.06 : (ndotl < -0.25 ? 0.86 : 1.0));
           col = clamp(base * shade, 0.0, 1.0);
         } else if (uRenderMode == 3) {
           float t1 = smoothstep(0.42, 0.58, ndotl), t2 = smoothstep(-0.04, 0.14, ndotl), t3 = smoothstep(-0.46, -0.28, ndotl);
           col = mix(base * 0.56, mix(base * 0.76, mix(base, clamp(base * 1.16 + 0.055, 0.0, 1.0), t1), t2), t3);
           col = clamp(col + vec3(pow(1.0 - max(0.0, dot(n, normalize(uViewDir))), 2.8) * 0.14), 0.0, 1.0);
         } else {
           if (ndotl > 0.50) col = clamp(base * 1.18 + 0.06, 0.0, 1.0);
           else if (ndotl < -0.36) col = base * 0.54;
           else if (ndotl < 0.06) col = base * 0.75;
         }
         if (uRenderMode == 1) col = floor(col * 24.0 + 0.5) / 24.0;
         gl_FragColor = vec4(col, uObjAlpha);
       }`
    );

    // Pass 2: True 2x2-SSAA Exact-ID Resolve + Glass-Smooth 16-Direction Screen-Space Silhouette Outline (ZERO internal artifacts!)
    const compProg = createProgram(
      `attribute vec2 aPos; varying vec2 vUv; void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
      `precision highp float; varying vec2 vUv;
       uniform sampler2D uSceneTex; uniform vec2 uTexel; uniform vec2 uSubOff; uniform vec2 uRes;
       uniform float uOutOn; uniform float uOutPx; uniform vec3 uOutCol; uniform int uMode; uniform float uPixelStep;
       int objIdAt(vec2 uv) {
         float a = texture2D(uSceneTex, clamp(uv, vec2(0.0), vec2(1.0))).a;
         if (a > 0.85) return 1;
         if (a > 0.35) return 2;
         return 0;
       }
       vec4 fetchQ(vec2 uv) {
         vec2 grid = max(vec2(64.0), floor(uRes / max(1.0, uPixelStep)));
         return texture2D(uSceneTex, clamp((floor(uv * grid) + 0.5) / grid, vec2(0.0), vec2(1.0)));
       }
       void main() {
         float rad = (uMode <= 1) ? max(uPixelStep, uOutPx) : uOutPx;
         if (uMode <= 1) {
           vec4 c = fetchQ(vUv); int cid = (c.a > 0.85) ? 1 : ((c.a > 0.35) ? 2 : 0);
           vec2 d = uTexel * rad, dd = d * 0.70710678;
           if (uOutOn > 0.5) {
             if (cid == 0) {
               bool hit = (fetchQ(vUv + vec2( d.x, 0.0)).a > 0.35) || (fetchQ(vUv + vec2(-d.x, 0.0)).a > 0.35) ||
                          (fetchQ(vUv + vec2(0.0,  d.y)).a > 0.35) || (fetchQ(vUv + vec2(0.0, -d.y)).a > 0.35);
               if (!hit && uMode != 1) {
                 hit = (fetchQ(vUv + vec2( dd.x,  dd.y)).a > 0.35) || (fetchQ(vUv + vec2(-dd.x,  dd.y)).a > 0.35) ||
                       (fetchQ(vUv + vec2( dd.x, -dd.y)).a > 0.35) || (fetchQ(vUv + vec2(-dd.x, -dd.y)).a > 0.35);
               }
               if (hit) { gl_FragColor = vec4(uOutCol, 1.0); return; }
               discard;
             } else {
               int oid = (cid == 1) ? 2 : 1; vec2 ds = uTexel * max(1.0, rad * 0.75);
               vec4 s0 = fetchQ(vUv + vec2( ds.x, 0.0)), s1 = fetchQ(vUv + vec2(-ds.x, 0.0));
               vec4 s2 = fetchQ(vUv + vec2(0.0,  ds.y)), s3 = fetchQ(vUv + vec2(0.0, -ds.y));
               bool sep = (((s0.a > 0.85) ? 1 : ((s0.a > 0.35) ? 2 : 0)) == oid) || (((s1.a > 0.85) ? 1 : ((s1.a > 0.35) ? 2 : 0)) == oid) ||
                          (((s2.a > 0.85) ? 1 : ((s2.a > 0.35) ? 2 : 0)) == oid) || (((s3.a > 0.85) ? 1 : ((s3.a > 0.35) ? 2 : 0)) == oid);
               if (sep) { gl_FragColor = vec4(uOutCol, 1.0); return; }
             }
           } else if (cid == 0) discard;
           vec3 rgb = c.rgb;
           if (uMode == 1) rgb = floor(rgb * 26.0 + 0.5) / 26.0;
           gl_FragColor = vec4(rgb, 1.0); return;
         }

         // Smooth 2x2 exact sub-texel SSAA resolve (zero black halo & exact discrete Object IDs!)
         vec4 q0 = texture2D(uSceneTex, clamp(vUv + vec2(-uSubOff.x, -uSubOff.y), vec2(0.0), vec2(1.0)));
         vec4 q1 = texture2D(uSceneTex, clamp(vUv + vec2( uSubOff.x, -uSubOff.y), vec2(0.0), vec2(1.0)));
         vec4 q2 = texture2D(uSceneTex, clamp(vUv + vec2(-uSubOff.x,  uSubOff.y), vec2(0.0), vec2(1.0)));
         vec4 q3 = texture2D(uSceneTex, clamp(vUv + vec2( uSubOff.x,  uSubOff.y), vec2(0.0), vec2(1.0)));
         vec3 fgSum = vec3(0.0); float fgCnt = 0.0; bool hasMain = false; bool hasComp = false;
         if (q0.a > 0.35) { fgSum += q0.rgb; fgCnt += 1.0; if (q0.a > 0.85) hasMain = true; else hasComp = true; }
         if (q1.a > 0.35) { fgSum += q1.rgb; fgCnt += 1.0; if (q1.a > 0.85) hasMain = true; else hasComp = true; }
         if (q2.a > 0.35) { fgSum += q2.rgb; fgCnt += 1.0; if (q2.a > 0.85) hasMain = true; else hasComp = true; }
         if (q3.a > 0.35) { fgSum += q3.rgb; fgCnt += 1.0; if (q3.a > 0.85) hasMain = true; else hasComp = true; }
         float fgCov = fgCnt * 0.25;
         vec3 fgRgb = (fgCnt > 0.5) ? (fgSum / fgCnt) : vec3(0.0);

         if (uOutOn < 0.5) {
           if (fgCov < 0.01) discard;
           gl_FragColor = vec4(fgRgb * fgCov, fgCov); return;
         }

         if (fgCov > 0.99) {
           float sepA = (hasMain && hasComp) ? 1.0 : 0.0;
           if (sepA < 0.5) {
             int oid = hasMain ? 2 : 1;
             vec2 ds = uTexel * max(1.0, rad * 0.72), dsd = ds * 0.70710678;
             float sh = 0.0;
             if (objIdAt(vUv + vec2( ds.x, 0.0)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2(-ds.x, 0.0)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2(0.0,  ds.y)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2(0.0, -ds.y)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2( dsd.x,  dsd.y)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2(-dsd.x,  dsd.y)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2( dsd.x, -dsd.y)) == oid) sh += 1.0;
             if (objIdAt(vUv + vec2(-dsd.x, -dsd.y)) == oid) sh += 1.0;
             sepA = clamp(sh * 0.55, 0.0, 1.0);
           }
           gl_FragColor = vec4(mix(fgRgb, uOutCol, sepA), 1.0); return;
         }

         // Exterior / Silhouette-edge pixel: solid inner ring (protects sharp tips) + glass-smooth AA 16-dir outer ring!
         float outA = (fgCov > 0.01) ? 1.0 : 0.0;
         if (outA < 0.99) {
           vec2 di = uTexel * max(0.6, rad - 0.65), did = di * 0.70710678;
           if (objIdAt(vUv + vec2( di.x, 0.0)) > 0 || objIdAt(vUv + vec2(-di.x, 0.0)) > 0 ||
               objIdAt(vUv + vec2(0.0,  di.y)) > 0 || objIdAt(vUv + vec2(0.0, -di.y)) > 0 ||
               objIdAt(vUv + vec2( did.x,  did.y)) > 0 || objIdAt(vUv + vec2(-did.x,  did.y)) > 0 ||
               objIdAt(vUv + vec2( did.x, -did.y)) > 0 || objIdAt(vUv + vec2(-did.x, -did.y)) > 0) {
             outA = 1.0;
           } else {
             vec2 d = uTexel * (rad + 0.25), dd = d * 0.70710678;
             vec2 d1 = d * vec2(0.9238795, 0.3826834), d2 = d * vec2(0.3826834, 0.9238795);
             float hits = 0.0;
             if (objIdAt(vUv + vec2( d.x, 0.0)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-d.x, 0.0)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2(0.0,  d.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(0.0, -d.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( dd.x,  dd.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-dd.x,  dd.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( dd.x, -dd.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-dd.x, -dd.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( d1.x,  d1.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-d1.x,  d1.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( d1.x, -d1.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-d1.x, -d1.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( d2.x,  d2.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-d2.x,  d2.y)) > 0) hits += 1.0;
             if (objIdAt(vUv + vec2( d2.x, -d2.y)) > 0) hits += 1.0; if (objIdAt(vUv + vec2(-d2.x, -d2.y)) > 0) hits += 1.0;
             outA = smoothstep(0.0, 3.2, hits);
           }
         }
         float finalA = max(fgCov, outA);
         if (finalA < 0.01) discard;
         vec3 finalRgb = mix(uOutCol, fgRgb, fgCov);
         gl_FragColor = vec4(finalRgb * finalA, finalA);
       }`
    );

    // True 3D World-Space Stage Pedestal, Rotating Compass Ring, 3D Shadows & 3D Extruded Rim!
    const stage3dProg = createProgram(
      `precision highp float;
       attribute vec3 aPos; attribute vec3 aNorm; attribute vec2 aUv;
       uniform mat4 uMVP; uniform vec3 uCenter; uniform vec3 uScale;
       varying vec2 vUv; varying vec3 vNorm; varying vec2 vLoc;
       void main() {
         vec3 wp = uCenter + vec3(aPos.x * uScale.x, aPos.y * uScale.y, aPos.z * uScale.z);
         vUv = aUv; vNorm = aNorm; vLoc = aPos.xy;
         gl_Position = uMVP * vec4(wp, 1.0);
       }`,
      `precision highp float;
       varying vec2 vUv; varying vec3 vNorm; varying vec2 vLoc;
       uniform sampler2D uTex; uniform int uKind; uniform float uAlpha;
       uniform vec3 uTint; uniform vec3 uLightDir; uniform vec3 uOutCol; uniform float uPosterize;
       void main() {
         if (uKind == 2) {
           vec3 n = normalize(vNorm); float nd = dot(n, normalize(uLightDir));
           vec3 col = uTint * (nd > 0.35 ? 1.15 : (nd < -0.15 ? 0.68 : 0.92));
           if (vUv.y < 0.14) col = mix(col, vec3(0.84, 0.95, 1.0), 0.72);
           else if (vUv.y > 0.84) col = mix(col, uOutCol, 0.82);
           float ang = atan(vLoc.y, vLoc.x);
           if (abs(sin(ang * 6.0)) < 0.08 && vUv.y > 0.18 && vUv.y < 0.82) col = mix(col, vec3(0.92, 0.98, 1.0), 0.55);
           if (uPosterize > 0.5) col = floor(col * 26.0 + 0.5) / 26.0;
           gl_FragColor = vec4(col * uAlpha, uAlpha); return;
         }
         vec4 c = texture2D(uTex, vUv); vec3 rgb = c.rgb * uTint; float a = c.a;
         if (uKind == 1) {
           float r = length(vLoc), ang = atan(vLoc.y, vLoc.x);
           if (r > 0.76 && r < 0.93 && abs(sin(ang * 6.0)) < 0.055) { rgb = mix(rgb, vec3(0.95, 0.99, 1.0), 0.82); a = max(a, 0.92); }
           float dy = vLoc.y + 0.84;
           if (abs(vLoc.x) < 0.11 && dy > -0.09 && dy < 0.09 && abs(vLoc.x) < (0.09 - dy) * 0.75) { rgb = vec3(1.0, 0.96, 0.72); a = max(a, 0.96); }
         }
         if (a < 0.02) discard;
         if (uPosterize > 0.5) rgb = floor(rgb * 26.0 + 0.5) / 26.0;
         float fa = a * uAlpha; gl_FragColor = vec4(rgb * fa, fa);
       }`
    );

    const blitProg = createProgram(
      `attribute vec2 aPos; varying vec2 vUv; void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
      `precision highp float; varying vec2 vUv;
       uniform sampler2D uTex; uniform vec2 uRes; uniform float uPixelStep; uniform float uPosterize;
       void main() {
         vec2 grid = max(vec2(64.0), floor(uRes / max(1.0, uPixelStep)));
         vec2 qUv = (floor(vUv * grid) + 0.5) / grid;
         vec4 c = texture2D(uTex, clamp(qUv, vec2(0.0), vec2(1.0)));
         if (c.a < 0.02) discard;
         if (uPosterize > 0.5) {
           vec3 rgb = floor((c.rgb / max(c.a, 0.001)) * 26.0 + 0.5) / 26.0;
           c = vec4(rgb * c.a, c.a);
         }
         gl_FragColor = c;
       }`
    );

    const spriteProg = createProgram(
      `attribute vec2 aPos; uniform vec4 uRect; uniform vec2 uRes; uniform float uRot; varying vec2 vUv;
       void main() {
         vec2 loc = aPos * (uRect.zw * 0.5); float cr = cos(uRot), sr = sin(uRot);
         vec2 p = uRect.xy + vec2(loc.x*cr - loc.y*sr, loc.x*sr + loc.y*cr);
         vec2 ndc = (p / uRes) * 2.0 - 1.0; ndc.y = -ndc.y; gl_Position = vec4(ndc, 0.0, 1.0); vUv = aPos * 0.5 + 0.5;
       }`,
      `precision mediump float; uniform sampler2D uTex; uniform float uAlpha; uniform vec3 uTint; varying vec2 vUv;
       void main() { vec4 c = texture2D(uTex, vUv); if (c.a < 0.02) discard; float a = c.a * uAlpha; gl_FragColor = vec4(c.rgb * uTint * a, a); }`
    );

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    const plane3dBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, plane3dBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,0, 0,0,1, 0,0,   1,-1,0, 0,0,1, 1,0,   -1, 1,0, 0,0,1, 0,1,
      -1, 1,0, 0,0,1, 0,1,   1,-1,0, 0,0,1, 1,0,    1, 1,0, 0,0,1, 1,1,
    ]), gl.STATIC_DRAW);

    const RIM_SEGS = 48;
    const rimData = new Float32Array(RIM_SEGS * 6 * 8);
    for (let i = 0; i < RIM_SEGS; i++) {
      const a0 = (i / RIM_SEGS) * TWO_PI, a1 = ((i + 1) / RIM_SEGS) * TWO_PI;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const u0 = i / RIM_SEGS, u1 = (i + 1) / RIM_SEGS;
      rimData.set([
        c0,s0,0, c0,s0,0, u0,0,  c1,s1,0, c1,s1,0, u1,0,  c0,s0,-1, c0,s0,0, u0,1,
        c0,s0,-1, c0,s0,0, u0,1, c1,s1,0, c1,s1,0, u1,0,  c1,s1,-1, c1,s1,0, u1,1,
      ], i * 48);
    }
    const rim3dBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rim3dBuf);
    gl.bufferData(gl.ARRAY_BUFFER, rimData, gl.STATIC_DRAW);

    let sceneFbo = null, sceneTex = null, sceneDepth = null, fboW = 0, fboH = 0, fboSS = 1;
    function ensureSceneFbo(cw, ch) {
      const ss = (Math.max(cw, ch) <= 1280) ? 2 : 1;
      const w = cw * ss, h = ch * ss;
      if (sceneFbo && fboW === w && fboH === h) return;
      if (sceneFbo) { gl.deleteFramebuffer(sceneFbo); gl.deleteTexture(sceneTex); gl.deleteRenderbuffer(sceneDepth); }
      fboW = w; fboH = h; fboSS = ss;
      sceneTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sceneDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      sceneFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let stageFbo = null, stageTex = null, stageDepth = null, stageW = 0, stageH = 0;
    function ensureStageFbo(w, h) {
      if (stageFbo && stageW === w && stageH === h) return;
      if (stageFbo) { gl.deleteFramebuffer(stageFbo); gl.deleteTexture(stageTex); gl.deleteRenderbuffer(stageDepth); }
      stageW = w; stageH = h;
      stageTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, stageTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      stageDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, stageDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      stageFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, stageFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, stageTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, stageDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function decodeMeshBuffers(bytes, meta) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const vc = meta.vCount, ic = meta.iCount, sc = meta.posScale || 0.01;
      const vbuf = new Float32Array(vc * 14);
      const ibuf = new Uint16Array(ic);
      if (meta.fmt === "compact9d") {
        const offX = meta.vOff, offY = offX + vc * 2, offZ = offY + vc * 2;
        const offR = offZ + vc * 2, offG = offR + vc, offB = offG + vc;
        let ax = 0, ay = 0, az = 0;
        for (let i = 0; i < vc; i++) {
          ax = (ax + dv.getUint16(offX + i * 2, true)) & 0xFFFF;
          ay = (ay + dv.getUint16(offY + i * 2, true)) & 0xFFFF;
          az = (az + dv.getUint16(offZ + i * 2, true)) & 0xFFFF;
          const b = i * 14;
          vbuf[b+0] = (ax >= 32768 ? ax - 65536 : ax) * sc;
          vbuf[b+1] = (ay >= 32768 ? ay - 65536 : ay) * sc;
          vbuf[b+2] = (az >= 32768 ? az - 65536 : az) * sc;
          vbuf[b+6] = bytes[offR + i] / 255.0;
          vbuf[b+7] = bytes[offG + i] / 255.0;
          vbuf[b+8] = bytes[offB + i] / 255.0;
        }
        let ai = 0;
        for (let i = 0; i < ic; i++) {
          ai = (ai + dv.getUint16(meta.iOff + i * 2, true)) & 0xFFFF;
          ibuf[i] = ai;
        }
        for (let t = 0; t < ic; t += 3) {
          const i0 = ibuf[t] * 14, i1 = ibuf[t+1] * 14, i2 = ibuf[t+2] * 14;
          const e1x = vbuf[i1]-vbuf[i0], e1y = vbuf[i1+1]-vbuf[i0+1], e1z = vbuf[i1+2]-vbuf[i0+2];
          const e2x = vbuf[i2]-vbuf[i0], e2y = vbuf[i2+1]-vbuf[i0+1], e2z = vbuf[i2+2]-vbuf[i0+2];
          const nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
          vbuf[i0+3]+=nx; vbuf[i0+4]+=ny; vbuf[i0+5]+=nz;
          vbuf[i1+3]+=nx; vbuf[i1+4]+=ny; vbuf[i1+5]+=nz;
          vbuf[i2+3]+=nx; vbuf[i2+4]+=ny; vbuf[i2+5]+=nz;
        }
        for (let i = 0; i < vc; i++) {
          const b = i * 14, l = Math.hypot(vbuf[b+3], vbuf[b+4], vbuf[b+5]) || 1.0;
          vbuf[b+3] /= l; vbuf[b+4] /= l; vbuf[b+5] /= l;
        }
      } else {
        let off = meta.vOff;
        for (let i = 0; i < vc; i++) {
          const b = i * 14;
          vbuf[b+0] = dv.getInt16(off+0, true) * sc; vbuf[b+1] = dv.getInt16(off+2, true) * sc; vbuf[b+2] = dv.getInt16(off+4, true) * sc;
          vbuf[b+3] = dv.getInt8(off+6) / 127.0; vbuf[b+4] = dv.getInt8(off+7) / 127.0; vbuf[b+5] = dv.getInt8(off+8) / 127.0;
          vbuf[b+6] = dv.getUint8(off+9) / 255.0; vbuf[b+7] = dv.getUint8(off+10) / 255.0; vbuf[b+8] = dv.getUint8(off+11) / 255.0; vbuf[b+9] = dv.getUint8(off+12) / 255.0;
          vbuf[b+10] = dv.getUint8(off+13); vbuf[b+11] = dv.getUint8(off+14) / 255.0; vbuf[b+12] = dv.getUint8(off+15) / 255.0; vbuf[b+13] = dv.getUint8(off+16) / 255.0;
          off += 17;
        }
        for (let i = 0; i < ic; i++) ibuf[i] = dv.getUint16(meta.iOff + i * 2, true);
      }
      return { vbuf, ibuf };
    }

    function createGpuMesh(bytes, meta) {
      const { vbuf, ibuf } = decodeMeshBuffers(bytes, meta);
      const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, vbuf, gl.STATIC_DRAW);
      const ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ibuf, gl.STATIC_DRAW);
      return { vbo, ibo, iCount: meta.iCount, meta };
    }

    const bgLoc = { aPos: gl.getAttribLocation(bgProg, "aPos"), uRes: gl.getUniformLocation(bgProg, "uRes"), uBg: gl.getUniformLocation(bgProg, "uBg"), uGrid: gl.getUniformLocation(bgProg, "uGrid"), uStar: gl.getUniformLocation(bgProg, "uStar"), uStarHi: gl.getUniformLocation(bgProg, "uStarHi"), uTime: gl.getUniformLocation(bgProg, "uTime") };
    const mLoc = { aPos: gl.getAttribLocation(meshProg, "aPos"), aNorm: gl.getAttribLocation(meshProg, "aNorm"), aCol: gl.getAttribLocation(meshProg, "aCol"), aRig: gl.getAttribLocation(meshProg, "aRig"), uMVP: gl.getUniformLocation(meshProg, "uMVP"), uCenter: gl.getUniformLocation(meshProg, "uCenter"), uOffset: gl.getUniformLocation(meshProg, "uOffset"), uYawRad: gl.getUniformLocation(meshProg, "uYawRad"), uScale: gl.getUniformLocation(meshProg, "uScale"), uSpring: gl.getUniformLocation(meshProg, "uSpring"), uExplode: gl.getUniformLocation(meshProg, "uExplode"), uLightDir: gl.getUniformLocation(meshProg, "uLightDir"), uViewDir: gl.getUniformLocation(meshProg, "uViewDir"), uRenderMode: gl.getUniformLocation(meshProg, "uRenderMode"), uPreLit: gl.getUniformLocation(meshProg, "uPreLit"), uObjAlpha: gl.getUniformLocation(meshProg, "uObjAlpha") };
    const cpLoc = { aPos: gl.getAttribLocation(compProg, "aPos"), uSceneTex: gl.getUniformLocation(compProg, "uSceneTex"), uTexel: gl.getUniformLocation(compProg, "uTexel"), uSubOff: gl.getUniformLocation(compProg, "uSubOff"), uRes: gl.getUniformLocation(compProg, "uRes"), uOutOn: gl.getUniformLocation(compProg, "uOutOn"), uOutPx: gl.getUniformLocation(compProg, "uOutPx"), uOutCol: gl.getUniformLocation(compProg, "uOutCol"), uMode: gl.getUniformLocation(compProg, "uMode"), uPixelStep: gl.getUniformLocation(compProg, "uPixelStep") };
    const stLoc = { aPos: gl.getAttribLocation(stage3dProg, "aPos"), aNorm: gl.getAttribLocation(stage3dProg, "aNorm"), aUv: gl.getAttribLocation(stage3dProg, "aUv"), uMVP: gl.getUniformLocation(stage3dProg, "uMVP"), uCenter: gl.getUniformLocation(stage3dProg, "uCenter"), uScale: gl.getUniformLocation(stage3dProg, "uScale"), uTex: gl.getUniformLocation(stage3dProg, "uTex"), uKind: gl.getUniformLocation(stage3dProg, "uKind"), uAlpha: gl.getUniformLocation(stage3dProg, "uAlpha"), uTint: gl.getUniformLocation(stage3dProg, "uTint"), uLightDir: gl.getUniformLocation(stage3dProg, "uLightDir"), uOutCol: gl.getUniformLocation(stage3dProg, "uOutCol"), uPosterize: gl.getUniformLocation(stage3dProg, "uPosterize") };
    const blLoc = { aPos: gl.getAttribLocation(blitProg, "aPos"), uTex: gl.getUniformLocation(blitProg, "uTex"), uRes: gl.getUniformLocation(blitProg, "uRes"), uPixelStep: gl.getUniformLocation(blitProg, "uPixelStep"), uPosterize: gl.getUniformLocation(blitProg, "uPosterize") };
    const spLoc = { aPos: gl.getAttribLocation(spriteProg, "aPos"), uRect: gl.getUniformLocation(spriteProg, "uRect"), uRes: gl.getUniformLocation(spriteProg, "uRes"), uRot: gl.getUniformLocation(spriteProg, "uRot"), uTex: gl.getUniformLocation(spriteProg, "uTex"), uAlpha: gl.getUniformLocation(spriteProg, "uAlpha"), uTint: gl.getUniformLocation(spriteProg, "uTint") };

    const CFG = opts.config || {};
    const ASSET_MAP = opts.assets || {};
    const MOTION_LIST = CFG.motions || [{ id: "turntable", label: "3D VIEW", frames: 24 }];
    const MOTION_BY_ID = {};
    for (const m of MOTION_LIST) MOTION_BY_ID[m.id] = m;
    const META = CFG.full3d || { centerZ: 56, halfHeight: 96, preLit: true, faceFocusZ: 64 };
    const DEFAULTS = Object.assign({ motion: MOTION_LIST[0].id, animFps: 24, renderMode: 2, dotSize: 1.35, pitchDeg: 20, spacing: 1.0, zoom: 1.45, themeIdx: 1, angleDeg: 20 }, CFG.defaults || {});

    const gpuMeshes = {};
    let rawPayloadBytes = null;
    const staticTex = {};
    for (const [k, src] of Object.entries(ASSET_MAP)) {
      const img = new Image();
      img.onload = () => {
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        const f = (CFG.assetLinear && CFG.assetLinear[k]) ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        staticTex[k] = tex;
      };
      img.src = src;
    }

    if (opts.meshPayload) {
      decompressMeshPayload(opts.meshPayload).then((bytes) => {
        rawPayloadBytes = bytes;
        for (const [k, v] of Object.entries(opts.meshPayload)) {
          if (v && typeof v === "object" && typeof v.vCount === "number") gpuMeshes[k] = createGpuMesh(bytes, v);
        }
        if (opts.onSceneChange) opts.onSceneChange();
      }).catch((e) => console.error("Full3D mesh unpack error:", e));
    }

    const state = {
      motion: DEFAULTS.motion, motionSwitchTime: performance.now() * 0.001,
      animPlaying: true, animFps: DEFAULTS.animFps, animPhase: 0, manualFrame: 0, lastFrameIdx: 0,
      renderMode: DEFAULTS.renderMode, dotSize: DEFAULTS.dotSize,
      springOn: true, fxOn: true, sqX: 1, sqY: 1, sqVx: 0, sqVy: 0,
      angle: (DEFAULTS.angleDeg * Math.PI) / 180, autoSpin: true, spinSpeed: 0.42,
      pitchDeg: DEFAULTS.pitchDeg, spacing: DEFAULTS.spacing, zoom: DEFAULTS.zoom,
      faceFocus: false, outlineOn: true, stageOn: true, themeIdx: DEFAULTS.themeIdx,
      dragActive: false, dragLastX: 0, dragLastY: 0, dragId: null, holdRotDir: 0,
    };
    const keys = { left: false, right: false };
    const callbacks = { onHudUpdate: opts.onHudUpdate, onTimelineUpdate: opts.onTimelineUpdate, onStateChange: opts.onStateChange };
    function notifyState() { if (callbacks.onStateChange) callbacks.onStateChange(); }
    function curMotionDef() { return MOTION_BY_ID[state.motion] || MOTION_LIST[0]; }
    function impulseSquash(sx, sy) { if (!state.springOn) return; state.sqX = sx; state.sqY = sy; state.sqVx = 0; state.sqVy = 0; }
    function stepSpring(dt) {
      if (!state.springOn) { state.sqX = 1; state.sqY = 1; state.sqVx = 0; state.sqVy = 0; return; }
      state.sqVx += ((1 - state.sqX) * 160 - state.sqVx * 16) * dt;
      state.sqVy += ((1 - state.sqY) * 160 - state.sqVy * 16) * dt;
      state.sqX = Math.max(0.76, Math.min(1.26, state.sqX + state.sqVx * dt));
      state.sqY = Math.max(0.76, Math.min(1.26, state.sqY + state.sqVy * dt));
    }

    function drawQuadSprite(tex, cx, cy, w, h, alpha, rotRad, tint) {
      if (!tex || alpha <= 0.01) return;
      gl.useProgram(spriteProg); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(spLoc.aPos); gl.vertexAttribPointer(spLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(spLoc.uTex, 0); gl.uniform4f(spLoc.uRect, cx, cy, w, h); gl.uniform2f(spLoc.uRes, canvas.width, canvas.height);
      gl.uniform1f(spLoc.uRot, rotRad || 0); gl.uniform1f(spLoc.uAlpha, alpha);
      const t = tint || [1, 1, 1]; gl.uniform3f(spLoc.uTint, t[0], t[1], t[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(spLoc.aPos);
    }

    function drawMesh(m, objAlpha) {
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
      const s = 14 * 4;
      gl.enableVertexAttribArray(mLoc.aPos); gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, s, 0);
      gl.enableVertexAttribArray(mLoc.aNorm); gl.vertexAttribPointer(mLoc.aNorm, 3, gl.FLOAT, false, s, 12);
      gl.enableVertexAttribArray(mLoc.aCol); gl.vertexAttribPointer(mLoc.aCol, 4, gl.FLOAT, false, s, 24);
      gl.enableVertexAttribArray(mLoc.aRig); gl.vertexAttribPointer(mLoc.aRig, 4, gl.FLOAT, false, s, 40);
      gl.uniform1f(mLoc.uObjAlpha, objAlpha);
      gl.drawElements(gl.TRIANGLES, m.iCount, gl.UNSIGNED_SHORT, 0);
    }

    function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); }

    function resolveMainMeshKey(mDef, fIdx, fc) {
      if (mDef && Array.isArray(mDef.meshFrames) && mDef.meshFrames.length > 0) {
        const k = mDef.meshFrames[Math.floor((fIdx / Math.max(1, fc)) * mDef.meshFrames.length) % mDef.meshFrames.length];
        if (gpuMeshes[k]) return k;
      }
      if (mDef && mDef.meshKey && gpuMeshes[mDef.meshKey]) return mDef.meshKey;
      return "main";
    }

    function resolveCompMeshKey(cid, fIdx, fc) {
      const cf = META.companionFrames && META.companionFrames[cid];
      if (Array.isArray(cf) && cf.length > 0) {
        const k = cf[Math.floor((fIdx / Math.max(1, fc)) * cf.length) % cf.length];
        if (gpuMeshes[k]) return k;
      }
      return "comp_" + cid;
    }

    function renderFrame(nowSec) {
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(1, Math.floor(rect.width * dpr)), ch = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const theme = THEMES[state.themeIdx], mDef = curMotionDef();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(bgProg); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(bgLoc.aPos); gl.vertexAttribPointer(bgLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(bgLoc.uRes, cw, ch); gl.uniform3fv(bgLoc.uBg, theme.bg); gl.uniform3fv(bgLoc.uGrid, theme.grid);
      gl.uniform3fv(bgLoc.uStar, theme.star); gl.uniform3fv(bgLoc.uStarHi, theme.starHi); gl.uniform1f(bgLoc.uTime, nowSec);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(bgLoc.aPos);

      const fc = mDef ? (mDef.frames || 24) : 24;
      const phaseF = state.animPlaying ? state.animPhase : state.manualFrame;
      const fIdx = Math.floor(phaseF) % fc;
      const mainKey = resolveMainMeshKey(mDef, fIdx, fc);
      const mainM = gpuMeshes[mainKey] || gpuMeshes.main;
      if (!mainM) return;

      const spZ = Math.max(0.35, state.spacing);
      const pitchRad = (state.pitchDeg * Math.PI) / 180;
      const sinP = Math.sin(pitchRad), cosP = Math.cos(pitchRad);
      const ca = Math.cos(state.angle), sa = Math.sin(state.angle);
      const targetZ = (state.faceFocus ? (META.faceFocusZ || META.centerZ) : (META.centerZ || 56)) * spZ;
      const aspect = cw / Math.max(1, ch);
      const halfH = (state.faceFocus ? (META.halfHeight * 0.52) : (META.halfHeight || 96)) / Math.max(0.5, state.zoom / 1.45);
      const halfW = halfH * aspect, unitPx = (ch * 0.5) / halfH;

      const signY = META.camFlipY ? -1.0 : 1.0, signX = META.camFlipY ? 1.0 : -1.0;
      const eyeX = signX * sa * cosP * 340.0;
      const eyeY = signY * ca * cosP * 340.0;
      const eyeZ = targetZ + sinP * 340.0;
      const upVec = [-signX * sa * sinP, -signY * ca * sinP, cosP];
      const viewM = mat4LookAt([eyeX, eyeY, eyeZ], [0.0, 0.0, targetZ], upVec);
      const projM = mat4Ortho(-halfW, halfW, -halfH, halfH, 10.0, 760.0);
      const mvp = mat4Mul(projM, viewM);

      const vLen = Math.hypot(eyeX, eyeY, eyeZ - targetZ) || 1;
      const vDir = [eyeX / vLen, eyeY / vLen, (eyeZ - targetZ) / vLen];
      const camRight = [viewM[0], viewM[4], viewM[8]], camUp = [viewM[1], viewM[5], viewM[9]];
      const lx = -0.26 * camRight[0] + 0.56 * vDir[0] + 0.78 * camUp[0];
      const ly = -0.26 * camRight[1] + 0.56 * vDir[1] + 0.78 * camUp[1];
      const lz = -0.26 * camRight[2] + 0.56 * vDir[2] + 0.78 * camUp[2];

      function project3D(wx, wy, wz) {
        const cx = mvp[0]*wx + mvp[4]*wy + mvp[8]*wz + mvp[12];
        const cy = mvp[1]*wx + mvp[5]*wy + mvp[9]*wz + mvp[13];
        const cz = mvp[2]*wx + mvp[6]*wy + mvp[10]*wz + mvp[14];
        return { sx: (cx * 0.5 + 0.5) * cw, sy: (0.5 - cy * 0.5) * ch, ndcZ: cz };
      }

      const ph = (phaseF / fc) * TWO_PI;
      let compState = null;
      if (state.fxOn && mDef && mDef.companion) {
        const orb = mDef.companion, ck = resolveCompMeshKey(orb.id, fIdx, fc);
        if (gpuMeshes[ck]) {
          const rx = orb.rx ?? 56, ry = orb.ry ?? 48;
          const wx = rx * Math.cos(ph), wy = ry * Math.sin(ph);
          const wz = (orb.zBase ?? 46) + (orb.zSin1 ?? -10) * Math.sin(ph) + (orb.zSin2 ?? 0) * Math.sin(2 * ph);
          const vx = -rx * Math.sin(ph), vy = ry * Math.cos(ph);
          compState = { mesh: gpuMeshes[ck], key: ck, orb, wx, wy, wz, yaw: orb.faceTangent !== false ? Math.atan2(-vx, vy) : 0.0 };
        }
      }

      function drawStage3D(isUnderside) {
        if (!state.stageOn) return;
        const alphaMul = isUnderside ? 0.34 : 1.0, ringRad = 66.0;
        const pixelize = (state.renderMode <= 1);
        if (pixelize) {
          ensureStageFbo(cw, ch);
          gl.bindFramebuffer(gl.FRAMEBUFFER, stageFbo); gl.viewport(0, 0, cw, ch);
          gl.clearColor(0, 0, 0, 0); gl.clearDepth(1.0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
          gl.clearDepth(1.0); gl.clear(gl.DEPTH_BUFFER_BIT);
        }
        gl.useProgram(stage3dProg);
        gl.uniformMatrix4fv(stLoc.uMVP, false, mvp);
        gl.uniform3f(stLoc.uLightDir, lx, ly, lz);
        gl.uniform3fv(stLoc.uOutCol, theme.outline);
        gl.uniform1f(stLoc.uPosterize, state.renderMode === 1 ? 1.0 : 0.0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        gl.bindBuffer(gl.ARRAY_BUFFER, rim3dBuf);
        gl.enableVertexAttribArray(stLoc.aPos); gl.vertexAttribPointer(stLoc.aPos, 3, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(stLoc.aNorm); gl.vertexAttribPointer(stLoc.aNorm, 3, gl.FLOAT, false, 32, 12);
        gl.enableVertexAttribArray(stLoc.aUv); gl.vertexAttribPointer(stLoc.aUv, 2, gl.FLOAT, false, 32, 24);
        gl.uniform3f(stLoc.uCenter, 0, 0, 0); gl.uniform3f(stLoc.uScale, ringRad, ringRad, 4.2);
        gl.uniform1i(stLoc.uKind, 2); gl.uniform1f(stLoc.uAlpha, 0.92 * alphaMul); gl.uniform3f(stLoc.uTint, 0.36, 0.64, 0.94);
        gl.drawArrays(gl.TRIANGLES, 0, RIM_SEGS * 6);
        gl.depthMask(false); gl.bindBuffer(gl.ARRAY_BUFFER, plane3dBuf);
        gl.vertexAttribPointer(stLoc.aPos, 3, gl.FLOAT, false, 32, 0);
        gl.vertexAttribPointer(stLoc.aNorm, 3, gl.FLOAT, false, 32, 12);
        gl.vertexAttribPointer(stLoc.aUv, 2, gl.FLOAT, false, 32, 24);
        gl.activeTexture(gl.TEXTURE0);
        if (staticTex.turntableRing) {
          gl.bindTexture(gl.TEXTURE_2D, staticTex.turntableRing); gl.uniform1i(stLoc.uTex, 0);
          gl.uniform3f(stLoc.uCenter, 0, 0, isUnderside ? -0.15 : 0.05); gl.uniform3f(stLoc.uScale, ringRad, ringRad, 1.0);
          gl.uniform1i(stLoc.uKind, 1); gl.uniform1f(stLoc.uAlpha, 0.95 * alphaMul); gl.uniform3f(stLoc.uTint, 1, 1, 1);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        if (!isUnderside) {
          gl.disable(gl.DEPTH_TEST);
          if (state.fxOn && mDef && mDef.fx) {
            for (const fx of mDef.fx) {
              if (fx.type !== "floor_wave_rings") continue;
              const wTex = staticTex[fx.sprite || "fxWaveRing"];
              if (!wTex) continue;
              gl.bindTexture(gl.TEXTURE_2D, wTex); gl.uniform1i(stLoc.uKind, 0);
              const tC = fx.tint || [0.85, 0.98, 1.0]; gl.uniform3f(stLoc.uTint, tC[0], tC[1], tC[2]);
              const rings = fx.count || 1, startF = fx.startFrame ?? 8.5, durF = fx.durationFrames ?? 12.0, stagger = fx.staggerFrames ?? 3.0;
              for (let r = 0; r < rings; r++) {
                const rp = (phaseF - startF - r * stagger) / durF;
                if (rp > 0 && rp < 1) {
                  const sc = (fx.startScale ?? 0.45) + rp * (fx.expandScale ?? 1.25);
                  gl.uniform3f(stLoc.uCenter, 0, 0, 0.25); gl.uniform3f(stLoc.uScale, 64.0 * sc, 64.0 * sc, 1.0);
                  gl.uniform1f(stLoc.uAlpha, Math.sin(rp * Math.PI) * 0.88);
                  gl.drawArrays(gl.TRIANGLES, 0, 6);
                }
              }
            }
          }
          if (staticTex.shadowDither) {
            gl.bindTexture(gl.TEXTURE_2D, staticTex.shadowDither);
            gl.uniform1i(stLoc.uKind, 0); gl.uniform3f(stLoc.uTint, 1, 1, 1);
            gl.uniform3f(stLoc.uCenter, 0, 0, 0.35); gl.uniform3f(stLoc.uScale, 37.0 * state.sqX, 37.0 * state.sqX, 1.0);
            gl.uniform1f(stLoc.uAlpha, 0.90); gl.drawArrays(gl.TRIANGLES, 0, 6);
            if (compState) {
              gl.uniform3f(stLoc.uCenter, compState.wx, compState.wy, 0.38);
              gl.uniform3f(stLoc.uScale, 17.5 * state.sqX, 17.5 * state.sqX, 1.0);
              gl.uniform1f(stLoc.uAlpha, 0.46); gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
          }
        }
        gl.disable(gl.DEPTH_TEST); gl.depthMask(true);
        gl.disableVertexAttribArray(stLoc.aPos); gl.disableVertexAttribArray(stLoc.aNorm); gl.disableVertexAttribArray(stLoc.aUv);
        if (pixelize) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(blitProg); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
          gl.enableVertexAttribArray(blLoc.aPos); gl.vertexAttribPointer(blLoc.aPos, 2, gl.FLOAT, false, 0, 0);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, stageTex);
          gl.uniform1i(blLoc.uTex, 0); gl.uniform2f(blLoc.uRes, cw, ch);
          gl.uniform1f(blLoc.uPixelStep, Math.max(1.0, state.dotSize * dpr * 1.9));
          gl.uniform1f(blLoc.uPosterize, state.renderMode === 1 ? 1.0 : 0.0);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.disableVertexAttribArray(blLoc.aPos);
        }
      }

      // Collect all 6 declarative 3D FX types & depth-sort into BACK vs FRONT!
      const fxBack = [], fxFront = [];
      const centerNdcZ = project3D(0.0, 0.0, (META.centerZ || 56.0) * spZ).ndcZ;
      if (state.fxOn && mDef && mDef.fx) {
        const t = (phaseF % fc) / fc;
        const pushFx = (wx, wy, wz, key, w, h, alpha, rot, tint) => {
          const tex = staticTex[key]; if (!tex || alpha <= 0.01) return;
          const p3 = project3D(wx, wy, wz * spZ);
          const it = { tex, sx: p3.sx, sy: p3.sy, w: w * unitPx, h: h * unitPx, a: alpha, rot: rot || 0, tint: tint || [1, 1, 1], z: p3.ndcZ };
          (p3.ndcZ > centerNdcZ ? fxBack : fxFront).push(it);
        };
        for (const fx of mDef.fx) {
          if (fx.type === "sparkle_perimeter") {
            const glowW = Math.max(0, Math.sin(Math.max(0, Math.min(1, (phaseF - (fx.startFrame ?? 4)) / (fx.durationFrames ?? 15))) * Math.PI));
            const coords = fx.points || [[-30,14,112],[32,14,116],[-38,6,86],[36,10,88],[-22,18,132],[22,18,130]];
            for (let i = 0; i < coords.length; i++) {
              const [bx, by, bz] = coords[i], beat = (t * 2.0 + i * 0.19) % 1.0, pop = Math.sin(beat * Math.PI);
              const sz = (7.2 + 6.0 * pop) * (0.45 + 0.55 * glowW);
              pushFx(bx, by, bz + beat * 9.0, beat < 0.55 ? (fx.sprite0 || "fxSpark_0") : (fx.sprite1 || "fxSpark_1"), sz, sz, pop * (0.35 + 0.65 * glowW), 0, (i % 3 === 0) ? [0.65, 0.94, 1.0] : [1.0, 0.96, 0.78]);
            }
          } else if (fx.type === "orbit_trail") {
            const count = fx.count || 18, rx = fx.rx ?? 54, ry = fx.ry ?? 42;
            for (let i = 0; i < count; i++) {
              const pLag = ph - (i / count) * (fx.phaseLag ?? 0.42) * TWO_PI, life = i / count;
              const wx = rx * Math.cos(pLag) + (hash1(i * 3.1) - 0.5) * 14, wy = ry * Math.sin(pLag) + (hash1(i * 5.7) - 0.5) * 14;
              const wz = (fx.zBase ?? 86) + (fx.zSin1 ?? -20) * Math.sin(pLag) + (fx.zSin2 ?? 8) * Math.sin(2 * pLag) + life * 22;
              const isA = (i % 3 === 0), sz = isA ? (10.5 * (1 - life * 0.45)) : (7.5 + 3.5 * hash1(i * 9.3));
              pushFx(wx, wy, wz, isA ? (fx.primarySprite || "fxHeart") : (fx.secondarySprite || "fxBubble"), sz, sz, Math.sin((1 - life) * Math.PI) * 0.95, 0);
            }
          } else if (fx.type === "burst_above") {
            const w = Math.max(0, Math.sin(Math.max(0, Math.min(1, (phaseF - (fx.startFrame ?? 2.5)) / (fx.durationFrames ?? 10.5))) * Math.PI));
            if (w > 0.05) {
              const count = fx.count || 5;
              for (let k = 0; k < count; k++) {
                const prog = (t * 2.4 + k * 0.21) % 1.0, sz = 11.5 * Math.sin(prog * Math.PI);
                pushFx((k - (count - 1) * 0.5) * 12.5, (fx.y ?? 24) + Math.sin(k * 2.1) * 8, (fx.zBase ?? 92) + prog * 38, fx.sprite || "fxHeart", sz, sz, Math.sin(prog * Math.PI) * w, 0);
              }
            }
          } else if (fx.type === "forward_slash_fan") {
            const atkF = phaseF - (fx.startFrame ?? 5.0), durF = fx.durationFrames ?? 15.0;
            if (atkF >= 0 && atkF <= durF) {
              const u = atkF / durF;
              if (u <= 0.76) {
                const su = u / 0.76, sf = Math.min((fx.slashFrames || 4) - 1, Math.floor(su * (fx.slashFrames || 4)));
                const szZ = (fx.slashZ ?? 70) + Math.sin(su * Math.PI) * 7;
                const pA = project3D(0, 20, szZ * spZ), pB = project3D(0, 50, szZ * spZ);
                const slRot = Math.atan2(pB.sy - pA.sy, pB.sx - pA.sx), slSc = 1.22 + 0.80 * su;
                pushFx(0, 30 + su * 50, szZ, (fx.slashPrefix || "fxSlash_") + sf, (fx.slashW ?? 84) * slSc, (fx.slashH ?? 44) * slSc, (1 - su * 0.40) * 0.98, slRot, [0.95, 1.0, 1.0]);
              }
              const count = fx.count || 72;
              for (let i = 0; i < count; i++) {
                const delay = hash1(i * 1.7) * 0.24, lu = (u - delay) / Math.max(0.15, 1 - delay);
                if (lu <= 0 || lu >= 1) continue;
                const ang = (hash1(i * 3.9) - 0.5) * 1.65, dist = 22 + (52 + hash1(i * 7.3) * 74) * Math.pow(lu, 0.68);
                const wx = Math.sin(ang) * dist + (hash1(i * 11.1) - 0.5) * 10, wy = Math.cos(ang) * dist;
                const wz = Math.max(2, (fx.originZ ?? 68) + (28 + hash1(i * 13.7) * 48) * lu - 76 * lu * lu);
                const kind = i % 3, tk = kind === 0 ? (fx.dropletSprite || "fxDroplet") : (kind === 1 ? (fx.bubbleSprite || "fxBubble") : (fx.foamSprite || "fxFoam"));
                const sz = (kind === 2 ? 10 : 9.2) * (0.72 + 0.65 * hash1(i * 17.3)) * (1 - lu * 0.30);
                pushFx(wx, wy, wz, tk, sz, sz, Math.sin(lu * Math.PI) * 0.96, lu * (hash1(i * 5.3) - 0.5) * 2.5, kind === 0 ? [0.68, 0.92, 1.0] : [0.92, 0.99, 1.0]);
              }
            }
          } else if (fx.type === "helix_vortex") {
            const count = fx.count || 108, slamS = fx.slamFrame ?? 8.5;
            const burst = Math.sin(Math.max(0, Math.min(1, (phaseF - slamS) / 11.0)) * Math.PI);
            const chg = Math.max(0, Math.min(1, phaseF / slamS)) * (1 - Math.max(0, Math.min(1, (phaseF - slamS + 0.5) / 3.0)));
            const maxH = fx.maxHeight ?? (META.centerZ * 1.6);
            for (let i = 0; i < count; i++) {
              const sA = hash1(i * 2.31), sB = hash1(i * 6.73), sC = hash1(i * 11.17);
              const hf = (sA + t * (1.35 + 0.4 * sB)) % 1.0, wz = 4 + hf * (maxH + 28 * burst);
              const th = (i % 2) * Math.PI + hf * TWO_PI * 2.1 + ph * 2.0 + (sC - 0.5) * 0.55;
              const rad = ((fx.baseRadius ?? 30) + 18 * hf + (sB - 0.5) * 14) * (0.86 + 0.14 * chg + 0.68 * burst * (0.55 + 0.65 * hf));
              const kind = i % 4, tk = (kind < 2) ? (fx.dropletSprite || "fxDroplet") : (kind === 2 ? (fx.bubbleSprite || "fxBubble") : (fx.foamSprite || "fxFoam"));
              const sz = (kind === 3 ? 11 : 9) * (0.68 + 0.62 * sC) * (0.8 + 0.42 * burst);
              pushFx(Math.cos(th) * rad, Math.sin(th) * rad, wz, tk, sz, sz, Math.sin(hf * Math.PI) * (0.65 + 0.35 * Math.max(chg, burst)), 0, kind === 0 ? [0.46 + 0.45 * hf, 0.78 + 0.22 * hf, 1.0] : [0.85, 0.98, 1.0]);
            }
          }
        }
        fxBack.sort((a, b) => b.z - a.z);
        fxFront.sort((a, b) => b.z - a.z);
      }

      const underFloor = (eyeZ < 0.0);
      if (!underFloor) drawStage3D(false);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const it of fxBack) drawQuadSprite(it.tex, it.sx, it.sy, it.w, it.h, it.a, it.rot, it.tint);

      // Pass 1: Render 3D meshes into 2x-SSAA transparent FBO
      ensureSceneFbo(cw, ch);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.viewport(0, 0, fboW, fboH);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1.0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);

      const isAnimatedFrames = Boolean(mDef && Array.isArray(mDef.meshFrames) && mDef.meshFrames.length > 1);
      const bob = isAnimatedFrames ? 0.0 : ((mDef && mDef.bobAmp ? mDef.bobAmp : 2.2) * Math.sin(ph));
      const swayYaw = isAnimatedFrames ? 0.0 : ((mDef && mDef.yawAmp ? mDef.yawAmp : 0.08) * Math.sin(ph));
      const breathe = isAnimatedFrames ? 0.0 : (0.025 * Math.sin(ph));
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(mLoc.uMVP, false, mvp);
      gl.uniform3f(mLoc.uCenter, 0.0, 0.0, META.centerZ || 56.0);
      gl.uniform3f(mLoc.uOffset, 0.0, 0.0, bob);
      gl.uniform1f(mLoc.uYawRad, swayYaw); gl.uniform1f(mLoc.uScale, 1.0);
      gl.uniform2f(mLoc.uSpring, state.sqX * (1 - breathe), state.sqY * (1 + breathe));
      gl.uniform1f(mLoc.uExplode, state.spacing);
      gl.uniform3f(mLoc.uLightDir, lx, ly, lz); gl.uniform3fv(mLoc.uViewDir, vDir);
      gl.uniform1i(mLoc.uRenderMode, state.renderMode); gl.uniform1f(mLoc.uPreLit, META.preLit ? 1.0 : 0.0);
      drawMesh(mainM, 1.0);

      if (compState) {
        const cCtrZ = META.companionCenterZ || 24.0;
        gl.uniform3f(mLoc.uCenter, 0.0, 0.0, cCtrZ);
        gl.uniform3f(mLoc.uOffset, compState.wx, compState.wy, compState.wz - cCtrZ);
        gl.uniform1f(mLoc.uYawRad, compState.yaw);
        gl.uniform1f(mLoc.uScale, compState.orb.scale ?? 0.9);
        gl.uniform2f(mLoc.uSpring, state.sqX, state.sqY);
        drawMesh(compState.mesh, 0.65);
      }

      // Pass 2: True 2x2-SSAA exact-ID resolve + glass-smooth 16-direction silhouette outline composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(compProg); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(cpLoc.aPos); gl.vertexAttribPointer(cpLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(cpLoc.uSceneTex, 0); gl.uniform2f(cpLoc.uTexel, 1.0 / cw, 1.0 / ch);
      gl.uniform2f(cpLoc.uSubOff, fboSS >= 2 ? 0.5 / fboW : 0.0, fboSS >= 2 ? 0.5 / fboH : 0.0);
      gl.uniform2f(cpLoc.uRes, cw, ch);
      gl.uniform1f(cpLoc.uOutOn, state.outlineOn ? 1.0 : 0.0);
      gl.uniform1f(cpLoc.uOutPx, (state.renderMode === 3 ? 2.2 : 2.8) * dpr);
      gl.uniform3fv(cpLoc.uOutCol, theme.outline); gl.uniform1i(cpLoc.uMode, state.renderMode);
      gl.uniform1f(cpLoc.uPixelStep, Math.max(1.0, state.dotSize * dpr * 1.9));
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(cpLoc.aPos);

      if (underFloor) drawStage3D(true);

      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const it of fxFront) drawQuadSprite(it.tex, it.sx, it.sy, it.w, it.h, it.a, it.rot, it.tint);

      if (state.fxOn && mDef && mDef.billboard && staticTex[mDef.billboard.assetKey]) {
        const bb = mDef.billboard;
        const age = Math.max(0, nowSec - state.motionSwitchTime);
        const pop = age < 0.25 ? (1 + 0.14 * Math.sin((age / 0.25) * Math.PI)) * (age / 0.25) : 1;
        const anchor = compState
          ? project3D(compState.wx, compState.wy, (compState.wz + 26) * spZ)
          : project3D(0, 0, (bb.anchorZ ?? (META.centerZ * 1.8)) * spZ);
        const bScale = Math.max(0.95 * dpr, Math.min(2.15 * dpr, unitPx * 0.56)) * Math.max(0.1, pop);
        const bw = (bb.width || 128) * bScale, bh = (bb.height || 56) * bScale;
        const ox = compState ? 24 * bScale : (bb.offsetX ?? 54) * bScale;
        const oy = compState ? -32 * bScale : (bb.offsetY ?? -30) * bScale;
        const bx = Math.max(bw * 0.52 + 10 * dpr, Math.min(cw - bw * 0.52 - 10 * dpr, anchor.sx + ox));
        const by = Math.max(bh * 0.52 + 54 * dpr, Math.min(ch - bh * 0.52 - 12 * dpr, anchor.sy + oy + Math.sin(ph) * (bb.bobAmp ?? 2.8) * unitPx));
        drawQuadSprite(staticTex[bb.assetKey], bx, by, bw, bh, 0.98, 0);
      }

      const deg = Math.round((((state.angle % TWO_PI) + TWO_PI) % TWO_PI) * (180 / Math.PI)) % 360;
      const fStr = String(fIdx + 1).padStart(2, "0");
      if (callbacks.onHudUpdate) {
        callbacks.onHudUpdate((window.innerWidth <= 860)
          ? `${mDef.label} F${fStr} ${String(deg).padStart(3, "0")}D`
          : `${mDef.label} F${fStr}/${fc} | FULL 3D | ${String(deg).padStart(3, "0")} DEG`);
      }
    }

    function selectMotion(id) {
      const m = MOTION_BY_ID[id]; if (!m) return;
      state.motion = id; state.motionSwitchTime = performance.now() * 0.001;
      state.animPhase = 0; state.manualFrame = 0; state.lastFrameIdx = 0; state.animPlaying = true;
      const imp = m.impulse || [1.04, 0.96]; impulseSquash(imp[0], imp[1]);
      if (callbacks.onTimelineUpdate) callbacks.onTimelineUpdate(0, m.frames || 24); notifyState();
    }
    function stepMotion(d) { if (MOTION_LIST.length <= 1) return; const idx = Math.max(0, MOTION_LIST.findIndex((m) => m.id === state.motion)); selectMotion(MOTION_LIST[(idx + d + MOTION_LIST.length) % MOTION_LIST.length].id); }
    function setFrame(f) { const fc = curMotionDef().frames || 24; state.animPlaying = false; state.manualFrame = Math.max(0, Math.min(fc - 1, f | 0)); state.animPhase = state.manualFrame; if (callbacks.onTimelineUpdate) callbacks.onTimelineUpdate(state.manualFrame, fc); notifyState(); }
    function togglePlay() { const fc = curMotionDef().frames || 24; if (state.animPlaying) { state.manualFrame = Math.floor(state.animPhase) % fc; state.animPlaying = false; } else { state.animPhase = state.manualFrame; state.animPlaying = true; } if (callbacks.onTimelineUpdate) callbacks.onTimelineUpdate(state.manualFrame, fc); notifyState(); }
    function toggleFaceFocus() { state.faceFocus = !state.faceFocus; state.zoom = state.faceFocus ? 2.15 : DEFAULTS.zoom; notifyState(); }
    function resetAll() {
      state.motion = DEFAULTS.motion; state.animPlaying = true; state.animFps = DEFAULTS.animFps;
      state.animPhase = 0; state.manualFrame = 0; state.renderMode = DEFAULTS.renderMode; state.dotSize = DEFAULTS.dotSize;
      state.angle = (DEFAULTS.angleDeg * Math.PI) / 180; state.autoSpin = true; state.springOn = true; state.fxOn = true;
      state.pitchDeg = DEFAULTS.pitchDeg; state.spacing = DEFAULTS.spacing; state.zoom = DEFAULTS.zoom;
      state.faceFocus = false; state.outlineOn = true; state.themeIdx = DEFAULTS.themeIdx;
      impulseSquash(1.10, 0.90); notifyState();
    }

    canvas.addEventListener("pointerdown", (e) => { state.dragActive = true; state.dragId = e.pointerId; state.dragLastX = e.clientX; state.dragLastY = e.clientY; state.autoSpin = false; canvas.classList.add("dragging"); canvas.setPointerCapture(e.pointerId); notifyState(); });
    canvas.addEventListener("pointermove", (e) => {
      if (!state.dragActive || e.pointerId !== state.dragId) return;
      const dx = e.clientX - state.dragLastX, dy = e.clientY - state.dragLastY;
      state.dragLastX = e.clientX; state.dragLastY = e.clientY;
      state.angle = (state.angle - dx * 0.011 + TWO_PI) % TWO_PI;
      if (Math.abs(dy) > 0.2) { state.pitchDeg = Math.max(-85, Math.min(90, state.pitchDeg + dy * 0.35)); notifyState(); }
    });
    const endDrag = (e) => { if (state.dragActive && e.pointerId === state.dragId) { state.dragActive = false; state.dragId = null; canvas.classList.remove("dragging"); } };
    canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); state.zoom = Math.max(0.8, Math.min(3.2, Math.round((state.zoom + (e.deltaY < 0 ? 0.1 : -0.1)) * 20) / 20)); notifyState(); }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "KeyQ" || e.code === "ArrowLeft") keys.left = true;
      if (e.code === "KeyE" || e.code === "ArrowRight") keys.right = true;
      if (e.key === "[") stepMotion(-1); if (e.key === "]") stepMotion(1);
      if (e.key >= "1" && e.key <= "9") { const idx = Number(e.key) - 1; if (idx < MOTION_LIST.length) selectMotion(MOTION_LIST[idx].id); }
      if (e.code === "KeyF") toggleFaceFocus(); if (e.code === "KeyB") impulseSquash(0.84, 1.20);
      if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.code === "KeyR") resetAll();
    });
    window.addEventListener("keyup", (e) => { if (e.code === "KeyQ" || e.code === "ArrowLeft") keys.left = false; if (e.code === "KeyE" || e.code === "ArrowRight") keys.right = false; });

    let lastT = performance.now();
    function tick(now) {
      const dt = Math.max(0, Math.min(0.05, (now - lastT) * 0.001)); lastT = now;
      if (state.holdRotDir !== 0) state.angle = (state.angle + state.holdRotDir * 1.9 * dt) % TWO_PI;
      else if (keys.left) state.angle = (state.angle - 1.9 * dt) % TWO_PI;
      else if (keys.right) state.angle = (state.angle + 1.9 * dt) % TWO_PI;
      else if (state.autoSpin && !state.dragActive) state.angle = (state.angle + state.spinSpeed * dt) % TWO_PI;
      const mDef = curMotionDef(), fc = mDef ? (mDef.frames || 24) : 24;
      if (mDef && state.animPlaying) {
        state.animPhase = (state.animPhase + state.animFps * dt) % fc;
        const curF = Math.floor(state.animPhase) % fc;
        if (curF !== state.lastFrameIdx) {
          state.lastFrameIdx = curF;
          if (callbacks.onTimelineUpdate) callbacks.onTimelineUpdate(curF, fc);
          if (mDef.springBeats) { for (const b of mDef.springBeats) if (b.frame === curF) impulseSquash(b.sx, b.sy); }
        }
      }
      stepSpring(dt); renderFrame(now * 0.001); requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    return {
      getState: () => state, getConfig: () => CFG, getAssets: () => ASSET_MAP, getAssetSrc: (k) => ASSET_MAP[k] || null,
      getMotions: () => MOTION_LIST, getActiveMotion: () => curMotionDef(), getThemeName: () => THEMES[state.themeIdx].name,
      selectMotion, stepMotion, setFrame, togglePlay, toggleFaceFocus, resetAll,
      setRenderMode: (m) => { state.renderMode = m | 0; notifyState(); },
      setDotSize: (v) => { state.dotSize = v; if (state.renderMode > 1) state.renderMode = 0; notifyState(); },
      toggleDotPreset: () => { state.dotSize = state.dotSize <= 1.05 ? 1.35 : 1.0; if (state.renderMode > 1) state.renderMode = 0; notifyState(); },
      setFps: (v) => { state.animFps = Math.round(v); notifyState(); },
      setPitchDeg: (d) => { state.pitchDeg = Math.max(-85, Math.min(90, Math.round(d))); notifyState(); },
      setSpacing: (v) => { state.spacing = v; notifyState(); },
      setZoom: (v) => { state.zoom = v; notifyState(); },
      setAngleDeg: (d) => { state.angle = ((Number(d) || 0) * Math.PI) / 180; state.autoSpin = false; notifyState(); },
      setHoldRotDir: (d) => { state.holdRotDir = d; if (d !== 0) state.autoSpin = false; notifyState(); },
      toggleTopView: () => { state.faceFocus = false; state.pitchDeg = state.pitchDeg >= 89 ? DEFAULTS.pitchDeg : 90; notifyState(); },
      toggleSpread: () => { state.spacing = state.spacing >= 1.80 ? 1.0 : 2.0; notifyState(); },
      triggerBounce: () => impulseSquash(0.84, 1.20),
      toggleFlag: (k) => { state[k] = !state[k]; notifyState(); },
      cycleTheme: () => { state.themeIdx = (state.themeIdx + 1) % THEMES.length; notifyState(); },
      supportsAP3DLoad: () => false,
      getExportFormats: () => {
        const fmts = [{ id: "glb", label: ".GLB (3D)" }];
        const hasComp = Object.keys(gpuMeshes).some((k) => k.startsWith("comp_")) ||
          (opts.meshPayload && Object.keys(opts.meshPayload).some((k) => k.startsWith("comp_")));
        if (hasComp) fmts.push({ id: "glb_all", label: ".GLB+PET" });
        fmts.push({ id: "png", label: ".PNG" });
        return fmts;
      },
      buildGlbBytes: (includePet) => {
        if (!rawPayloadBytes) throw new Error("3D mesh not loaded yet");
        const mDef = curMotionDef(), fc = mDef ? (mDef.frames || 24) : 24;
        const fIdx = Math.floor(state.animPlaying ? state.animPhase : state.manualFrame) % fc;
        const mk = resolveMainMeshKey(mDef, fIdx, fc);
        const mainM = gpuMeshes[mk] || gpuMeshes.main;
        if (!mainM) throw new Error("3D mesh not loaded yet");
        const md = decodeMeshBuffers(rawPayloadBytes, mainM.meta);
        const parts = [{ name: "MainCharacter_" + (mDef ? mDef.id : "pose"), rawV: md.vbuf, rawI: md.ibuf, offset: [0, 0, 0], scale: 1.0 }];
        if (includePet) {
          const seen = new Set();
          for (const [k, m] of Object.entries(gpuMeshes)) {
            if (!k.startsWith("comp_")) continue;
            const cid = k.replace(/_\d+$/, "");
            if (seen.has(cid)) continue;
            seen.add(cid);
            const cd = decodeMeshBuffers(rawPayloadBytes, m.meta);
            parts.push({ name: cid, rawV: cd.vbuf, rawI: cd.ibuf, offset: [48, -28, 22], scale: 0.9 });
          }
        }
        return buildGlbBytes(parts);
      },
      async exportByFormat(fmt) {
        const slug = String(CFG.title || "character-3d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character-3d";
        if (fmt === "png") {
          const filename = slug + ".png";
          const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
          if (!blob) throw new Error("PNG capture failed");
          triggerDownload(blob, filename);
          return { filename, bytes: blob.size };
        }
        const includePet = (fmt === "glb_all");
        const bytes = this.buildGlbBytes(includePet);
        const filename = slug + (includePet ? "-with-pet.glb" : ".glb");
        triggerDownload(new Blob([bytes], { type: "model/gltf-binary" }), filename);
        return { filename, bytes: bytes.byteLength };
      },
    };
  }

  function autoBootstrap() {
    if (global.ANIME_AUTO_MOUNT === false) return;
    const root = document.getElementById("appRoot");
    if (!root || !global.AnimeUIKit) return;
    let engineRef = null;
    const proxy = new Proxy({}, { get: (_, k) => (...a) => engineRef && typeof engineRef[k] === "function" ? engineRef[k](...a) : undefined });
    const ui = global.AnimeUIKit.mountStudioUI(root, proxy, { showFileIO: true });
    engineRef = createEngine({
      canvas: ui.canvas, config: global.SCENE_CONFIG || {}, assets: global.SPRITE_ASSETS || {}, meshPayload: global.FULL3D_MESH_DATA || null,
      onHudUpdate: (txt) => ui.updateHud(txt), onTimelineUpdate: (f, fc) => ui.updateTimeline(f, fc),
      onStateChange: () => { if (engineRef) ui.syncAll(); },
      onSceneChange: () => { if (engineRef) ui.syncScene(); },
    });
    ui.syncScene(); global.ANIME_ENGINE = engineRef; global.ANIME_UI = ui;
  }

  global.Full3DMeshEngine = { create: createEngine, THEMES };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoBootstrap);
  else autoBootstrap();
})(window);
