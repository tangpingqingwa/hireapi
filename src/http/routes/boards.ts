import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { getBoardByUrl } from "../../core/boards.js";
import { HireError } from "../../core/errors.js";
import type { JobSummary } from "../../types.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const BOARDS_BY_URL_PATH = "/v1/boards/by-url" as const;

export const boardsRoutes: FastifyPluginAsync = async (app) => {
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
        const board = await getBoardByUrl(request.query.url ?? "", request.server.db);
        const open = board.jobs.filter((row) => !row.closed);
        const credits = open.length === 0 ? 0 : open.length;
        if (credits > 0) {
          if (key.credits < credits) {
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
        }
        const data: JobSummary[] = open.map((row) => ({
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
    },
  );
};
