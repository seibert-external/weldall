// Package weldall protects a Go HTTP service with Weldall and calls other
// Weldall-protected services as a machine.
//
// It follows the same protocol as the TypeScript @weldall/sdk, which is the
// behaviour reference: configuration validation, ID-JAG token exchange,
// DPoP-bound user (at+jwt) and machine (weldall-machine+jwt) access tokens,
// strict DPoP proofs with replay protection, Weldall discovery with JWKS
// rotation, scope policy, and the OAuth metadata, JWKS and skill catalog
// endpoints.
//
// A resource creates one Weldall at startup with New, mounts the protocol
// routes with RegisterRoutes, and wraps its own handlers with Protect. A
// machine client obtains a token with RequestMachineToken and signs each
// call with CreateDPoPProof.
package weldall
