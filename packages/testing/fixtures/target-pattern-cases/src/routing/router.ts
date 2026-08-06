export type Handler = (path: string) => string;

export class Router {
  post(path: string, handler: Handler): string;
  post(path: RegExp, handler: Handler): string;
  post(path: string | RegExp, handler: Handler): string {
    return handler(String(path));
  }
}
