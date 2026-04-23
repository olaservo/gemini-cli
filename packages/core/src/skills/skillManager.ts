/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '../config/storage.js';
import { type SkillDefinition, loadSkillsFromDir } from './skillLoader.js';
import type { GeminiCLIExtension } from '../config/config.js';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';

export { type SkillDefinition };

export class SkillManager {
  /** Merged view: localSkills + sourcedSkills with local-wins precedence. */
  private skills: SkillDefinition[] = [];
  /** Filesystem-owned skills (built-in, extension, user, workspace). */
  private localSkills: SkillDefinition[] = [];
  private adminSkillsEnabled = true;

  /** Skills owned by dynamic sources (e.g. MCP servers), keyed by source tag. */
  private sourcedSkills: Map<string, SkillDefinition[]> = new Map();

  /**
   * Clears all discovered skills.
   */
  clearSkills(): void {
    this.skills = [];
    this.localSkills = [];
    this.sourcedSkills.clear();
  }

  /**
   * Sets administrative settings for skills.
   */
  setAdminSettings(enabled: boolean): void {
    this.adminSkillsEnabled = enabled;
  }

  /**
   * Returns true if skills are enabled by the admin.
   */
  isAdminEnabled(): boolean {
    return this.adminSkillsEnabled;
  }

  /**
   * Discovers skills from standard user and workspace locations, as well as extensions.
   * Precedence: Extensions (lowest) -> User -> Workspace (highest).
   */
  async discoverSkills(
    storage: Storage,
    extensions: GeminiCLIExtension[] = [],
    isTrusted: boolean = false,
  ): Promise<void> {
    // Reset only the filesystem-owned portion; sourced skills (e.g. MCP) are
    // managed by their providers via setSkillsForSource and should survive a
    // filesystem re-scan. The merged view in this.skills keeps whatever MCP
    // skills were already registered so concurrent getSkills() callers don't
    // briefly see an empty MCP set during the async filesystem scan.
    this.localSkills = [];

    // 1. Built-in skills (lowest precedence)
    await this.discoverBuiltinSkills();

    // 2. Extension skills
    for (const extension of extensions) {
      if (extension.isActive && extension.skills) {
        this.addSkillsWithPrecedence(extension.skills);
      }
    }

    // 3. User skills
    const userSkills = await loadSkillsFromDir(Storage.getUserSkillsDir());
    this.addSkillsWithPrecedence(userSkills);

    // 3.1 User agent skills alias (.agents/skills)
    const userAgentSkills = await loadSkillsFromDir(
      Storage.getUserAgentSkillsDir(),
    );
    this.addSkillsWithPrecedence(userAgentSkills);

    // 4. Workspace skills (highest precedence)
    if (!isTrusted) {
      debugLogger.debug(
        'Workspace skills disabled because folder is not trusted.',
      );
      this.rebuildSkillList();
      return;
    }

    const projectSkills = await loadSkillsFromDir(
      storage.getProjectSkillsDir(),
    );
    this.addSkillsWithPrecedence(projectSkills);

    // 4.1 Workspace agent skills alias (.agents/skills)
    const projectAgentSkills = await loadSkillsFromDir(
      storage.getProjectAgentSkillsDir(),
    );
    this.addSkillsWithPrecedence(projectAgentSkills);

    this.rebuildSkillList();
  }

  /**
   * Discovers built-in skills.
   */
  private async discoverBuiltinSkills(): Promise<void> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const builtinDir = path.join(__dirname, 'builtin');

    const builtinSkills = await loadSkillsFromDir(builtinDir);

    for (const skill of builtinSkills) {
      skill.isBuiltin = true;
    }

    this.addSkillsWithPrecedence(builtinSkills);
  }

  /**
   * Adds skills to the manager programmatically.
   */
  addSkills(skills: SkillDefinition[]): void {
    this.addSkillsWithPrecedence(skills);
    this.rebuildSkillList();
  }

  /**
   * Replaces the set of skills registered under a given source tag. Used by
   * dynamic providers (e.g. MCP servers) to keep their skills in sync with
   * server state — pass an empty array on disconnect to clear. Local
   * filesystem skills (isBuiltin, extension, user, workspace) always win on
   * name collision; when a MCP skill is shadowed by a local skill a warning
   * is emitted once.
   */
  setSkillsForSource(sourceTag: string, skills: SkillDefinition[]): void {
    if (skills.length === 0) {
      this.sourcedSkills.delete(sourceTag);
    } else {
      this.sourcedSkills.set(sourceTag, skills);
    }
    this.rebuildSkillList();
  }

  /**
   * Rebuilds the merged skill list from localSkills + sourcedSkills. Local
   * filesystem skills always win on name collision (case-insensitive); the
   * first sourced skill to claim a name wins across MCP sources, with later
   * duplicates dropped with a warning.
   */
  private rebuildSkillList(): void {
    const localNames = new Set(
      this.localSkills.map((s) => s.name.toLowerCase()),
    );
    const takenNames = new Set(localNames);
    const merged: SkillDefinition[] = [...this.localSkills];

    for (const [sourceTag, sourcedSkills] of this.sourcedSkills) {
      for (const skill of sourcedSkills) {
        const key = skill.name.toLowerCase();
        if (localNames.has(key)) {
          coreEvents.emitFeedback(
            'warning',
            `Skill "${skill.name}" from ${sourceTag} is shadowed by a local skill of the same name.`,
          );
          continue;
        }
        if (takenNames.has(key)) {
          coreEvents.emitFeedback(
            'warning',
            `Skill "${skill.name}" from ${sourceTag} is shadowed by another source that registered the same name first.`,
          );
          continue;
        }
        takenNames.add(key);
        merged.push(skill);
      }
    }

    this.skills = merged;
  }

  private addSkillsWithPrecedence(newSkills: SkillDefinition[]): void {
    const skillMap = new Map<string, SkillDefinition>(
      this.localSkills.map((s) => [s.name.toLowerCase(), s]),
    );

    for (const newSkill of newSkills) {
      const key = newSkill.name.toLowerCase();
      const existingSkill = skillMap.get(key);
      if (existingSkill && existingSkill.location !== newSkill.location) {
        if (existingSkill.isBuiltin) {
          debugLogger.warn(
            `Skill "${newSkill.name}" from "${newSkill.location}" is overriding the built-in skill.`,
          );
        } else {
          coreEvents.emitFeedback(
            'warning',
            `Skill conflict detected: "${newSkill.name}" from "${newSkill.location}" is overriding the same skill from "${existingSkill.location}".`,
          );
        }
      }
      skillMap.set(key, newSkill);
    }

    this.localSkills = Array.from(skillMap.values());
  }

  /**
   * Returns the list of enabled discovered skills.
   */
  getSkills(): SkillDefinition[] {
    return this.skills.filter((s) => !s.disabled);
  }

  /**
   * Returns the list of enabled discovered skills that should be displayed in the UI.
   * This excludes built-in skills.
   */
  getDisplayableSkills(): SkillDefinition[] {
    return this.skills.filter((s) => !s.disabled && !s.isBuiltin);
  }

  /**
   * Returns all discovered skills, including disabled ones.
   */
  getAllSkills(): SkillDefinition[] {
    return this.skills;
  }

  /**
   * Filters discovered skills by name.
   */
  filterSkills(predicate: (skill: SkillDefinition) => boolean): void {
    this.skills = this.skills.filter(predicate);
  }

  /**
   * Sets the list of disabled skill names.
   */
  setDisabledSkills(disabledNames: string[]): void {
    const lowercaseDisabledNames = disabledNames.map((n) => n.toLowerCase());
    for (const skill of this.skills) {
      skill.disabled = lowercaseDisabledNames.includes(
        skill.name.toLowerCase(),
      );
    }
  }

  /**
   * Reads the full content (metadata + body) of a skill by name.
   */
  getSkill(name: string): SkillDefinition | null {
    const lowercaseName = name.toLowerCase();
    return (
      this.skills.find((s) => s.name.toLowerCase() === lowercaseName) ?? null
    );
  }
}
