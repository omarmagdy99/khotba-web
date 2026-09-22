// أوقاف 15 مايو — التشفير والهاش
//
// خوارزمية SHA-256 مكتوبة يدوياً وبشكل متزامن (Synchronous) لتفادي نداءات
// crypto.subtle غير المتزامنة التي تستنزف حد الـ CPU (10ms) على Cloudflare Workers.
//
// الخوارزمية مطابقة 100% لمخرجات Utilities.computeDigest في Apps Script و Node:crypto.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const ENC = new TextEncoder();

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

function digest(data) {
  const len = data.length;
  const total = (((len + 9) + 63) & ~63);
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;

  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7];
}

/**
 * SHA-256 لنص UTF-8 → سلسلة hex بحروف صغيرة
 */
export function sha256Hex(s) {
  const words = digest(ENC.encode(String(s)));
  let out = '';
  for (let i = 0; i < 8; i++) {
    const w = words[i];
    out += HEX[(w >>> 24) & 255] + HEX[(w >>> 16) & 255] +
           HEX[(w >>> 8) & 255] + HEX[w & 255];
  }
  return out;
}

/**
 * مطابقة تامة لخوارزمية Apps Script الأصلية:
 * sha256(salt + password)
 * مع دعم اختياري لـ PEPPER إن وجد في env.
 */
export function hashPassword(password, salt, pepper) {
  const secret = pepper ? String(pepper) : '';
  return sha256Hex(String(salt) + String(password) + secret);
}

export const PBKDF2_ITERATIONS = 10000;

/**
 * هاش PBKDF2-HMAC-SHA256 عبر Web Crypto API (crypto.subtle)
 * الصيغة المحفوظة: pbkdf2$<iterations>$<hex>
 */
export async function hashPasswordPbkdf2(password, salt, iterations = PBKDF2_ITERATIONS, pepper = '') {
  const secret = pepper ? String(pepper) : '';
  const pwData = ENC.encode(String(password) + secret);
  const saltData = ENC.encode(String(salt));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pwData,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltData,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256 // 32 bytes
  );

  const bytes = new Uint8Array(derivedBits);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX[bytes[i]];
  }
  return `pbkdf2$${iterations}$${hex}`;
}

/**
 * التحقق المزدوج من كلمة المرور مع مقارنة ثابتة الزمن
 * إذا كان الهاش المخزن بصيغة pbkdf2$ يتم التحقق بـ PBKDF2 بعدد التكرارات المسجل فيه
 * غير ذلك يتم التحقق بالهاش القديم sha256 مع إشارة الترقية needsUpgrade
 */
export async function verifyPassword(password, salt, storedHash, pepper = '') {
  const stored = String(storedHash || '');
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    const iterations = parseInt(parts[1], 10);
    if (!iterations || isNaN(iterations)) {
      return { valid: false, needsUpgrade: false };
    }
    const computed = await hashPasswordPbkdf2(password, salt, iterations, pepper);
    const valid = timingSafeEqual(computed, stored);
    return { valid, needsUpgrade: false };
  }

  // المسار القديم: SHA-256
  const computed = hashPassword(password, salt, pepper);
  const valid = timingSafeEqual(computed, stored);
  return { valid, needsUpgrade: valid };
}

/**
 * مقارنة ثابتة الزمن لمنع هجمات التوقيت
 */
export function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * توليد سلسلة عشوائية من الـ Hex
 * 16 بايت = 32 حرف للـ salt
 * 32 بايت = 64 حرف للتوكن
 */
export function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
}
