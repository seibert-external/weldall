"""Django middleware, views, and URL helpers for Weldall."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, cast

from django.http import HttpRequest, HttpResponse
from django.urls import path, re_path
from django.views.decorators.csrf import csrf_exempt

from ..core import Weldall
from ..http import Request, Response
from ..types import AuthContext, ScopePolicy, VerifyResult, WeldallOptions


class WeldallMiddleware:
    """Protect configured path prefixes before invoking the Django view."""

    def __init__(
        self,
        get_response: Callable[[HttpRequest], HttpResponse],
        weldall: Weldall | DjangoWeldall,
        *,
        protected_paths: Sequence[str] = (),
        policy: ScopePolicy | None = None,
    ) -> None:
        self.get_response = get_response
        self.weldall = weldall.core if isinstance(weldall, DjangoWeldall) else weldall
        self.protected_paths = tuple(protected_paths)
        self.policy = policy

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if any(_path_accepts(prefix, request.path) for prefix in self.protected_paths):
            result = self.weldall.verify_no_throw(_request(request), self.policy)
            if not result.ok:
                assert result.response is not None
                return _response(result.response)
            request.weldall_auth = result.auth  # type: ignore[attr-defined]
        return self.get_response(request)


class DjangoWeldall:
    def __init__(self, core: Weldall) -> None:
        self.core = core
        self.host = core.host
        self.issuer = core.issuer
        self.resource = core.resource
        self.token_endpoint = core.token_endpoint
        self.skills_endpoint = core.skills_endpoint
        self.handlers = core.handlers

    def ready(self) -> None:
        self.core.ready()

    def close(self) -> None:
        self.core.close()

    def verify(self, request: Request, policy: ScopePolicy | None = None) -> AuthContext:
        return self.core.verify(request, policy)

    def verify_no_throw(self, request: Request, policy: ScopePolicy | None = None) -> VerifyResult:
        return self.core.verify_no_throw(request, policy)

    def middleware(
        self,
        get_response: Callable[[HttpRequest], HttpResponse],
        *,
        protected_paths: Sequence[str] = (),
        policy: ScopePolicy | None = None,
    ) -> WeldallMiddleware:
        return WeldallMiddleware(
            get_response,
            self,
            protected_paths=protected_paths,
            policy=policy,
        )

    @staticmethod
    def get_auth(request: HttpRequest) -> AuthContext:
        auth = getattr(request, "weldall_auth", None)
        if auth is None:
            raise RuntimeError("Weldall authentication middleware did not run")
        return cast(AuthContext, auth)

    def authorization_server_metadata(self, request: HttpRequest) -> HttpResponse:
        if request.method != "GET":
            return _method_not_allowed("GET")
        return _response(self.handlers.authorization_server_metadata(_request(request)))

    def protected_resource_metadata(self, request: HttpRequest) -> HttpResponse:
        if request.method != "GET":
            return _method_not_allowed("GET")
        return _response(self.handlers.protected_resource_metadata(_request(request)))

    def jwks(self, request: HttpRequest) -> HttpResponse:
        if request.method != "GET":
            return _method_not_allowed("GET")
        return _response(self.handlers.jwks(_request(request)))

    def skills(self, request: HttpRequest) -> HttpResponse:
        if request.method != "GET":
            return _method_not_allowed("GET")
        return _response(self.handlers.skills(_request(request)))

    @csrf_exempt
    def token(self, request: HttpRequest) -> HttpResponse:
        if request.method != "POST":
            return _method_not_allowed("POST")
        return _response(self.handlers.token(_request(request, body=True)))

    def urls(self) -> list[Any]:
        patterns = [
            path(
                ".well-known/oauth-authorization-server",
                self.authorization_server_metadata,
                name="weldall-authorization-server-metadata",
            ),
            path(
                ".well-known/oauth-protected-resource",
                self.protected_resource_metadata,
                name="weldall-protected-resource-metadata",
            ),
            re_path(
                r"^\.well-known/oauth-protected-resource/.+$",
                self.protected_resource_metadata,
                name="weldall-protected-resource-metadata-path",
            ),
            path(".well-known/jwks.json", self.jwks, name="weldall-jwks"),
            path("oauth/token", self.token, name="weldall-token"),
        ]
        if self.skills_endpoint is not None:
            patterns.append(
                path(
                    ".well-known/weldall-skills",
                    self.skills,
                    name="weldall-skills",
                )
            )
        return patterns


def _path_accepts(prefix: str, target: str) -> bool:
    normalized = "/" + prefix.strip("/")
    if normalized == "/":
        return True
    return target == normalized or target.startswith(f"{normalized}/")


def _request(request: HttpRequest, *, body: bool = False) -> Request:
    return Request(
        method=request.method or "",
        url=request.build_absolute_uri(),
        headers={key: value for key, value in request.headers.items()},
        body=request.body if body else b"",
    )


def _response(response: Response) -> HttpResponse:
    result = HttpResponse(
        content=response.body,
        status=response.status,
        content_type=None,
    )
    for name, value in response.headers.items():
        result[name] = value
    return result


def _method_not_allowed(allowed: str) -> HttpResponse:
    response = HttpResponse(status=405)
    response["allow"] = allowed
    return response


def init_weldall(host: str, options: WeldallOptions) -> DjangoWeldall:
    return DjangoWeldall(Weldall(host, options))


def get_auth(request: HttpRequest) -> AuthContext:
    return DjangoWeldall.get_auth(request)


def urls(weldall: DjangoWeldall) -> list[Any]:
    return weldall.urls()


__all__ = [
    "DjangoWeldall",
    "WeldallMiddleware",
    "get_auth",
    "init_weldall",
    "urls",
]
