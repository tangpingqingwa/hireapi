import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { HireError } from "../../core/errors.js";
import { searchIngestedJobs } from "../../core/search.js";
import type { JobSummary } from "../../types.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const SEARCH_PATH = "/v1/search" as const;

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: {
      q?: string;
      location?: string;
      source?: string;
      remote?: string;
      cursor?: string;
    };
  }>(SEARCH_PATH, { preHandler: requireAuth }, async (request, reply) => {
    const key = request.apiKey;
    if (key === undefined) {
      return sendErr(reply, "internal", "Authenticated route missing key.");
    }
    const started = Date.now();
    try {
      const page = searchIngestedJobs(request.server.db, request.query);
      const credits = page.jobs.length;
      if (credits > 0) {
        if (key.credits < credits) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        const charged = tryChargeOrPaymentRequired(request.server.db, key, credits, SEARCH_PATH);
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
      }
      const data: JobSummary[] = page.jobs.map((row) => ({
        ...row,
        hasFullDescription: false,
      }));
      return sendOk(reply, data, {
        cached: false,
        creditsCharged: credits,
        upstreamMs: Date.now() - started,
      });
    } catch (err) {
      if (err instanceof HireError) {
        return sendErr(reply, err.code, err.message);
      }
      throw err;
    }
  });
};
