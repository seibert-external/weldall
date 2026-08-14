---
title: Group provider HTTP interface
description: The HTTP contract for group and membership data from a group provider.
sidebar:
  label: Group provider API
---

To support a broad range of Active Directory and LDAP environments, Weldall reads groups and current memberships through a small HTTP interface. The supporting web service implements the REST paths described below and returns the shown JSON responses.

Administrators configure the HTTPS origin and a token under **Group providers**.

:::note[Active Directory and LDAP]
The HTTP interface is intentionally small so it can sit in front of different Active Directory and LDAP variants. If the directory does not expose these REST paths itself, an additional proxy translates between the interface and LDAP.
:::

## Authentication

Weldall sends every request with these headers:

```http
Authorization: Token <configured token>
Accept: application/json
```

The base URL must be an HTTPS origin without credentials, a path, query parameters, or a fragment, such as `https://groups.example.com`. Weldall appends the following paths to this origin.

## List groups

```http
GET <baseUrl>/api/management/groups/
```

```json
[
  {
    "ou": "finance",
    "cn": "Finance",
    "description": "Finance team"
  }
]
```

| Field         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `ou`          | Required, stable, case-sensitive group ID.                            |
| `cn`          | Optional display name. Weldall uses `ou` when it is missing or empty. |
| `description` | Optional description. `null` is accepted.                             |

Weldall uses this list for connection tests and optional group searches. Assignment creation treats group IDs as opaque and does not call the provider. Search runs locally across the ID, name, and description. The response may contain at most 10,000 groups.

## Get one group

```http
GET <baseUrl>/api/management/groups/<url-encoded-group-id>/
```

The response uses the same object shape as an entry in the group list. `ou` must exactly match the requested group ID.

## Find a user by email

```http
GET <baseUrl>/api/management/users/?mail=<url-encoded-normalized-email>
```

Weldall trims and lowercases the email address and uses the `mail` query parameter.

```json
[
  {
    "username": "jane.doe",
    "email": "jane.doe@example.com",
    "is_active": true
  }
]
```

The response must be an array with zero or exactly one result. With no result, the provider contributes no group-based scopes. Multiple results or an email mismatch are rejected.

| Field       | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `username`  | Required, stable user ID at the provider.         |
| `email`     | Required user email address.                      |
| `is_active` | Only active users can receive group-based scopes. |

## Get a user with groups

```http
GET <baseUrl>/api/management/users/<url-encoded-user-id>/
```

```json
{
  "username": "jane.doe",
  "email": "jane.doe@example.com",
  "is_active": true,
  "groups": ["finance", "employees"]
}
```

`username` and the normalized `email` must match the earlier search result. The user must still be active. `groups` contains the user's effective group IDs and may have at most 10,000 entries. Weldall does not resolve nested groups itself.

## Response rules and limits

Every endpoint must return a successful HTTP status with `Content-Type: application/json`. Additional object fields are accepted and discarded.

- Group IDs, usernames, and entries in `groups` contain 1 to 191 characters after trimming.
- Group names contain at most 191 characters. Descriptions contain at most 2,000 characters.
- Email addresses must be valid and contain at most 320 characters.
- A response may be at most 5 MiB and must arrive within 5 seconds.
- Weldall does not follow redirects, retry failed requests, or cache provider responses on the server.

Weldall fetches membership again for every new authorization decision. Invalid responses, inactive users, timeouts, and provider failures do not create group-based scopes.

:::note[Effective scopes]
An employee's effective scopes are the union of group scopes and scopes assigned directly to their email address. If the provider is temporarily unavailable, the email scopes remain available.
:::
