/**
 * Password policy shared by the API. Keep the web checklist in
 * apps/web/src/lib/password.ts in sync with this.
 */
export const PASSWORD_MIN_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[a-z]/.test(password)) return "password must include a lowercase letter";
  if (!/[A-Z]/.test(password)) return "password must include an uppercase letter";
  if (!/[0-9]/.test(password)) return "password must include a number";
  return null;
}
