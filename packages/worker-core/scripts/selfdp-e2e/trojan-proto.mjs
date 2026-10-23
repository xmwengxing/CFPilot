// src/protocols/address.ts
function formatIpv6(groups) {
  const hex = groups.map((g) => (g & 65535).toString(16));
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  let len = 0;
  for (let i = 0; i < hex.length; i++) {
    if (hex[i] === "0") {
      if (start < 0) start = i;
      len++;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
    } else {
      start = -1;
      len = 0;
    }
  }
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
function readAddress(bytes, offset, addressType, vlessStyle) {
  if (offset < 0 || offset >= bytes.length) return null;
  if (addressType === 1) {
    if (offset + 5 > bytes.length) return null;
    const hostname = `${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}.${bytes[offset + 4]}`;
    return { hostname, next: offset + 5 };
  }
  if (vlessStyle ? addressType === 2 : addressType === 3) {
    if (offset + 2 > bytes.length) return null;
    const len = bytes[offset + 1];
    if (offset + 2 + len > bytes.length) return null;
    const hostname = new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + len));
    return { hostname, next: offset + 2 + len };
  }
  if (vlessStyle ? addressType === 3 : addressType === 4) {
    if (offset + 17 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 16);
    const groups = [];
    for (let i = 0; i < 8; i++) groups.push(view.getUint16(i * 2, false));
    return { hostname: formatIpv6(groups), next: offset + 17 };
  }
  return null;
}
async function readAddressFromStream(stream, vlessStyle) {
  const typeOnly = await stream.peekExactly(1);
  if (!typeOnly) return null;
  const addressType = typeOnly[0];
  let total;
  if (addressType === 1) {
    total = 5;
  } else if (vlessStyle ? addressType === 2 : addressType === 3) {
    const head = await stream.peekExactly(2);
    if (!head) return null;
    total = 2 + head[1];
  } else if (vlessStyle ? addressType === 3 : addressType === 4) {
    total = 17;
  } else {
    return null;
  }
  const buf = await stream.peekExactly(total);
  if (!buf) return null;
  const parsed = readAddress(buf, 0, addressType, vlessStyle);
  if (!parsed) return null;
  stream.skip(total);
  return { hostname: parsed.hostname, addressType, consumed: total };
}

// src/protocols/sha224.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var HEX = "0123456789abcdef";
function rotr(x, n) {
  return x >>> n | x << 32 - n;
}
function sha224(input) {
  const h = new Uint32Array([
    3238371032,
    914150663,
    812702999,
    4144912697,
    4290775857,
    1750603025,
    1694076839,
    3204075428
  ]);
  const bitLen = input.length * 8;
  const padLen = Math.ceil((input.length + 9) / 64) * 64;
  const msg = new Uint8Array(padLen);
  msg.set(input);
  msg[input.length] = 128;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 4294967296), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const temp1 = hh + S1 + ch + K[i] + w[i] >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const temp2 = S0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  const out = new Uint8Array(28);
  for (let i = 0; i < 7; i++) {
    out[i * 4] = h[i] >>> 24 & 255;
    out[i * 4 + 1] = h[i] >>> 16 & 255;
    out[i * 4 + 2] = h[i] >>> 8 & 255;
    out[i * 4 + 3] = h[i] & 255;
  }
  return out;
}
function sha224Hex(input) {
  const digest = sha224(input);
  let out = "";
  for (const b of digest) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

// src/protocols/trojan.ts
var TROJAN_COMMAND_TCP = 1;
var TROJAN_COMMAND_UDP = 3;
function trojanPasswordHash(password) {
  return sha224Hex(new TextEncoder().encode(password));
}
function isCrLf(bytes) {
  return bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10;
}
async function parseTrojan(stream, expectedPassword) {
  const expectedHash = trojanPasswordHash(expectedPassword);
  const hashBytes = await stream.peekExactly(56);
  const provided = hashBytes ? new TextDecoder().decode(hashBytes).trim().toLowerCase() : "";
  if (provided === expectedHash) {
    stream.skip(56);
    const crlf1 = await stream.readExactly(2);
    if (!crlf1 || !isCrLf(crlf1)) return null;
  } else {
    const pwBytes = new TextEncoder().encode(expectedPassword);
    if (pwBytes.length === 0 || pwBytes.length > 56) return null;
    const peek = await stream.peekExactly(pwBytes.length + 2);
    if (!peek) return null;
    let matched = true;
    for (let i = 0; i < pwBytes.length; i++) {
      if (peek[i] !== pwBytes[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) return null;
    if (!isCrLf(peek.subarray(pwBytes.length, pwBytes.length + 2))) return null;
    stream.skip(pwBytes.length + 2);
  }
  const commandByte = await stream.readExactly(1);
  if (!commandByte) return null;
  const address = await readAddressFromStream(stream, false);
  if (!address) return null;
  const portBytes = await stream.readExactly(2);
  if (!portBytes) return null;
  const crlf2 = await stream.readExactly(2);
  if (!crlf2 || !isCrLf(crlf2)) return null;
  const port = portBytes[0] << 8 | portBytes[1];
  return {
    header: {
      command: commandByte[0],
      port,
      hostname: address.hostname,
      addressType: address.addressType
    },
    payload: stream.release()
  };
}
function parseTrojanBuffer(bytes, expectedPassword) {
  if (bytes.byteLength < 58) return null;
  const expectedHash = trojanPasswordHash(expectedPassword);
  const provided = new TextDecoder().decode(bytes.subarray(0, 56)).trim().toLowerCase();
  if (provided !== expectedHash) return null;
  if (bytes[56] !== 13 || bytes[57] !== 10) return null;
  let offset = 58;
  if (bytes.byteLength < offset + 2) return null;
  const command = bytes[offset];
  offset += 1;
  const addressType = bytes[offset];
  offset += 1;
  let hostname = "";
  if (addressType === 1) {
    if (bytes.byteLength < offset + 4) return null;
    hostname = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
    offset += 4;
  } else if (addressType === 3) {
    if (bytes.byteLength < offset + 1) return null;
    const len = bytes[offset];
    offset += 1;
    if (bytes.byteLength < offset + len) return null;
    hostname = new TextDecoder().decode(bytes.subarray(offset, offset + len));
    offset += len;
  } else if (addressType === 4) {
    if (bytes.byteLength < offset + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push((bytes[offset + i * 2] << 8 | bytes[offset + i * 2 + 1]).toString(16));
    hostname = parts.join(":");
    offset += 16;
  } else {
    return null;
  }
  if (bytes.byteLength < offset + 4) return null;
  const port = bytes[offset] << 8 | bytes[offset + 1];
  offset += 2;
  if (bytes[offset] !== 13 || bytes[offset + 1] !== 10) return null;
  offset += 2;
  return { header: { command, port, hostname, addressType }, consumed: offset };
}
export {
  TROJAN_COMMAND_TCP,
  TROJAN_COMMAND_UDP,
  parseTrojan,
  parseTrojanBuffer,
  trojanPasswordHash
};
