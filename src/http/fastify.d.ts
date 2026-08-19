import type { Key } from "../billing/keys.js";
import type { HireApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: HireApiDb;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
