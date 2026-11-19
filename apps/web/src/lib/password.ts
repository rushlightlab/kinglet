/**
 * Keep this in sync with apps/api/src/auth/password.ts.
 */
export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordCheck {
  id: string;
  label: string;
  ok: boolean;
}

export function passwordChecks(value: string): PasswordCheck[] {
  return [
    { id: "length", label: `at least ${PASSWORD_MIN_LENGTH} characters`, ok: value.length >= PASSWORD_MIN_LENGTH },
    { id: "lower", label: "a lowercase letter", ok: /[a-z]/.test(value) },
    { id: "upper", label: "an uppercase letter", ok: /[A-Z]/.test(value) },
    { id: "number", label: "a number", ok: /[0-9]/.test(value) },
  ];
}

export function passwordProblem(value: string): string | null {
  const missing = passwordChecks(value).filter((check) => !check.ok);
  if (missing.length === 0) return null;
  return `Password needs ${missing.map((check) => check.label).join(", ")}.`;
}
