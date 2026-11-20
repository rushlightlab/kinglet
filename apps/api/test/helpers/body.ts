import { isFiniteNumber, isJsonObject, isString } from "../../src/json.js";
import type { JsonObject, JsonValue } from "../../src/json.js";

/**
 * Response-body readers for integration tests. `Response.json()` is `any`;
 * these narrow it to the JSON domain types so assertions stay type-checked and
 * a malformed response fails with a useful message instead of a TypeError.
 */

export async function jsonBody(response: Response): Promise<JsonObject> {
  let parsed: unknown;

  try {
    parsed = await response.json();
  } catch {
    throw new Error(`expected JSON, received status ${response.status} with a non-JSON body`);
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`expected a JSON object, received status ${response.status}`);
  }

  return parsed;
}

export function objectAt(value: JsonValue | undefined, name: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`"${name}" is not a JSON object`);

  return value;
}

export function arrayAt(value: JsonValue | undefined, name: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`"${name}" is not a JSON array`);

  return value;
}

export function stringAt(value: JsonValue | undefined, name: string): string {
  if (!isString(value)) throw new Error(`"${name}" is not a string`);

  return value;
}

export function numberAt(value: JsonValue | undefined, name: string): number {
  if (!isFiniteNumber(value)) throw new Error(`"${name}" is not a number`);

  return value;
}

export function errorOf(body: JsonObject): string {
  return stringAt(body.error, "error");
}

/** Extracts `events[].message` from a log query response. */
export function messagesOf(body: JsonObject): string[] {
  const messages: string[] = [];

  for (const event of arrayAt(body.events, "events")) {
    messages.push(stringAt(objectAt(event, "event").message, "event.message"));
  }

  return messages;
}
