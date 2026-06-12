export type Handler = (req: string) => string;

export class Router {
  post(path: string, handler: Handler): void;
  post(path: RegExp, handler: Handler): void;
  post(path: string | RegExp, handler: Handler): void {
    void path;
    void handler;
  }
}
