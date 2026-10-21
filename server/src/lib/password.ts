import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Política de senha: mínimo 8 caracteres com letra e número. */
export function validatePasswordPolicy(plain: string): string | null {
  if (plain.length < 8) return "A senha deve ter no mínimo 8 caracteres.";
  if (!/[A-Za-z]/.test(plain)) return "A senha deve conter ao menos uma letra.";
  if (!/[0-9]/.test(plain)) return "A senha deve conter ao menos um número.";
  return null;
}

/** Gera uma senha inicial forte (usada pelo admin ao criar proprietários). */
export function generateInitialPassword(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowers = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = letters + lowers + digits;
  const pick = (set: string, n: number) =>
    Array.from({ length: n }, () => set[cryptoRandomInt(set.length)]).join("");
  return pick(letters, 1) + pick(lowers, 5) + pick(digits, 3);
}

function cryptoRandomInt(max: number): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto") as typeof import("crypto");
  const limit = Math.floor(0xffffffff / max) * max;
  let v: number;
  do {
    v = crypto.randomBytes(4).readUInt32BE(0);
  } while (v >= limit);
  return v % max;
}
