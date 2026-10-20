"""Published skill catalog validation and loading."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from typing import Any, TypeGuard, cast

from .constants import (
    SKILL_ASSERTION_TYPE,
    SKILL_CATALOG_PATH,
    SKILL_CATALOG_SCHEMA_VERSION,
    SKILL_TAG_LENGTH_LIMIT,
    SKILL_TAG_LIMIT,
)
from .types import PublishedSkill, SkillCatalog, SkillMcpDependency, SkillMeta

_LOCAL_SKILL_ID = re.compile(r"^[a-z0-9]+(?:[_-][a-z0-9]+)*$")
_GLOBAL_SCOPE = re.compile(r"^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$")
_VISIBILITIES = {"DEFAULT", "HIDDEN_IF_UNALLOWED"}
_CATALOG_KEYS = {"schemaVersion", "resource", "skills"}
_SKILL_KEYS = {
    "id",
    "title",
    "requiredScopes",
    "visibility",
    "content",
    "meta",
    "lastUpdatedAt",
    "mcpDependencies",
}
_MCP_DEPENDENCY_KEYS = {"connectorKey", "tools", "includeResources"}
_MCP_CONNECTOR_KEY = re.compile(r"[a-z0-9][a-z0-9._-]{0,119}")
_MCP_TOOL_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}")
_META_KEYS = {"tags", "owner", "appearance"}


def _record(value: object) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def _js_len(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _parse_mcp_dependencies(value: object) -> list[SkillMcpDependency]:
    if not isinstance(value, list) or len(value) > 8:
        raise TypeError("invalid skill MCP dependencies")
    result: list[SkillMcpDependency] = []
    keys: set[str] = set()
    for dependency in value:
        if not _record(dependency):
            raise TypeError("invalid skill MCP dependencies")
        if dependency.get("kind") in ("resource", "connector"):
            field = "resourceKey" if dependency["kind"] == "resource" else "connectorType"
            key = dependency.get(field)
            identity = f"{dependency['kind'] if field == 'resourceKey' else 'connector-type'}:{key}"
            if (
                dependency.keys() != {"kind", field}
                or not isinstance(key, str)
                or _MCP_CONNECTOR_KEY.fullmatch(key) is None
                or identity in keys
            ):
                raise TypeError("invalid skill MCP dependencies")
            keys.add(identity)
            result.append(cast(SkillMcpDependency, dict(dependency)))
            continue
        if dependency.keys() != _MCP_DEPENDENCY_KEYS:
            raise TypeError("invalid skill MCP dependencies")
        key = dependency["connectorKey"]
        tools = dependency["tools"]
        include_resources = dependency["includeResources"]
        if (
            not isinstance(key, str)
            or _MCP_CONNECTOR_KEY.fullmatch(key) is None
            or f"connector:{key}" in keys
            or not isinstance(tools, list)
            or len(tools) > 32
            or any(
                not isinstance(tool, str) or _MCP_TOOL_NAME.fullmatch(tool) is None
                for tool in tools
            )
            or type(include_resources) is not bool
            or (not tools and not include_resources)
        ):
            raise TypeError("invalid skill MCP dependencies")
        keys.add(f"connector:{key}")
        result.append(
            {
                "connectorKey": key,
                "tools": sorted(set(tools)),
                "includeResources": include_resources,
            }
        )

    def dependency_key(dependency: SkillMcpDependency) -> str:
        item = cast(dict[str, Any], dependency)
        if "connectorKey" in item:
            return f"connector:{item['connectorKey']}"
        if item["kind"] == "resource":
            return f"resource:{item['resourceKey']}"
        return f"connector-type:{item['connectorType']}"

    return sorted(result, key=dependency_key)


def parse_skill_catalog(value: object, expected_resource: str | None = None) -> SkillCatalog:
    if not _record(value) or any(key not in _CATALOG_KEYS for key in value):
        raise TypeError("invalid skill catalog")
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise TypeError("unsupported skill catalog schema version")
    resource = value.get("resource")
    if not isinstance(resource, str) or (expected_resource and resource != expected_resource):
        raise TypeError("skill catalog resource mismatch")
    raw_skills = value.get("skills")
    if not isinstance(raw_skills, list) or len(raw_skills) > 100:
        raise TypeError("skill catalog must contain at most 100 skills")
    ids: set[str] = set()
    skills: list[PublishedSkill] = []
    for candidate in raw_skills:
        if not _record(candidate) or any(key not in _SKILL_KEYS for key in candidate):
            raise TypeError("invalid published skill")
        dependencies = _parse_mcp_dependencies(candidate.get("mcpDependencies", []))
        skill_id = candidate.get("id")
        title = candidate.get("title")
        required = candidate.get("requiredScopes")
        visibility = candidate.get("visibility")
        content = candidate.get("content")
        has_meta = "meta" in candidate
        meta = candidate.get("meta")
        has_updated = "lastUpdatedAt" in candidate
        updated = candidate.get("lastUpdatedAt")
        if (
            not isinstance(skill_id, str)
            or _js_len(skill_id) > 120
            or _LOCAL_SKILL_ID.fullmatch(skill_id) is None
            or skill_id in ids
        ):
            raise TypeError("published skill IDs must be unique valid local IDs")
        ids.add(skill_id)
        if not isinstance(title, str) or not 1 <= _js_len(title) <= 200:
            raise TypeError("published skill title must contain 1 to 200 characters")
        if not isinstance(content, str) or not 1 <= _js_len(content) <= 100_000:
            raise TypeError("published skill content must contain 1 to 100000 characters")
        if not isinstance(required, list) or len(required) > 100:
            raise TypeError("published skill must require at most 100 scopes")
        scopes: list[str] = []
        for scope in required:
            if not isinstance(scope, str) or _GLOBAL_SCOPE.fullmatch(scope) is None:
                raise TypeError("published skill contains an invalid global scope")
            scopes.append(scope)
        if len(set(scopes)) != len(scopes):
            raise TypeError("published skill scopes must be unique")
        if not isinstance(visibility, str) or visibility not in _VISIBILITIES:
            raise TypeError("published skill visibility is invalid")
        if has_meta:
            if not _record(meta) or any(key not in _META_KEYS for key in meta):
                raise TypeError("published skill meta is invalid")
            if "tags" in meta:
                tags = meta["tags"]
                if (
                    not isinstance(tags, list)
                    or len(tags) > SKILL_TAG_LIMIT
                    or any(
                        not isinstance(tag, str) or not 0 < _js_len(tag) <= SKILL_TAG_LENGTH_LIMIT
                        for tag in tags
                    )
                ):
                    raise TypeError("published skill meta is invalid")
            if "owner" in meta and not isinstance(meta["owner"], str):
                raise TypeError("published skill meta is invalid")
            if "appearance" in meta:
                appearance = meta["appearance"]
                if (
                    not isinstance(appearance, dict)
                    or any(not isinstance(key, str) for key in appearance)
                    or any(not isinstance(item, str) for item in appearance.values())
                ):
                    raise TypeError("published skill meta is invalid")
        if has_updated and not isinstance(updated, str):
            raise TypeError("published skill lastUpdatedAt is invalid")
        skill: PublishedSkill = {
            "id": skill_id,
            "title": title,
            "requiredScopes": scopes,
            "visibility": visibility,  # type: ignore[typeddict-item]
            "content": content,
        }
        if dependencies:
            skill["mcpDependencies"] = dependencies
        if has_meta:
            skill["meta"] = cast(SkillMeta, meta)
        if has_updated:
            skill["lastUpdatedAt"] = cast(str, updated)
        skills.append(skill)
    return {"schemaVersion": SKILL_CATALOG_SCHEMA_VERSION, "resource": resource, "skills": skills}


def load_skill_catalog(provider: object, resource: str) -> SkillCatalog:
    if isinstance(provider, Mapping):
        raw_items = provider.get("items") if "items" in provider else provider["load"]()
    else:
        static_items = getattr(provider, "items", None)
        raw_items = static_items if static_items is not None else cast(Any, provider).load()
    items = cast(Iterable[PublishedSkill], raw_items)
    catalog = {"schemaVersion": 1, "resource": resource, "skills": list(items)}
    encoded = json.dumps(catalog, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > 1_048_576:
        raise TypeError("skill catalog exceeds 1 MiB")
    return parse_skill_catalog(json.loads(encoded), resource)


__all__ = [
    "SKILL_ASSERTION_TYPE",
    "SKILL_CATALOG_PATH",
    "SKILL_CATALOG_SCHEMA_VERSION",
    "SKILL_TAG_LENGTH_LIMIT",
    "SKILL_TAG_LIMIT",
    "PublishedSkill",
    "SkillCatalog",
    "SkillMcpDependency",
    "SkillMeta",
    "load_skill_catalog",
    "parse_skill_catalog",
]
