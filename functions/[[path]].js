import {
  deleteRoute,
  getAdminCount,
  getRouteById,
  getRouteList,
  insertRoute,
  updateRoute,
} from "./_lib/db.js";
import { getCurrentSession, login, logout, requireAuth, setupInitialAdmin } from "./_lib/auth.js";
import { maybeHandleProxy } from "./_lib/proxy.js";
import { json, noContent, readJson, sanitizeRouteInput, text, withCors } from "./_lib/utils.js";

const SENSITIVE_STATIC_PATHS = new Set([
  "/wrangler.toml",
  "/package.json",
  "/package-lock.json",
  "/readme.md",
  "/.gitignore",
]);
const SENSITIVE_STATIC_PREFIXES = ["/migrations/", "/scripts/", "/.github/", "/functions/"];
const SETUP_TOKEN_ENV = "ADMIN_SETUP_TOKEN";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/admin") {
    return Response.redirect(`${url.origin}/admin/`, 301);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(context);
  }

  if (isBlockedStaticPath(url.pathname)) {
    return text("Not found.", { status: 404 });
  }

  const proxyResponse = await maybeHandleProxy(context);
  if (proxyResponse) return proxyResponse;

  if (request.method === "GET" || request.method === "HEAD") {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }
  }

  return json(
    {
      success: false,
      error: "No matching static asset or proxy route was found.",
    },
    { status: 404 },
  );
}

async function handleApi(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors(request) });
  }

  try {
    ensureDatabaseBinding(env);

    if (url.pathname === "/api/public/bootstrap" && method === "GET") {
      const initialized = (await getAdminCount(env.DB)) > 0;
      const session = initialized ? await getCurrentSession(env.DB, request) : null;
      const routes = initialized && session ? await getRouteList(env.DB) : [];
      return json(
        {
          success: true,
          initialized,
          session: session
            ? {
                username: session.username,
                expiresAt: session.expiresAt,
              }
            : null,
          stats: {
            totalRoutes: routes.length,
            enabledRoutes: routes.filter((route) => route.enabled).length,
          },
          setupTokenConfigured: initialized ? true : Boolean(env[SETUP_TOKEN_ENV]),
        },
        { headers: withCors(request) },
      );
    }

    if (url.pathname === "/api/auth/setup" && method === "POST") {
      await requireSameOrigin(request);
      const body = await readJson(request);
      requireSetupToken(env, body?.setupToken);
      const result = await setupInitialAdmin(env.DB, request, body?.username, body?.password);
      return json(
        {
          success: true,
          message: "Administrator account created.",
          session: result.session,
        },
        {
          status: 201,
          headers: {
            ...withCors(request),
            "set-cookie": result.cookie,
          },
        },
      );
    }

    if (url.pathname === "/api/auth/login" && method === "POST") {
      await requireSameOrigin(request);
      const body = await readJson(request);
      const result = await login(env.DB, request, body?.username, body?.password);
      return json(
        {
          success: true,
          message: "Signed in successfully.",
          session: result.session,
        },
        {
          headers: {
            ...withCors(request),
            "set-cookie": result.cookie,
          },
        },
      );
    }

    if (url.pathname === "/api/auth/logout" && method === "POST") {
      await requireSameOrigin(request);
      const cookie = await logout(env.DB, request);
      return noContent({
        ...withCors(request),
        "set-cookie": cookie,
      });
    }

    if (url.pathname === "/api/auth/session" && method === "GET") {
      const session = await getCurrentSession(env.DB, request);
      return json(
        {
          success: true,
          authenticated: Boolean(session),
          session: session
            ? {
                username: session.username,
                expiresAt: session.expiresAt,
              }
            : null,
        },
        { headers: withCors(request) },
      );
    }

    if (url.pathname === "/api/overview" && method === "GET") {
      const session = await requireAuth(env.DB, request);
      const routes = await getRouteList(env.DB);
      return json(
        {
          success: true,
          user: {
            username: session.username,
          },
          stats: {
            totalRoutes: routes.length,
            enabledRoutes: routes.filter((route) => route.enabled).length,
            disabledRoutes: routes.filter((route) => !route.enabled).length,
          },
          routes,
        },
        { headers: withCors(request) },
      );
    }

    if (url.pathname === "/api/routes" && method === "GET") {
      await requireAuth(env.DB, request);
      return json(
        {
          success: true,
          routes: await getRouteList(env.DB),
        },
        { headers: withCors(request) },
      );
    }

    if (url.pathname === "/api/routes" && method === "POST") {
      await requireSameOrigin(request);
      await requireAuth(env.DB, request);
      const body = await readJson(request);
      const route = sanitizeRouteInput(body);
      const id = await insertRoute(env.DB, route);
      const created = await getRouteById(env.DB, id);
      return json(
        {
          success: true,
          message: "Route created.",
          route: created,
        },
        {
          status: 201,
          headers: withCors(request),
        },
      );
    }

    const routeMatch = url.pathname.match(/^\/api\/routes\/(\d+)$/);
    if (routeMatch && method === "PUT") {
      await requireSameOrigin(request);
      await requireAuth(env.DB, request);
      const existing = await getRouteById(env.DB, Number(routeMatch[1]));
      if (!existing) {
        throw new Error("The route you want to update does not exist.");
      }
      const body = await readJson(request);
      const route = sanitizeRouteInput(body);
      await updateRoute(env.DB, Number(routeMatch[1]), route);
      const updated = await getRouteById(env.DB, Number(routeMatch[1]));
      return json(
        {
          success: true,
          message: "Route updated.",
          route: updated,
        },
        { headers: withCors(request) },
      );
    }

    if (routeMatch && method === "DELETE") {
      await requireSameOrigin(request);
      await requireAuth(env.DB, request);
      const existing = await getRouteById(env.DB, Number(routeMatch[1]));
      if (!existing) {
        throw new Error("The route you want to delete does not exist.");
      }
      await deleteRoute(env.DB, Number(routeMatch[1]));
      return noContent(withCors(request));
    }

    if (url.pathname === "/api/health" && method === "GET") {
      return json(
        {
          success: true,
          runtime: "cloudflare-pages",
          time: new Date().toISOString(),
        },
        { headers: withCors(request) },
      );
    }

    return json(
      {
        success: false,
        error: "Undefined API route.",
      },
      {
        status: 404,
        headers: withCors(request),
      },
    );
  } catch (error) {
    const message = error?.message || "Unknown error";
    const status = error?.status || (message === "UNAUTHORIZED" ? 401 : 400);
    return json(
      {
        success: false,
        error: message === "UNAUTHORIZED" ? "Please sign in to continue." : message,
      },
      {
        status,
        headers: withCors(request),
      },
    );
  }
}

async function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const current = new URL(request.url).origin;
  if (origin !== current) {
    throw httpError(403, "Cross-origin request rejected.");
  }
}

function ensureDatabaseBinding(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw httpError(500, "The D1 database binding named DB is missing from this Pages project.");
  }
}

function requireSetupToken(env, providedToken) {
  const expected = `${env?.[SETUP_TOKEN_ENV] || ""}`.trim();
  if (!expected) {
    throw httpError(503, `Initial setup is disabled until ${SETUP_TOKEN_ENV} is configured.`);
  }

  if (`${providedToken || ""}` !== expected) {
    throw httpError(403, "Invalid setup token.");
  }
}

function isBlockedStaticPath(pathname) {
  const normalized = pathname.toLowerCase();
  return SENSITIVE_STATIC_PATHS.has(normalized) || SENSITIVE_STATIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
