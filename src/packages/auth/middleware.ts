import type { NextFunction, Request, Response } from 'express';
import { getEnv } from '../../env.js';
import { decodeJwt, session } from './functions.js';

export const auth = async (req: Request, res: Response, next: NextFunction) => {
  const authorizationHeader = req.get('authorization');
  const response = await session(authorizationHeader);

  if (response.success) {
    next();
  } else {
    res.status(401).send({ message: 'Unauthorized', success: false });
  }
};

// Only permits `aerie_admin` users
export const adminOnlyAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authorizationHeader = req.get('authorization');
  const response = await session(authorizationHeader);

  if (response.success) {
    const { jwtPayload } = await decodeJwt(authorizationHeader);
    if (jwtPayload == null) {
      res.status(401).send({ message: 'No authorization headers present.' });
      return;
    }

    const { JWT_CLAIMS } = getEnv();
    const namespace = jwtPayload[JWT_CLAIMS.namespace] as Record<string, string | string[]>;
    if (!namespace) {
      res.status(401).send({ message: `JWT missing claims namespace: ${JWT_CLAIMS.namespace}` });
      return;
    }

    const defaultRole = namespace[JWT_CLAIMS.defaultRole] as string;
    const allowedRoles = namespace[JWT_CLAIMS.allowedRoles] as string[];

    const { headers } = req;
    const { 'x-hasura-role': role } = headers;

    if (role != undefined) {
      if (!allowedRoles.includes(role as string)) {
        res.status(401).send({ message: 'Declared role is not in allowed roles.' });
        return;
      }
      if (role != 'aerie_admin') {
        res.status(403).send({ message: 'Current active role is unauthorized.' });
        return;
      }
    } else if (defaultRole != 'aerie_admin') {
      res.status(403).send({ message: 'Current active role is unauthorized.' });
      return;
    }
    next();
  } else {
    res.status(401).send({ message: 'Unauthorized', success: false });
  }
};
