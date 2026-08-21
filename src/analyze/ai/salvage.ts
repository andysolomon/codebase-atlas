/** Rescuing JSON from a model that would not stay inside the schema.

    The AI SDK validates structured output for us, but weaker and cheaper models sometimes reason in
    prose first and emit the object late, or wrap it in a code fence. When schema generation throws,
    the raw text is still there — so scan it for balanced top-level objects and keep the last valid
    one. Last, not first: a model that shows an example before its real answer would otherwise have
    the example parsed as the result. (The approach is borrowed from arc-orchestrator's envelope.ts.) */

export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json|jsonc)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** Every balanced top-level `{…}` in the text, in source order, quote- and escape-aware. */
export function embeddedObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* not an object we can use */ }
        start = -1;
      }
    }
  }
  return out;
}

/** Candidate parses of a model's raw text, best guess last. */
export function salvageCandidates(text: string): unknown[] {
  const stripped = stripCodeFences(text);
  const out: unknown[] = [];
  try { out.push(JSON.parse(stripped)); } catch { /* fall through to scanning */ }
  out.push(...embeddedObjects(stripped));
  return out;
}
