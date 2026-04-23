/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { getFolderStructure } from '../utils/getFolderStructure.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolInvocation,
  type ToolConfirmationOutcome,
  type ExecuteOptions,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ACTIVATE_SKILL_TOOL_NAME } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import { getActivateSkillDefinition } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import type { SkillDefinition } from '../skills/skillLoader.js';
import { FRONTMATTER_REGEX, parseFrontmatter } from '../skills/skillLoader.js';
import { uriParentPrefix } from '../skills/mcpSkillDiscovery.js';
import { debugLogger } from '../utils/debugLogger.js';

// Cap the SKILL.md body returned by an MCP server. Bodies are inlined into the
// model's context on activation, so an unbounded response is both a memory and
// a context-budget DoS vector. 256 KiB is several orders of magnitude above any
// reasonable hand-authored SKILL.md.
const MAX_SKILL_BODY_BYTES = 256 * 1024;

// MCP-served strings reach the model inside a `<instructions>` XML block
// marked `trust="untrusted"`. Without escaping, a malicious server could emit
// `</instructions>` (or a closing `</activated_skill>`) in its body to break
// out of the fence and impersonate trusted host content to the model.
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// The activation confirmation prompt is rendered as Markdown. Untrusted
// server-supplied strings are escaped so a server can't inject trusted-looking
// UI (e.g. `**TRUSTED SOURCE**` or a fake `[Click here](link)` link) into the
// user's trust decision.
function mdEscape(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, '\\$1');
}

/**
 * Parameters for the ActivateSkill tool
 */
export interface ActivateSkillToolParams {
  /**
   * The name of the skill to activate
   */
  name: string;
}

class ActivateSkillToolInvocation extends BaseToolInvocation<
  ActivateSkillToolParams,
  ToolResult
> {
  private cachedFolderStructure: string | undefined;

  constructor(
    private config: Config,
    params: ActivateSkillToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const skillName = this.params.name;
    const skill = this.config.getSkillManager().getSkill(skillName);
    if (skill) {
      return `"${skillName}": ${skill.description}`;
    }
    return `"${skillName}" (?) unknown skill`;
  }

  private async getOrFetchFolderStructure(
    skillLocation: string,
  ): Promise<string> {
    if (this.cachedFolderStructure === undefined) {
      this.cachedFolderStructure = await getFolderStructure(
        path.dirname(skillLocation),
      );
    }
    return this.cachedFolderStructure;
  }

  /**
   * For MCP-sourced skills, builds a listing of the skill's sibling resources
   * (supporting files under the same `skill://<skill-path>/` prefix) from the
   * resource registry. Presented to the model so it knows what's available
   * and can fetch any supporting file with `read_mcp_resource`.
   */
  private buildMcpAvailableResources(skill: SkillDefinition): string {
    if (!skill.mcp) return '(none)';
    const registry = this.config.getResourceRegistry();
    const serverResources = registry.getResourcesByServer(skill.mcp.serverName);
    const skillUri = skill.mcp.skillUri;
    const skillRoot = uriParentPrefix(skillUri);
    if (!skillRoot) return '(none)';
    const siblings = serverResources
      .filter((r) => r.uri.startsWith(skillRoot) && r.uri !== skillUri)
      .map(
        (r) =>
          `- ${xmlEscape(r.uri)}${
            r.description ? `  — ${xmlEscape(r.description)}` : ''
          }`,
      );
    if (siblings.length === 0) {
      return `(supporting files may be referenced from within the skill body; fetch them with read_mcp_resource using the URI exactly as written in the skill instructions)`;
    }
    return siblings.join('\n');
  }

  /**
   * Reads the SKILL.md body for an MCP skill from the server and caches it
   * on the skill definition. Re-reads are avoided on subsequent activations.
   */
  private async fetchMcpSkillBody(skill: SkillDefinition): Promise<string> {
    if (!skill.mcp) return '';
    if (skill.body) return skill.body;

    const mcpManager = this.config.getMcpClientManager();
    const client = mcpManager?.getClient(skill.mcp.serverName);
    if (!client) {
      throw new Error(
        `MCP server '${skill.mcp.serverName}' is not connected; cannot load skill '${skill.name}'.`,
      );
    }

    const result = await client.readResource(skill.mcp.skillUri);
    let text = '';
    for (const content of result.contents ?? []) {
      if ('text' in content && typeof content.text === 'string') {
        text = content.text;
        break;
      }
    }
    if (!text) {
      throw new Error(
        `Skill '${skill.name}' at ${skill.mcp.skillUri} returned no text content.`,
      );
    }
    // Bound the response before we keep it around or hand it to the model.
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > MAX_SKILL_BODY_BYTES) {
      throw new Error(
        `Skill '${skill.name}' body from ${skill.mcp.skillUri} is ${textBytes} bytes, exceeds the ${MAX_SKILL_BODY_BYTES}-byte limit; refusing to activate.`,
      );
    }

    const match = text.match(FRONTMATTER_REGEX);
    if (match) {
      // If the SKILL.md carries its own frontmatter, the `name` it advertises
      // must match the name the index pointed us at. Mismatches signal body /
      // index drift or a server trying to deliver a different skill than the
      // one the user is about to trust; reject rather than activate.
      const frontmatter = parseFrontmatter(match[1] ?? '');
      if (frontmatter && frontmatter.name !== skill.name) {
        throw new Error(
          `Skill '${skill.name}' body frontmatter advertises name '${frontmatter.name}'; refusing to activate.`,
        );
      }
    }
    const body = match ? (match[2]?.trim() ?? '') : text.trim();
    skill.body = body;
    return body;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (!this.messageBus) {
      return false;
    }

    const skillName = this.params.name;
    const skill = this.config.getSkillManager().getSkill(skillName);

    if (!skill) {
      return false;
    }

    if (skill.isBuiltin) {
      return false;
    }

    const resourcesBlock =
      skill.source === 'mcp'
        ? this.buildMcpAvailableResources(skill)
        : await this.getOrFetchFolderStructure(skill.location);

    const provenance =
      skill.source === 'mcp' && skill.mcp
        ? `\n\n**Source:** MCP server \`${mdEscape(skill.mcp.serverName)}\` (${mdEscape(skill.mcp.skillUri)})`
        : '';

    const safeDescription =
      skill.source === 'mcp' ? mdEscape(skill.description) : skill.description;

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Activate Skill: ${skillName}`,
      prompt: `You are about to enable the specialized agent skill **${skillName}**.

**Description:**
${safeDescription}${provenance}

**Resources to be shared with the model:**
${resourcesBlock}`,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        await this.publishPolicyUpdate(outcome);
      },
    };
    return confirmationDetails;
  }

  async execute({ abortSignal: _signal }: ExecuteOptions): Promise<ToolResult> {
    const skillName = this.params.name;
    const skillManager = this.config.getSkillManager();
    const skill = skillManager.getSkill(skillName);

    if (!skill) {
      const skills = skillManager.getSkills();
      const availableSkills = skills.map((s) => s.name).join(', ');
      const errorMessage = `Skill "${skillName}" not found. Available skills are: ${availableSkills}`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    if (skill.source === 'mcp' && skill.mcp) {
      let body: string;
      try {
        body = await this.fetchMcpSkillBody(skill);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        debugLogger.warn(
          `Failed to fetch MCP skill '${skillName}' body: ${errorMessage}`,
        );
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
          error: {
            message: errorMessage,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }
      const siblings = this.buildMcpAvailableResources(skill);
      // The body comes from an MCP server — treat every server-derived value
      // (body, serverName, skillUri, siblings) as untrusted and XML-escape it
      // so the content can't break out of the `<instructions>` fence or forge
      // attributes on the surrounding elements.
      const safeServerName = xmlEscape(skill.mcp.serverName);
      const safeSkillUri = xmlEscape(skill.mcp.skillUri);
      const safeBody = xmlEscape(body);
      const preamble = `(This skill is served by MCP server '${safeServerName}'. Any URI referenced here or inside the instructions can be fetched with the read_mcp_resource tool — pass the URI exactly as written; the host resolves the server.)`;
      return {
        llmContent: `<activated_skill name="${skillName}">
<source>MCP server: ${safeServerName}</source>
<location>${safeSkillUri}</location>
<instructions trust="untrusted">
${safeBody}
</instructions>

<available_resources>
${preamble}
${siblings}
</available_resources>
</activated_skill>`,
        returnDisplay: `Skill **${skillName}** activated from MCP server \`${mdEscape(skill.mcp.serverName)}\` (${mdEscape(skill.mcp.skillUri)}).`,
      };
    }

    // Add the filesystem skill's directory to the workspace context so the
    // agent has permission to read its bundled resources.
    this.config
      .getWorkspaceContext()
      .addDirectory(path.dirname(skill.location));

    const folderStructure = await this.getOrFetchFolderStructure(
      skill.location,
    );

    return {
      llmContent: `<activated_skill name="${skillName}">
  <instructions>
    ${skill.body}
  </instructions>

  <available_resources>
    ${folderStructure}
  </available_resources>
</activated_skill>`,
      returnDisplay: `Skill **${skillName}** activated. Resources loaded from \`${path.dirname(skill.location)}\`:\n\n${folderStructure}`,
    };
  }
}

/**
 * Implementation of the ActivateSkill tool logic
 */
export class ActivateSkillTool extends BaseDeclarativeTool<
  ActivateSkillToolParams,
  ToolResult
> {
  static readonly Name = ACTIVATE_SKILL_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    const skills = config.getSkillManager().getSkills();
    const skillNames = skills.map((s) => s.name);
    const definition = getActivateSkillDefinition(skillNames);

    super(
      ActivateSkillTool.Name,
      'Activate Skill',
      definition.base.description!,
      Kind.Other,
      definition.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ActivateSkillToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ActivateSkillToolParams, ToolResult> {
    return new ActivateSkillToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName ?? 'Activate Skill',
    );
  }

  override getSchema(modelId?: string) {
    const skills = this.config.getSkillManager().getSkills();
    const skillNames = skills.map((s) => s.name);
    return resolveToolDeclaration(
      getActivateSkillDefinition(skillNames),
      modelId,
    );
  }
}
