from __future__ import annotations

import pytest

from weldall import (
    load_skill_catalog,
    normalize_authorization_server,
    normalize_request_prefix,
    normalize_request_target,
    normalize_resource_identifier,
    parse_skill_catalog,
    request_prefix_accepts,
    request_prefixes_overlap,
    resolve_resource_for_target,
)

RESOURCE = "https://example.com/api"


def skill(**patch):
    value = {
        "id": "review",
        "title": "Review",
        "requiredScopes": ["expenses:read"],
        "visibility": "DEFAULT",
        "content": "# Review",
    }
    value.update(patch)
    return value


def catalog(item=None, **patch):
    value = {"schemaVersion": 1, "resource": RESOURCE, "skills": [item or skill()]}
    value.update(patch)
    return value


def test_skill_catalog_roundtrip_and_loader():
    value = catalog(
        skill(
            meta={
                "tags": ["finance"],
                "owner": "ops",
                "appearance": {"icon": "file-text"},
            },
            lastUpdatedAt="anything",
        )
    )
    assert parse_skill_catalog(value, RESOURCE) == value
    assert load_skill_catalog({"items": value["skills"]}, RESOURCE) == value
    assert load_skill_catalog({"load": lambda: value["skills"]}, RESOURCE) == value


@pytest.mark.parametrize(
    "value",
    [
        {**catalog(), "extra": True},
        catalog(schemaVersion=2),
        catalog(resource="https://other.example/api"),
        catalog(skills=[skill(id="review"), skill(id="review")]),
        catalog(skill(id="Invalid ID")),
        catalog(skill(title="")),
        catalog(skill(content="")),
        catalog(skill(requiredScopes=["invalid"])),
        catalog(skill(requiredScopes=["expenses:read", "expenses:read"])),
        catalog(skill(visibility="PUBLIC")),
        catalog(skill(extra=True)),
        catalog(skill(meta={"unknown": "x"})),
        catalog(skill(meta=None)),
        catalog(skill(lastUpdatedAt=1)),
        catalog(skill(lastUpdatedAt=None)),
    ],
)
def test_skill_catalog_strict_validation(value):
    with pytest.raises(TypeError):
        parse_skill_catalog(value, RESOURCE)


@pytest.mark.parametrize(
    "tags",
    [[""], ["x" * 41], [f"tag-{number}" for number in range(21)]],
)
def test_skill_tag_caps(tags):
    with pytest.raises(TypeError, match="meta"):
        parse_skill_catalog(catalog(skill(meta={"tags": tags})))


def test_skill_catalog_count_and_size_caps():
    with pytest.raises(TypeError, match="100"):
        parse_skill_catalog(catalog(skills=[skill(id=f"skill-{index}") for index in range(101)]))
    with pytest.raises(TypeError, match="1 MiB"):
        load_skill_catalog({"items": [skill(content="x" * 1_048_576)]}, RESOURCE)


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("https://example.com/api", True),
        ("https://example.com/api/events", True),
        ("https://example.com/api/events?year=2026", True),
        ("https://example.com/api-attacker", False),
        ("https://other.example.com/api/events", False),
        ("https://example.com/other/../api/events", True),
        ("https://example.com:443/api/events", True),
    ],
)
def test_request_prefix_segment_matching(target, expected):
    assert request_prefix_accepts("https://example.com/api", target) is expected


def test_resource_url_normalization():
    assert normalize_authorization_server(" https://EXAMPLE.com:443 ") == "https://example.com"
    for value in [
        "https://EXAMPLE.com:443/api/",
        "https://EXAMPLE.com:443/api//",
        "https://EXAMPLE.com:443/api///",
    ]:
        assert normalize_request_prefix(value) == "https://example.com/api"
    assert normalize_request_prefix("https://example.com///") == "https://example.com/"
    assert normalize_request_target("https://EXAMPLE.com/api?q=1") == "https://example.com/api?q=1"
    assert normalize_request_target("https://faß.de/api") == "https://xn--fa-hia.de/api"
    assert normalize_request_target("https://ς.gr/api") == "https://xn--3xa.gr/api"
    assert normalize_request_target("https://☃.net/api") == "https://xn--n3h.net/api"
    assert normalize_resource_identifier("https://EXAMPLE.com:443/api?q=1") == (
        "https://example.com/api?q=1"
    )


def test_prefix_overlap_and_resource_resolution():
    assert request_prefixes_overlap("https://example.com/api", "https://example.com/api/events")
    assert not request_prefixes_overlap("https://example.com/api", "https://example.com/api-v2")
    resources = [
        {
            "key": "one",
            "request_prefixes": ["https://example.com/api", "https://example.com/api/events"],
        },
        {"key": "two", "request_prefixes": ["https://other.example.com/api"]},
    ]
    assert resolve_resource_for_target(resources, "https://example.com/api/events/1") == [
        resources[0]
    ]


@pytest.mark.parametrize(
    "prefix",
    [
        "http://example.com/api",
        "https://user@example.com/api",
        "https://example.com/api?x=1",
        "https://example.com/api#fragment",
        "https://example.com/%61pi",
        "https://example.com/api%2Fevents",
    ],
)
def test_unsafe_prefix_rejected(prefix):
    with pytest.raises(TypeError):
        normalize_request_prefix(prefix)


@pytest.mark.parametrize(
    "target",
    [
        "https://example.com/api/..%2Fadmin",
        "https://example.com/api/%2e%2e%2fadmin",
        "https://example.com/api/%5Cadmin",
        "https://example.com/api%2Fevents",
    ],
)
def test_percent_encoded_target_rejected(target):
    with pytest.raises(TypeError, match="percent encoding"):
        normalize_request_target(target)
    with pytest.raises(TypeError, match="percent encoding"):
        request_prefix_accepts("https://example.com/api", target)
