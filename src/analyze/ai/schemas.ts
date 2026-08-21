/** What each pass is allowed to return. Deliberately flat: arrays of objects travel across every
    provider's structured-output implementation, where a free-form record does not. */

import { z } from 'zod';

export const PartitionOut = z.object({
  product: z.string().describe('The product name in caps, e.g. LITTLE WORLDS. Not the repo slug.'),
  groups: z.array(z.string())
    .describe('Group names in caps, ordered the way the system reads top to bottom.'),
  blocks: z.array(z.object({
    key: z.string().describe('Short lowercase slug, unique, e.g. viewport-engine.'),
    name: z.string().describe('What a reader would call this, e.g. "Viewport engine", "Params".'),
    group: z.string().describe('One of the group names above.'),
    paths: z.array(z.string()).min(1)
      .describe('Exact file paths from the tree, or folder prefixes ending in "/".'),
    slab: z.boolean().optional().describe('True for storage and records rather than logic.'),
  })),
});
export type PartitionOut = z.infer<typeof PartitionOut>;

export const NarrateOut = z.object({
  blocks: z.array(z.object({
    id: z.string(),
    name: z.string().optional().describe('Only if the given name is wrong now you have read the code.'),
    what: z.string().describe('What this is and why it exists. Two or three sentences.'),
    how: z.string().describe('How it is built: the real files, the mechanism, the constraint that matters.'),
    children: z.array(z.object({ file: z.string(), what: z.string() })).optional()
      .describe('One short line per listed file.'),
  })),
});
export type NarrateOut = z.infer<typeof NarrateOut>;

export const ComposeOut = z.object({
  overviewTitle: z.string().describe('A sentence a person would say, e.g. "Sculpt a planet, then see who lives there".'),
  overviewKicker: z.string().describe('The product name in caps.'),
  overviewSub: z.string().describe('One lowercase line, e.g. "a browser planet sculptor and star-system builder".'),
  overviewWhat: z.array(z.string()).describe('Paragraphs on what the system is. Mark key phrases with [[double brackets]].'),
  overviewHow: z.array(z.string()).describe('Paragraphs on how it is built.'),
  howToRead: z.string().describe('One line telling a reader how to use the map.'),
  stats: z.array(z.object({
    key: z.string().describe('Caps label, e.g. WORLD TYPES.'),
    value: z.string(),
    evidence: z.string().describe('Where in the evidence this number came from. A stat without this is discarded.'),
  })),
  traceTitle: z.string().describe('Caps label for the journey, e.g. ONE SLIDER DRAG.'),
  trace: z.array(z.object({
    id: z.string().describe('A block id from the list.'),
    sentence: z.string(),
  })).describe('One action followed end to end. May return to a block it already visited.'),
  edgeLabels: z.array(z.object({
    from: z.string(), to: z.string(),
    payload: z.string().describe('What travels along this edge, e.g. "clean PlanetParams".'),
  })),
});
export type ComposeOut = z.infer<typeof ComposeOut>;
