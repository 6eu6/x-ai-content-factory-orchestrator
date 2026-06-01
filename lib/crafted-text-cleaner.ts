/**
 * crafted-text-cleaner.ts — Phase 2C: Extract plain text from JSON/markdown wrappers
 *
 * Problem: The AI model sometimes returns crafted_text wrapped in JSON objects
 * or markdown code fences, e.g.:
 *   ```json\n{ "reply": "actual text" }\n```
 *   { "quote": "actual text" }
 *   { "quote_tweet": "actual text" }
 *   { "text": "actual text" }
 *
 * These wrappers must NEVER reach publish_gate or quality scoring.
 * This module extracts the actual content from such wrappers.
 *
 * If extraction fails or the content is irrecoverable, the opportunity
 * is marked with malformed_json_output = true.
 */

// ═══ Types ═══

export type CleanedTextResult = {
  cleaned_text: string;
  cleaned_json_wrapper: boolean;
  malformed_json_output: boolean;
  cleaning_notes: string;
};

// ═══ Known JSON keys to extract from ═══

const EXTRACT_KEYS = [
  'reply',
  'quote',
  'quote_tweet',
  'quotetweet',
  'text',
  'content',
  'message',
  'tweet',
  'response',
  'crafted_text',
  'body',
];

// ═══ Main Cleaning Function ═══

/**
 * Clean crafted_text by extracting plain text from JSON/markdown wrappers.
 *
 * Handles:
 * - Markdown code fences: ```json\n{ "reply": "..." }\n```
 * - JSON objects: { "reply": "..." }
 * - JSON objects with empty keys: { "": "..." }
 * - Nested simple objects (one level deep)
 * - Plain text that already looks clean (pass-through)
 *
 * After cleaning:
 * - crafted_text must be plain English text only
 * - No JSON object strings should remain
 * - No markdown fences should remain
 * - No keys like reply, quote, quote_tweet, text should remain
 */
export function cleanCraftedText(raw: string): CleanedTextResult {
  if (!raw || typeof raw !== 'string') {
    return {
      cleaned_text: '',
      cleaned_json_wrapper: false,
      malformed_json_output: true,
      cleaning_notes: 'Empty or non-string input'
    };
  }

  let text = raw.trim();
  const notes: string[] = [];
  let cleanedJsonWrapper = false;

  // Step 1: Remove markdown code fences
  const fenceResult = stripMarkdownFences(text);
  if (fenceResult.stripped) {
    text = fenceResult.text;
    notes.push('Stripped markdown code fences');
    cleanedJsonWrapper = true;
  }

  // Step 2: Try to parse as JSON and extract content
  const jsonResult = tryExtractFromJson(text);
  if (jsonResult.extracted) {
    text = jsonResult.text;
    notes.push(`Extracted from JSON wrapper (key: ${jsonResult.key || 'unknown'})`);
    cleanedJsonWrapper = true;
  }

  // Step 3: Check if the result still looks like JSON
  if (looksLikeJsonWrapper(text)) {
    // Try one more time with more aggressive extraction
    const aggressiveResult = tryAggressiveExtraction(text);
    if (aggressiveResult.extracted) {
      text = aggressiveResult.text;
      notes.push(`Aggressive extraction (method: ${aggressiveResult.method})`);
      cleanedJsonWrapper = true;
    } else {
      // Could not extract — mark as malformed
      return {
        cleaned_text: text,
        cleaned_json_wrapper: cleanedJsonWrapper,
        malformed_json_output: true,
        cleaning_notes: [...notes, 'Content still looks like JSON after cleaning — marking as malformed'].join('; ')
      };
    }
  }

  // Step 4: Final cleanup
  text = text.trim();

  // Remove any remaining leading/trailing quotes that wrap the entire text
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
    notes.push('Removed surrounding quotes');
  }

  // Unescape common JSON escape sequences
  text = unescapeJsonString(text);

  // Step 5: Validate the cleaned text
  if (!text || text.length < 5) {
    return {
      cleaned_text: text,
      cleaned_json_wrapper: cleanedJsonWrapper,
      malformed_json_output: true,
      cleaning_notes: [...notes, 'Cleaned text is too short or empty'].join('; ')
    };
  }

  // Step 6: Final check — if it STILL looks like JSON, it's malformed
  if (looksLikeJsonWrapper(text)) {
    return {
      cleaned_text: text,
      cleaned_json_wrapper: cleanedJsonWrapper,
      malformed_json_output: true,
      cleaning_notes: [...notes, 'Content still looks like JSON after all cleaning'].join('; ')
    };
  }

  return {
    cleaned_text: text,
    cleaned_json_wrapper: cleanedJsonWrapper,
    malformed_json_output: false,
    cleaning_notes: notes.length > 0 ? notes.join('; ') : 'No cleaning needed'
  };
}

// ═══ Markdown Fence Stripping ═══

function stripMarkdownFences(text: string): { text: string; stripped: boolean } {
  // Pattern: ```json\n...\n``` or ```\n...\n```
  const fencePattern = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const match = text.match(fencePattern);
  if (match) {
    return { text: match[1].trim(), stripped: true };
  }

  // Also handle fences without closing (partial)
  const openFence = /^```(?:json|javascript|js)?\s*\n?/;
  if (openFence.test(text)) {
    const cleaned = text.replace(openFence, '').replace(/\n?\s*```$/,'').trim();
    if (cleaned !== text) {
      return { text: cleaned, stripped: true };
    }
  }

  return { text, stripped: false };
}

// ═══ JSON Extraction ═══

function tryExtractFromJson(text: string): { text: string; extracted: boolean; key?: string } {
  // Try parsing as JSON
  try {
    const parsed = JSON.parse(text);

    // If it's a string (double-wrapped), return it
    if (typeof parsed === 'string') {
      return { text: parsed, extracted: true, key: 'string' };
    }

    // If it's an object, try to extract from known keys
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Try known keys in priority order
      for (const key of EXTRACT_KEYS) {
        if (parsed[key] && typeof parsed[key] === 'string' && parsed[key].length > 0) {
          return { text: parsed[key], extracted: true, key };
        }
      }

      // Try empty string key
      if (parsed[''] && typeof parsed[''] === 'string' && parsed[''].length > 0) {
        return { text: parsed[''], extracted: true, key: '(empty key)' };
      }

      // Try ANY string value in the object
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.length > 5) {
          return { text: value, extracted: true, key: key || '(unknown key)' };
        }
      }
    }
  } catch {
    // Not valid JSON — try other methods
  }

  // Try regex extraction for common patterns
  // { "reply": "some text" } or { "quote": "some text" }
  for (const key of EXTRACT_KEYS) {
    // Match: { "key": "value" }
    const singleKeyPattern = new RegExp(`\\{\\s*"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*\\}`, 'i');
    const match = text.match(singleKeyPattern);
    if (match && match[1]) {
      return { text: match[1], extracted: true, key };
    }

    // Match: { "key": "value", ... } — extract the value for the key
    const keyInObjectPattern = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*[,}]`, 'i');
    const objectMatch = text.match(keyInObjectPattern);
    if (objectMatch && objectMatch[1]) {
      return { text: objectMatch[1], extracted: true, key };
    }
  }

  return { text, extracted: false };
}

// ═══ Aggressive Extraction ═══

function tryAggressiveExtraction(text: string): { text: string; extracted: boolean; method?: string } {
  // Try to find any quoted string that could be the content
  // Look for the longest quoted string value
  const quotedValues: string[] = [];
  const valuePattern = /:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = valuePattern.exec(text)) !== null) {
    if (match[1] && match[1].length > 10) {
      quotedValues.push(unescapeJsonString(match[1]));
    }
  }

  if (quotedValues.length > 0) {
    // Take the longest value — most likely the actual content
    const longest = quotedValues.reduce((a, b) => a.length >= b.length ? a : b, '');
    return { text: longest, extracted: true, method: 'longest_quoted_value' };
  }

  // Last resort: try to find text between curly braces
  const bracePattern = /\{\s*"(?:reply|quote|quote_tweet|text|content|message)"\s*:\s*"([\s\S]*?)"\s*\}/i;
  const braceMatch = text.match(bracePattern);
  if (braceMatch && braceMatch[1]) {
    return { text: unescapeJsonString(braceMatch[1]), extracted: true, method: 'brace_extraction' };
  }

  return { text, extracted: false };
}

// ═══ Helpers ═══

/**
 * Check if text still looks like a JSON wrapper (not plain publishable text).
 */
export function looksLikeJsonWrapper(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();

  // Starts with { or [
  if (/^\s*[\{\[]/.test(trimmed)) return true;

  // Contains JSON key patterns like "reply": or "quote":
  if (/"(?:reply|quote|quote_tweet|text|content|message|tweet|response)"\s*:/.test(trimmed)) return true;

  // Starts with markdown fence
  if (/^```/.test(trimmed)) return true;

  return false;
}

/**
 * Unescape common JSON string escape sequences.
 */
function unescapeJsonString(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\'/g, "'");
}

// ═══ Anti-AI Pattern Detection ═══

/**
 * Common AI-generated tweet patterns that make content feel inauthentic.
 * These patterns are detected AFTER cleaning and BEFORE publishing.
 */
const AI_TWEET_PATTERNS = [
  // "The real X isn't Y — it's Z" formula
  /^the real (?:\w+\s+)?isn't\b/i,
  // "X distorts Y" / "The X lens distorts Y"
  /\b\w+ lens distorts\b/i,
  // "not just X, but Y" / "not just better tools, but"
  /not just \w+,? but\b/i,
  // "It's not about X — it's about Y"
  /it'?s not about \w+ —? it'?s about/i,
  // "The shift from X to Y suggests"
  /\bthe shift (?:from|to)\b.*\bsuggests\b/i,
  // "What [they] stop working on"
  /\bwhat they stop\b/i,
  // Overuse of em-dash (—) as a crutch
  /(?:^|\w)\s*—\s*(?:the |it'|they |this |that )/i,
  // Generic AI filler phrases
  /\b(reveals|signals|suggests|indicates|highlights|underscores)\s+(?:a |the |that )\b/i,
  // "cognitive infrastructure" / "new cognitive" type academic phrasing
  /\b(cognitive infrastructure|new cognitive|paradigm shift|fundamental shift)\b/i,
  // Excessive tool name dropping (3+ proper nouns in sequence)
  /(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)){2,}/,
];

/**
 * Detect AI-sounding patterns in crafted text.
 * Returns pattern matches for diagnostics but does NOT reject —
 * the decision engine uses this as a quality signal.
 */
export function detectAIPatterns(text: string): { 
  is_ai_sounding: boolean; 
  matched_patterns: string[];
  penalty_score: number; // 0-3, higher = more AI-sounding
} {
  if (!text || text.length < 20) {
    return { is_ai_sounding: false, matched_patterns: [], penalty_score: 0 };
  }
  
  const matched: string[] = [];
  let penalty = 0;
  
  for (const pattern of AI_TWEET_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.toString().slice(1, 40));
      penalty += 0.5;
    }
  }
  
  return {
    is_ai_sounding: penalty >= 1.0,
    matched_patterns: matched,
    penalty_score: Math.min(3, penalty),
  };
}

/**
 * Batch clean all opportunities' crafted_text.
 * Returns cleaned opportunities and a summary.
 */
export function cleanOpportunitiesText(
  opportunities: Array<{ crafted_text: string; [key: string]: any }>
): {
  cleaned: Array<{ crafted_text: string; [key: string]: any }>;
  summary: {
    total: number;
    json_wrappers_cleaned: number;
    malformed_count: number;
  };
} {
  if (!opportunities?.length) {
    return { cleaned: [], summary: { total: 0, json_wrappers_cleaned: 0, malformed_count: 0 } };
  }

  let jsonWrappersCleaned = 0;
  let malformedCount = 0;

  const cleaned = opportunities.map(opp => {
    const result = cleanCraftedText(opp.crafted_text || '');

    if (result.cleaned_json_wrapper) jsonWrappersCleaned++;
    if (result.malformed_json_output) malformedCount++;

    return {
      ...opp,
      crafted_text: result.cleaned_text,
      cleaned_json_wrapper: result.cleaned_json_wrapper,
      malformed_json_output: result.malformed_json_output,
      quality_notes: [opp.quality_notes || '', result.cleaning_notes].filter(Boolean).join('; ')
    };
  });

  return {
    cleaned,
    summary: {
      total: opportunities.length,
      json_wrappers_cleaned: jsonWrappersCleaned,
      malformed_count: malformedCount
    }
  };
}
