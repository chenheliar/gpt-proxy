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
import { json, noContent, readJson, sanitizeRouteInput, withCors } from "./_lib/utils.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/admin") {
    return Response.redirect(`${url.origin}/admin/`, 301);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(context);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }
  }

  const proxyResponse = await maybeHandleProxy(context);
  if (proxyResponse) return proxyResponse;

  if (request.method === "GET" || request.method === "HEAD") {
    const fallback = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    if (fallback.status !== 404) return fallback;
  }

  return json(
    {
      success: false,
      error: "未找到对应的静态资源或代理路由。",
    },
    { status: 404 },
  );
}

async function handleApi(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
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
        },
        { headers: withCors() },
      );
    }

    if (url.pathname === "/api/auth/setup" && method === "POST") {
      await requireSameOrigin(request);
      const body = await readJson(request);
      const result = await setupInitialAdmin(env.DB, request, body?.username, body?.password);
      return json(
        {
          success: true,
          message: "管理员账户已创建。",
          session: result.session,
        },
        {
          status: 201,
          headers: {
            ...withCors(),
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
          message: "登录成功。",
          session: result.session,
        },
        {
          headers: {
            ...withCors(),
            "set-cookie": result.cookie,
          },
        },
      );
    }

    if (url.pathname === "/api/auth/logout" && method === "POST") {
      await requireSameOrigin(request);
      const cookie = await logout(env.DB, request);
      return noContent({
        ...withCors(),
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
        { headers: withCors() },
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
        { headers: withCors() },
      );
    }

    if (url.pathname === "/api/routes" && method === "GET") {
      await requireAuth(env.DB, request);
      return json(
        {
          success: true,
          routes: await getRouteList(env.DB),
        },
        { headers: withCors() },
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
          message: "路由已创建。",
          route: created,
        },
        {
          status: 201,
          headers: withCors(),
        },
      );
    }

    const routeMatch = url.pathname.match(/^\/api\/routes\/(\d+)$/);
    if (routeMatch && method === "PUT") {
      await requireSameOrigin(request);
      await requireAuth(env.DB, request);
      const existing = await getRouteById(env.DB, Number(routeMatch[1]));
      if (!existing) {
        throw new Error("要更新的路由不存在。");
      }
      const body = await readJson(request);
      const route = sanitizeRouteInput(body);
      await updateRoute(env.DB, Number(routeMatch[1]), route);
      const updated = await getRouteById(env.DB, Number(routeMatch[1]));
      return json(
        {
          success: true,
          message: "路由已更新。",
          route: updated,
        },
        { headers: withCors() },
      );
    }

    if (routeMatch && method === "DELETE") {
      await requireSameOrigin(request);
      await requireAuth(env.DB, request);
      const existing = await getRouteById(env.DB, Number(routeMatch[1]));
      if (!existing) {
        throw new Error("要删除的路由不存在。");
      }
      await deleteRoute(env.DB, Number(routeMatch[1]));
      return noContent(withCors());
    }

    if (url.pathname === "/api/health" && method === "GET") {
      return json(
        {
          success: true,
          runtime: "cloudflare-pages",
          time: new Date().toISOString(),
        },
        { headers: withCors() },
      );
    }

    return json(
      {
        success: false,
        error: "未定义的 API 路由。",
      },
      {
        status: 404,
        headers: withCors(),
      },
    );
  } catch (error) {
    const message = error?.message || "未知错误";
    const status = message === "UNAUTHORIZED" ? 401 : 400;
    return json(
      {
        success: false,
        error: message === "UNAUTHORIZED" ? "请先登录管理后台。" : message,
      },
      {
        status,
        headers: withCors(),
      },
    );
  }
}

async function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const current = new URL(request.url).origin;
  if (origin !== current) {
    throw new Error("非法来源请求。");
  }
}

function ensureDatabaseBinding(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    throw new Error("D1 数据库尚未绑定，请先在 Cloudflare Pages 项目中绑定变量名为 DB 的 D1 数据库。");
  }
}
