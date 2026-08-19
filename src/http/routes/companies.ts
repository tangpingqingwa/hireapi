import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { listCompanyJobs } from "../../core/companies.js";
import { HireError } from "../../core/errors.js";
import type { JobSummary } from "../../types.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const COMPANY_JOBS_PATH = "/v1/companies/:id/jobs" as const;

export const companiesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    COMPANY_JOBS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const started = Date.now();
      try {
        const page = listCompanyJobs(request.server.db, request.params.id);
        if (key.credits < 1) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          1,
          `/v1/companies/${request.params.id}/jobs`,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        const data: JobSummary[] = page.jobs.map((row) => ({
          ...row,
          hasFullDescription: false,
        }));
        return sendOk(reply, data, {
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
