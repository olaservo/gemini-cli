/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Response structure for a test tool call.
 */
export interface TestToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Definition of a test tool.
 */
export interface TestTool {
  name: string;
  description: string;
  /** JSON Schema for input arguments */
  inputSchema?: Record<string, unknown>;
  response: TestToolResponse;
}

/**
 * Definition of a test skill served via the skills-over-MCP SEP
 * (io.modelcontextprotocol/skills). The server registers a
 * `skill://<name>/SKILL.md` resource plus any supporting files, and
 * synthesizes a `skill://index.json` discovery index on request.
 */
export interface TestSkill {
  /** Skill name — must match the final path segment in the skill URI. */
  name: string;
  /** Short description for the index and resource metadata. */
  description: string;
  /** Full SKILL.md file contents (frontmatter + body). */
  skillMd: string;
  /**
   * Optional supporting files, keyed by path relative to the skill root
   * (e.g. `references/GUIDE.md`), value is the file content.
   */
  supportingFiles?: Record<string, string>;
}

/**
 * Configuration structure for the generic test MCP server template.
 */
export interface TestMcpConfig {
  name: string;
  version?: string;
  tools: TestTool[];
  /**
   * Skills served per the skills-over-MCP SEP. When non-empty, the server
   * declares `capabilities.extensions["io.modelcontextprotocol/skills"]`
   * and publishes a `skill://index.json` resource.
   */
  skills?: TestSkill[];
}

/**
 * Builder to easily configure a Test MCP Server in tests.
 */
export class TestMcpServerBuilder {
  private config: TestMcpConfig;

  constructor(name: string) {
    this.config = { name, tools: [] };
  }

  /**
   * Adds a tool to the test server configuration.
   * @param name Tool name
   * @param description Tool description
   * @param response The response to return. Can be a string for simple text responses.
   * @param inputSchema Optional JSON Schema for validation/documentation
   */
  addTool(
    name: string,
    description: string,
    response: TestToolResponse | string,
    inputSchema?: Record<string, unknown>,
  ): this {
    const responseObj =
      typeof response === 'string'
        ? { content: [{ type: 'text' as const, text: response }] }
        : response;

    this.config.tools.push({
      name,
      description,
      inputSchema,
      response: responseObj,
    });
    return this;
  }

  /**
   * Adds a skill to the test server. The server will advertise the
   * `io.modelcontextprotocol/skills` extension capability and publish the
   * skill's resources per the SEP.
   */
  addSkill(
    name: string,
    skillMd: string,
    options: {
      description?: string;
      supportingFiles?: Record<string, string>;
    } = {},
  ): this {
    if (!this.config.skills) this.config.skills = [];
    this.config.skills.push({
      name,
      description: options.description ?? `Test skill: ${name}`,
      skillMd,
      supportingFiles: options.supportingFiles,
    });
    return this;
  }

  build(): TestMcpConfig {
    return this.config;
  }
}
