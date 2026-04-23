/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node template.mjs <config-path>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const hasSkills = Array.isArray(config.skills) && config.skills.length > 0;

const capabilities = { tools: {} };
if (hasSkills) {
  capabilities.resources = {};
  // Declare the skills-over-MCP SEP extension. Today's MCP SDK only accepts
  // `experimental` in its capabilities schema and strips unknown keys, so use
  // that slot. When SEP-2133 (`capabilities.extensions`) lands in the SDK,
  // the real github-mcp-server fork may publish to either slot; clients MUST
  // check both.
  capabilities.experimental = {
    'io.modelcontextprotocol/skills': {},
  };
}

const server = new Server(
  {
    name: config.name,
    version: config.version || '1.0.0',
  },
  {
    capabilities,
  },
);

// Add tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: (config.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    })),
  };
});

// Add call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const tool = (config.tools || []).find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Tool ${toolName} not found`,
        },
      ],
      isError: true,
    };
  }

  return tool.response;
});

if (hasSkills) {
  const skillResources = [];
  const skillContent = new Map();

  for (const skill of config.skills) {
    const skillMdUri = `skill://${skill.name}/SKILL.md`;
    skillResources.push({
      uri: skillMdUri,
      name: `${skill.name}_skill`,
      mimeType: 'text/markdown',
      description: skill.description,
    });
    skillContent.set(skillMdUri, {
      mimeType: 'text/markdown',
      text: skill.skillMd,
    });
    if (skill.supportingFiles) {
      for (const [relPath, content] of Object.entries(skill.supportingFiles)) {
        const uri = `skill://${skill.name}/${relPath}`;
        skillResources.push({
          uri,
          name: `${skill.name}_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}`,
          mimeType: relPath.endsWith('.json')
            ? 'application/json'
            : 'text/markdown',
          description: `Supporting file ${relPath} for skill ${skill.name}`,
        });
        skillContent.set(uri, {
          mimeType: relPath.endsWith('.json')
            ? 'application/json'
            : 'text/markdown',
          text: content,
        });
      }
    }
  }

  const index = {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: config.skills.map((skill) => ({
      name: skill.name,
      type: 'skill-md',
      description: skill.description,
      url: `skill://${skill.name}/SKILL.md`,
    })),
  };
  skillResources.unshift({
    uri: 'skill://index.json',
    name: 'skills_index',
    mimeType: 'application/json',
    description: 'Agent Skill discovery index for this test server.',
  });
  skillContent.set('skill://index.json', {
    mimeType: 'application/json',
    text: JSON.stringify(index, null, 2),
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: skillResources,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const content = skillContent.get(uri);
    if (!content) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: content.mimeType,
          text: content.text,
        },
      ],
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
// server.connect resolves when transport connects, but listening continues
console.error(`Test MCP Server '${config.name}' connected and listening.`);
