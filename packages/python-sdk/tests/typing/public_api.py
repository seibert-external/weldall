"""Static consumer checks for the shipped public type surface."""

from typing import assert_type

from weldall import (
    AuthContext,
    CreateDpopProofInput,
    IdJagClaims,
    MachineAuthContext,
    MachineToken,
    MachineTokenRequestInput,
    Signing,
    SkillProvider,
    SkillVisibility,
    UserAuthContext,
    VerifyResult,
    WeldallOptions,
    create_dpop_proof,
    init_weldall,
    request_machine_token,
)
from weldall.adapters.django import DjangoWeldall
from weldall.adapters.fastapi import FastAPIWeldall


def narrow_auth(auth: AuthContext) -> None:
    if auth.identity_type == "user":
        assert_type(auth, UserAuthContext)
        assert_type(auth.email, str)
        assert_type(auth.identity.email, str)
    else:
        assert_type(auth, MachineAuthContext)
        assert_type(auth.identity.client_id, str)


def narrow_result(result: VerifyResult) -> None:
    if result.ok:
        assert_type(result.auth, AuthContext)
    else:
        assert_type(result.error.code, str)
        assert_type(result.response.status, int)


def typed_inputs(
    proof: CreateDpopProofInput,
    machine: MachineTokenRequestInput,
    signing: Signing,
    skills: SkillProvider,
    visibility: SkillVisibility,
    claims: IdJagClaims,
) -> None:
    assert_type(create_dpop_proof(proof), str)
    assert_type(request_machine_token(machine), MachineToken)
    assert_type(signing, Signing)
    assert_type(skills, SkillProvider)
    assert_type(visibility, SkillVisibility)
    assert_type(claims["urn:weldall:id-jag-draft"], str)


def public_constructors(
    host: str,
    options: WeldallOptions,
) -> tuple[FastAPIWeldall, DjangoWeldall]:
    assert_type(init_weldall(host, options).issuer, str)
    return FastAPIWeldall(host, options), DjangoWeldall(init_weldall(host, options))
