import { getEnabledRoutes } from "./db.js";
import { isRouteMatch, joinPaths, text, withCors } from "./utils.js";

const INTERNAL_DOCKER_AUTH_PATH = "/_gateway/docker-auth";
const INTERNAL_REALM_PARAM = "__gateway_realm";
const NPM_JSON_TYPES = ["application/json", "application/vnd.npm.install-v1+json"];

export async function maybeHandleProxy(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const routes = await getEnabledRoutes(env.DB);
  const match = resolveRouteMatch(routes, url.pathname);
  const route = match?.route;

  if (!route) {
    return null;
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: withCors(request, {
        "x-gateway-route": route.mount_path,
      }),
    });
  }

  try {
    const upstream = buildTargetUrl(url, route, match.requestBasePath);
    const upstreamRequest = new Request(upstream.toString(), {
      method: request.method,
      headers: rewriteRequestHeaders(request.headers, route, url),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const upstreamResponse = await fetch(upstreamRequest);
    return buildProxyResponse(upstreamResponse, route, url, upstream, request.method, match.requestBasePath);
  } catch (error) {
    return text(`Gateway upstream error: ${error.message || "unknown error"}`, {
      status: 502,
      headers: withCors(request),
    });
  }
}

function resolveRouteMatch(routes, pathname) {
  const direct = routes.find((item) => isRouteMatch(pathname, item.mount_path));
  if (direct) {
    return {
      route: direct,
      requestBasePath: direct.mount_path,
    };
  }

  if (isDockerRegistryRootPath(pathname)) {
    const dockerRoute = routes.find((item) => isDockerRegistryTarget(item));
    if (dockerRoute) {
      return {
        route: dockerRoute,
        requestBasePath: "",
      };
    }
  }

  return null;
}

function buildTargetUrl(incomingUrl, route, requestBasePath) {
  const dockerAuthUrl = buildDockerAuthUrl(incomingUrl, route, requestBasePath);
  if (dockerAuthUrl) {
    return dockerAuthUrl;
  }

  const target = new URL(route.target_base);
  const normalizedBasePath = requestBasePath || "";
  const remainder =
    route.strip_prefix && normalizedBasePath
      ? incomingUrl.pathname.slice(normalizedBasePath.length) || "/"
      : incomingUrl.pathname;
  target.pathname = joinPaths(target.pathname || "/", remainder || "/");
  target.search = incomingUrl.search;
  return target;
}

async function buildProxyResponse(upstreamResponse, route, incomingUrl, upstreamUrl, requestMethod, requestBasePath) {
  const headers = rewriteResponseHeaders(upstreamResponse.headers, route, incomingUrl, upstreamUrl, requestBasePath);

  if (shouldRewriteNpmMetadata(route, upstreamResponse, requestMethod)) {
    const body = await upstreamResponse.text();
    const nextBody = rewriteNpmMetadataBody(body, route, incomingUrl);
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(nextBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function rewriteRequestHeaders(sourceHeaders, route, incomingUrl) {
  const headers = new Headers(sourceHeaders);
  const removeHeaders = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-forwarded-host", "x-forwarded-proto"];

  for (const name of removeHeaders.concat(route.remove_headers || [])) {
    headers.delete(name);
  }

  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-gateway-route", route.mount_path);

  for (const [key, value] of Object.entries(route.inject_headers || {})) {
    headers.set(key, value);
  }

  return headers;
}

function rewriteResponseHeaders(sourceHeaders, route, incomingUrl, upstreamUrl, requestBasePath) {
  const headers = new Headers(sourceHeaders);
  headers.set("x-gateway-route", route.mount_path);
  headers.set("cache-control", headers.get("cache-control") || "no-store");

  const location = headers.get("location");
  if (location) {
    const rewritten = rewriteLocation(location, route, incomingUrl, upstreamUrl, requestBasePath);
    if (rewritten) headers.set("location", rewritten);
  }

  const authenticate = headers.get("www-authenticate");
  if (authenticate && isDockerRegistryTarget(route)) {
    headers.set("www-authenticate", rewriteDockerAuthenticateHeader(authenticate, route, incomingUrl, requestBasePath));
  }

  for (const [key, value] of Object.entries(withCors())) {
    headers.set(key, value);
  }
  return headers;
}

function rewriteLocation(location, route, incomingUrl, upstreamUrl, requestBasePath) {
  try {
    const resolved = new URL(location, upstreamUrl);
    if (resolved.origin !== upstreamUrl.origin) {
      return location;
    }
    const basePath = new URL(route.target_base).pathname.replace(/\/$/, "");
    const suffix = resolved.pathname.startsWith(basePath) ? resolved.pathname.slice(basePath.length) : resolved.pathname;
    const next = new URL(incomingUrl.toString());
    next.pathname = route.strip_prefix ? joinPaths(requestBasePath || "/", suffix || "/") : resolved.pathname;
    next.search = resolved.search;
    return next.toString();
  } catch {
    return location;
  }
}

function buildDockerAuthUrl(incomingUrl, route, requestBasePath) {
  const internalPath = joinPaths(requestBasePath || "/", INTERNAL_DOCKER_AUTH_PATH);
  if (incomingUrl.pathname !== internalPath) {
    return null;
  }

  const realm = normalizeDockerRealm(incomingUrl.searchParams.get(INTERNAL_REALM_PARAM), route);
  if (!realm) {
    throw new Error("docker auth realm is missing");
  }

  const target = new URL(realm);
  const params = new URLSearchParams(incomingUrl.search);
  params.delete(INTERNAL_REALM_PARAM);

  for (const [key, value] of params.entries()) {
    target.searchParams.append(key, value);
  }

  return target;
}

function rewriteDockerAuthenticateHeader(value, route, incomingUrl, requestBasePath) {
  return value.replace(/realm="([^"]+)"/i, (_match, realm) => {
    const localRealm = new URL(incomingUrl.origin);
    localRealm.pathname = joinPaths(requestBasePath || "/", INTERNAL_DOCKER_AUTH_PATH);
    localRealm.searchParams.set(INTERNAL_REALM_PARAM, normalizeDockerRealm(realm, route));
    return `realm="${localRealm.toString()}"`;
  });
}

function normalizeDockerRealm(rawRealm, route) {
  const fallback = defaultDockerRealm(route);
  if (!fallback) {
    return null;
  }

  const expected = new URL(fallback);
  const realm = new URL(rawRealm || fallback);

  if (realm.protocol !== "https:" || realm.hostname !== expected.hostname) {
    throw new Error("docker auth realm rejected");
  }

  return realm.toString();
}

function shouldRewriteNpmMetadata(route, upstreamResponse, requestMethod) {
  if (requestMethod !== "GET" || !isNpmRegistryTarget(route)) {
    return false;
  }

  const contentType = (upstreamResponse.headers.get("content-type") || "").toLowerCase();
  return NPM_JSON_TYPES.some((type) => contentType.includes(type));
}

function rewriteNpmMetadataBody(body, route, incomingUrl) {
  try {
    const parsed = JSON.parse(body);
    const rewritten = rewriteJsonUrls(parsed, (value) => rewriteUpstreamUrl(value, route, incomingUrl));
    return JSON.stringify(rewritten);
  } catch {
    return body;
  }
}

function rewriteJsonUrls(value, replacer) {
  if (typeof value === "string") {
    return replacer(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonUrls(item, replacer));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, rewriteJsonUrls(nested, replacer)]),
    );
  }

  return value;
}

function rewriteUpstreamUrl(rawValue, route, incomingUrl) {
  try {
    const targetBase = new URL(route.target_base);
    const url = new URL(rawValue);
    if (url.origin !== targetBase.origin) {
      return rawValue;
    }

    const basePath = targetBase.pathname.replace(/\/$/, "");
    if (basePath && !url.pathname.startsWith(basePath)) {
      return rawValue;
    }

    const suffix = basePath ? url.pathname.slice(basePath.length) || "/" : url.pathname;
    const gateway = new URL(incomingUrl.origin);
    gateway.pathname = route.strip_prefix ? joinPaths(route.mount_path, suffix || "/") : url.pathname;
    gateway.search = url.search;
    gateway.hash = url.hash;
    return gateway.toString();
  } catch {
    return rawValue;
  }
}

function isNpmRegistryTarget(route) {
  const host = new URL(route.target_base).hostname;
  return host === "registry.npmjs.org";
}

function isDockerRegistryTarget(route) {
  const host = new URL(route.target_base).hostname;
  return host === "registry-1.docker.io" || host === "registry.docker.io";
}

function isDockerRegistryRootPath(pathname) {
  return (
    pathname === "/v2" ||
    pathname.startsWith("/v2/") ||
    pathname === INTERNAL_DOCKER_AUTH_PATH ||
    pathname.startsWith(`${INTERNAL_DOCKER_AUTH_PATH}/`)
  );
}

function defaultDockerRealm(route) {
  return isDockerRegistryTarget(route) ? "https://auth.docker.io/token" : null;
}
