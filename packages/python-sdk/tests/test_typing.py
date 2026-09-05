from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_public_types_reject_invalid_configuration_and_calls(tmp_path: Path) -> None:
    consumer = tmp_path / "invalid_consumer.py"
    consumer.write_text(
        """\
from weldall import (
    WeldallOptions,
    create_dpop_proof,
    request_machine_token,
    sign_es256,
    verify_es256,
)

bad: WeldallOptions = {
    "resource": "x",
    "public_origin": "x",
    "client_id": "x",
    "supported_scopes": [],
    "signing_key": {"anything": object()},
    "replay_store": "disabled",
    "skills": 42,
}
create_dpop_proof(private_jwk={}, public_jwk={}, method="GET")
request_machine_token(
    issuer="x", client_id="x", kid="x", key=42, resource="x", scopes=[]
)
sign_es256({}, nonsense=object())
verify_es256("token", nonsense=object())
""",
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-m", "mypy", "--strict", "--no-error-summary", str(consumer)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert 'TypedDict item "signing_key"' in result.stdout
    assert 'TypedDict item "skills"' in result.stdout
    assert 'No overload variant of "create_dpop_proof"' in result.stdout
    assert 'No overload variant of "request_machine_token"' in result.stdout
    assert 'No overload variant of "sign_es256"' in result.stdout
    assert 'No overload variant of "verify_es256"' in result.stdout
