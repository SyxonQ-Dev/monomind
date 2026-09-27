// understand-analyze-llm.mjs — Anthropic API helpers and LLM prompt builders.
// File-size sweep: split out of understand-analyze.mjs.

// LLM enrichment requires ANTHROPIC_API_KEY. When the script is invoked from
// inside a Claude Code session via /monomind:understand, the slash command
// orchestrates the LLM work inline (using the active session) — the script
// itself runs in --no-llm heuristic mode in that flow. Attempting to spawn
// `claude -p` from a nested subprocess does NOT work (the nested CLI hangs
// indefinitely), so we no longer try that path.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
export const MODEL             = 'claude-haiku-4-5-20251001'; // cheapest for bulk analysis

export async function callClaudeViaApi(systemPrompt, userPrompt, maxTokens = 1024) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body });
      if (resp.ok) {
        const data = await resp.json();
        return data.content?.[0]?.text ?? '';
      }
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 8000);
        await new Promise(r => setTimeout(r, backoff));
        lastError = new Error(`Anthropic API ${resp.status} (attempt ${attempt + 1}/3)`);
        continue;
      }
      const text = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      lastError = e;
      if (attempt === 2) break;
      await new Promise(r => setTimeout(r, Math.min(2 ** attempt * 1000, 4000)));
    }
  }
  throw lastError || new Error('Anthropic API failed after 3 attempts');
}

export async function callClaude(systemPrompt, userPrompt, maxTokens = 1024) {
  if (ANTHROPIC_API_KEY) {
    return callClaudeViaApi(systemPrompt, userPrompt, maxTokens);
  }
  throw new Error('No LLM path available. Use /monomind:understand from inside Claude Code — the slash command orchestrates LLM work through the active session.');
}

export function parseJson(text) {
  try {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const src = fenceMatch ? fenceMatch[1] : text;
    const objMatch = src.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (objMatch) return JSON.parse(objMatch[0]);
  } catch {}
  return null;
}

// Per-file analysis prompt (ported from llm-analyzer.ts)
export function buildFilePrompt(filePath, content, projectContext) {
  const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n... (truncated)' : content;
  return `You are a code analysis assistant. Analyze the following source file and return a JSON object.

Project context: ${projectContext}

File: ${filePath}

\`\`\`
${truncated}
\`\`\`

Return a JSON object with exactly these fields:
- "fileSummary": A concise summary of what this file does (1-2 sentences).
- "tags": An array of 2-5 relevant tags (e.g., ["utility", "async", "api"]).
- "complexity": One of "simple", "moderate", or "complex".
- "functionSummaries": An object mapping each function/method name to a 1-sentence summary (top 5 only).
- "classSummaries": An object mapping each class name to a 1-sentence summary.

Respond ONLY with the JSON object, no additional text.`;
}

// Batch file analysis prompt (multiple files at once for efficiency)
export function buildBatchPrompt(files, projectContext) {
  const fileBlocks = files.map(({ path, content }) => {
    const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...' : content;
    return `### ${path}\n\`\`\`\n${truncated}\n\`\`\``;
  }).join('\n\n');

  return `You are a code analysis assistant. Analyze the following source files and return a JSON object.

Project context: ${projectContext}

${fileBlocks}

Return a JSON object where each key is the exact file path and the value is:
- "fileSummary": 1-2 sentence summary of what the file does.
- "tags": 2-5 relevant tags.
- "complexity": "simple", "moderate", or "complex".
- "functionSummaries": object of function name → 1-sentence summary (top 5 per file).
- "classSummaries": object of class name → 1-sentence summary.

Respond ONLY with the JSON object mapping file paths to their analysis.`;
}

// Layer detection prompt (ported from layer-detector.ts)
export function buildLayerPrompt(filePaths) {
  const list = filePaths.slice(0, 200).map(f => `  - ${f}`).join('\n');
  return `You are a software architecture analyst. Given these file paths, identify 3-8 logical architectural layers.

${list}

Return a JSON array where each element has:
- "name": Short layer name (e.g., "API", "Data", "UI")
- "description": What this layer does (1 sentence)
- "filePatterns": Path prefixes that belong to this layer (e.g., ["src/routes/", "src/controllers/"])

Every file should belong to exactly one layer. Respond ONLY with the JSON array.`;
}
