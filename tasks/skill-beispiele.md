# Beispiel-Skills für die Skill Registry

Vier vollständig ausformulierte Skills im Registry-Format aus `skill-registry.md` — direkt über den Admin-Bereich in die (leere) Registry übernehmbar. Sie decken die vier wichtigsten Fälle ab: Jedermann-Selbstbezug (Personio), Jedermann-Einreichung (Seibert Documents), rollenspezifisch mit `hidden: true` (Reddit) und schreibender Fachprozess mit Zustimmungspflicht (Vertragsdatenbank). Die Scope-Keys folgen der bestehenden `Scope_key_format`-Constraint (ein Doppelpunkt, Objektebene per Punkt).

Alle Slugs bestehen die `Skill_slug_format`-Prüfung aus Migration `0007`, und alle `weldall request`-Aufrufe nutzen ausschließlich die dokumentierten CLI-Flags (`--method`, `--scope`, `--json`, `--header`); der Datei-Upload läuft deshalb als Base64 im JSON-Body — ein natives `--file` wäre eine CLI-Erweiterung mit eigener DPoP-Betrachtung. Die Adapter-URLs sind Platzhalter, bis die jeweilige Resource registriert ist.

---

## Skill 1: `personio.urlaubssaldo`

```md
---
title: "Urlaubssaldo abfragen"
requiredScopes:
  - "personio:me.read"
hidden: false
---

Frage den eigenen Urlaubssaldo und die eigenen Abwesenheiten ab:

`weldall request --scope personio:me.read https://personio.seibert.tools/api/me/absences/balance`

Die Antwort enthält Resturlaub (Tage), bereits genehmigte und beantragte
Abwesenheiten des laufenden Jahres. Für die Liste einzelner Abwesenheiten:

`weldall request --scope personio:me.read https://personio.seibert.tools/api/me/absences`

Wichtig:

- Der Zugriff ist strikt auf die eigene Person begrenzt. Der Adapter leitet
  die Identität aus dem Weldall-Token ab; eine Mitarbeiter-ID wird nicht
  übergeben und würde abgelehnt.
- Salden anderer Personen sind über diesen Skill nicht abrufbar, auch nicht
  für Führungskräfte (dafür existiert ein eigener Skill mit
  `personio:employees.read`).
- Nenne bei der Antwort an den Menschen immer den Stichtag der Abfrage, da
  genehmigte Anträge den Saldo sofort verändern.
```

## Skill 2: `documents.beleg-einreichen`

```md
---
title: "Beleg für die Buchhaltung einreichen"
requiredScopes:
  - "documents:receipts.create"
hidden: false
---

Reiche einen Beleg (PDF, JPG oder PNG) beim zentralen Belegserver ein. Die
Datei wird Base64-codiert im JSON-Body übergeben:

`weldall request --method POST --scope documents:receipts.create --json '{"filename":"rechnung.pdf","contentBase64":"<base64 der Datei>","description":"Bahnfahrt Kundentermin","date":"2026-07-24","amount":24.50,"currency":"EUR"}' https://documents.seibert.tools/api/receipts`

Regeln:

- Ein Beleg pro Request. Mehrseitige Belege als ein PDF, nicht als
  Einzelbilder.
- `description` kurz und konkret („Bahnfahrt Kundentermin", nicht „Beleg").
  `date` ist das Belegdatum, nicht das Einreichdatum.
- Die Antwort enthält eine `receiptId` und den Status `submitted`. Nenne dem
  Menschen die `receiptId` als Referenz.
- Der Server dedupliziert per Datei-Hash: Dieselbe Datei erneut einzureichen
  liefert die bestehende `receiptId` zurück und legt keinen zweiten Beleg an.
  Den Status der eigenen Einreichungen liefert `documents:receipts.read`; die
  Klassifizierung übernimmt Finance.
- Bei Ablehnung (`rejected`) steht der Grund im Statusfeld — erst beheben
  (z. B. lesbares PDF), dann neu einreichen.
```

## Skill 3: `reddit.kampagnen-analyse`

```md
---
title: "Reddit-Ads-Kampagnen auswerten"
requiredScopes:
  - "reddit:ads.read"
hidden: true
---

Ziehe einen Performance-Report über den Reddit-Ads-Adapter:

`weldall request --scope reddit:ads.read "https://reddit.seibert.tools/api/reports?from=2026-07-01&to=2026-07-14&by=campaign,ad_group"`

Die Antwort liefert pro Kampagne/Ad-Group: Spend, Impressions, Clicks und
Conversions (SignUps aus Pixel + Conversions API). Kennzahlen daraus
berechnen, nicht schätzen:

- CTR = Clicks / Impressions
- CPC = Spend / Clicks
- CPA = Spend / Conversions
- Conversion-Rate = Conversions / Clicks

Hinweise:

- Eine Conversion ist ein SignUp, kein Kauf. Für ROAS-Aussagen den erwarteten
  Umsatz je SignUp vom Menschen erfragen, nie einen Plan-Preis unterstellen.
- Zeiträume unter 7 Tagen sind für Pause/Scale-Empfehlungen zu verrauscht —
  darauf hinweisen.
- Dieser Skill ist read-only. Kampagnen ändern braucht `reddit:ads.write`,
  Conversion-Events senden braucht `reddit:conversions.send`; beides ist
  bewusst nicht Teil dieses Skills.
```

## Skill 4: `contracts.analyse-ablegen`

```md
---
title: "Vertragsanalyse in der Vertragsdatenbank ablegen"
requiredScopes:
  - "contracts:analyses.create"
hidden: false
---

Lege den Bericht eines `/contract-analysis`-Laufs in der Vertragsdatenbank ab.
Alle Felder stammen aus der Marker-Zeile, die jeder Bericht in Zeile 1 trägt:

`weldall request --method POST --scope contracts:analyses.create --json '{"report":"CONTRACT-ANALYSIS-REPORT | v0.3.0 | id:20260724-142300 | doc:NDA Acme.pdf | type:NDA | flags:R0/O1/Y2 | class:B | legal:NEIN | date:2026-07-24\n\n<vollständiger Berichtstext>","skillVersion":"0.3.0","runId":"20260724-142300","documentName":"NDA Acme.pdf","documentType":"NDA","flagsRed":0,"flagsOrange":1,"flagsYellow":2,"riskClass":"B","legalRecommendation":"NEIN","analyzedAt":"2026-07-24","contract":{"documentName":"NDA Acme.pdf","company":"SeibertGroupGmbH","contractTypes":["NDA"]}}' https://contracts.seibert.tools/api/analyses`

Regeln:

- **Erst vorschlagen, dann ablegen.** Biete die Ablage nach jedem Lauf von
  Dir aus an, führe sie aber erst nach ausdrücklicher Zustimmung des Menschen
  aus. Der Datensatz ist dauerhaft — es gibt weder einen Lösch- noch einen
  Änderungs-Scope, ein Fehlgriff bleibt in der geteilten Datenbank stehen.
- `runId` ist die Idempotenz-Klammer: Dieselbe `runId` erneut zu senden legt
  keinen zweiten Datensatz an, sondern liefert den bestehenden zurück. Nach
  Timeout oder Abbruch also **denselben** Request wiederholen — eine frisch
  gewürfelte `runId` erzeugt eine Dublette.
- `riskClass` (`A`/`B`/`C`) ist das Routing-Signal, nicht die Ampel-Zählung.
  `flagsRed/Orange/Yellow` sind Statistik. `riskClass: "C"` verlangt
  `legalRecommendation: "JA"`; die Gegenprobe weist der Server ab.
- Genau eines von `contractId` (bestehender Vertrag) **oder** `contract`
  (Vertrag mit anlegen) — nie beides, nie keines. Ohne bekannten Vertrag legt
  der Server einen mit Status „Unter Prüfung" an: Die Analyse ist dann der
  Beleg dafür, dass es den Vertrag überhaupt gibt.
- Die Antwort enthält `analysisId` und `contractId`. Nenne dem Menschen
  beide — die `contractId` ist der Einstieg für jede spätere Rückfrage.
- Klasse C bedeutet **Business-Freigabe durch die Geschäftsführung**, nicht
  „Legal muss freigeben". Dieser Skill legt ab und benennt die Klasse; er holt
  keine Freigabe ein und ersetzt keine.
- Analysen lesen braucht `contracts:analyses.read`, Verträge pflegen
  `contracts:contracts.create` — beides ist bewusst nicht Teil dieses Skills.
```

---

## Was die vier Beispiele zeigen sollen

1. **`hidden` richtig eingesetzt:** Die beiden Jedermann-Skills sind sichtbar (fehlt der Scope, zeigt Weldall die Lücke — Discovery-Effekt für den @helpme-Antrag). Der Reddit-Skill ist `hidden: true`: außerhalb des Marketings existiert er nicht.
2. **Skills erklären Verhalten, nicht nur Syntax:** Selbstbezug-Grenze (Personio), Idempotenz-Regel (Documents), Metrik-Disziplin (Reddit). Genau das unterscheidet kuratierte Skills von generierter API-Doku.
3. **Scope-Grenzen werden im Text benannt:** Jeder Skill sagt, was er bewusst *nicht* kann und welcher Scope dafür nötig wäre — der Agent kann dem Menschen den nächsten Schritt nennen, statt zu raten.
4. **Zustimmung vor irreversiblen Schreibzugriffen:** Der Vertragsskill schreibt dauerhaft in eine geteilte Datenbank ohne Lösch-Pfad. Deshalb steht die Zustimmungspflicht im Skill-Text selbst, nicht in einer Betriebsanleitung daneben: Der Scope erlaubt den Schreibzugriff, der Skill regelt, wann er ausgeübt wird.

Der vierte Fall ist zugleich der handfeste Rollout-Anlass: Heute braucht jede Person, die eine Vertragsanalyse ablegen soll, einen manuell ausgestellten API-Key mit Schreibrecht auf die Vertragsdatenbank. Genau dieser Ausstell-Schritt ist der Engpass, den Weldall ersetzt — der Scope-Antrag läuft über den @helpme-Bot, der Key bleibt im Adapter.
