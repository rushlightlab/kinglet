import type { APIRequestContext, APIResponse } from "@playwright/test";

/** Fails with the status only; response bodies can contain one-time secrets. */
export async function requireOk(response: APIResponse, action: string): Promise<void> {
  if (!response.ok()) {
    throw new Error(`${action} failed with HTTP ${response.status()}`);
  }
}

export async function apiSignIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email, password },
  });

  await requireOk(response, `sign-in for ${email}`);
}
