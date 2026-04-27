/**
 * /best — Best things to do and upcoming events at a given location.
 *
 * Searches for:
 *   - Top local activities, attractions, and experiences
 *   - Upcoming events in the next 7 days (concerts, festivals, markets, sports, etc.)
 *   - Seasonal or weather-appropriate recommendations
 *
 * Exports:
 *   generateBest()        — run the briefing agent for a location
 *   getDefaultLocation()  — read the saved default zip code
 *   setDefaultLocation()  — persist a new default zip code
 *   isValidZipCode()      — validate a 5-digit US zip code
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCATION_FILE = path.join(PROJECT_DIR, 'default-location');

export function isValidZipCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}

export function getDefaultLocation(): string | null {
  try {
    const saved = fs.readFileSync(DEFAULT_LOCATION_FILE, 'utf8').trim();
    return saved || null;
  } catch {
    return null;
  }
}

export function setDefaultLocation(zip: string): void {
  fs.writeFileSync(DEFAULT_LOCATION_FILE, zip.trim(), 'utf8');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a sharp local insider writing a "best things to do this week" briefing for a friend who lives in the area and wants real, specific picks — not tourist-trap generic lists.

MANDATORY: You MUST use web_search to find real, current information before writing anything. NEVER fabricate, simulate, or invent event data. If search results are sparse, say so — do not make up picks.

CRITICAL INSTRUCTION: Begin your response immediately with "BEST —" followed by the location and date range on the very first line. Never ask the user for clarification — search immediately with whatever location was given. If a zip code is given, identify the city it belongs to and use that name.

VOICE AND STYLE
- Opinionated, specific, and local — cite venue names, dates, and neighborhoods
- Plain text only — no markdown, no asterisks, no bullet symbols. Signal does not render markdown.
- Use dashes (—) as separators within a line, blank lines between picks
- Keep each pick under 60 words
- Max 8 picks total. Prioritize what is time-sensitive or unique this week

OUTPUT FORMAT — follow exactly:

BEST — [Location] — [Month DD]–[Month DD YYYY]

[Category: EVENTS / FOOD + DRINK / OUTDOORS / ARTS / SPORTS — pick whichever fit]

[Pick title or event name]
[Date/time] — [Venue, neighborhood]
[One or two sentences: what makes this worth going, any ticket/reservation note]

(repeat for each pick, blank line between each)

DO NOT include picks that are open year-round with no special hook this week. Everything should feel time-sensitive or locally relevant right now.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 12,
  },
];

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

function buildInitialPrompt(location: string, dateContext: string): string {
  return `Generate a "best things" briefing for ${location} around the date ${dateContext}.

Use web_search to find:

1. Upcoming events in ${location} around ${dateContext} — search:
   - "${location} events ${dateContext}"
   - "${location} concerts ${dateContext}"
   - "${location} festivals ${dateContext}"
   - "${location} things to do ${dateContext}"

2. Time-limited food and drink experiences:
   - "${location} restaurant opening 2026"
   - "${location} pop-up bar event"
   - "${location} farmers market ${dateContext}"

3. Outdoor and seasonal picks:
   - "${location} outdoor events ${dateContext}"
   - "${location} hiking trail conditions" (if relevant to season)

4. Arts and sports:
   - "${location} museum exhibit opening"
   - "${location} sports games ${dateContext}"

Prioritize picks that are happening only around this date or are newly opened. Skip anything that runs year-round without a specific hook.

Write the briefing exactly per the format in your instructions.`;
}

const MAX_CONTINUATIONS = 3;
const MAX_ITERATIONS = 20;

export async function generateBest(
  client: Anthropic,
  model: string,
  location: string,
  dateContext?: string,
): Promise<string> {
  const date = dateContext ?? new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const history: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialPrompt(location, date) },
  ];

  const allTextParts: string[] = [];
  let continuationCount = 0;
  let iterations = 0;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: history,
    });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    if (textBlocks.length > 0) {
      allTextParts.push(textBlocks.map(b => b.text).join(''));
    }

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // web_search_20260209 is fully server-side: the API executes the search
      // and returns WebSearchToolResultBlock entries in response.content
      // alongside ServerToolUseBlock. The client never executes searches or
      // fabricates results — the real data is already in response.content.
      const clientToolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (clientToolUseBlocks.length > 0) {
        // No client-side tools are defined — this should never happen.
        return '(error: unexpected client-side tool_use with no handler)';
      }
      // Server-side tool results already embedded in content; continue so
      // the model can synthesize them into the final briefing.
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      if (continuationCount >= MAX_CONTINUATIONS) break;
      continuationCount++;
      history.push({ role: 'user', content: 'Continue the briefing.' });
      continue;
    }

    return `(unexpected stop: ${response.stop_reason})`;
  }

  const text = allTextParts.join('').trim();
  return text || '(no picks found)';
}
