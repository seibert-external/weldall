"""Protocol constants pinned to the authoritative TypeScript SDK."""

TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag"
REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token"
JWT_DPOP_GRANT = "urn:ietf:params:oauth:grant-type:jwt-dpop"
ID_JAG_DRAFT = "draft-ietf-oauth-identity-assertion-authz-grant-04"
JWT_DPOP_DRAFT = "draft-parecki-oauth-jwt-dpop-grant-01"
DPOP_MAX_AGE_SECONDS = 60
DPOP_FUTURE_SKEW_SECONDS = 5
PRIVATE_KEY_JWT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
MACHINE_TOKEN_TYP = "weldall-machine+jwt"
MACHINE_TOKEN_LIFETIME_SECONDS = 300
SKILL_CATALOG_SCHEMA_VERSION = 1
SKILL_CATALOG_PATH = "/.well-known/weldall-skills"
SKILL_ASSERTION_TYPE = "weldall-skills+jwt"
SKILL_TAG_LIMIT = 20
SKILL_TAG_LENGTH_LIMIT = 40
