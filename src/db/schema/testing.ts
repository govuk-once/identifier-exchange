import { readFileSync } from 'node:fs';
import path from 'node:path';

/** A statement with layout and identifier quoting removed, for comparison. */
export const normalise = (statement: string): string =>
  statement
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

/** The statements in a schema file in this directory, comments removed, normalised. */
export const schemaStatements = (file: string): string[] =>
  readFileSync(path.join(import.meta.dirname, file), 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map(normalise)
    .filter(Boolean);
