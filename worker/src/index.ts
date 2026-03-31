import type { WorkerEnv } from "./proxy";
import { proxyRequest } from "./proxy";

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return proxyRequest(request, env, fetch);
  }
};
