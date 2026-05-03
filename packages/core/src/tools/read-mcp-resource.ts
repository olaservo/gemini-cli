/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { READ_MCP_RESOURCE_TOOL_NAME } from './tool-names.js';
import { READ_MCP_RESOURCE_DEFINITION } from './definitions/coreTools.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { ToolErrorType } from './tool-error.js';
import type { MCPResource } from '../resources/resource-registry.js';

export interface ReadMcpResourceParams {
  server: string;
  uri: string;
}

export class ReadMcpResourceTool extends BaseDeclarativeTool<
  ReadMcpResourceParams,
  ToolResult
> {
  static readonly Name = READ_MCP_RESOURCE_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super(
      ReadMcpResourceTool.Name,
      'Read MCP Resource',
      READ_MCP_RESOURCE_DEFINITION.base.description!,
      Kind.Read,
      READ_MCP_RESOURCE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ReadMcpResourceParams,
  ): ReadMcpResourceToolInvocation {
    return new ReadMcpResourceToolInvocation(
      this.context,
      params,
      this.messageBus,
    );
  }
}

class ReadMcpResourceToolInvocation extends BaseToolInvocation<
  ReadMcpResourceParams,
  ToolResult
> {
  private resource: MCPResource | undefined;

  constructor(
    private readonly context: AgentLoopContext,
    params: ReadMcpResourceParams,
    messageBus: MessageBus,
  ) {
    super(params, messageBus, ReadMcpResourceTool.Name, 'Read MCP Resource');
    const mcpManager = this.context.config.getMcpClientManager();
    this.resource = mcpManager?.findResource(params.server, params.uri);
  }

  getDescription(): string {
    if (this.resource) {
      return `Read MCP resource "${this.resource.name}" from server "${this.resource.serverName}"`;
    }
    return `Read MCP resource: ${this.params.uri} (server: ${this.params.server})`;
  }

  async execute({
    abortSignal: _abortSignal,
  }: ExecuteOptions): Promise<ToolResult> {
    const mcpManager = this.context.config.getMcpClientManager();
    if (!mcpManager) {
      return {
        llmContent: 'Error: MCP Client Manager not available.',
        returnDisplay: 'Error: MCP Client Manager not available.',
        error: {
          message: 'MCP Client Manager not available.',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    const { server, uri } = this.params;
    if (!uri || !server) {
      const missing = !uri ? 'uri' : 'server';
      return {
        llmContent: `Error: Missing required parameter "${missing}".`,
        returnDisplay: `Error: Missing required parameter "${missing}".`,
        error: {
          message: `Missing required parameter "${missing}". Both "server" and "uri" are required; use list_mcp_resources to discover them.`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const resource = mcpManager.findResource(server, uri);
    if (!resource) {
      const errorMessage = `Resource not found for uri "${uri}" on server "${server}". Use list_mcp_resources to see what is available.`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.MCP_RESOURCE_NOT_FOUND,
        },
      };
    }

    const client = mcpManager.getClient(resource.serverName);
    if (!client) {
      const errorMessage = `MCP Client not found for server: ${resource.serverName}`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      const result = await client.readResource(resource.uri);
      let contentText = '';
      if (result && result.contents) {
        for (const content of result.contents) {
          if ('text' in content && content.text) {
            contentText += content.text + '\n';
          } else if ('blob' in content && content.blob) {
            contentText += `[Binary Data (${content.mimeType})]` + '\n';
          }
        }
      }

      return {
        llmContent: contentText || 'No content returned from resource.',
        returnDisplay: `Successfully read resource "${resource.name}" from server "${resource.serverName}"`,
      };
    } catch (e) {
      const errorMessage = `Failed to read resource: ${e instanceof Error ? e.message : String(e)}`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.MCP_TOOL_ERROR,
        },
      };
    }
  }
}
