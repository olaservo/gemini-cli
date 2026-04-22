/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  declaresSkillsExtension,
  discoverMcpSkills,
  skillSourceTag,
  SKILLS_EXTENSION_ID,
  SKILL_INDEX_URI,
} from './mcpSkillDiscovery.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

function makeClient({
  capabilities,
  readResourceImpl,
}: {
  capabilities?: unknown;
  readResourceImpl?: (args: { uri: string }) => Promise<unknown>;
}): Client {
  return {
    getServerCapabilities: vi.fn().mockReturnValue(capabilities),
    readResource: vi
      .fn()
      .mockImplementation((args: { uri: string }) =>
        readResourceImpl
          ? readResourceImpl(args)
          : Promise.reject(new Error('not configured')),
      ),
  } as unknown as Client;
}

function textContents(obj: unknown): {
  contents: Array<{ uri?: string; mimeType?: string; text: string }>;
} {
  return {
    contents: [
      {
        uri: SKILL_INDEX_URI,
        mimeType: 'application/json',
        text: typeof obj === 'string' ? obj : JSON.stringify(obj),
      },
    ],
  };
}

describe('declaresSkillsExtension', () => {
  it('returns true when extensions slot carries the SEP id', () => {
    const client = makeClient({
      capabilities: {
        extensions: { [SKILLS_EXTENSION_ID]: {} },
      },
    });
    expect(declaresSkillsExtension(client)).toBe(true);
  });

  it('also accepts the experimental slot as a fallback', () => {
    const client = makeClient({
      capabilities: {
        experimental: { [SKILLS_EXTENSION_ID]: {} },
      },
    });
    expect(declaresSkillsExtension(client)).toBe(true);
  });

  it('returns false when capability is absent', () => {
    const client = makeClient({
      capabilities: { tools: {}, resources: {} },
    });
    expect(declaresSkillsExtension(client)).toBe(false);
  });

  it('returns false when capabilities are undefined', () => {
    const client = makeClient({ capabilities: undefined });
    expect(declaresSkillsExtension(client)).toBe(false);
  });
});

describe('discoverMcpSkills', () => {
  it('materializes skill-md entries as SkillDefinitions with empty body', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
          skills: [
            {
              name: 'pull-requests',
              type: 'skill-md',
              description: 'PR workflow',
              url: 'skill://pull-requests/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'github-skills');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'pull-requests',
      description: 'PR workflow',
      source: 'mcp',
      body: '',
      location: 'skill://pull-requests/SKILL.md',
      mcp: {
        serverName: 'github-skills',
        skillUri: 'skill://pull-requests/SKILL.md',
      },
    });
  });

  it('skips mcp-resource-template entries and logs them', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              type: 'mcp-resource-template',
              description: 'Per-product docs',
              url: 'skill://docs/{product}/SKILL.md',
            },
            {
              name: 'ready',
              type: 'skill-md',
              description: 'A concrete skill',
              url: 'skill://ready/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result.map((s) => s.name)).toEqual(['ready']);
  });

  it('returns empty array when the server has no index', async () => {
    const client = makeClient({
      readResourceImpl: async () => {
        throw new Error('Resource not found');
      },
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result).toEqual([]);
  });

  it('returns empty array when the index is not valid JSON', async () => {
    const client = makeClient({
      readResourceImpl: async () => textContents('not-json'),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result).toEqual([]);
  });

  it('returns empty array when the index is shaped wrong', async () => {
    const client = makeClient({
      readResourceImpl: async () => textContents({ notSkills: true }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result).toEqual([]);
  });

  it('derives name from URI when the entry has no name field', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              type: 'skill-md',
              description: 'Nested skill',
              url: 'skill://acme/billing/refunds/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('refunds');
  });

  it('accepts non-skill:// URIs (the SEP SHOULDs skill:// but permits any scheme)', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              name: 'custom-scheme',
              type: 'skill-md',
              description: 'Server-native scheme',
              url: 'github://skills/custom-scheme/SKILL.md',
            },
            {
              name: 'classic',
              type: 'skill-md',
              description: 'Classic entry',
              url: 'skill://classic/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result.map((s) => s.name).sort()).toEqual([
      'classic',
      'custom-scheme',
    ]);
    const github = result.find((s) => s.name === 'custom-scheme');
    expect(github?.location).toBe('github://skills/custom-scheme/SKILL.md');
    expect(github?.mcp?.skillUri).toBe(
      'github://skills/custom-scheme/SKILL.md',
    );
  });

  it('rejects skill names that do not match the allowlist', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              name: 'bad"><!--',
              type: 'skill-md',
              description: 'Name contains XML metacharacters',
              url: 'skill://evil/SKILL.md',
            },
            {
              name: 'has space',
              type: 'skill-md',
              description: 'Name contains whitespace',
              url: 'skill://ws/SKILL.md',
            },
            {
              name: 'good-name_1.0',
              type: 'skill-md',
              description: 'Allowed name',
              url: 'skill://ok/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result.map((s) => s.name)).toEqual(['good-name_1.0']);
  });

  it('strips ASCII control chars from description and caps length', async () => {
    const longDescription = 'x'.repeat(600);
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              name: 'ctrl',
              type: 'skill-md',
              description: 'has\x00NUL and\x1Bescape',
              url: 'skill://ctrl/SKILL.md',
            },
            {
              name: 'long',
              type: 'skill-md',
              description: longDescription,
              url: 'skill://long/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    const ctrl = result.find((s) => s.name === 'ctrl');
    expect(ctrl?.description).toBe('has NUL and escape');
    const long = result.find((s) => s.name === 'long');
    expect(long?.description.length).toBe(500);
    expect(long?.description.endsWith('…')).toBe(true);
  });

  it('skips entries whose url is malformed (no <scheme>://)', async () => {
    const client = makeClient({
      readResourceImpl: async () =>
        textContents({
          skills: [
            {
              name: 'relative-path',
              type: 'skill-md',
              description: 'Not a URI',
              url: '/just/a/path/SKILL.md',
            },
            {
              name: 'good',
              type: 'skill-md',
              description: 'Good entry',
              url: 'skill://good/SKILL.md',
            },
          ],
        }),
    });
    const result = await discoverMcpSkills(client, 'srv');
    expect(result.map((s) => s.name)).toEqual(['good']);
  });
});

describe('skillSourceTag', () => {
  it('prefixes with mcp:', () => {
    expect(skillSourceTag('foo')).toBe('mcp:foo');
  });
});
