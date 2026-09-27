import {
  CAPABILITIES,
  type Capability,
  type PlatformAdapter,
  type PlatformId,
  type VerificationEvidence,
} from './types.js';

const unverifiedEvidence = (): VerificationEvidence => ({
  level: 'none',
  verifiedAt: '2026-08-24',
});
const schemaEvidence = (sourceUrl: string, sourceLocator: string): VerificationEvidence => ({
  level: 'schema',
  sourceUrl,
  sourceLocator,
  verifiedAt: '2026-08-24',
});

/**
 * Sources are intentionally limited to Markdown surfaces. JSONC/TOML/YAML
 * configuration remains experimental until its parser contract is implemented
 * and then accepted by a target schema or a real-runtime smoke test.
 */
const VERIFIED_NATIVE_CAPABILITIES: Partial<
  Record<PlatformId, Partial<Record<Capability, VerificationEvidence>>>
> = {
  claude: {
    instructions: schemaEvidence(
      'https://code.claude.com/docs/en/features-overview',
      'Project instructions',
    ),
    skills: schemaEvidence('https://code.claude.com/docs/en/skills', 'Skill directories'),
  },
  gemini: {
    instructions: schemaEvidence(
      'https://github.com/google-gemini/gemini-cli/tree/main/docs',
      'GEMINI.md instructions',
    ),
    skills: schemaEvidence(
      'https://github.com/google-gemini/gemini-cli/tree/main/docs',
      'Skills directories',
    ),
  },
  cursor: {
    instructions: schemaEvidence('https://cursor.com/docs/context/rules', 'Project rules'),
    skills: schemaEvidence('https://cursor.com/docs/context/skills', 'Skills directories'),
  },
  vscode: {
    instructions: schemaEvidence(
      'https://code.visualstudio.com/docs/agent/customization',
      'Custom instructions',
    ),
    skills: schemaEvidence(
      'https://code.visualstudio.com/docs/agent-customization/agent-skills',
      'Agent skills',
    ),
  },
  copilot: {
    instructions: schemaEvidence(
      'https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot',
      'Repository instructions',
    ),
    skills: schemaEvidence(
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills',
      'Copilot CLI skills',
    ),
  },
  opencode: {
    instructions: schemaEvidence('https://opencode.ai/docs', 'AGENTS.md instructions'),
    skills: schemaEvidence('https://opencode.ai/docs/skills/', 'Skills directories'),
  },
  aider: {
    instructions: schemaEvidence(
      'https://aider.chat/docs/config/aider_conf.html',
      'read: conventions file',
    ),
  },
  kiro: {
    instructions: schemaEvidence('https://kiro.dev/docs/steering/', 'Steering files'),
    skills: schemaEvidence('https://kiro.dev/docs/skills/', 'Skills directories'),
  },
  openclaw: {
    instructions: schemaEvidence(
      'https://docs.openclaw.ai/configuration',
      'Workspace instructions',
    ),
    skills: schemaEvidence('https://docs.openclaw.ai/tools/skills', 'Skills directories'),
  },
  droid: {
    instructions: schemaEvidence('https://docs.factory.ai/harness', 'AGENTS.md instructions'),
    skills: schemaEvidence('https://docs.factory.ai/harness/skills', 'Skills directories'),
  },
  codex: {
    instructions: schemaEvidence(
      'https://learn.chatgpt.com/docs/config-file/config-reference',
      'Project instructions',
    ),
    skills: schemaEvidence('https://learn.chatgpt.com/docs/build-skills.md', 'Skills directories'),
  },
  kimi: {
    skills: schemaEvidence(
      'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html',
      'Skills directories',
    ),
  },
};

export function verification(platform: PlatformId): PlatformAdapter['verification'] {
  return Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      VERIFIED_NATIVE_CAPABILITIES[platform]?.[capability] ?? unverifiedEvidence(),
    ]),
  ) as PlatformAdapter['verification'];
}
