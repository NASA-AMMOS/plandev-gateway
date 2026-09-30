import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { getEnv } from './env.js';
import getLogger from './logger.js';
import initApiPlaygroundRoutes from './packages/api-playground/api-playground.js';
import { CAMAuthAdapter } from './packages/auth/adapters/CAMAuthAdapter.js';
import { NoAuthAdapter } from './packages/auth/adapters/NoAuthAdapter.js';
import { validateGroupRoleMappings } from './packages/auth/functions.js';
import initAuthRoutes from './packages/auth/routes.js';
import { DbMerlin } from './packages/db/db.js';
import initExpansionRoutes from './packages/expansion/expansion.js';
import initExternalSourceRoutes from './packages/external-source/external-source.js';
import initFileRoutes from './packages/files/files.js';
import initHasuraRoutes from './packages/hasura/hasura-events.js';
import initHealthRoutes from './packages/health/health.js';
import initPlanRoutes from './packages/plan/plan.js';
import initSwaggerRoutes from './packages/swagger/swagger.js';
import { AuthAdapter } from './types/auth.js';

async function main(): Promise<void> {
  const logger = getLogger('main');
  const { PORT, AUTH_TYPE } = getEnv();
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  await DbMerlin.init();

  let authHandler: AuthAdapter;
  switch (AUTH_TYPE) {
    case 'none':
      authHandler = NoAuthAdapter;
      break;
    case 'cam':
      validateGroupRoleMappings();
      authHandler = CAMAuthAdapter;
      break;
    default:
      throw new Error(`invalid auth type env var: ${AUTH_TYPE}`);
  }

  initApiPlaygroundRoutes(app);
  initAuthRoutes(app, authHandler);
  initExpansionRoutes(app);
  initFileRoutes(app);
  initHealthRoutes(app);
  initHasuraRoutes(app);
  initPlanRoutes(app);
  initExternalSourceRoutes(app);
  initSwaggerRoutes(app);

  app.listen(PORT, () => {
    logger.info(`🚀 PLANDEV-GATEWAY listening on ${PORT}`);
  });
}

main();
