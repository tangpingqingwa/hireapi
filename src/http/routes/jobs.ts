import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { HireError } from "../../core/errors.js";
import { getJobByUrl } from "../../core/jobs.js";
import type { Job } from "../../types.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const JOBS_BY_URL_PATH = "/v1/jobs/by-url" as const;

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { url?: string } }>(
    JOBS_BY_URL_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const started = Date.now();
      try {
        if (key.credits < 1) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        const job: Job = await getJobByUrl(request.query.url ?? "", {
          db: request.server.db,
        });
        const charged = tryChargeOrPaymentRequired(request.server.db, key, 1);
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, job, {
          cached: false,
          creditsCharged: 1,
          upstreamMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof HireError) {
          return sendErr(reply, err.code, err.message);
        }
        throw err;
      }
    },
  );
};
