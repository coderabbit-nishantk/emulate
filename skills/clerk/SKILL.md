---
name: clerk
description: Emulated Clerk API for local development and testing. Use when the user needs to manage users and organizations locally, test Clerk auth flows, implement OAuth/OIDC sign-in, manage sessions and JWTs, test invitation workflows, or work with the Clerk Backend API without hitting the real Clerk API. Triggers include "Clerk API", "emulate Clerk", "Clerk auth", "Clerk OAuth", "Clerk users", "CLERK_API_URL", or any task requiring a local auth/identity API.
allowed-tools: Bash(npx --no-install emulate:*), Bash(curl:*)
---

# Clerk API Emulator

Local Clerk Backend API emulation with users, email addresses, organizations, memberships, invitations, sessions, and an OAuth authorization-code flow with PKCE and RS256 JWT signing. Check the application's exact operations against this fork. Backend API registration and OAuth examples do not establish ClerkJS browser-session or production Clerk compatibility.

## Start

Use packages built from your project's pinned CodeRabbit fork revision. The fork's `v0.0.1` tag is commit `7b4ed6d341b48fd21bbe9dab724613aacf3e6987`; its package manifest version is `0.10.0`. The manifest version alone does not identify the fork. The examples use `npx --no-install` so they do not download a different package. If your environment supplies an explicit installed Node CLI command, use that command instead.

```bash
# Clerk only
npx --no-install emulate --service clerk

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const clerk = await createEmulator({ service: "clerk", port: 4000 });
// clerk.url === 'http://localhost:4000'
// Stop only this instance when the caller is finished.
await clerk.close();
```

## Auth

For the standalone CLI and `createEmulator` API, Backend management requests require an Authorization header. This fork supplies a fallback identity for any nonempty bearer token; it does not validate a production Clerk secret key or restrict the token to the `sk_test_*` prefix. Use only synthetic local values. Missing authorization is rejected. Discovery and JWKS are public; OAuth userinfo, client-secret and PKCE checks are separate and remain required below.

```bash
curl http://localhost:4000/v1/users \
  -H "Authorization: Bearer sk_test_emulate"
```

## Pointing Your App at the Emulator

### Client compatibility

The REST examples below are the supported starting point. An endpoint override alone does not establish compatibility with a Clerk SDK. With `@clerk/backend` 3.31.4, this fork's JSON content type causes a successful user response to be returned as text, so the SDK's `user.id` example does not work. Other SDK versions are unverified. Do not change application assertions or emulator authentication to hide that limitation.

### Environment Variable

Set these only for an application or client that explicitly supports the overrides. They do not configure browser cookies, ClerkJS or an operator session by themselves.

```bash
export CLERK_API_URL=http://localhost:4000
export CLERK_SECRET_KEY=sk_test_emulate
```

### Embedded adapters

The adapter does not inherit the standalone fallback authentication described above. The shown synthetic bearer value alone cannot authenticate embedded Backend API management requests in this fork. Use the standalone service for this guide's management and OAuth examples; an embedded setup needs its own verified authentication configuration. Endpoint overrides alone do not configure a ClerkJS browser session.

## Seed Config

```yaml
clerk:
  users:
    - email_addresses:
        - admin@example.com
      first_name: Admin
      last_name: User
      username: admin
      password: test123
    - email_addresses:
        - dev@example.com
      first_name: Developer
      last_name: One
  organizations:
    - name: Acme Corp
      slug: acme
      members:
        - email: admin@example.com
          role: org:admin
        - email: dev@example.com
          role: org:member
  oauth_applications:
    - client_id: emu_clerk_client_id
      client_secret: emu_clerk_client_secret
      name: My App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/clerk
```

Save this example as a YAML file and pass it explicitly with `--seed`; plain startup does not run `init` or load this example automatically. Default seeding creates one user and one confidential OAuth application, but no organization. The supplied seed is additive to those defaults. State is in memory: restart with the same seed to recreate the baseline, and rediscover generated IDs, sessions and tokens after every restart.

## API Endpoints

The following are independent endpoint examples, not a script to run from top to bottom. Replace placeholder IDs with values returned by the current instance before invoking each command. In particular, deleting a resource invalidates later examples using that resource. Keep URLs containing placeholders quoted so the shell cannot interpret them as redirections.

### Users

```bash
TOKEN="sk_test_emulate"
BASE="http://localhost:4000"

# Create user
curl -X POST $BASE/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address": ["user@example.com"], "first_name": "Jane", "last_name": "Doe"}'

# List users (supports ?query=, ?order_by=, repeated ?email_address=)
# order_by supports created_at or updated_at, with an optional leading minus.
curl "$BASE/v1/users?query=jane" \
  -H "Authorization: Bearer $TOKEN"

# Get user count
curl $BASE/v1/users/count \
  -H "Authorization: Bearer $TOKEN"

# Get user by ID
curl "$BASE/v1/users/<userId>" \
  -H "Authorization: Bearer $TOKEN"

# Update user
curl -X PATCH "$BASE/v1/users/<userId>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"first_name": "Updated"}'

# Delete user
curl -X DELETE "$BASE/v1/users/<userId>" \
  -H "Authorization: Bearer $TOKEN"

# Ban / Unban / Lock / Unlock
curl -X POST "$BASE/v1/users/<userId>/ban" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/v1/users/<userId>/unban" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/v1/users/<userId>/lock" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/v1/users/<userId>/unlock" -H "Authorization: Bearer $TOKEN"

# Update metadata
curl -X PATCH "$BASE/v1/users/<userId>/metadata" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"role": "admin"}}'

# Verify password
curl -X POST "$BASE/v1/users/<userId>/verify_password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password": "test123"}'
```

### Email Addresses

```bash
# Get email address
curl "$BASE/v1/email_addresses/<emailId>" \
  -H "Authorization: Bearer $TOKEN"

# Create email address for user
curl -X POST $BASE/v1/email_addresses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx", "email_address": "alt@example.com", "verified": true}'

# Update email address
curl -X PATCH "$BASE/v1/email_addresses/<emailId>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"verified": true}'

# Delete email address
curl -X DELETE "$BASE/v1/email_addresses/<emailId>" \
  -H "Authorization: Bearer $TOKEN"
```

### Organizations

```bash
# Create organization
curl -X POST $BASE/v1/organizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Org", "slug": "new-org", "created_by": "user_xxx"}'

# List organizations (supports ?query=)
curl "$BASE/v1/organizations?query=acme" \
  -H "Authorization: Bearer $TOKEN"

# Get organization
curl "$BASE/v1/organizations/<orgId>" \
  -H "Authorization: Bearer $TOKEN"

# Update organization
curl -X PATCH "$BASE/v1/organizations/<orgId>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Org"}'

# Delete organization
curl -X DELETE "$BASE/v1/organizations/<orgId>" \
  -H "Authorization: Bearer $TOKEN"

# Update organization metadata
curl -X PATCH "$BASE/v1/organizations/<orgId>/metadata" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"plan": "enterprise"}}'
```

### Organization Memberships

Memberships have roles (`org:admin`, `org:member`). API-created memberships receive the permissions below. Seeded memberships omit the two domain permissions from the admin list, so do not assume identical permission sets across those creation paths.

```bash
# List memberships
curl "$BASE/v1/organizations/<orgId>/memberships" \
  -H "Authorization: Bearer $TOKEN"

# Add member
curl -X POST "$BASE/v1/organizations/<orgId>/memberships" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx", "role": "org:member"}'

# Update member role
curl -X PATCH "$BASE/v1/organizations/<orgId>/memberships/<userId>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "org:admin"}'

# Remove member
curl -X DELETE "$BASE/v1/organizations/<orgId>/memberships/<userId>" \
  -H "Authorization: Bearer $TOKEN"

# Update membership metadata
curl -X PATCH "$BASE/v1/organizations/<orgId>/memberships/<userId>/metadata" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_metadata": {"team": "engineering"}}'
```

Admin role permissions: `org:sys_profile:manage`, `org:sys_profile:delete`, `org:sys_memberships:read`, `org:sys_memberships:manage`, `org:sys_domains:read`, `org:sys_domains:manage`. Member role: `org:sys_memberships:read`.

### Organization Invitations

```bash
# List invitations (supports ?status=pending)
curl "$BASE/v1/organizations/<orgId>/invitations?status=pending" \
  -H "Authorization: Bearer $TOKEN"

# Get invitation
curl "$BASE/v1/organizations/<orgId>/invitations/<invitationId>" \
  -H "Authorization: Bearer $TOKEN"

# Create invitation
curl -X POST "$BASE/v1/organizations/<orgId>/invitations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_address": "invite@example.com", "role": "org:member"}'

# Bulk create invitations
curl -X POST "$BASE/v1/organizations/<orgId>/invitations/bulk" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email_addresses": ["a@example.com", "b@example.com"], "role": "org:member"}'

# Revoke invitation
curl -X POST "$BASE/v1/organizations/<orgId>/invitations/<invitationId>/revoke" \
  -H "Authorization: Bearer $TOKEN"
```

### Sessions

```bash
# List sessions (supports ?user_id=)
curl "$BASE/v1/sessions?user_id=user_xxx" \
  -H "Authorization: Bearer $TOKEN"

# Get session
curl "$BASE/v1/sessions/<sessionId>" \
  -H "Authorization: Bearer $TOKEN"

# Create session
curl -X POST $BASE/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user_xxx"}'

# Revoke session
curl -X POST "$BASE/v1/sessions/<sessionId>/revoke" \
  -H "Authorization: Bearer $TOKEN"

# Generate session token (JWT)
curl -X POST "$BASE/v1/sessions/<sessionId>/tokens" \
  -H "Authorization: Bearer $TOKEN"

# Generate token from template
curl -X POST "$BASE/v1/sessions/<sessionId>/tokens/<template>" \
  -H "Authorization: Bearer $TOKEN"
```

Session tokens are RS256-signed JWTs containing `sub`, `iss`, `iat`, `nbf`, `exp` and `sid`. They do not contain `aud` or `azp` in this fork. Optional organization and public-metadata claims follow the selected user/session. OAuth ID tokens below are a separate token surface and include `aud`. Template-named token routes do not establish production template fidelity.

### OAuth / OIDC

The token endpoint implements the `authorization_code` grant with PKCE S256. Discovery, JWKS and userinfo are available, but refresh-token and other OAuth grant support is not established. Do not describe this as a full production OAuth server.

```bash
# OpenID Configuration
curl $BASE/.well-known/openid-configuration

# JSON Web Key Set
curl $BASE/v1/jwks

# Authorization (browser flow)
# GET $BASE/oauth/authorize?client_id=xxx&redirect_uri=xxx&response_type=code&scope=openid+profile+email

# Token exchange
curl -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=xxx" \
  -d "redirect_uri=http://localhost:3000/api/auth/callback/clerk" \
  -d "client_id=xxx" \
  -d "client_secret=xxx"

# User info
curl $BASE/oauth/userinfo \
  -H "Authorization: Bearer <access_token>"
```

Supports authorization_code grant with PKCE (S256 code_challenge_method). The authorize endpoint renders a user selection UI where you pick which seeded user to sign in as.

## Common Patterns

### Create User and Add to Organization

```javascript
import { createEmulator } from "emulate";

const emu = await createEmulator({ service: "clerk", port: 4000 });
const post = async (path, body) => {
  const response = await fetch(emu.url + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_test_emulate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Emulator returned HTTP ${response.status}`);
  return response.json();
};

try {
  const user = await post("/v1/users", {
    email_address: ["jane@example.com"],
    first_name: "Jane",
  });
  const org = await post("/v1/organizations", { name: "Engineering" });
  await post(`/v1/organizations/${org.id}/memberships`, {
    user_id: user.id,
    role: "org:admin",
  });
} finally {
  await emu.close();
}
```

### OAuth PKCE Flow

Save the complete example under Seed Config as `clerk-seed.yaml`, then start the service with `npx --no-install emulate --service clerk --seed clerk-seed.yaml`. The flow below uses that seeded client's registered callback and synthetic client secret. Keep the callback identical during authorization and token exchange. A confidential client's secret is required in addition to PKCE.

```bash
BASE="http://localhost:4000"

# 1. Generate PKCE challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr '/+' '_-' | tr -d '=\n')
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '=' | tr '/+' '_-')

# 2. Print the authorization URL, then open it with your browser tool.
printf '%s\n' "$BASE/oauth/authorize?client_id=emu_clerk_client_id&redirect_uri=http://localhost:3000/api/auth/callback/clerk&response_type=code&scope=openid+profile+email&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. After user selects, exchange code for tokens
curl -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=<code_from_redirect>" \
  -d "redirect_uri=http://localhost:3000/api/auth/callback/clerk" \
  -d "client_id=emu_clerk_client_id" \
  -d "client_secret=emu_clerk_client_secret" \
  -d "code_verifier=$CODE_VERIFIER"
```

Guide source: adapted from [vercel-labs/emulate PR #57](https://github.com/vercel-labs/emulate/pull/57), authored by `mvanhorn`, at commit `abef6a26100a66eda5f47541bdb609493c932308`.
