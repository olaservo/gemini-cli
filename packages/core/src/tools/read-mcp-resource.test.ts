/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ReadMcpResourceTool } from './read-mcp-resource.js';
import { ToolErrorType } from './tool-error.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';

describe('ReadMcpResourceTool', () => {
  let tool: ReadMcpResourceTool;
  let mockContext: {
    config: {
      getMcpClientManager: Mock;
    };
  };
  let mockMcpManager: {
    findResource: Mock;
    getClient: Mock;
  };
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    mockMcpManager = {
      findResource: vi.fn(),
      getClient: vi.fn(),
    };

    mockContext = {
      config: {
        getMcpClientManager: vi.fn().mockReturnValue(mockMcpManager),
      },
    };

    tool = new ReadMcpResourceTool(
      mockContext as unknown as AgentLoopContext,
      createMockMessageBus(),
    );
  });

  it('reads a resource using the (server, uri) pair', async () => {
    const uri = 'protocol://resource';
    const serverName = 'test-server';
    const resourceName = 'Test Resource';
    const resourceContent = 'Resource Content';

    mockMcpManager.findResource.mockReturnValue({
      uri,
      serverName,
      name: resourceName,
    });
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: resourceContent }],
      }),
    };
    mockMcpManager.getClient.mockReturnValue(mockClient);

    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          getDescription: () => string;
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ server: serverName, uri });

    expect(invocation.getDescription()).toBe(
      `Read MCP resource "${resourceName}" from server "${serverName}"`,
    );

    const result = (await invocation.execute({ abortSignal })) as {
      llmContent: string;
      returnDisplay: string;
    };

    expect(mockMcpManager.findResource).toHaveBeenCalledWith(serverName, uri);
    expect(mockMcpManager.getClient).toHaveBeenCalledWith(serverName);
    expect(mockClient.readResource).toHaveBeenCalledWith(uri);
    expect(result).toEqual({
      llmContent: resourceContent + '\n',
      returnDisplay: `Successfully read resource "${resourceName}" from server "${serverName}"`,
    });
  });

  it('keeps colliding skill:// URIs distinct via the server param', async () => {
    // The motivating skills regression: two MCP servers expose
    // `skill://index.json`. With server required, the right resource is
    // resolved instead of a silent first-match.
    const uri = 'skill://index.json';
    mockMcpManager.findResource.mockImplementation((server: string) =>
      server === 'github'
        ? { uri, serverName: 'github', name: 'github-skills' }
        : undefined,
    );
    const mockClient = {
      readResource: vi
        .fn()
        .mockResolvedValue({ contents: [{ text: 'gh body' }] }),
    };
    mockMcpManager.getClient.mockReturnValue(mockClient);

    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ server: 'github', uri });

    const result = (await invocation.execute({ abortSignal })) as {
      llmContent: string;
    };

    expect(mockMcpManager.findResource).toHaveBeenCalledWith('github', uri);
    expect(result.llmContent).toBe('gh body\n');
  });

  it('returns error if MCP Client Manager not available', async () => {
    mockContext.config.getMcpClientManager.mockReturnValue(undefined);

    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ server: 's', uri: 'uri' });
    const result = (await invocation.execute({ abortSignal })) as {
      error: { type: string; message: string };
    };

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.error?.message).toContain('MCP Client Manager not available');
  });

  it('returns INVALID_TOOL_PARAMS when server is missing', async () => {
    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ uri: 'skill://index.json' });
    const result = (await invocation.execute({ abortSignal })) as {
      error: { type: string; message: string };
    };

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.error?.message).toContain('server');
  });

  it('returns a not-found error naming both server and uri', async () => {
    mockMcpManager.findResource.mockReturnValue(undefined);

    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ server: 'filesystem', uri: 'skill://index.json' });
    const result = (await invocation.execute({ abortSignal })) as {
      error: { type: string; message: string };
    };

    expect(result.error?.type).toBe(ToolErrorType.MCP_RESOURCE_NOT_FOUND);
    expect(result.error?.message).toContain('skill://index.json');
    expect(result.error?.message).toContain('filesystem');
  });

  it('returns error if reading fails', async () => {
    const uri = 'protocol://resource';
    const serverName = 'test-server';

    mockMcpManager.findResource.mockReturnValue({ uri, serverName });
    const mockClient = {
      readResource: vi.fn().mockRejectedValue(new Error('Failed to read')),
    };
    mockMcpManager.getClient.mockReturnValue(mockClient);

    const invocation = (
      tool as unknown as {
        createInvocation: (params: Record<string, unknown>) => {
          execute: (options: { abortSignal: AbortSignal }) => Promise<unknown>;
        };
      }
    ).createInvocation({ server: serverName, uri });
    const result = (await invocation.execute({ abortSignal })) as {
      error: { type: string; message: string };
    };

    expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
    expect(result.error?.message).toContain('Failed to read resource');
  });
});
