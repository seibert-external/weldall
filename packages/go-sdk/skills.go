package weldall

import (
	"context"
	"regexp"
)

// Skill catalog constants, pinned to packages/sdk/src/skills.ts.
const (
	SkillCatalogSchemaVersion = 1
	SkillCatalogPath          = "/.well-known/weldall-skills"
	SkillAssertionType        = "weldall-skills+jwt"
	SkillTagLimit             = 20
	SkillTagLengthLimit       = 40

	SkillVisibilityDefault           = "DEFAULT"
	SkillVisibilityHiddenIfUnallowed = "HIDDEN_IF_UNALLOWED"

	maxSkillCatalogBytes = 1_048_576
)

// SkillMeta is optional presentation metadata for a published skill.
type SkillMeta struct {
	Tags       []string          `json:"tags,omitempty"`
	Owner      string            `json:"owner,omitempty"`
	Appearance map[string]string `json:"appearance,omitempty"`
}

// PublishedSkill is one agent instruction a resource publishes. Visibility
// controls discovery only; the API route still needs its own protection.
type PublishedSkill struct {
	ID             string     `json:"id"`
	Title          string     `json:"title"`
	RequiredScopes []string   `json:"requiredScopes"`
	Visibility     string     `json:"visibility"`
	Content        string     `json:"content"`
	Meta           *SkillMeta `json:"meta,omitempty"`
	LastUpdatedAt  string     `json:"lastUpdatedAt,omitempty"`
}

// SkillCatalog is the document served at SkillCatalogPath.
type SkillCatalog struct {
	SchemaVersion int              `json:"schemaVersion"`
	Resource      string           `json:"resource"`
	Skills        []PublishedSkill `json:"skills"`
}

// SkillProvider supplies a resource's skills: exactly one of Items (a fixed
// list) or Load (for example from a database). The catalog must be the same
// for every caller; Load receives no employee identity.
type SkillProvider struct {
	Items []PublishedSkill
	Load  func(ctx context.Context) ([]PublishedSkill, error)
}

var (
	localSkillID = regexp.MustCompile(`^[a-z0-9]+(?:[_-][a-z0-9]+)*$`)
	globalScope  = regexp.MustCompile(`^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$`)
)

func hasOnlyKeys(value map[string]any, allowed ...string) bool {
	for key := range value {
		if !contains(allowed, key) {
			return false
		}
	}
	return true
}

// ParseSkillCatalog validates a decoded JSON skill catalog against every
// rule of the TypeScript SDK. An empty expectedResource skips the resource
// check.
func ParseSkillCatalog(value any, expectedResource string) (*SkillCatalog, error) {
	catalog, ok := isRecord(value)
	if !ok || !hasOnlyKeys(catalog, "schemaVersion", "resource", "skills") {
		return nil, configError("invalid skill catalog")
	}
	if version, ok := jsNumber(catalog["schemaVersion"]); !ok || version != SkillCatalogSchemaVersion {
		return nil, configError("unsupported skill catalog schema version")
	}
	resource, ok := catalog["resource"].(string)
	if !ok || expectedResource != "" && resource != expectedResource {
		return nil, configError("skill catalog resource mismatch")
	}
	rawSkills, ok := catalog["skills"].([]any)
	if !ok || len(rawSkills) > 100 {
		return nil, configError("skill catalog must contain at most 100 skills")
	}
	ids := map[string]bool{}
	skills := make([]PublishedSkill, 0, len(rawSkills))
	for _, candidate := range rawSkills {
		skill, err := parseSkill(candidate, ids)
		if err != nil {
			return nil, err
		}
		skills = append(skills, skill)
	}
	return &SkillCatalog{SchemaVersion: SkillCatalogSchemaVersion, Resource: resource, Skills: skills}, nil
}

func parseSkill(candidate any, ids map[string]bool) (PublishedSkill, error) {
	raw, ok := isRecord(candidate)
	if !ok || !hasOnlyKeys(raw, "id", "title", "requiredScopes", "visibility", "content", "meta", "lastUpdatedAt") {
		return PublishedSkill{}, configError("invalid published skill")
	}
	id, ok := raw["id"].(string)
	if !ok || utf16Length(id) > 120 || !localSkillID.MatchString(id) || ids[id] {
		return PublishedSkill{}, configError("published skill IDs must be unique valid local IDs")
	}
	ids[id] = true
	title, ok := raw["title"].(string)
	if !ok || utf16Length(title) < 1 || utf16Length(title) > 200 {
		return PublishedSkill{}, configError("published skill title must contain 1 to 200 characters")
	}
	content, ok := raw["content"].(string)
	if !ok || utf16Length(content) < 1 || utf16Length(content) > 100_000 {
		return PublishedSkill{}, configError("published skill content must contain 1 to 100000 characters")
	}
	rawScopes, ok := raw["requiredScopes"].([]any)
	if !ok || len(rawScopes) > 100 {
		return PublishedSkill{}, configError("published skill must require at most 100 scopes")
	}
	scopes := make([]string, 0, len(rawScopes))
	seen := map[string]bool{}
	for _, rawScope := range rawScopes {
		scope, ok := rawScope.(string)
		if !ok || !globalScope.MatchString(scope) {
			return PublishedSkill{}, configError("published skill contains an invalid global scope")
		}
		if seen[scope] {
			return PublishedSkill{}, configError("published skill scopes must be unique")
		}
		seen[scope] = true
		scopes = append(scopes, scope)
	}
	visibility, ok := raw["visibility"].(string)
	if !ok || visibility != SkillVisibilityDefault && visibility != SkillVisibilityHiddenIfUnallowed {
		return PublishedSkill{}, configError("published skill visibility is invalid")
	}
	skill := PublishedSkill{ID: id, Title: title, RequiredScopes: scopes, Visibility: visibility, Content: content}
	if rawMeta, present := raw["meta"]; present {
		meta, err := parseSkillMeta(rawMeta)
		if err != nil {
			return PublishedSkill{}, err
		}
		skill.Meta = meta
	}
	if rawUpdated, present := raw["lastUpdatedAt"]; present {
		updated, ok := rawUpdated.(string)
		if !ok {
			return PublishedSkill{}, configError("published skill lastUpdatedAt is invalid")
		}
		skill.LastUpdatedAt = updated
	}
	return skill, nil
}

func parseSkillMeta(value any) (*SkillMeta, error) {
	invalid := configError("published skill meta is invalid")
	raw, ok := isRecord(value)
	if !ok || !hasOnlyKeys(raw, "tags", "owner", "appearance") {
		return nil, invalid
	}
	meta := &SkillMeta{}
	if rawTags, present := raw["tags"]; present {
		tags, ok := rawTags.([]any)
		if !ok || len(tags) > SkillTagLimit {
			return nil, invalid
		}
		for _, rawTag := range tags {
			tag, ok := rawTag.(string)
			if !ok || tag == "" || utf16Length(tag) > SkillTagLengthLimit {
				return nil, invalid
			}
			meta.Tags = append(meta.Tags, tag)
		}
	}
	if rawOwner, present := raw["owner"]; present {
		owner, ok := rawOwner.(string)
		if !ok {
			return nil, invalid
		}
		meta.Owner = owner
	}
	if rawAppearance, present := raw["appearance"]; present {
		appearance, ok := isRecord(rawAppearance)
		if !ok {
			return nil, invalid
		}
		meta.Appearance = map[string]string{}
		for key, rawValue := range appearance {
			value, ok := rawValue.(string)
			if !ok {
				return nil, invalid
			}
			meta.Appearance[key] = value
		}
	}
	return meta, nil
}

// loadSkillCatalog builds the catalog from the provider, caps it at 1 MiB
// and validates it as a client would.
func loadSkillCatalog(ctx context.Context, provider *SkillProvider, resource string) (*SkillCatalog, error) {
	items := provider.Items
	if provider.Load != nil {
		loaded, err := provider.Load(ctx)
		if err != nil {
			return nil, err
		}
		items = loaded
	}
	normalized := make([]PublishedSkill, len(items))
	for i, item := range items {
		if item.RequiredScopes == nil {
			item.RequiredScopes = []string{}
		}
		normalized[i] = item
	}
	encoded, err := marshalJSON(SkillCatalog{SchemaVersion: SkillCatalogSchemaVersion, Resource: resource, Skills: normalized})
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxSkillCatalogBytes {
		return nil, configError("skill catalog exceeds 1 MiB")
	}
	decoded, err := decodeJSONObject(encoded)
	if err != nil {
		return nil, err
	}
	return ParseSkillCatalog(decoded, resource)
}
