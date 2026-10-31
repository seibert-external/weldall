package weldall

// Protocol constants, pinned to the TypeScript SDK (packages/sdk/src).
const (
	TokenExchangeGrant  = "urn:ietf:params:oauth:grant-type:token-exchange"
	IDJAGTokenType      = "urn:ietf:params:oauth:token-type:id-jag"
	RefreshTokenType    = "urn:ietf:params:oauth:token-type:refresh_token"
	JWTDPoPGrant        = "urn:ietf:params:oauth:grant-type:jwt-dpop"
	IDJAGDraft          = "draft-ietf-oauth-identity-assertion-authz-grant-04"
	JWTDPoPDraft        = "draft-parecki-oauth-jwt-dpop-grant-01"
	DPoPMaxAgeSeconds   = 60
	DPoPFutureSkewSecs  = 5
	PrivateKeyJWTType   = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
	MachineTokenTyp     = "weldall-machine+jwt"
	MachineTokenSeconds = 300

	accessTokenTyp      = "at+jwt"
	dpopTyp             = "dpop+jwt"
	idJAGTyp            = "oauth-id-jag+jwt"
	userTokenSeconds    = 600
	idJAGSeconds        = 300
	clockToleranceSecs  = 5
	idJAGDraftClaim     = "urn:weldall:id-jag-draft"
	jwtDPoPDraftMetadat = "urn:weldall:jwt-dpop-draft"
)
