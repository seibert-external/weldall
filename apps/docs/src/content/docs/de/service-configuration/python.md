---
title: Einen Webdienst mit Python absichern
description: Mit dem Weldall SDK und FastAPI eine Vertrags-API absichern oder mit dem Django-Beispiel beginnen.
sidebar:
  label: Python
---

Weldall prüft eingehende Anfragen an Webdienste. Dafür bieten wir Bibliotheken an, die du in deine Anwendung einbindest. Sie prüfen, wer eine Anfrage stellt und ob die nötigen Berechtigungen vorliegen, bevor die Anwendung Daten liest oder Änderungen ausführt.

Für Python gibt es die Bibliothek `weldall-sdk` mit Anbindungen für FastAPI und Django. Diese Anleitung zeigt ihren Einsatz mit FastAPI: Ein Webdienst gibt eine Vertragsliste nur mit der Berechtigung `contracts:read` zurück. Dazu veröffentlicht er einen Skill, also eine Anleitung mit dem passenden Befehl für den Agenten.

Du benötigst Python 3.11 oder neuer, [uv](https://docs.astral.sh/uv/) und eine laufende Weldall-Instanz. Das veröffentlichte Paket findest du als [`weldall-sdk` auf PyPI](https://pypi.org/project/weldall-sdk/). [Quellcode und Referenz](https://github.com/seibert-external/weldall/tree/main/packages/python-sdk) liegen neben der TypeScript-Bibliothek im Weldall-Projekt auf GitHub.

## 1. FastAPI-Projekt anlegen

```sh
uv init --bare --python 3.11 weldall-contracts
cd weldall-contracts
uv add 'weldall-sdk[fastapi]' uvicorn
```

Wenn du Abhängigkeiten mit pip verwaltest, installiere stattdessen `weldall-sdk[fastapi]` und `uvicorn` in deiner virtuellen Umgebung.

## 2. Zugriff auf Verträge absichern

Lege `app.py` an:

```python
import os

from fastapi import Depends, FastAPI
from weldall import generate_es256_key_pair, in_memory
from weldall.adapters.fastapi import init_weldall

weldall_issuer = os.environ.get("WELDALL_ISSUER", "https://weldall.example.com")
public_origin = os.environ.get("PUBLIC_ORIGIN", "http://localhost:8000")
key = generate_es256_key_pair()

weldall = init_weldall(
    weldall_issuer,
    {
        "resource": f"{public_origin}/api",
        "public_origin": public_origin,
        "client_id": "weldall-cli-at-contracts",
        "supported_scopes": ["contracts:read"],
        "signing_key": {
            "kid": "development-only",
            "private_jwk": key["private_jwk"],
            "public_jwk": key["public_jwk"],
        },
        "replay_store": in_memory(),
        "skills": {
            "items": [
                {
                    "id": "list",
                    "title": "List contracts",
                    "requiredScopes": ["contracts:read"],
                    "visibility": "HIDDEN_IF_UNALLOWED",
                    "content": (
                        "# List contracts\n\nRun `weldall request --scope contracts:read "
                        f"{public_origin}/api/contracts`."
                    ),
                }
            ]
        },
        "allow_insecure_loopback": public_origin == "http://localhost:8000",
    },
)

app = FastAPI()
weldall.register_routes(app)


@app.get("/api/contracts")
def contracts(auth=Depends(weldall.require_auth({"scopes": ["contracts:read"]}))):
    return {
        "requested_by": auth.identity.subject,
        "contracts": [
            {"id": "contract-1001", "customer": "Nordstern GmbH", "status": "active"},
            {"id": "contract-1002", "customer": "Südwind AG", "status": "review"},
        ],
    }
```

`register_routes()` stellt die Endpunkte bereit, über die Weldall den Dienst erkennt, Signaturschlüssel und Skills abruft und Berechtigungsnachweise gegen Zugangstokens eintauscht. FastAPI führt die Prüfung mit `require_auth()` aus, bevor es die Funktion zum Auflisten der Verträge aufruft. Diese erhält die geprüfte Identität als `auth`. Wie du diese Identität den Benutzerkonten deiner Anwendung zuordnest, legst du selbst fest.

Python-Optionen heißen etwa `public_origin` und `supported_scopes`. Skill-Felder wie `requiredScopes` behalten die Schreibweise des Übertragungsformats.

Der Skill zeigt dem Agenten den passenden Aufruf. Mitarbeitende ohne `contracts:read` sehen ihn nicht. Diese Einstellung ersetzt jedoch nicht die Berechtigungsprüfung beim Zugriff auf die Vertragsliste.

## 3. Webdienst lokal prüfen

Trage unter `WELDALL_ISSUER` die Adresse deiner Weldall-Instanz ein und starte den Webdienst:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8000 \
uv run uvicorn app:app --port 8000
```

Rufe in einem zweiten Terminal die Dienstbeschreibung und die geschützte Vertragsliste ab:

```sh
curl -i http://localhost:8000/.well-known/oauth-protected-resource
curl -i http://localhost:8000/api/contracts
```

Die Dienstbeschreibung liefert den Statuscode `200` und die Ressourcenkennung `http://localhost:8000/api`. Die Anfrage nach Verträgen wird mit `401` abgelehnt, weil der Berechtigungsnachweis fehlt. Für diese Prüfung brauchst du keine Anmeldung an der Weldall CLI. Mit `weldall.ready()` beim Start kannst du zusätzlich prüfen, ob die Bibliothek die Konfiguration deiner Weldall-Instanz abrufen kann und die Signaturschlüssel korrekt eingerichtet sind. Rufe die Methode auf, bevor der Webdienst Anfragen annimmt.

## 4. Webdienst bereitstellen und registrieren

:::caution[Replay-Schutz bei mehreren Instanzen]
Jeder DPoP-Proof enthält eine eindeutige ID (`jti`). Das SDK speichert bereits verwendete IDs und lehnt wiederverwendete Proofs ab. Mit `in_memory()` funktioniert das nur innerhalb eines Prozesses.

Die Proofs sind zwar nur kurz gültig, können in dieser Zeit aber an einem anderen Worker oder einer anderen Instanz erneut verwendet werden. Für Replay-Schutz über alle Worker und Instanzen hinweg brauchst du einen gemeinsamen Replay-Store, etwa auf Basis von Redis. Er muss neue IDs atomar eintragen, Duplikate ablehnen und die IDs bis zum Ende des Gültigkeitsfensters speichern. Details stehen unter [Sicherheit](../../oauth-security/).
:::

Verwende in Produktion HTTPS und lade deinen ES256-Signaturschlüssel aus der Konfiguration, statt ihn wie im Beispiel bei jedem Start neu zu erzeugen.

Stelle den Webdienst unter `https://contracts.example.com` bereit und setze `PUBLIC_ORIGIN` auf genau diese URL. `WELDALL_ISSUER` zeigt weiterhin auf deine Weldall-Instanz. Die Ressourcenkennung lautet dann `https://contracts.example.com/api`. Auch der Skill verwendet nun die öffentliche Adresse.

Fahre mit der [Registrierung und Berechtigungsvergabe](../#für-weldall-administratoren) fort. Diese Schritte sind für TypeScript und Python identisch.

## Beispiele auf GitHub

- [FastAPI: `examples/python-fastapi`](https://github.com/seibert-external/weldall/tree/main/examples/python-fastapi)
- [Django: `examples/python-django`](https://github.com/seibert-external/weldall/tree/main/examples/python-django)

Die Startbefehle stehen in der jeweiligen README. Beide Beispiele schützen `/api/expenses` mit `expenses:read`, veröffentlichen aber keine Skills.
