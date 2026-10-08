/**
 * Money for AdhikarAI.
 *
 * Every monetary value in this system is an integer number of PAISE held in a
 * `bigint`. There are no floats in any financial path, ever. Benefit amounts
 * are reconciled, differenced and accumulated across months, and float drift
 * in a ledger that claims to tell a citizen what they are owed is not an
 * acceptable failure mode.
 *
 * Two further rules this module exists to enforce:
 *
 *   1. Parsing never guesses. `fromRupeeString("unknown")` throws rather than
 *      returning zero, because turning an unknown amount into zero is the
 *      exact mistake this product exists to avoid.
 *   2. Negative results are preserved. Clamping happens only when a caller
 *      explicitly asks via `nonNegative`, so a reconciliation shortfall can
 *      never be silently hidden.
 */

/**
 * An integer number of paise.
 *
 * Branded so a raw rupee `number` cannot be passed where paise are expected.
 * Construct with {@link rupees}, {@link paise} or {@link fromRupeeString}.
 */
export type Paise = bigint & { readonly __brand: "Paise" };

const brand = (v: bigint): Paise => v as Paise;

/** Tolerance for float-to-paise conversion, well below one paise. */
const EPSILON = 1e-9;

export const ZERO: Paise = brand(0n);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Wrap an exact integer count of paise. */
export function paise(value: bigint | number): Paise {
  if (typeof value === "bigint") return brand(value);

  if (!Number.isFinite(value)) {
    throw new RangeError(`paise() requires a finite number, received ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `paise() requires an integer number of paise, received ${value}. ` +
        `Use rupees() to convert a rupee amount.`,
    );
  }
  return brand(BigInt(value));
}

/**
 * Convert a rupee amount to paise.
 *
 * Accepts amounts with exact paise (`10.5` -> 1050 paise) and rejects anything
 * finer, rather than truncating and introducing drift.
 */
export function rupees(value: number): Paise {
  if (!Number.isFinite(value)) {
    throw new RangeError(`rupees() requires a finite number, received ${value}`);
  }

  const scaled = value * 100;
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > EPSILON) {
    throw new RangeError(
      `rupees(${value}) is finer than one paise. Amounts must be exact to ` +
        `the paise; rounding here would drift a citizen's ledger.`,
    );
  }

  return brand(BigInt(rounded));
}

/**
 * Parse a human-written rupee string.
 *
 * Handles the rupee sign, an `Rs.` prefix, surrounding whitespace, Indian
 * digit grouping (`1,20,000`) and an optional one- or two-digit paise
 * component. Throws on anything else: an unparseable amount is unknown, and
 * unknown is never zero.
 */
export function fromRupeeString(input: string): Paise {
  const cleaned = input
    .replace(/₹/g, "")
    .replace(/\bRs\.?/gi, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");

  if (cleaned === "") {
    throw new SyntaxError(`fromRupeeString() received no amount in "${input}"`);
  }

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new SyntaxError(
      `fromRupeeString() could not parse "${input}" as a rupee amount. ` +
        `An unparseable amount is unknown, and unknown must not become zero.`,
    );
  }

  const [, sign, whole, fraction = ""] = match;
  const paisePart = fraction.padEnd(2, "0");
  const total = BigInt(whole) * 100n + BigInt(paisePart);

  return brand(sign === "-" ? -total : total);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Group an integer string with Indian digit separators: the last three digits,
 * then groups of two (`12000000` -> `1,20,000`).
 *
 * Done by hand rather than through `Intl` so output is byte-identical across
 * Node and ICU versions, which keeps it safe to assert on in tests and stable
 * in server-rendered markup.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;

  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);

  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/**
 * Format paise for display, e.g. `₹1,20,000` or `₹2,000.50`.
 *
 * Paise are shown only when non-zero, so whole-rupee benefit amounts read the
 * way a citizen expects.
 */
export function formatINR(value: Paise | bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const whole = absolute / 100n;
  const remainder = absolute % 100n;

  const grouped = groupIndian(whole.toString());
  const body =
    remainder === 0n
      ? grouped
      : `${grouped}.${remainder.toString().padStart(2, "0")}`;

  return `${negative ? "-" : ""}₹${body}`;
}

/**
 * Rupees as a `number`, for display and charting only.
 *
 * Never feed this back into a calculation: that is precisely the float path
 * this module exists to prevent.
 */
export function toRupeeNumber(value: Paise | bigint): number {
  return Number(value) / 100;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(a: Paise | bigint, b: Paise | bigint): Paise {
  return brand(a + b);
}

export function sub(a: Paise | bigint, b: Paise | bigint): Paise {
  return brand(a - b);
}

/** Multiply by an integer count, e.g. installments per year. */
export function mulInt(value: Paise | bigint, count: number): Paise {
  if (!Number.isInteger(count)) {
    throw new RangeError(
      `mulInt() requires an integer multiplier, received ${count}`,
    );
  }
  return brand(value * BigInt(count));
}

export function sumPaise(values: readonly (Paise | bigint)[]): Paise {
  return brand(values.reduce<bigint>((total, v) => total + v, 0n));
}

export function isZero(value: Paise | bigint): boolean {
  return value === 0n;
}

export function isNegative(value: Paise | bigint): boolean {
  return value < 0n;
}

export function isPositive(value: Paise | bigint): boolean {
  return value > 0n;
}

export function abs(value: Paise | bigint): Paise {
  return brand(value < 0n ? -value : value);
}

/** Clamp a negative amount to zero. Always an explicit decision at the call site. */
export function nonNegative(value: Paise | bigint): Paise {
  return brand(value < 0n ? 0n : value);
}

export function maxPaise(a: Paise | bigint, b: Paise | bigint): Paise {
  return brand(a > b ? a : b);
}

export function minPaise(a: Paise | bigint, b: Paise | bigint): Paise {
  return brand(a < b ? a : b);
}

/** True when the two amounts differ by no more than `tolerance`. */
export function withinTolerance(
  a: Paise | bigint,
  b: Paise | bigint,
  tolerance: Paise | bigint,
): boolean {
  return abs(sub(a, b)) <= abs(tolerance);
}

// ---------------------------------------------------------------------------
// JSON boundary
// ---------------------------------------------------------------------------

/**
 * `BigInt` cannot be passed to `JSON.stringify`, so paise cross any API or
 * server-to-client boundary as decimal strings. Keeping this explicit means a
 * forgotten conversion fails loudly instead of shipping a mangled amount.
 */
export function serialize(value: Paise | bigint): string {
  return value.toString();
}

export function deserialize(value: string): Paise {
  if (!/^-?\d+$/.test(value)) {
    throw new SyntaxError(
      `deserialize() expected a decimal paise string, received "${value}"`,
    );
  }
  return brand(BigInt(value));
}
