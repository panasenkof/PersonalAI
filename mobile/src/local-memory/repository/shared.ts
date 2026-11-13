/** Shared connection-local SQL primitives for canonical repository submodules. */
import type * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";

export type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
export type Row = Record<string, unknown>;
export const now = (): string => new Date().toISOString();
export const uid = (): string => Crypto.randomUUID();
export const TEXT = (value: unknown) => typeof value === "string" ? value : null;
