const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const DISALLOWED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"];

export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: withSecurityHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    }),
  });
}

export function text(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: withSecurityHeaders({
      "content-type": "text/plain; charset=utf-8",
      ...(init.headers || {}),
    }),
  });
}

export function noContent(headers = {}) {
  return new Response(null, {
    status: 204,
    headers: withSecurityHeaders(headers),
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function normalizeMountPath(value) {
  if (!value) return "";
  let normalized = value.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function normalizeTargetBase(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https upstream URLs are supported.");
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  url.hash = "";
  validatePublicUpstreamHost(url);
  return url.toString();
}

export function sanitizeRouteInput(payload) {
  const name = `${payload?.name || ""}`.trim();
  const description = `${payload?.description || ""}`.trim();
  const mountPath = normalizeMountPath(`${payload?.mountPath || ""}`);
  const targetBase = normalizeTargetBase(`${payload?.targetBase || ""}`);
  const stripPrefix = payload?.stripPrefix === false ? 0 : 1;
  const enabled = payload?.enabled === false ? 0 : 1;
  const injectHeaders = normalizeJsonObject(payload?.injectHeaders, "Injected request headers");
  const removeHeaders = normalizeJsonArray(payload?.removeHeaders, "Removed request headers");

  validateRouteName(name);
  validateMountPath(mountPath);

  return {
    name,
    description: description || null,
    mountPath,
    targetBase,
    stripPrefix,
    enabled,
    injectHeaders: JSON.stringify(injectHeaders),
    removeHeaders: JSON.stringify(removeHeaders),
  };
}

function validateRouteName(name) {
  if (!name || name.length < 2) {
    throw new Error("Route name must be at least 2 characters.");
  }
  if (name.length > 80) {
    throw new Error("Route name must not exceed 80 characters.");
  }
}

function validateMountPath(mountPath) {
  const reserved = ["/admin", "/api", "/functions", "/assets", "/favicon.ico"];
  if (!mountPath || mountPath === "/") {
    throw new Error("Mount path cannot be empty and cannot use the root path.");
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(mountPath)) {
    throw new Error("Mount path contains unsupported characters.");
  }
  if (reserved.some((item) => mountPath === item || mountPath.startsWith(`${item}/`))) {
    throw new Error("Mount path conflicts with a reserved system path.");
  }
}

function normalizeJsonObject(value, label) {
  if (value == null || value === "") return {};
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (Object.prototype.toString.call(parsed) !== "[object Object]") {
    throw new Error(`${label} must be a JSON object.`);
  }
  const normalized = {};
  for (const [key, raw] of Object.entries(parsed)) {
    const header = `${key}`.trim();
    if (!header) continue;
    normalized[header] = `${raw}`;
  }
  return normalized;
}

function normalizeJsonArray(value, label) {
  if (value == null || value === "") return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed.map((item) => `${item}`.trim()).filter(Boolean);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return base64Url(bytes);
}

export async function hashPassword(password, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const separator = chunk.indexOf("=");
        if (separator === -1) return [chunk, ""];
        return [chunk.slice(0, separator), decodeURIComponent(chunk.slice(separator + 1))];
      }),
  );
}

export function buildCookie(name, value, request, maxAge = 60 * 60 * 24 * 7) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) segments.push("Secure");
  return segments.join("; ");
}

export function clearCookie(name, request) {
  return buildCookie(name, "", request, 0);
}

export function sessionCookieName(request) {
  return new URL(request.url).protocol === "https:" ? "__Host-gateway_session" : "gateway_session";
}

export function joinPaths(basePath, appendPath) {
  const left = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const right = appendPath.startsWith("/") ? appendPath : `/${appendPath}`;
  const joined = `${left}${right}`.replace(/\/{2,}/g, "/");
  return joined || "/";
}

export function withCors(headers = {}) {
  const [request, inputHeaders = {}, options = {}] =
    headers instanceof Request
      ? [headers, arguments[1] || {}, arguments[2] || {}]
      : [null, headers || {}, arguments[1] || {}];

  const next = new Headers(withSecurityHeaders(inputHeaders));
  const origin = request?.headers?.get("origin");

  if (!origin) {
    return Object.fromEntries(next.entries());
  }

  const currentOrigin = new URL(request.url).origin;
  const allowedOrigins = new Set([currentOrigin, ...(options.allowedOrigins || [])]);

  if (options.allowAnyOrigin === true) {
    next.set("access-control-allow-origin", "*");
  } else if (allowedOrigins.has(origin)) {
    next.set("access-control-allow-origin", origin);
    next.set("vary", appendVary(next.get("vary"), "Origin"));
  } else {
    return Object.fromEntries(next.entries());
  }

  next.set("access-control-allow-headers", "Content-Type");
  next.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  next.set("access-control-expose-headers", "Content-Type, Cache-Control, X-Gateway-Route");
  return Object.fromEntries(next.entries());
}

export function isRouteMatch(pathname, mountPath) {
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`);
}

export function formatRouteRow(row) {
  return {
    ...row,
    strip_prefix: Boolean(row.strip_prefix),
    enabled: Boolean(row.enabled),
    inject_headers: safeJsonParse(row.inject_headers, {}),
    remove_headers: safeJsonParse(row.remove_headers, []),
  };
}

export function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function withSecurityHeaders(headers = {}) {
  const next = new Headers(headers);
  if (!next.has("x-content-type-options")) next.set("x-content-type-options", "nosniff");
  if (!next.has("referrer-policy")) next.set("referrer-policy", "same-origin");
  if (!next.has("x-frame-options")) next.set("x-frame-options", "DENY");
  if (!next.has("permissions-policy")) {
    next.set(
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  }
  return Object.fromEntries(next.entries());
}

function appendVary(current, value) {
  if (!current) return value;
  const parts = current
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.includes(value)) parts.push(value);
  return parts.join(", ");
}

function validatePublicUpstreamHost(url) {
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("Upstream hostname is missing.");
  }

  if (hostname === "localhost" || DISALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Local or internal upstream addresses are not allowed.");
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new Error("Private or loopback upstream addresses are not allowed.");
  }
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}
