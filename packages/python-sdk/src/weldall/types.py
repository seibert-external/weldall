"""Public typing contracts."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, NotRequired, Protocol, TypedDict

from .errors import WeldallAuthError
from .http import Response

JWK = dict[str, Any]
JWTPayload = dict[str, Any]


class ReplayStore(Protocol):
    def consume(self, key: str, expires_at: datetime) -> bool:
        """Atomically consume a key; return true only for its first use."""


class DpopKeyPair(TypedDict):
    private_jwk: JWK
    public_jwk: JWK
    jkt: str


class DirectSigningKey(TypedDict):
    kid: str
    private_jwk: JWK
    public_jwk: JWK


class ProviderSigningKey(TypedDict):
    kid: str
    public_jwk: JWK
    sign: Callable[[JWTPayload, dict[str, str]], str]


class SigningKeyProvider(Protocol):
    def current(self) -> ProviderSigningKey: ...

    def jwks(self) -> Sequence[JWK]: ...


Signing = DirectSigningKey | SigningKeyProvider
Replay = ReplayStore | Literal["disabled"]

SkillVisibility = Literal["DEFAULT", "HIDDEN_IF_UNALLOWED"]


class SkillMeta(TypedDict, total=False):
    tags: list[str]
    owner: str
    appearance: dict[str, str]


class PublishedSkill(TypedDict):
    id: str
    title: str
    requiredScopes: list[str]
    visibility: SkillVisibility
    content: str
    meta: NotRequired[SkillMeta]
    lastUpdatedAt: NotRequired[str]


class SkillCatalog(TypedDict):
    schemaVersion: int
    resource: str
    skills: list[PublishedSkill]


class StaticSkillProvider(TypedDict):
    items: Sequence[PublishedSkill]


class DynamicSkillProvider(TypedDict):
    load: Callable[[], Sequence[PublishedSkill]]


class StaticSkillProviderObject(Protocol):
    items: Sequence[PublishedSkill]


class DynamicSkillProviderObject(Protocol):
    def load(self) -> Sequence[PublishedSkill]: ...


SkillProvider = (
    StaticSkillProvider
    | DynamicSkillProvider
    | StaticSkillProviderObject
    | DynamicSkillProviderObject
)


class ConfirmationClaim(TypedDict):
    jkt: str


IdJagClaims = TypedDict(
    "IdJagClaims",
    {
        "iss": str,
        "sub": str,
        "email": str,
        "email_verified": Literal[True],
        "aud": str,
        "client_id": str,
        "resource": str,
        "scope": str,
        "cnf": ConfirmationClaim,
        "jti": str,
        "iat": int,
        "exp": int,
        "urn:weldall:id-jag-draft": str,
    },
)


class ScopePolicy(TypedDict, total=False):
    scopes: Sequence[str]
    any_scopes: Sequence[str]


@dataclass(frozen=True, slots=True)
class UserPrincipal:
    type: Literal["user"]
    subject: str
    email: str
    email_verified: Literal[True]


@dataclass(frozen=True, slots=True)
class MachinePrincipal:
    type: Literal["machine"]
    subject: str
    client_id: str


@dataclass(frozen=True, slots=True)
class UserAuthContext:
    identity_type: Literal["user"]
    identity: UserPrincipal
    subject: str
    email: str
    email_verified: Literal[True]
    client_id: str
    scopes: tuple[str, ...]
    token_id: str


@dataclass(frozen=True, slots=True)
class MachineAuthContext:
    identity_type: Literal["machine"]
    identity: MachinePrincipal
    subject: str
    client_id: str
    scopes: tuple[str, ...]
    token_id: str


AuthContext = UserAuthContext | MachineAuthContext


@dataclass(frozen=True, slots=True)
class VerifySuccess:
    ok: Literal[True]
    auth: AuthContext


@dataclass(frozen=True, slots=True)
class VerifyFailure:
    ok: Literal[False]
    error: WeldallAuthError
    response: Response


VerifyResult = VerifySuccess | VerifyFailure


class WeldallOptions(TypedDict):
    resource: str
    public_origin: str
    client_id: str
    supported_scopes: Sequence[str]
    signing_key: Signing
    replay_store: Replay
    discovery_timeout_ms: NotRequired[int]
    discovery_proxy_origin: NotRequired[str]
    allow_insecure_loopback: NotRequired[bool]
    skills: NotRequired[SkillProvider]


@dataclass(frozen=True, slots=True)
class VerifiedDpop:
    payload: JWTPayload
    public_jwk: JWK
    jkt: str
