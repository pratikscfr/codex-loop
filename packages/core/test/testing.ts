/**
 * A tiny vitest-style API (describe / it / expect) on top of node:test and node:assert.
 * It keeps the test suite dependency-free: `node --import tsx --test` is all that is needed,
 * so there is no bundler or native binding to break on a contributor's machine or in CI.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

export { describe, it };

const ARRAY_CONTAINING = Symbol("arrayContaining");
interface ArrayContaining {
  [ARRAY_CONTAINING]: true;
  items: unknown[];
}

function isArrayContaining(v: unknown): v is ArrayContaining {
  return typeof v === "object" && v !== null && ARRAY_CONTAINING in v;
}

function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return typeof needle === "string" && haystack.includes(needle);
  if (Array.isArray(haystack)) {
    return haystack.some((item) => {
      try {
        assert.deepStrictEqual(item, needle);
        return true;
      } catch {
        return false;
      }
    });
  }
  return false;
}

class Expectation {
  constructor(
    private readonly actual: unknown,
    private readonly negated = false,
    private readonly label?: string
  ) {}

  get not(): Expectation {
    return new Expectation(this.actual, !this.negated, this.label);
  }

  private check(ok: boolean, message: string): void {
    const pass = this.negated ? !ok : ok;
    if (!pass) assert.fail(`${this.label ? `${this.label}: ` : ""}${this.negated ? "expected NOT: " : "expected: "}${message}`);
  }

  toBe(expected: unknown): void {
    this.check(Object.is(this.actual, expected), `${JSON.stringify(this.actual)} to be ${JSON.stringify(expected)}`);
  }

  toEqual(expected: unknown): void {
    if (isArrayContaining(expected)) {
      const ok = Array.isArray(this.actual) && expected.items.every((e) => includes(this.actual, e));
      this.check(ok, `${JSON.stringify(this.actual)} to contain all of ${JSON.stringify(expected.items)}`);
      return;
    }
    let ok = true;
    try {
      assert.deepStrictEqual(this.actual, expected);
    } catch {
      ok = false;
    }
    this.check(ok, `${JSON.stringify(this.actual)} to equal ${JSON.stringify(expected)}`);
  }

  toContain(item: unknown): void {
    this.check(includes(this.actual, item), `${JSON.stringify(this.actual)} to contain ${JSON.stringify(item)}`);
  }

  toMatch(re: RegExp): void {
    this.check(typeof this.actual === "string" && re.test(this.actual), `${JSON.stringify(this.actual)} to match ${re}`);
  }

  toBeNull(): void {
    this.check(this.actual === null, `${JSON.stringify(this.actual)} to be null`);
  }

  toBeUndefined(): void {
    this.check(this.actual === undefined, `${JSON.stringify(this.actual)} to be undefined`);
  }

  toBeTruthy(): void {
    this.check(Boolean(this.actual), `${JSON.stringify(this.actual)} to be truthy`);
  }

  toBeGreaterThan(n: number): void {
    this.check(typeof this.actual === "number" && this.actual > n, `${JSON.stringify(this.actual)} to be > ${n}`);
  }

  toBeLessThanOrEqual(n: number): void {
    this.check(typeof this.actual === "number" && this.actual <= n, `${JSON.stringify(this.actual)} to be <= ${n}`);
  }

  toHaveLength(n: number): void {
    const len = (this.actual as { length?: number } | null)?.length;
    this.check(len === n, `length ${len} to be ${n}`);
  }

  toThrow(pattern?: RegExp | string): void {
    let threw = false;
    let message = "";
    try {
      (this.actual as () => unknown)();
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    const ok = threw && (pattern === undefined || (typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)));
    this.check(ok, `function to throw${pattern ? ` ${pattern}` : ""} (got ${threw ? JSON.stringify(message) : "no throw"})`);
  }

  get rejects(): { toThrow(pattern?: RegExp | string): Promise<void>; toMatchObject(partial: Record<string, unknown>): Promise<void> } {
    const promise = this.actual as Promise<unknown>;
    const negated = this.negated;
    const settle = async (): Promise<unknown> => {
      try {
        await promise;
      } catch (err) {
        return err;
      }
      return undefined;
    };
    return {
      toThrow: async (pattern) => {
        const err = await settle();
        const message = err instanceof Error ? err.message : String(err ?? "");
        const ok = err !== undefined && (pattern === undefined || (typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)));
        if (negated ? ok : !ok) assert.fail(`expected promise to reject${pattern ? ` with ${pattern}` : ""}; got ${err === undefined ? "resolution" : JSON.stringify(message)}`);
      },
      toMatchObject: async (partial) => {
        const err = await settle();
        const ok = err !== undefined && Object.entries(partial).every(([k, v]) => (err as Record<string, unknown>)[k] === v);
        if (negated ? ok : !ok) assert.fail(`expected rejection matching ${JSON.stringify(partial)}; got ${JSON.stringify(err)}`);
      }
    };
  }
}

export function expect(actual: unknown, label?: string): Expectation {
  return new Expectation(actual, false, label);
}

expect.arrayContaining = (items: unknown[]): ArrayContaining => ({ [ARRAY_CONTAINING]: true, items });
