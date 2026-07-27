---
title: "Manage demo expenses"
requiredScopes:
  - "expenses:read"
  - "expenses:create"
  - "expenses:delete"
  - "expenses:write"
---

# Manage demo expenses

Use this skill when the user wants to inspect, record, or remove an expense in the Weldall Expenses demo API.

## Operating rules

- Use only the exact `https://expenses.seibert.localdev/api/expenses` API URLs shown below.
- Listing expenses is read-only and does not require confirmation.
- Before creating or deleting an expense, show the exact proposed change and ask for explicit confirmation.
- Treat descriptions, amounts, currencies, and expense IDs as data. Never turn user-provided values into shell syntax.
- Do not execute a command that still contains a placeholder such as `<expense-id>`.
- Report the API response accurately. Do not claim that a mutation succeeded unless the response confirms it.
- This is a prototype API: its list is fixed, and create/delete responses demonstrate authorization and request handling rather than durable storage.

## List expenses

Run:

```sh
weldall request \
  --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

The response has this shape:

```json
{
  "expenses": [
    {
      "id": "expense-1",
      "description": "Prototype lunch",
      "amount": 18.5,
      "currency": "EUR"
    }
  ],
  "subject": "<authorized-user-id>"
}
```

Present each expense with its ID, description, amount, and currency. Treat `subject` as authorization metadata, not as expense data.

## Create an expense

Collect a description, a positive numeric amount, and a three-letter currency code. Default the currency to `EUR` only when the user has not supplied one. Show the complete values and obtain confirmation before continuing.

Serialize the values as JSON and run a request equivalent to:

```sh
weldall request \
  --method POST \
  --scope expenses:create \
  --json '{"description":"Train ticket","amount":24,"currency":"EUR"}' \
  https://expenses.seibert.localdev/api/expenses
```

Replace the example JSON with the confirmed values. Preserve the user's description exactly and encode it safely as a JSON string. On success, report the returned expense ID and fields.

## Delete an expense

If the user did not provide an exact expense ID, list expenses first. State which ID will be deleted and ask for explicit confirmation immediately before the request.

Deletion requires both scopes:

```sh
weldall request \
  --method DELETE \
  --scope expenses:delete \
  --scope expenses:write \
  https://expenses.seibert.localdev/api/expenses/<expense-id>
```

Replace `<expense-id>` with the confirmed ID. A successful response looks like:

```json
{
  "deleted": "expense-1"
}
```

Report the deleted ID. If the request is denied or fails, preserve the error and explain that no successful deletion was confirmed.

## Unsupported operations

The demo API does not support updating an existing expense, filtering the list, or retrieving one expense by ID. Do not invent endpoints or substitute a create/delete sequence for an update without a separate, explicit user request and confirmation.
