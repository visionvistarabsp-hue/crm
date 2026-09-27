/**
 * Password policy only - no Node built-ins, so it can be imported from client
 * components as well as server code. The hashing/verification half lives in
 * `password.ts`, which imports `node:crypto` and must stay server-side.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordProblem = string | null;

/** Policy check for signup. Returns a message, or null when acceptable. */
export function checkPasswordPolicy(password: string): PasswordProblem {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain a letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}
