/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { ResourceRegistry } from './resource-registry.js';

describe('ResourceRegistry', () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  const createResource = (overrides: Partial<Resource> = {}): Resource => ({
    uri: 'file:///tmp/foo.txt',
    name: 'foo',
    description: 'example resource',
    mimeType: 'text/plain',
    ...overrides,
  });

  it('stores resources per server', () => {
    registry.setResourcesForServer('a', [createResource()]);
    registry.setResourcesForServer('b', [createResource({ uri: 'foo' })]);

    expect(
      registry.getAllResources().filter((res) => res.serverName === 'a'),
    ).toHaveLength(1);
    expect(
      registry.getAllResources().filter((res) => res.serverName === 'b'),
    ).toHaveLength(1);
  });

  it('clears resources for server before adding new ones', () => {
    registry.setResourcesForServer('a', [
      createResource(),
      createResource({ uri: 'bar' }),
    ]);
    registry.setResourcesForServer('a', [createResource({ uri: 'baz' })]);

    const resources = registry
      .getAllResources()
      .filter((res) => res.serverName === 'a');
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('baz');
  });

  describe('findResourceByServerAndUri', () => {
    it('returns the resource for a (server, uri) pair', () => {
      registry.setResourcesForServer('a', [createResource()]);
      registry.setResourcesForServer('b', [
        createResource({ uri: 'file:///tmp/bar.txt' }),
      ]);

      expect(
        registry.findResourceByServerAndUri('a', 'file:///tmp/foo.txt')
          ?.serverName,
      ).toBe('a');
      expect(
        registry.findResourceByServerAndUri('b', 'file:///tmp/bar.txt')
          ?.serverName,
      ).toBe('b');
    });

    it('returns undefined when the URI is not on the named server', () => {
      registry.setResourcesForServer('a', [createResource()]);
      expect(
        registry.findResourceByServerAndUri('a', 'file:///tmp/missing.txt'),
      ).toBeUndefined();
      expect(
        registry.findResourceByServerAndUri('b', 'file:///tmp/foo.txt'),
      ).toBeUndefined();
    });

    it('handles URIs containing colons without ambiguity', () => {
      // Both server and URI are passed as separate arguments, so URIs with
      // `://` (file://, https://, skill://) cannot be misinterpreted as the
      // server-name boundary the way a single colon-joined identifier could.
      registry.setResourcesForServer('a', [
        createResource({ uri: 'https://example.com/data' }),
      ]);
      registry.setResourcesForServer('skills-server', [
        createResource({ uri: 'skill://index.json' }),
      ]);
      expect(
        registry.findResourceByServerAndUri('a', 'https://example.com/data')
          ?.serverName,
      ).toBe('a');
      expect(
        registry.findResourceByServerAndUri(
          'skills-server',
          'skill://index.json',
        )?.serverName,
      ).toBe('skills-server');
    });

    it('scopes the lookup to a single server when the URI is shared across servers', () => {
      // Once the Skills extension lands, multiple servers will routinely
      // expose `skill://index.json`. Server-scoped lookup keeps these
      // distinct instead of silently picking one.
      registry.setResourcesForServer('github', [
        createResource({ uri: 'skill://index.json', name: 'github-skills' }),
      ]);
      registry.setResourcesForServer('filesystem', [
        createResource({ uri: 'skill://index.json', name: 'fs-skills' }),
      ]);
      expect(
        registry.findResourceByServerAndUri('github', 'skill://index.json')
          ?.name,
      ).toBe('github-skills');
      expect(
        registry.findResourceByServerAndUri('filesystem', 'skill://index.json')
          ?.name,
      ).toBe('fs-skills');
    });
  });

  it('clears resources for a server', () => {
    registry.setResourcesForServer('a', [createResource()]);
    registry.removeResourcesByServer('a');

    expect(
      registry.getAllResources().filter((res) => res.serverName === 'a'),
    ).toHaveLength(0);
  });
});
