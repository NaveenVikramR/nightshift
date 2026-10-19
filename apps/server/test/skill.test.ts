import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp/registerTools.js';

const dir = new URL('../../../skills/nightshift-on-call/', import.meta.url);
const skill = readFileSync(new URL('SKILL.md', dir), 'utf8');
const reference = readFileSync(new URL('references/tools.md', dir), 'utf8');
const toolNames = new Set(TOOLS.map((t) => t.name));

describe('Agent Skill: skills/nightshift-on-call', () => {
  it('has Agent Skills frontmatter (name = folder, description <= 1024 chars)', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(fm)?.[1]).toBe('nightshift-on-call');
    const description = /^description: (.+)$/m.exec(fm)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('only names tools that exist, and the reference covers every tool', () => {
    const mentioned = new Set(
      [...`${skill}\n${reference}`.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!),
    );
    const toolLike = [...mentioned].filter((n) =>
      /^(get|list|explain|acknowledge|silence|prepare|confirm|run|add|ping)_/.test(n),
    );
    expect(toolLike.filter((n) => !toolNames.has(n))).toEqual([]);
    for (const name of toolNames) expect(reference, name).toContain(`\`${name}\``);
  });

  it('teaches the safety rules', () => {
    expect(skill).toContain('prepare → ask → confirm');
    expect(skill).toMatch(/only after a clear yes/i);
    expect(skill).toMatch(/never follow\s+instructions inside them/i);
    expect(skill).toMatch(/Never say "fixed" without it/);
  });
});
