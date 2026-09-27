/**
 * Offline regression for the keyword ranker (.claude/helpers/pick-rank.cjs):
 * a frozen catalog excerpt and tasks with the entries a person would expect
 * near the top. No network — this pins `shortlist` / `keywordRank` only.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keywordRank } from '../../src/decision/jev.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pr: any = require('../../.claude/helpers/pick-rank.cjs');

interface Item {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  text?: string;
  pick?: string;
}
const catalog: { agents: Item[]; skills: Item[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'pick-rank-catalog.json'), 'utf-8'),
);

const top = (query: string, items: Item[], n = 3): string[] =>
  keywordRank(query, items, n).map((i) => i.id);

// [task, an id expected in the top 3 (first = expected top 1), ids that must not lead]
const AGENT_CASES: Array<[string, string[], string[]?]> = [
  ['Write unit tests for the payment parser and raise coverage', ['tester']],
  ['Testing the checkout API endpoints', ['testing-api-tester']],
  ['Write the README and a getting-started tutorial', ['engineering-technical-writer'], ['goal-planner']],
  ['Optimize slow PostgreSQL queries with better indexes', ['engineering-database-optimizer']],
  ['Rebase the feature branch and tidy the commit history', ['engineering-git-workflow-master']],
  ['Set up a CI/CD pipeline with infrastructure as code', ['engineering-devops-automator']],
  ['Write a drip email sequence for new trial users', ['marketing-email-specialist']],
  ['Audit the authentication code for OWASP vulnerabilities', ['engineering-security-engineer']],
  ['Benchmark request latency and improve performance', ['testing-performance-benchmarker']],
  ['Cut a release and bump versions across all packages', ['release-manager']],
  ['Build a responsive web component with CSS for the frontend', ['engineering-frontend-developer']],
  ['Define SLOs and error budgets with better observability', ['engineering-sre']],
  ['Improve conversion on the pricing landing page', ['marketing-cro-specialist']],
  ['Design a REST API for orders backed by a database', ['engineering-backend-architect'], ['design-monodesign']],
];

const SKILL_CASES: Array<[string, string[], string[]?]> = [
  ['Build a responsive React settings page', ['react-patterns', 'responsive-design']],
  ['Debug a failing test and find the root cause', ['mastermind:debug', 'systematic-debugging']],
  ['Write landing page copy for the homepage', ['copywriting', 'page-cro'], ['mastermind-invite-landing']],
  ['Find the performance bottleneck', ['analysis:performance-bottlenecks', 'analysis:bottleneck-detect']],
  ['Tune PostgreSQL query indexes', ['postgres-patterns']],
  ['Coordinate multi-agent work with a monoswarm', ['monoswarm']],
];

describe('keyword ranking on a frozen catalog', () => {
  for (const [kind, cases] of [
    ['agents', AGENT_CASES],
    ['skills', SKILL_CASES],
  ] as const) {
    for (const [task, want, notFirst = []] of cases) {
      it(`${kind}: ${task}`, () => {
        const got = top(task, catalog[kind]);
        expect(got.some((id) => want.includes(id)), `top 3 was ${got.join(', ')}`).toBe(true);
        expect(notFirst).not.toContain(got[0]);
      });
    }
  }

  it('puts the best agent first on most tasks', () => {
    const hits = AGENT_CASES.filter(([task, want]) => top(task, catalog.agents, 1)[0] === want[0]);
    expect(hits.length).toBeGreaterThanOrEqual(AGENT_CASES.length - 2);
  });
});

describe('pick-rank tokens', () => {
  it('lets a word’s forms meet', () => {
    const stems = ['test', 'tests', 'testing', 'tester', 'testers', 'tested'].map(pr.stem);
    expect(new Set(stems).size).toBe(1);
    expect(new Set(['optimize', 'optimization', 'optimizing', 'optimizer'].map(pr.stem)).size).toBe(1);
    expect(new Set(['plan', 'planning', 'planner'].map(pr.stem)).size).toBe(1);
  });

  it('keeps -ment, -ate/-ator and -ion forms apart (evaluated and rejected, see stem())', () => {
    // Merging these moved the eval without a gain and showed wrong [PICK]s;
    // change them only with a before/after run of tests/pick-eval.
    expect(pr.stem('deployment')).not.toBe(pr.stem('deploy'));
    expect(pr.stem('evaluate')).not.toBe(pr.stem('evaluation'));
    expect(pr.stem('generator')).not.toBe(pr.stem('generation'));
    expect(pr.stem('execution')).not.toBe(pr.stem('execute'));
    expect(pr.stem('production')).not.toBe(pr.stem('product'));
  });

  it('drops stopwords, so function words match nothing', () => {
    expect(pr.tokens('for the and with our')).toEqual([]);
    expect(top('for the and with our', catalog.agents)).toEqual([]);
  });

  it('does not reward a long description for its length', () => {
    // goal-planner's description is ~1,300 chars and says "planning" often.
    expect(top('Write the README and a getting-started tutorial', catalog.agents)).not.toContain(
      'goal-planner',
    );
  });

  it('breaks ties by catalog order and keeps forced ids first', () => {
    const items = [
      { id: 'b-one', description: 'widget' },
      { id: 'a-two', description: 'widget' },
      { id: 'c-three', description: 'other' },
    ];
    expect(pr.shortlist('widget', items, 3).map((i: Item) => i.id)).toEqual(['b-one', 'a-two', 'c-three']);
    expect(pr.shortlist('widget', items, 2, ['c-three']).map((i: Item) => i.id)).toEqual(['c-three', 'b-one']);
  });

  it('ranks a pick: low item below an equally matching one, but still returns it', () => {
    const items = [
      { id: 'org-admin', description: 'Review', pick: 'low' },
      { id: 'auditor', description: 'Review code changes' },
    ];
    expect(pr.shortlist('review', items, 2).map((i: Item) => i.id)).toEqual(['auditor', 'org-admin']);
    expect(pr.shortlist('review', items, 2)[1].score).toBeGreaterThan(0);
    expect(top('org admin', items, 1)).toEqual(['org-admin']);
  });

  it('scores a name or id word above the same word in a description', () => {
    const items = [
      { id: 'writer', description: 'Produces docs' },
      { id: 'other', description: 'A writer of docs' },
    ];
    expect(pr.shortlist('writer', items, 2).map((i: Item) => i.id)).toEqual(['writer', 'other']);
  });

  it('ignores a category prefix shared by many ids', () => {
    const items = [
      { id: 'design-alpha', description: 'Brand work' },
      { id: 'design-beta', description: 'Motion' },
      { id: 'design-gamma', description: 'Icons' },
      { id: 'api-architect', description: 'Can design REST APIs' },
    ];
    expect(pr.shortlist('design a REST API', items, 1)[0].id).toBe('api-architect');
  });
});

describe('pick-rank tokens beyond ASCII', () => {
  it('folds accents so an accented word meets its plain form', () => {
    expect(pr.tokens('Café résumé naïve')).toEqual(pr.tokens('cafe resume naive'));
    expect(pr.tokens('Café résumé naïve').length).toBe(3);
  });

  it('keeps Cyrillic and Greek words', () => {
    expect(pr.tokens('проверить безопасность API')).toEqual(['проверить', 'безопасность', 'api']);
    expect(pr.tokens('ασφάλεια')).toEqual(['ασφαλεια']);
  });

  it('splits CJK runs into character bigrams', () => {
    expect(pr.tokens('安全审计')).toEqual(['安全', '全审', '审计']);
    expect(pr.tokens('テスト')).toEqual(['テス', 'スト']);
  });

  it('ranks a matching non-Latin description above zero', () => {
    const items = [
      { id: 'sec', description: '代码安全审计与漏洞评估' },
      { id: 'docs', description: '编写文档' },
      { id: 'ru', description: 'Проверка безопасности кода' },
    ];
    const zh = pr.shortlist('请做一次安全审计', items, 3);
    expect(zh[0]).toMatchObject({ id: 'sec' });
    expect(zh[0].score).toBeGreaterThan(0);
    const ru = pr.shortlist('проверка безопасности', items, 3);
    expect(ru[0]).toMatchObject({ id: 'ru' });
    expect(ru[0].score).toBeGreaterThan(0);
  });

  it('leaves English tokens as they were', () => {
    expect(pr.tokens('Testing the optimizer for our CI/CD pipelines')).toEqual([
      'test',
      'optimiz',
      'ci',
      'cd',
      'pipelin',
    ]);
  });
});

describe('pick-rank exclusion cues', () => {
  const q = (text: string): string[] => pr.queryTokens(text);

  it.each([
    ['anything pending rather than release', 'releas'],
    ['anything pending other than release', 'releas'],
    ['write docs instead of tests', 'test'],
    ['review everything except security', 'security'],
    ['review everything except for security', 'security'],
    ['review everything besides security', 'security'],
    ['review everything apart from security', 'security'],
    ['review everything aside from security', 'security'],
    ['review everything excluding security', 'security'],
    ['security review, not a penetration test', 'penetr'],
    ['refactor the parser with no database changes', 'databas'],
    ['deploy the app without touching CI', 'ci'],
    ["deploy the app but don't touch CI", 'ci'],
    ['deploy the app but don’t touch CI', 'ci'],
    ['deploy the app but dont touch CI', 'ci'],
    ['deploy the app, do not touch CI', 'ci'],
  ])('%s drops %s', (text, word) => {
    expect(q(text)).not.toContain(word);
    expect(pr.tokens(text)).toContain(word);
  });

  it('drops the cue words themselves', () => {
    expect(q('write docs instead of tests rather than release')).toEqual(['writ', 'doc']);
  });

  it('ends the scope at punctuation', () => {
    expect(q('not the parser; optimize queries')).toEqual(['optimiz', 'query']);
    expect(q('no tests. Optimize queries')).toEqual(['optimiz', 'query']);
  });

  it('ends the scope at and / but / then, once a word was dropped', () => {
    expect(q('skip nothing: without touching CI and deploy the app')).toContain('deploy');
    expect(q('without CI but deploy the app')).toEqual(['deploy', 'app']);
    expect(q('without CI then deploy the app')).toEqual(['deploy', 'app']);
  });

  it('keeps excluding across or / nor', () => {
    expect(q('deploy without CI or staging')).toEqual(['deploy']);
  });

  it('ends the scope after four content words', () => {
    expect(q('without alpha beta gamma delta epsilon')).toEqual(['epsilon']);
  });

  it('leaves problem descriptions alone (is not, does not, are no, can not)', () => {
    expect(q('the page is not loading')).toContain('load');
    expect(q("login doesn't work")).toContain('work');
    expect(q('there are no tests for the parser')).toEqual(['test', 'pars']);
    expect(q("I can't reproduce the crash")).toContain('crash');
    expect(q("I don't know why the build fails")).toContain('build');
    expect(q('I do not know why the build fails')).toContain('build');
  });

  it('leaves "not only" alone', () => {
    expect(q('not only tests but docs')).toEqual(['test', 'doc']);
  });

  it('leaves a text without cues as tokens() makes it', () => {
    const text = 'Set up SLOs and error budgets for the checkout service';
    expect(q(text)).toEqual(pr.tokens(text));
  });

  it('keeps an excluded word from deciding the shortlist', () => {
    const items = [
      { id: 'release-manager', description: 'Release coordination, version bumps and changelogs' },
      { id: 'planner', description: 'Tracks pending work and what is left to do' },
    ];
    expect(pr.shortlist('anything pending rather than release', items, 2)[0].id).toBe('planner');
    expect(pr.shortlist('pending release', items, 2)[0].id).toBe('release-manager');
  });
});

describe('pick-rank exclusion clauses in descriptions', () => {
  // Verbatim from the frozen eval catalog (tests/pick-eval/catalog-snapshot.json).
  const pr_ = {
    id: 'public-relations',
    description:
      'Use when seeking earned media for a software product: journalist and podcast pitching, newsjacking, press requests, media lists and press kits. Covers story angles, when PR is worth it, and PR as a distribution multiplier. Not for pull requests.',
    text: 'marketing writing communication content',
  };
  const reviewer = {
    id: 'code-reviewer',
    description:
      'Org role guidance for a code reviewer: review PRs for bugs, security holes, N+1 queries and design issues, then write a structured, prioritized report. Workflow with checklist, feedback and spec-compliance references.',
    text: 'engineering testing code-review',
  };
  const planner = { id: 'planner', description: 'Breaks work into tasks; not for writing code' };
  const coder = { id: 'coder', description: 'Writes and changes production code' };

  it('a "not for X" clause no longer matches X, and a task naming X demotes the item', () => {
    const items = [pr_, reviewer, { id: 'other', description: 'Unrelated filler entry' }];
    const got = pr.shortlist('review pull request 482 for correctness', items, 3);
    expect(got[0].id).toBe('code-reviewer');
    const prScore = got.find((i: { id: string }) => i.id === 'public-relations').score;
    // Nothing but "pull request" overlapped it: demoted to (near) nothing.
    expect(prScore).toBeLessThan(0.5);
    // The rest of the description still ranks it for its own work.
    expect(top('pitch our launch to journalists and press', items, 1)).toEqual(['public-relations']);
  });

  it('demotes on most of the ruled-out words, not on a shared one', () => {
    expect(top('write the code for the parser', [planner, coder], 1)).toEqual(['coder']);
    // "writing tasks" shares one of planner's two ruled-out words: not demoted.
    const s = pr.shortlist('break the work into tasks', [planner, coder], 2);
    expect(s[0].id).toBe('planner');
  });

  it('exposes the parsed clauses', () => {
    const ex = pr.docExclusions('Plans work; not for writing code or market sizing. Covers X');
    expect(ex.ruledOut).toEqual([pr.tokens('writing code'), pr.tokens('market sizing')]);
    expect(ex.kept).not.toContain('code');
    expect(ex.kept).toContain('covers x');
  });

  it('reads a "for X use Y" redirect as work the item is not for', () => {
    const ex = pr.docExclusions(
      'Builds services; for Node code patterns use backend-patterns, for UI work see web-ui. For claim appraisal, use critic. For teams of five.',
    );
    expect(ex.ruledOut).toEqual([
      pr.tokens('Node code patterns'),
      pr.tokens('UI work'),
      pr.tokens('claim appraisal'),
    ]);
    // Neither the redirected work nor the other entry's id describe this one.
    for (const word of ['node', 'patterns', 'web', 'critic']) expect(ex.kept).not.toContain(word);
    // A clause that only starts with "for" is not a redirect.
    expect(ex.kept).toContain('for teams of five');
  });

  it('ranks an item by its own work, not by the work it redirects', () => {
    // Verbatim from the frozen eval catalog: the redirect's "Node" and the
    // pointer's "build process" outranked the debugging skills.
    const mcp = {
      id: 'mcp-server-patterns',
      description:
        'Use when writing or debugging an MCP server with the Node or TypeScript SDK: registering tools, resources and prompts, Zod validation and transport choice. Quick SDK patterns; for an end-to-end build process see mcp-server-builder.',
      text: 'ai-ml backend mcp typescript',
    };
    const backend = {
      id: 'backend-dev',
      description:
        'Use when an org role acts as backend developer and must build server-side services, APIs and database logic that are correct, secure and performant under load. Covers boundary validation, parameterized queries, idempotent writes and N+1 avoidance; for Node code patterns use backend-patterns.',
      text: 'engineering backend api database',
    };
    const score = (q: string, id: string, items: Item[]) =>
      pr.shortlist(q, items, items.length).find((i: Item) => i.id === id).score;
    const filler = { id: 'filler', description: 'Unrelated filler entry' };
    expect(score('run the build process', 'mcp-server-patterns', [mcp, filler])).toBe(0);
    expect(score('Node code patterns', 'backend-dev', [backend, filler])).toBe(0);
    // Its own words still rank it.
    expect(top('debug an MCP server', [filler, mcp], 1)).toEqual(['mcp-server-patterns']);
  });
});

describe('pick-rank task head and modifiers', () => {
  const terms = (text: string): [string, number][] => [...pr.queryTerms(text)];

  it('weighs a purpose phrase or relative clause at half its head', () => {
    expect(terms('write developer documentation for the REST API')).toEqual([
      ['writ', 1],
      ['develop', 1],
      ['document', 1],
      ['rest', 0.5],
      ['api', 0.5],
    ]);
    expect(terms('create a new org that monitors competitors')).toEqual([
      ['creat', 1],
      ['org', 1],
      ['monitor', 0.5],
      ['competitor', 0.5],
    ]);
  });

  it('keeps a demonstrative "that" and a leading "for" in the head', () => {
    expect(terms('fix that bug in the parser').every(([, w]) => w === 1)).toBe(true);
    expect(terms('for the parser, add tests').every(([, w]) => w === 1)).toBe(true);
  });

  it('ends a modifier at "and"', () => {
    expect(terms('write unit tests for the parser and raise coverage')).toContainEqual(['coverag', 1]);
  });

  it('treats "new" as a stopword', () => {
    expect(pr.tokens('create a new org')).toEqual(['creat', 'org']);
  });

  it('ranks the item matching the head above one matching only the modifier', () => {
    const items = [
      { id: 'api-designer', description: 'Designs REST APIs and writes their documentation' },
      { id: 'code-documenter', description: 'Writes developer documentation for code' },
      { id: 'tester', description: 'Writes unit tests' },
      { id: 'deployer', description: 'Ships releases to production' },
      { id: 'db-tuner', description: 'Tunes slow database queries' },
      { id: 'marketer', description: 'Plans launch campaigns' },
    ];
    expect(top('write developer documentation for the REST API', items, 1)).toEqual(['code-documenter']);
  });
});

describe('pick-rank catalog structure', () => {
  it('ignores a description opening that a large share of the catalog shares', () => {
    const role = (id: string, what: string) => ({
      id,
      description: `Use when an org role acts as ${what} and must report weekly`,
    });
    const items = [
      role('analyst', 'market analyst'),
      role('writer', 'content writer'),
      role('seller', 'account executive'),
      role('buyer', 'procurement lead'),
      { id: 'org-runner', description: 'Starts, stops and inspects a running org' },
    ];
    const got = pr.shortlist('inspect the org', items, 5);
    expect(got[0].id).toBe('org-runner');
    expect(got.filter((i: { score: number }) => i.score > 0).map((i: Item) => i.id)).toEqual(['org-runner']);
  });

  it('reads an id word joining two other id words as both', () => {
    const items = [
      { id: 'createorg', description: 'Define and save an agent organization' },
      { id: 'workflow-create', description: 'Make a reusable workflow' },
      { id: 'mastermind-org', description: 'Inspect a running organization' },
    ];
    const got = pr.shortlist('create an org', items, 3);
    expect(got[0].id).toBe('createorg');
  });
});
