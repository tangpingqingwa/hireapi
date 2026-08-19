import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { getBoardByUrl, paginateSummaries } from "../../core/boards.js";
import { HireError } from "../../core/errors.js";
import { getJobByUrl } from "../../core/jobs.js";
import type { Job, JobSummary } from "../../types.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const JOBS_BY_URL_PATH = "/v1/jobs/by-url" as const;
export const BOARDS_BY_URL_PATH = "/v1/boards/by-url" as const;

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
        const job: Job = await getJobByUrl(request.query.url ?? "", undefined, request.server.db);
        const charged = tryChargeOrPaymentRequired(request.server.db, key, 1, JOBS_BY_URL_PATH);
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

  app.get<{ Querystring: { url?: string; cursor?: string } }>(
    BOARDS_BY_URL_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const started = Date.now();
      try {
        const summaries: JobSummary[] = await getBoardByUrl(
          request.query.url ?? "",
          request.server.db,
        );
        const page = paginateSummaries(summaries, request.query.cursor);
        const openCount = page.jobs.filter((job) => !job.closed).length;
        const credits = openCount > 0 ? Math.max(1, openCount) : 0;
        if (credits > 0 && key.credits < credits) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          credits,
          BOARDS_BY_URL_PATH,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, page.jobs, {
          cached: false,
          creditsCharged: credits,
          upstreamMs: Date.now() - started,
          nextCursor: page.nextCursor,
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
