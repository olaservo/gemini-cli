/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from './skillManager.js';
import { Storage } from '../config/storage.js';
import { type GeminiCLIExtension } from '../config/config.js';
import { loadSkillsFromDir, type SkillDefinition } from './skillLoader.js';
import { coreEvents } from '../utils/events.js';
import { debugLogger } from '../utils/debugLogger.js';

vi.mock('./skillLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skillLoader.js')>();
  return {
    ...actual,
    loadSkillsFromDir: vi.fn(actual.loadSkillsFromDir),
  };
});

describe('SkillManager', () => {
  let testRootDir: string;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-manager-test-'),
    );
  });

  afterEach(async () => {
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should discover skills from extensions, user, and workspace with precedence', async () => {
    const userDir = path.join(testRootDir, 'user');
    const projectDir = path.join(testRootDir, 'workspace');
    await fs.mkdir(path.join(userDir, 'skill-a'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'skill-b'), { recursive: true });

    await fs.writeFile(
      path.join(userDir, 'skill-a', 'SKILL.md'),
      `---
name: skill-user
description: user-desc
---
`,
    );
    await fs.writeFile(
      path.join(projectDir, 'skill-b', 'SKILL.md'),
      `---
name: skill-project
description: project-desc
---
`,
    );

    const mockExtension: GeminiCLIExtension = {
      name: 'test-ext',
      version: '1.0.0',
      isActive: true,
      path: '/ext',
      contextFiles: [],
      id: 'ext-id',
      skills: [
        {
          name: 'skill-extension',
          description: 'ext-desc',
          location: '/ext/skills/SKILL.md',
          body: 'body',
        },
      ],
    };

    vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue(userDir);
    vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
      '/non-existent-user-agent',
    );
    const storage = new Storage('/dummy');
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue(projectDir);
    vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
      '/non-existent-project-agent',
    );

    const service = new SkillManager();
    // @ts-expect-error accessing private method for testing
    vi.spyOn(service, 'discoverBuiltinSkills').mockResolvedValue(undefined);
    await service.discoverSkills(storage, [mockExtension], true);

    const skills = service.getSkills();
    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name);
    expect(names).toContain('skill-extension');
    expect(names).toContain('skill-user');
    expect(names).toContain('skill-project');
  });

  it('should respect precedence: Workspace > User > Extension', async () => {
    const userDir = path.join(testRootDir, 'user');
    const projectDir = path.join(testRootDir, 'workspace');
    await fs.mkdir(path.join(userDir, 'skill'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'skill'), { recursive: true });

    await fs.writeFile(
      path.join(userDir, 'skill', 'SKILL.md'),
      `---
name: same-name
description: user-desc
---
`,
    );
    await fs.writeFile(
      path.join(projectDir, 'skill', 'SKILL.md'),
      `---
name: same-name
description: project-desc
---
`,
    );

    const mockExtension: GeminiCLIExtension = {
      name: 'test-ext',
      version: '1.0.0',
      isActive: true,
      path: '/ext',
      contextFiles: [],
      id: 'ext-id',
      skills: [
        {
          name: 'same-name',
          description: 'ext-desc',
          location: '/ext/skills/SKILL.md',
          body: 'body',
        },
      ],
    };

    vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue(userDir);
    vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
      '/non-existent-user-agent',
    );
    const storage = new Storage('/dummy');
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue(projectDir);
    vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
      '/non-existent-project-agent',
    );

    const service = new SkillManager();
    // @ts-expect-error accessing private method for testing
    vi.spyOn(service, 'discoverBuiltinSkills').mockResolvedValue(undefined);
    await service.discoverSkills(storage, [mockExtension], true);

    const skills = service.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('project-desc');

    // Test User > Extension
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue('/non-existent');
    await service.discoverSkills(storage, [mockExtension], true);
    expect(service.getSkills()[0].description).toBe('user-desc');
  });

  it('should discover built-in skills', async () => {
    const service = new SkillManager();
    const mockBuiltinSkill: SkillDefinition = {
      name: 'builtin-skill',
      description: 'builtin-desc',
      location: 'builtin-loc',
      body: 'builtin-body',
    };

    vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
      if (dir.endsWith('builtin')) {
        return [{ ...mockBuiltinSkill }];
      }
      return [];
    });

    const storage = new Storage('/dummy');
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue('/non-existent');
    vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue('/non-existent');

    await service.discoverSkills(storage, [], true);

    const skills = service.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('builtin-skill');
    expect(skills[0].isBuiltin).toBe(true);
  });

  it('should filter disabled skills in getSkills but not in getAllSkills', async () => {
    const skillDir = path.join(testRootDir, 'skill1');
    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: skill1
description: desc1
---
body1`,
    );

    const storage = new Storage('/dummy');
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue(testRootDir);
    vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
      '/non-existent-project-agent',
    );
    vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue('/non-existent');
    vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
      '/non-existent-user-agent',
    );

    const service = new SkillManager();
    // @ts-expect-error accessing private method for testing
    vi.spyOn(service, 'discoverBuiltinSkills').mockResolvedValue(undefined);
    await service.discoverSkills(storage, [], true);
    service.setDisabledSkills(['skill1']);

    expect(service.getSkills()).toHaveLength(0);
    expect(service.getAllSkills()).toHaveLength(1);
    expect(service.getAllSkills()[0].disabled).toBe(true);
  });

  it('should skip workspace skills if folder is not trusted', async () => {
    const projectDir = path.join(testRootDir, 'workspace');
    await fs.mkdir(path.join(projectDir, 'skill-project'), { recursive: true });

    await fs.writeFile(
      path.join(projectDir, 'skill-project', 'SKILL.md'),
      `---
name: skill-project
description: project-desc
---
`,
    );

    const storage = new Storage('/dummy');
    vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue(projectDir);
    vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
      '/non-existent-project-agent',
    );
    vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue('/non-existent');
    vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
      '/non-existent-user-agent',
    );

    const service = new SkillManager();
    // @ts-expect-error accessing private method for testing
    vi.spyOn(service, 'discoverBuiltinSkills').mockResolvedValue(undefined);

    // Call with isTrusted = false
    await service.discoverSkills(storage, [], false);

    const skills = service.getSkills();
    expect(skills).toHaveLength(0);
  });

  it('should filter built-in skills in getDisplayableSkills', async () => {
    const service = new SkillManager();

    // @ts-expect-error accessing private property for testing
    service.skills = [
      {
        name: 'regular-skill',
        description: 'regular',
        location: 'loc1',
        body: 'body',
        isBuiltin: false,
      },
      {
        name: 'builtin-skill',
        description: 'builtin',
        location: 'loc2',
        body: 'body',
        isBuiltin: true,
      },
      {
        name: 'disabled-builtin',
        description: 'disabled builtin',
        location: 'loc3',
        body: 'body',
        isBuiltin: true,
        disabled: true,
      },
    ];

    const displayable = service.getDisplayableSkills();
    expect(displayable).toHaveLength(1);
    expect(displayable[0].name).toBe('regular-skill');

    const all = service.getAllSkills();
    expect(all).toHaveLength(3);

    const enabled = service.getSkills();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((s) => s.name)).toContain('builtin-skill');
  });

  it('should maintain admin settings state', async () => {
    const service = new SkillManager();

    // Case 1: Enabled by admin

    service.setAdminSettings(true);

    expect(service.isAdminEnabled()).toBe(true);

    // Case 2: Disabled by admin

    service.setAdminSettings(false);

    expect(service.isAdminEnabled()).toBe(false);
  });

  describe('setSkillsForSource', () => {
    it('registers, replaces, and clears MCP-sourced skills by source tag', () => {
      const service = new SkillManager();
      const alpha: SkillDefinition = {
        name: 'alpha',
        description: 'first',
        location: 'skill://alpha/SKILL.md',
        body: '',
        source: 'mcp',
        mcp: { serverName: 'srv', skillUri: 'skill://alpha/SKILL.md' },
      };
      const beta: SkillDefinition = {
        name: 'beta',
        description: 'second',
        location: 'skill://beta/SKILL.md',
        body: '',
        source: 'mcp',
        mcp: { serverName: 'srv', skillUri: 'skill://beta/SKILL.md' },
      };

      service.setSkillsForSource('mcp:srv', [alpha, beta]);
      expect(
        service
          .getSkills()
          .map((s) => s.name)
          .sort(),
      ).toEqual(['alpha', 'beta']);

      service.setSkillsForSource('mcp:srv', [alpha]);
      expect(service.getSkills().map((s) => s.name)).toEqual(['alpha']);

      service.setSkillsForSource('mcp:srv', []);
      expect(service.getSkills()).toHaveLength(0);
    });

    it('keeps skills from different source tags independent', () => {
      const service = new SkillManager();
      const a: SkillDefinition = {
        name: 'a',
        description: '',
        location: 'skill://a/SKILL.md',
        body: '',
        source: 'mcp',
        mcp: { serverName: 'one', skillUri: 'skill://a/SKILL.md' },
      };
      const b: SkillDefinition = {
        name: 'b',
        description: '',
        location: 'skill://b/SKILL.md',
        body: '',
        source: 'mcp',
        mcp: { serverName: 'two', skillUri: 'skill://b/SKILL.md' },
      };
      service.setSkillsForSource('mcp:one', [a]);
      service.setSkillsForSource('mcp:two', [b]);
      expect(
        service
          .getSkills()
          .map((s) => s.name)
          .sort(),
      ).toEqual(['a', 'b']);

      service.setSkillsForSource('mcp:one', []);
      expect(service.getSkills().map((s) => s.name)).toEqual(['b']);
    });

    it('lets a filesystem-loaded skill shadow an MCP skill of the same name', async () => {
      const service = new SkillManager();
      const warnSpy = vi.spyOn(coreEvents, 'emitFeedback');

      // Simulate a filesystem-loaded skill by using addSkills (local skills
      // leave `source` unset).
      service.addSkills([
        {
          name: 'collision',
          description: 'local',
          location: '/local/collision/SKILL.md',
          body: 'local body',
        },
      ]);

      service.setSkillsForSource('mcp:srv', [
        {
          name: 'collision',
          description: 'remote',
          location: 'skill://collision/SKILL.md',
          body: '',
          source: 'mcp',
          mcp: {
            serverName: 'srv',
            skillUri: 'skill://collision/SKILL.md',
          },
        },
      ]);

      const names = service.getSkills().map((s) => s.name);
      expect(names).toEqual(['collision']);
      const winner = service.getSkill('collision');
      expect(winner?.source).toBeUndefined(); // local wins
      expect(winner?.body).toBe('local body');
      expect(warnSpy).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('shadowed by a local skill'),
      );
    });

    it('deduplicates skills when two MCP sources publish the same name', () => {
      const service = new SkillManager();
      const warnSpy = vi.spyOn(coreEvents, 'emitFeedback');

      service.setSkillsForSource('mcp:one', [
        {
          name: 'dup',
          description: 'from one',
          location: 'skill://dup/SKILL.md',
          body: '',
          source: 'mcp',
          mcp: { serverName: 'one', skillUri: 'skill://dup/SKILL.md' },
        },
      ]);
      service.setSkillsForSource('mcp:two', [
        {
          name: 'dup',
          description: 'from two',
          location: 'skill://dup/SKILL.md',
          body: '',
          source: 'mcp',
          mcp: { serverName: 'two', skillUri: 'skill://dup/SKILL.md' },
        },
      ]);

      const matches = service.getSkills().filter((s) => s.name === 'dup');
      expect(matches).toHaveLength(1);
      expect(matches[0].mcp?.serverName).toBe('one');
      expect(warnSpy).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining(
          'shadowed by another source that registered the same name first',
        ),
      );
    });

    it('applies setDisabledSkills to MCP-sourced skills', () => {
      const service = new SkillManager();
      const skill: SkillDefinition = {
        name: 'pr-review',
        description: 'pr workflow',
        location: 'skill://pr-review/SKILL.md',
        body: '',
        source: 'mcp',
        mcp: { serverName: 'srv', skillUri: 'skill://pr-review/SKILL.md' },
      };
      service.setSkillsForSource('mcp:srv', [skill]);
      service.setDisabledSkills(['pr-review']);

      expect(service.getSkills()).toHaveLength(0);
      expect(service.getAllSkills()).toHaveLength(1);
      expect(service.getAllSkills()[0].disabled).toBe(true);
    });
  });

  describe('Conflict Detection', () => {
    it('should emit UI warning when a non-built-in skill is overridden', async () => {
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const userDir = path.join(testRootDir, 'user');
      const projectDir = path.join(testRootDir, 'workspace');
      await fs.mkdir(userDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const skillName = 'conflicting-skill';
      const userSkillPath = path.join(userDir, 'SKILL.md');
      const projectSkillPath = path.join(projectDir, 'SKILL.md');

      vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
        if (dir === userDir) {
          return [
            {
              name: skillName,
              description: 'user-desc',
              location: userSkillPath,
              body: '',
            },
          ];
        }
        if (dir === projectDir) {
          return [
            {
              name: skillName,
              description: 'project-desc',
              location: projectSkillPath,
              body: '',
            },
          ];
        }
        return [];
      });

      vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue(userDir);
      vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
        '/non-existent-user-agent',
      );
      const storage = new Storage('/dummy');
      vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue(projectDir);
      vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
        '/non-existent-project-agent',
      );

      const service = new SkillManager();
      // @ts-expect-error accessing private method for testing
      vi.spyOn(service, 'discoverBuiltinSkills').mockResolvedValue(undefined);

      await service.discoverSkills(storage, [], true);

      expect(emitFeedbackSpy).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining(
          `Skill conflict detected: "${skillName}" from "${projectSkillPath}" is overriding the same skill from "${userSkillPath}".`,
        ),
      );
    });

    it('should log warning but NOT emit UI warning when a built-in skill is overridden', async () => {
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const debugWarnSpy = vi.spyOn(debugLogger, 'warn');
      const userDir = path.join(testRootDir, 'user');
      await fs.mkdir(userDir, { recursive: true });

      const skillName = 'builtin-skill';
      const userSkillPath = path.join(userDir, 'SKILL.md');
      const builtinSkillPath = 'builtin/loc';

      vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
        if (dir.endsWith('builtin')) {
          return [
            {
              name: skillName,
              description: 'builtin-desc',
              location: builtinSkillPath,
              body: '',
              isBuiltin: true,
            },
          ];
        }
        if (dir === userDir) {
          return [
            {
              name: skillName,
              description: 'user-desc',
              location: userSkillPath,
              body: '',
            },
          ];
        }
        return [];
      });

      vi.spyOn(Storage, 'getUserSkillsDir').mockReturnValue(userDir);
      vi.spyOn(Storage, 'getUserAgentSkillsDir').mockReturnValue(
        '/non-existent-user-agent',
      );
      const storage = new Storage('/dummy');
      vi.spyOn(storage, 'getProjectSkillsDir').mockReturnValue('/non-existent');
      vi.spyOn(storage, 'getProjectAgentSkillsDir').mockReturnValue(
        '/non-existent-project-agent',
      );

      const service = new SkillManager();

      await service.discoverSkills(storage, [], true);

      // UI warning should not be called
      expect(emitFeedbackSpy).not.toHaveBeenCalled();

      // Debug warning should be called
      expect(debugWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Skill "${skillName}" from "${userSkillPath}" is overriding the built-in skill.`,
        ),
      );
    });
  });
});
