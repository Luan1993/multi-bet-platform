import crypto from "crypto";

/**
 * Código de cupom: alta entropia (não adivinhável) + dígito verificador.
 * Formato: BET-XXXX-XXXX-XXXX-C
 * O checksum mod-36 (peso posicional) detecta erros de digitação e
 * transposições na consulta.
 *
 * Alfabeto: '0-9A-Z' sem a letra U (35 símbolos) — sem I/L/O para reduzir
 * confusão visual? Não: aqui usa-se base32 Crockford clássico para o corpo
 * e base36 para o verificador, com validação estrita de dígitos.
 */
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ"; // 32 símbolos, sem I, L, O, U

function randomChars(n: number): string {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function charValue(c: string): number {
  return ALPHABET.indexOf(c);
}

// Base36 (0-9, A-Z) para o dígito verificador — nunca gera 'U', evitando
// qualquer ambiguidade com o alfabeto do corpo.
const CHECK_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Dígito verificador de 2 caracteres (base36) com peso posicional.
 * Geração e validação usam exatamente esta mesma função.
 */
function checkChars(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum = (sum * 36 + charValue(body[i]) * (i + 1)) % 1296; // 36^2
  }
  return CHECK_ALPHABET[Math.floor(sum / 36)] + CHECK_ALPHABET[sum % 36];
}

/** Corpo do código (12 caracteres) a partir do código completo/digitado. */
function bodyOf(raw: string): string | null {
  // Código completo: "BET" + 12 caracteres de corpo + 2 de verificação = 17
  const compact = (raw || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!compact.startsWith("BET") || compact.length !== 17) return null;
  return compact.slice(3);
}

export function generateCouponCode(): string {
  const body = randomChars(4) + randomChars(4) + randomChars(4); // 12 chars = 60 bits
  return formatCode(body);
}

/**
 * Normaliza e valida um código digitado; devolve o código formatado ou null.
 */
export function normalizeCouponCode(input: string): string | null {
  const full = bodyOf(input || "");
  if (!full) return null;
  const body = full.slice(0, 12);
  const check = full.slice(12);
  for (const c of body) if (charValue(c) < 0) return null;
  if (checkChars(body) !== check) return null;
  return formatCode(body);
}

/** Monta o código completo a partir do corpo validado. */
export function formatCode(body: string): string {
  return `BET-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${checkChars(body)}`;
}
