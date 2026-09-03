"""FastAPI adapter for the synchronous Weldall core."""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

from fastapi import FastAPI, HTTPException
from fastapi import Request as FastAPIRequest
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response as StarletteResponse

from ..core import Weldall
from ..http import Request, Response
from ..types import AuthContext, ScopePolicy, WeldallOptions


class WeldallHTTPException(HTTPException):
    """HTTPException whose detail is already an OAuth response body."""


class FastAPIWeldall(Weldall):
    def require_auth(
        self, policy: ScopePolicy | None = None
    ) -> Callable[[FastAPIRequest], AuthContext]:
        def dependency(request: FastAPIRequest) -> AuthContext:
            result = self.verify_no_throw(_request(request), policy)
            if not result.ok:
                raise WeldallHTTPException(
                    status_code=result.response.status,
                    detail=result.response.json_body(),
                    headers=result.response.headers.as_dict(),
                )
            request.state.weldall_auth = result.auth
            return result.auth

        return dependency

    @staticmethod
    def get_auth(request: FastAPIRequest) -> AuthContext:
        auth = getattr(request.state, "weldall_auth", None)
        if auth is None:
            raise RuntimeError("Weldall authentication dependency did not run")
        return cast(AuthContext, auth)

    def install_exception_handler(self, app: FastAPI) -> FastAPI:
        """Install the exact OAuth-body handler used by :meth:`require_auth`."""

        async def oauth_exception_handler(
            _request_value: FastAPIRequest, exc: WeldallHTTPException
        ) -> JSONResponse:
            return JSONResponse(
                exc.detail,
                status_code=exc.status_code,
                headers=exc.headers,
            )

        app.add_exception_handler(WeldallHTTPException, oauth_exception_handler)  # type: ignore[arg-type]
        return app

    def register_routes(self, app: FastAPI) -> FastAPI:
        self.install_exception_handler(app)

        async def token(request: FastAPIRequest) -> StarletteResponse:
            raw = await request.body()
            response = await run_in_threadpool(
                self.handlers.token,
                _request(request, body=raw),
            )
            return _response(response)

        def authorization_server_metadata(request: FastAPIRequest) -> StarletteResponse:
            return _response(self.handlers.authorization_server_metadata(_request(request)))

        def protected_resource_metadata(request: FastAPIRequest) -> StarletteResponse:
            return _response(self.handlers.protected_resource_metadata(_request(request)))

        def jwks(request: FastAPIRequest) -> StarletteResponse:
            return _response(self.handlers.jwks(_request(request)))

        def skills(request: FastAPIRequest) -> StarletteResponse:
            return _response(self.handlers.skills(_request(request)))

        app.add_api_route(
            "/.well-known/oauth-authorization-server",
            authorization_server_metadata,
            methods=["GET"],
            include_in_schema=False,
        )
        app.add_api_route(
            "/.well-known/oauth-protected-resource",
            protected_resource_metadata,
            methods=["GET"],
            include_in_schema=False,
        )
        app.add_api_route(
            "/.well-known/oauth-protected-resource/{path:path}",
            protected_resource_metadata,
            methods=["GET"],
            include_in_schema=False,
        )
        app.add_api_route("/.well-known/jwks.json", jwks, methods=["GET"], include_in_schema=False)
        if self.skills_endpoint is not None:
            app.add_api_route(
                "/.well-known/weldall-skills",
                skills,
                methods=["GET"],
                include_in_schema=False,
            )
        app.add_api_route("/oauth/token", token, methods=["POST"], include_in_schema=False)
        return app


def _combined_headers(request: FastAPIRequest) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_name, raw_value in request.headers.raw:
        name = raw_name.decode("latin-1").lower()
        value = raw_value.decode("latin-1")
        values[name] = f"{values[name]}, {value}" if name in values else value
    return values


def _request(request: FastAPIRequest, *, body: bytes = b"") -> Request:
    return Request(
        method=request.method,
        url=str(request.url),
        headers=_combined_headers(request),
        body=body,
    )


def _response(response: Response) -> StarletteResponse:
    return StarletteResponse(
        content=response.body,
        status_code=response.status,
        headers=response.headers.as_dict(),
    )


def init_weldall(host: str, options: WeldallOptions) -> FastAPIWeldall:
    return FastAPIWeldall(host, options)


def get_auth(request: FastAPIRequest) -> AuthContext:
    return FastAPIWeldall.get_auth(request)


__all__ = ["FastAPIWeldall", "WeldallHTTPException", "get_auth", "init_weldall"]
