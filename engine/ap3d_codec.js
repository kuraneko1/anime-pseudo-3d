/* Anime Pseudo-3D (.ap3d) Zero-Dependency Browser Binary Codec
 *
 * Byte-compatible with `toolkit/ap3d_format.py`.
 * Works completely offline over file:// with zero external ZIP/compression libraries.
 *
 * Binary Header (24 bytes, little-endian):
 *   [0..4)   ASCII "AP3D"
 *   [4..6)   uint16 version (1)
 *   [6..8)   uint16 flags (0)
 *   [8..12)  uint32 manifestLen (UTF-8 JSON scene config)
 *   [12..16) uint32 tocLen (UTF-8 JSON [{k, m, o, s}, ...])
 *   [16..24) uint64 payloadLen (low uint32 + high uint32)
 */
(function (global) {
  "use strict";

  const MAGIC = [0x41, 0x50, 0x33, 0x44]; // "AP3D"
  const VERSION = 1;
  const HEADER_SIZE = 24;

  const textEnc = new TextEncoder();
  const textDec = new TextDecoder("utf-8");

  function dataUriToBytes(uri) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("Invalid data URI");
    const head = uri.slice(5, comma);
    const semi = head.indexOf(";");
    const mime = semi >= 0 ? head.slice(0, semi) : (head || "application/octet-stream");
    const b64 = uri.slice(comma + 1);
    const binStr = atob(b64);
    const out = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      out[i] = binStr.charCodeAt(i);
    }
    return { mime, bytes: out };
  }

  async function assetSrcToBytes(src) {
    if (typeof src !== "string") {
      throw new Error("Asset source must be a data URI or Blob/Object URL");
    }
    if (src.startsWith("data:")) {
      return dataUriToBytes(src);
    }
    const resp = await fetch(src);
    const buf = await resp.arrayBuffer();
    const mime = resp.headers.get("content-type") || "application/octet-stream";
    return { mime, bytes: new Uint8Array(buf) };
  }

  async function encode(sceneConfig, assetMap) {
    const cleanCfg = {};
    for (const k of Object.keys(sceneConfig || {})) {
      if (k !== "assets") cleanCfg[k] = sceneConfig[k];
    }
    const manifestBytes = textEnc.encode(JSON.stringify(cleanCfg));

    const keys = Object.keys(assetMap || {}).sort();
    const toc = [];
    const chunks = [];
    let offset = 0;
    for (const k of keys) {
      const { mime, bytes } = await assetSrcToBytes(assetMap[k]);
      toc.push({ k, m: mime, o: offset, s: bytes.byteLength });
      chunks.push(bytes);
      offset += bytes.byteLength;
    }
    const tocBytes = textEnc.encode(JSON.stringify(toc));

    const totalLen = HEADER_SIZE + manifestBytes.byteLength + tocBytes.byteLength + offset;
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);
    out[0] = MAGIC[0];
    out[1] = MAGIC[1];
    out[2] = MAGIC[2];
    out[3] = MAGIC[3];
    dv.setUint16(4, VERSION, true);
    dv.setUint16(6, 0, true);
    dv.setUint32(8, manifestBytes.byteLength, true);
    dv.setUint32(12, tocBytes.byteLength, true);
    dv.setUint32(16, offset >>> 0, true);
    dv.setUint32(20, Math.floor(offset / 4294967296) >>> 0, true);

    let cursor = HEADER_SIZE;
    out.set(manifestBytes, cursor);
    cursor += manifestBytes.byteLength;
    out.set(tocBytes, cursor);
    cursor += tocBytes.byteLength;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  }

  function decode(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (bytes.byteLength < HEADER_SIZE) {
      throw new Error("Invalid .ap3d file: header truncated");
    }
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
      // Optional JSON fallback if user dropped an uncompressed JSON bundle
      const firstChar = String.fromCharCode(bytes[0]).trim();
      if (firstChar === "{") {
        const parsed = JSON.parse(textDec.decode(bytes));
        return {
          sceneConfig: parsed.sceneConfig || parsed,
          assets: parsed.assets || {},
          objectUrls: [],
        };
      }
      throw new Error("Invalid .ap3d file: bad magic header (expected AP3D)");
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint16(4, true);
    if (version !== VERSION) {
      throw new Error(`Unsupported .ap3d version: ${version}`);
    }
    const manifestLen = dv.getUint32(8, true);
    const tocLen = dv.getUint32(12, true);
    const payloadLo = dv.getUint32(16, true);
    const payloadHi = dv.getUint32(20, true);
    const payloadLen = payloadLo + payloadHi * 4294967296;

    const pManifest = HEADER_SIZE;
    const pToc = pManifest + manifestLen;
    const pPayload = pToc + tocLen;
    if (pPayload + payloadLen > bytes.byteLength) {
      throw new Error("Invalid .ap3d file: payload truncated");
    }

    const sceneConfig = JSON.parse(textDec.decode(bytes.subarray(pManifest, pToc)));
    const toc = JSON.parse(textDec.decode(bytes.subarray(pToc, pPayload)));
    const assets = {};
    const objectUrls = [];
    for (const entry of toc) {
      const slice = bytes.subarray(pPayload + entry.o, pPayload + entry.o + entry.s);
      const blob = new Blob([slice], { type: entry.m || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      assets[entry.k] = url;
      objectUrls.push(url);
    }
    return { sceneConfig, assets, objectUrls };
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "character.ap3d";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function slugifyFilename(title) {
    const clean = String(title || "anime_character")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return (clean || "anime_character") + ".ap3d";
  }

  global.AP3DCodec = {
    VERSION,
    encode,
    decode,
    downloadBytes,
    slugifyFilename,
  };
})(window);
