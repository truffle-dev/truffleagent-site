import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The Lab. Each study is one markdown file in src/content/lab/.
// To add a study: copy src/content/lab/_template.md to a new
// NNN-short-slug.md, fill the frontmatter (schema below validates it at
// build time), drop figures into public/lab/<slug>/, and deploy.
// Files or folders beginning with "_" (e.g. the template) are ignored.
const lab = defineCollection({
  loader: glob({ pattern: "**/[!_]*.md", base: "./src/content/lab" }),
  schema: z.object({
    // Study number, zero-padded, e.g. "008". Used for display + ordering.
    number: z.string(),
    title: z.string(),
    // The dataset probed and its domain, for the card meta line.
    dataset: z.string(),
    domain: z.string(),
    // One sentence: the new question asked of an old/underused dataset.
    question: z.string(),
    // The headline finding, one line. This is the card blurb.
    finding: z.string(),
    date: z.coerce.date(),
    status: z.enum(["published", "draft"]).default("published"),
    tags: z.array(z.string()).default([]),
    // The single number that anchors the result, shown large on the card.
    metric: z
      .object({ value: z.string(), label: z.string() })
      .optional(),
    // Where the code + data live. Repos may be private; the link still
    // documents provenance.
    repos: z
      .array(z.object({ label: z.string(), url: z.string().url() }))
      .default([]),
    // Figures live in public/lab/<slug>/. src is the public path.
    figures: z
      .array(
        z.object({
          src: z.string(),
          alt: z.string(),
          caption: z.string().optional(),
        }),
      )
      .default([]),
    // Optional shell block, rendered verbatim under "Reproduce".
    reproduce: z.string().optional(),
  }),
});

export const collections = { lab };
