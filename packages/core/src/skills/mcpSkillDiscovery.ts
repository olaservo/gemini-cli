/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { debugLogger } from '../utils/debugLogger.js';
import type { SkillDefinition } from './skillLoader.js';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILL_INDEX_URI = 'skill://index.json';

// Skill names become XML attribute values, z.enum variants, and UI labels —
// names from untrusted servers must match this allowlist exactly.
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Cap description length; descriptions flow into model prompts verbatim.
const MAX_DESCRIPTION_LENGTH = 500;

// Strip ASCII control chars except \t, \n, \r — descriptions reach the model
// and the UI, and embedded control bytes have no legitimate use there.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

interface SkillIndexEntry {
  type: 'skill-md' | 'mcp-resource-template' | string;
  description: string;
  url: string;
  name?: string;
}

interface SkillIndex {
  skills?: SkillIndexEntry[];
}

/**
 * Returns true if the server's initialize capabilities declare the
 * skills-over-MCP SEP extension. Checks both the SEP-2133 `extensions` slot
 * and the older `experimental` slot to tolerate SDK versions in transition.
 */
export function declaresSkillsExtension(client: Client): boolean {
  const caps = client.getServerCapabilities() as
    | {
        extensions?: Record<string, unknown>;
        experimental?: Record<string, unknown>;
      }
    | undefined;
  if (!caps) return false;
  if (caps.extensions?.[SKILLS_EXTENSION_ID]) return true;
  if (caps.experimental?.[SKILLS_EXTENSION_ID]) return true;
  return false;
}

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function hasUriScheme(value: string): boolean {
  return SCHEME_PATTERN.test(value);
}

/**
 * Returns the directory-style prefix of a `<scheme>://...` URI (everything up
 * to and including the final `/`), or `undefined` if `uri` has no scheme or
 * no authority/path segment. Used by callers that need to enumerate sibling
 * resources under the same skill root.
 */
export function uriParentPrefix(uri: string): string | undefined {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd < 0) return undefined;
  const lastSlash = uri.lastIndexOf('/');
  if (lastSlash <= schemeEnd + 2) return undefined;
  return uri.slice(0, lastSlash + 1);
}

/**
 * Best-effort fallback for deriving a skill name from its URI when the index
 * entry omits the `name` field. For `skill://` URIs the SEP guarantees the
 * final segment before the file is the skill name; for other schemes this is
 * only a heuristic and callers SHOULD rely on the entry's `name` field.
 */
function extractIndexName(url: string): string | undefined {
  if (!hasUriScheme(url)) return undefined;
  const schemeEnd = url.indexOf('://');
  const withoutScheme = url.slice(schemeEnd + 3);
  const parts = withoutScheme.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts[parts.length - 2];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isSkillIndexEntry(value: unknown): value is SkillIndexEntry {
  if (!isRecord(value)) return false;
  if (!isString(value['type'])) return false;
  if (!isString(value['description'])) return false;
  if (!isString(value['url'])) return false;
  if (
    'name' in value &&
    value['name'] !== undefined &&
    !isString(value['name'])
  ) {
    return false;
  }
  return true;
}

function sanitizeDescription(description: string): string {
  const stripped = description.replace(CONTROL_CHAR_PATTERN, ' ');
  if (stripped.length <= MAX_DESCRIPTION_LENGTH) return stripped;
  return `${stripped.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

function parseIndexPayload(payload: unknown): SkillIndex | null {
  if (!isRecord(payload)) return null;
  const skills = payload['skills'];
  if (!Array.isArray(skills)) return null;
  return { skills: skills.filter(isSkillIndexEntry) };
}

/**
 * Discover MCP-served skills from a connected server per the skills-over-MCP
 * SEP. Reads `skill://index.json` and materializes each `skill-md` entry as
 * a `SkillDefinition` with an empty body (body is fetched lazily on
 * activation).
 *
 * Template entries (`mcp-resource-template`) are logged and skipped in v1.
 *
 * Missing index or read errors resolve to an empty array — this is the
 * expected state for servers that don't implement the SEP, and for servers
 * that declare the extension but haven't published an index yet.
 */
export async function discoverMcpSkills(
  client: Client,
  serverName: string,
): Promise<SkillDefinition[]> {
  let raw;
  try {
    raw = await client.readResource({ uri: SKILL_INDEX_URI });
  } catch (error) {
    debugLogger.debug(
      `No skill://index.json on server '${serverName}' (treating as no skills): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  let indexText: string | undefined;
  if (raw && Array.isArray(raw.contents)) {
    for (const content of raw.contents) {
      if ('text' in content && typeof content.text === 'string') {
        indexText = content.text;
        break;
      }
    }
  }
  if (!indexText) {
    debugLogger.debug(
      `skill://index.json on server '${serverName}' returned no text content; skipping.`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch (error) {
    debugLogger.warn(
      `skill://index.json on server '${serverName}' is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  const index = parseIndexPayload(parsed);
  if (!index || !index.skills) {
    debugLogger.warn(
      `skill://index.json on server '${serverName}' does not match the discovery schema; skipping.`,
    );
    return [];
  }

  const definitions: SkillDefinition[] = [];
  let templateSkipCount = 0;
  for (const entry of index.skills) {
    if (entry.type === 'mcp-resource-template') {
      templateSkipCount++;
      continue;
    }
    if (entry.type !== 'skill-md') {
      debugLogger.debug(
        `Skipping unknown skill entry type '${entry.type}' on server '${serverName}'.`,
      );
      continue;
    }
    // The SEP SHOULDs `skill://` but MAYs any URI scheme. Accept any
    // well-formed `<scheme>://...` URI; the ResourceRegistry routes reads
    // by (serverName, URI) and `uriParentPrefix` scopes sibling enumeration
    // to the exact scheme+authority+path prefix, so a non-`skill://` scheme
    // is not a cross-server trust boundary.
    if (!hasUriScheme(entry.url)) {
      debugLogger.warn(
        `Skill entry on server '${serverName}' has malformed URL '${entry.url}'; skipping.`,
      );
      continue;
    }
    const name = entry.name ?? extractIndexName(entry.url);
    if (!name) {
      debugLogger.warn(
        `Skill entry on server '${serverName}' with url '${entry.url}' has no name; skipping.`,
      );
      continue;
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      debugLogger.warn(
        `Skill name '${name}' on server '${serverName}' does not match ${SKILL_NAME_PATTERN}; skipping.`,
      );
      continue;
    }
    definitions.push({
      name,
      description: sanitizeDescription(entry.description),
      location: entry.url,
      body: '',
      source: 'mcp',
      mcp: { serverName, skillUri: entry.url },
    });
  }

  if (templateSkipCount > 0) {
    debugLogger.log(
      `Server '${serverName}' published ${templateSkipCount} mcp-resource-template skill entries; those are not rendered in this client yet.`,
    );
  }

  return definitions;
}

export function skillSourceTag(serverName: string): string {
  return `mcp:${serverName}`;
}
