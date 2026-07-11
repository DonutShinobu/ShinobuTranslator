import { describe, expect, it } from "vitest";
import {
  buildOpenAiAuthorizeUrl,
  buildOpenAiTokenExpiresAt,
  decodeJwtPayload,
  isOpenAiOAuthRefreshSuperseded,
  isOpenAiOAuthExpired,
  isPermanentOpenAiOAuthRefreshFailure,
  normalizeOpenAiOAuthTokenResponse,
  openAiOAuthLoopbackRedirectUri,
  parseOpenAiOAuthCallbackUrl,
} from "../../src/shared/openaiOAuth";

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encode = (value: string) =>
    Buffer.from(value)
      .toString("base64url");
  return `${encode('{"alg":"none"}')}.${encode(JSON.stringify(payload))}.sig`;
}

describe("buildOpenAiAuthorizeUrl", () => {
  it("builds a PKCE authorization URL for the OpenAI loopback redirect URI", () => {
    const url = new URL(buildOpenAiAuthorizeUrl({
      clientId: "client-123",
      redirectUri: openAiOAuthLoopbackRedirectUri,
      codeChallenge: "challenge",
      state: "state-123",
      originator: "shinobu_translator",
    }));

    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1457/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access api.connectors.read api.connectors.invoke");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("shinobu_translator");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("parseOpenAiOAuthCallbackUrl", () => {
  it("extracts the authorization code and state from the loopback callback", () => {
    expect(parseOpenAiOAuthCallbackUrl("http://localhost:1457/auth/callback?code=code-123&state=state-123")).toEqual({
      code: "code-123",
      state: "state-123",
    });
  });

  it("extracts OpenAI authorization errors from the loopback callback", () => {
    expect(parseOpenAiOAuthCallbackUrl("http://localhost:1457/auth/callback?error=access_denied&error_description=nope&state=state-123")).toEqual({
      error: "access_denied",
      errorDescription: "nope",
      state: "state-123",
    });
  });

  it("ignores unrelated URLs", () => {
    expect(parseOpenAiOAuthCallbackUrl("https://example.com/auth/callback?code=code-123&state=state-123")).toBeNull();
  });
});

describe("decodeJwtPayload", () => {
  it("decodes url-safe JWT payload JSON", () => {
    expect(decodeJwtPayload(jwtWithPayload({ email: "user@example.com", exp: 123 }))).toEqual({
      email: "user@example.com",
      exp: 123,
    });
  });
});

describe("normalizeOpenAiOAuthTokenResponse", () => {
  it("extracts account metadata and expiration from OAuth tokens", () => {
    const idToken = jwtWithPayload({
      email: "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-1",
        chatgpt_plan_type: "plus",
      },
    });
    const accessToken = jwtWithPayload({ exp: 2000 });

    expect(normalizeOpenAiOAuthTokenResponse({
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "refresh",
    })).toMatchObject({
      idToken,
      accessToken,
      refreshToken: "refresh",
      accountId: "acct-1",
      email: "user@example.com",
      planType: "plus",
      expiresAt: 2000 * 1000,
    });
  });
});

describe("isOpenAiOAuthExpired", () => {
  it("treats tokens inside the refresh window as expired", () => {
    const now = 100_000;
    expect(isOpenAiOAuthExpired({ expiresAt: now + 120_000 }, now)).toBe(true);
    expect(isOpenAiOAuthExpired({ expiresAt: now + 900_000 }, now)).toBe(false);
  });
});

describe("buildOpenAiTokenExpiresAt", () => {
  it("prefers JWT exp over expires_in", () => {
    const accessToken = jwtWithPayload({ exp: 2000 });
    expect(buildOpenAiTokenExpiresAt(accessToken, 3600, 10)).toBe(2_000_000);
  });

  it("falls back to expires_in when access token has no exp claim", () => {
    expect(buildOpenAiTokenExpiresAt("not-a-jwt", 3600, 10)).toBe(3_600_010);
  });
}
);

describe("refresh token safety helpers", () => {
  it("detects when an in-flight refresh belongs to a stale login", () => {
    expect(isOpenAiOAuthRefreshSuperseded({
      refreshToken: "refresh-new",
    }, {
      refreshToken: "refresh-old",
    })).toBe(true);
  });

  it("classifies only explicit refresh-token terminal errors as permanent", () => {
    expect(isPermanentOpenAiOAuthRefreshFailure({
      error: {
        code: "refresh_token_expired",
        message: "expired",
      },
    })).toBe(true);
    expect(isPermanentOpenAiOAuthRefreshFailure({
      error: "server_error",
      message: "temporary outage",
    })).toBe(false);
  });
});
