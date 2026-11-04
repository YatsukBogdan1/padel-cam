import type { Env } from './types';

export type Params = Record<string, string>;
export type RouteHandler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Params,
) => Response | Promise<Response>;

interface Route {
  method: string;
  parts: string[];
  handler: RouteHandler;
}

/** Minimal method + `/a/:b/c` path router. Returns null when nothing matches. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, parts: split(pattern), handler });
    return this;
  }

  get(p: string, h: RouteHandler): this {
    return this.add('GET', p, h);
  }
  post(p: string, h: RouteHandler): this {
    return this.add('POST', p, h);
  }
  put(p: string, h: RouteHandler): this {
    return this.add('PUT', p, h);
  }
  patch(p: string, h: RouteHandler): this {
    return this.add('PATCH', p, h);
  }
  delete(p: string, h: RouteHandler): this {
    return this.add('DELETE', p, h);
  }

  async handle(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response | null> {
    const segs = split(new URL(req.url).pathname);
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.parts.length !== segs.length) continue;
      const params: Params = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i]!;
        const seg = segs[i]!;
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(seg);
        } else if (part !== seg) {
          matched = false;
          break;
        }
      }
      if (matched) return route.handler(req, env, ctx, params);
    }
    return null;
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}
