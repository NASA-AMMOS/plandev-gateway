import type { Express } from 'express';
import { adminOnlyAuth } from '../auth/middleware.js';
import rateLimit from 'express-rate-limit';
import getLogger from '../../logger.js';
import { getEnv } from '../../env.js';
import { generateJwt, decodeJwt } from '../auth/functions.js';

export default (app: Express) => {
  const logger = getLogger('packages/hasura/hasura-events');
  const { RATE_LIMITER_LOGIN_MAX } = getEnv();

  const refreshLimiter = rateLimit({
    legacyHeaders: false,
    max: RATE_LIMITER_LOGIN_MAX,
    standardHeaders: true,
    windowMs: 15 * 60 * 1000, // 15 minutes
  });

  /**
   * @swagger
   * /modelExtraction:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - application/json
   *     produces:
   *       - application/json
   *     parameters:
   *      - in: header
   *        name: x-hasura-role
   *        schema:
   *          type: string
   *          required: false
   *     requestBody:
   *       content:
   *         application/json:
   *          schema:
   *            type: object
   *            properties:
   *              missionModelId:
   *                type: integer
   *     responses:
   *       200:
   *         description: ExtractionResponse
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Request extraction of a Mission Model's JAR
   *     tags:
   *       - Hasura
   */
  app.post('/modelExtraction', refreshLimiter, adminOnlyAuth, async (req, res) => {
    const { jwtPayload } = await decodeJwt(req.get('authorization'));
    const username = jwtPayload?.username as string;

    const { body } = req;
    const { missionModelId } = body;

    // Invoke endpoints using the Hasura Metadata API
    const { HASURA_API_URL: metadataURL } = getEnv();

    // Generate a temporary token that has Hasura Admin access
    const tempToken = generateJwt(username, 'admin', ['admin'], '10s');

    const headers = {
      Authorization: `Bearer ${tempToken}`,
      'Content-Type': 'application/json',
      'x-hasura-role': 'admin',
      'x-hasura-user-id': username,
    };

    const generateBody = (name: string) =>
      JSON.stringify({
        args: {
          name: `refresh${name}`,
          payload: { id: missionModelId },
          source: 'PlanDev',
        },
        type: 'pg_invoke_event_trigger',
      });

    const extract = async (name: string) => {
      return await fetch(`${metadataURL}/v1/metadata`, {
        body: generateBody(name),
        headers,
        method: 'POST',
      })
        .then(response => {
          if (!response.ok) {
            logger.error(`Bad status received when extracting ${name}: [${response.status}] ${response.statusText}`);
            return {
              error: `Bad status received when extracting ${name}: [${response.status}] ${response.statusText}`,
              status: response.status,
              statusText: response.statusText,
            };
          }
          return response.json();
        })
        .catch(error => {
          logger.error(`Error connecting to Hasura metadata API at ${metadataURL}. Full error below:\n${error}`);
          return { error: `Error connecting to metadata API at ${metadataURL}` };
        });
    };

    const [activityTypeResp, modelParameterResp, resourceTypeResp] = await Promise.all([
      extract('ActivityTypes'),
      extract('ModelParameters'),
      extract('ResourceTypes'),
    ]);

    logger.info(`POST /modelExtraction: Extraction triggered for model: ${missionModelId}`);

    res.json({
      message: `Extraction triggered for model: ${missionModelId}`,
      response: {
        activity_types: activityTypeResp,
        model_parameters: modelParameterResp,
        resource_types: resourceTypeResp,
      },
    });
  });
};
