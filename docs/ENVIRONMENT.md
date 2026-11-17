# Environment

This document provides detailed information about environment variables for the gateway.

| Name                        | Description                                                                                           | Type     | Default                                        |
|-----------------------------|-------------------------------------------------------------------------------------------------------| -------- |------------------------------------------------|
| `ALLOWED_ROLES`             | Allowed roles when authentication is enabled.                                                         | `array`  | ["user", "viewer"]                             |
| `ALLOWED_ROLES_NO_AUTH`     | Allowed roles when authentication is disabled.                                                        | `array`  | ["aerie_admin", "user", "viewer"]              |
| `AUTH_GROUP_ROLE_MAPPINGS`  | JSON object that maps auth provider groups to PlanDev roles. See [SSO authentication docs][SSO authn] | `JSON`   | {}                                             |
| `AUTH_TYPE`                 | Mode of authentication. Set to `cam`, `sso2`, or `none`.      | `string` | none                                           |
| `AUTH_URL`                  | URL of Auth provider's REST API. Used if the given `AUTH_TYPE` is not set to `none`.                  | `string` | https://atb-ocio-12b.jpl.nasa.gov:8443/cam-api |
| `AUTH_UI_URL`               | URL of Auth provider's login UI. Returned to the UI if SSO token is invalid, so user is redirected    | `string` | https://atb-ocio-12b.jpl.nasa.gov:8443/cam-ui  |
| `AUTH_SSO_TOKEN_NAME`       | The name of the SSO tokens the Gateway should parse cookies for. Likely found in auth provider docs.  | `array`  | ["iPlanetDirectoryPro"]                        |
| `DEFAULT_ROLE`              | Default roles when authentication is enabled. See [SSO authorization docs][SSO authz] for details.    | `array`  | ["user"]                                       |
| `DEFAULT_ROLE_NO_AUTH`      | Default role when authentication is disabled.                                                         | `string` | aerie_admin                                    |
| `GQL_API_URL`               | URL of GraphQL API for the GraphQL Playground.                                                        | `string` | http://localhost:8080/v1/graphql               |
| `GQL_API_WS_URL`            | URL of GraphQL WebSocket API for the GraphQL Playground.                                              | `string` | ws://localhost:8080/v1/graphql                 |
| `HASURA_API_URL`            | URL of the base Hasura API.                                                                           | `string` | http://hasura:8080/                            |
| `HASURA_GRAPHQL_JWT_SECRET` | The JWT secret. Also in Hasura. **Required** even if auth off in Hasura.                              | `string` |                                                |
| `JWT_ALGORITHMS`            | List of [JWT signing algorithms][algorithms]. Must include algorithm in `HASURA_GRAPHQL_JWT_SECRET`.  | `array`  | ["HS256"]                                      |
| `JWT_EXPIRATION`            | Amount of time until JWT expires.                                                                     | `string` | 36h                                            |
| `LOG_FILE`                  | Either an output filepath to log to, or 'console'.                                                    | `string` | console                                        |
| `LOG_LEVEL`                 | Logging level for filtering logs.                                                                     | `string` | warn                                           |
| `PORT`                      | Port the Gateway server listens on.                                                                   | `number` | 9000                                           |
| `PLANDEV_DB`                | Name of the PlanDev Posgres Database.                                                                 | `string` | plandev                                        |
| `PLANDEV_DB_HOST`           | Hostname of the PlanDev Posgres Database.                                                             | `string` | localhost                                      |
| `PLANDEV_DB_PORT`           | Port of the PlanDev Posgres Database.                                                                 | `number` | 5432                                           |
| `GATEWAY_DB_USER`           | Username of the Gateway DB User.                                                                      | `string` |                                                |
| `GATEWAY_DB_PASSWORD`       | Password of the Gateway DB User.                                                                      | `string` |                                                |
| `RATE_LIMITER_FILES_MAX`    | Max requests allowed every 15 minutes to file endpoints                                               | `number` | 1000                                           |
| `RATE_LIMITER_LOGIN_MAX`    | Max requests allowed every 15 minutes to login endpoints                                              | `number` | 1000                                           |

[algorithms]: https://github.com/auth0/node-jsonwebtoken#algorithms-supported
[SSO authn]: https://nasa-ammos.github.io/plandev-docs/deployment/advanced-authentication
[SSO authz]: https://nasa-ammos.github.io/plandev-docs/deployment/advanced-permissions
