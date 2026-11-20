import type { TestHarness } from "./harness.js";
import { createTestHarness } from "./harness.js";
import { signIn } from "./request.js";
import type { CookieJar } from "./request.js";
import { seedTestData } from "./seed.js";
import type { SeededTestData } from "./seed.js";

export interface TestSession {
  harness: TestHarness;
  data: SeededTestData;
  adminJar: CookieJar;
  memberJar: CookieJar;
  viewerJar: CookieJar;
  close(): Promise<void>;
}

/**
 * A harness with the baseline fixture, plus a fresh cookie jar for each role.
 * Callers that mutate a shared fixture should mint their own users/keys rather
 * than rotate or remove a baseline credential.
 */
export async function createTestSession(): Promise<TestSession> {
  const harness = await createTestHarness();

  try {
    const data = await seedTestData(harness.storage, harness.auth);

    const admin = await signIn(harness.app, harness.admin.email, harness.admin.password);

    if (!admin.response.ok) {
      throw new Error(`test session: admin sign-in failed (${admin.response.status})`);
    }

    const member = await signIn(harness.app, data.member.email, data.member.password);

    if (!member.response.ok) {
      throw new Error(`test session: member sign-in failed (${member.response.status})`);
    }

    const viewer = await signIn(harness.app, data.viewer.email, data.viewer.password);

    if (!viewer.response.ok) {
      throw new Error(`test session: viewer sign-in failed (${viewer.response.status})`);
    }

    return {
      harness,
      data,
      adminJar: admin.jar,
      memberJar: member.jar,
      viewerJar: viewer.jar,
      close: harness.close,
    };
  } catch (err) {
    try {
      await harness.close();
    } catch (closeErr) {
      // Preserve the setup failure; cleanup trouble must not mask it.
      console.warn("[kinglet-test] session cleanup failed:", closeErr);
    }

    throw err;
  }
}

/** Signs in as a seeded user and fails loudly when Better Auth rejects it. */
export async function signInUser(
  session: TestSession,
  email: string,
  password: string,
): Promise<CookieJar> {
  const result = await signIn(session.harness.app, email, password);

  if (!result.response.ok) {
    throw new Error(`sign-in failed for ${email} (${result.response.status})`);
  }

  return result.jar;
}
