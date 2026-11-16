package weldall

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// ReasonReplayDetected marks an AuthError raised because a one-time value
// (DPoP proof, ID-JAG, skills assertion) was presented a second time.
const ReasonReplayDetected = "replay_detected"

// AuthError is an OAuth protocol error. Code is the OAuth error code sent to
// the client, Status the HTTP status, and RequiredScopes the scopes named in
// the WWW-Authenticate header of an insufficient_scope response.
type AuthError struct {
	Code           string
	Message        string
	Status         int
	RequiredScopes []string
	Reason         string
}

func (e *AuthError) Error() string { return e.Code + ": " + e.Message }

func newAuthError(code, message string, status int) *AuthError {
	if message == "" {
		message = code
	}
	if status == 0 {
		status = http.StatusBadRequest
	}
	return &AuthError{Code: code, Message: message, Status: status}
}

// asAuthError reports whether err is (or wraps) an AuthError.
func asAuthError(err error) (*AuthError, bool) {
	var authErr *AuthError
	ok := errors.As(err, &authErr)
	return authErr, ok
}

// WriteOAuthError writes err as an OAuth error response. An error that is not
// an AuthError becomes a 500 server_error without exposing its message.
func WriteOAuthError(w http.ResponseWriter, err error) {
	status, header, body := oauthErrorResponse(err)
	for key, values := range header {
		w.Header()[key] = values
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func oauthErrorResponse(err error) (int, http.Header, []byte) {
	authErr, known := asAuthError(err)
	status, code, description := http.StatusInternalServerError, "server_error", "server error"
	if known {
		status, code, description = authErr.Status, authErr.Code, authErr.Message
	}
	header := http.Header{}
	header.Set("Cache-Control", "no-store")
	header.Set("Pragma", "no-cache")
	header.Set("Content-Type", "application/json")
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		value := `DPoP error="` + code + `"`
		if known && len(authErr.RequiredScopes) > 0 {
			value += `, scope="` + strings.Join(authErr.RequiredScopes, " ") + `"`
		}
		header.Set("WWW-Authenticate", value)
	}
	body, _ := json.Marshal(struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}{code, description})
	return status, header, body
}
