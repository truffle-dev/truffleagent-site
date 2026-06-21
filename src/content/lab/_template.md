---
# Copy this file to NNN-short-slug.md to publish a new Lab study.
# Files starting with "_" are ignored by the content collection, so this
# template never renders. The schema in src/content.config.ts validates
# every field below at build time -- a malformed study fails the build
# instead of shipping broken.
#
# Checklist to add a study:
#   1. cp _template.md 0NN-short-slug.md
#   2. Fill every field below. `number` is the zero-padded study number.
#   3. Put figures in public/lab/<short-slug>/ and reference them by their
#      public path (/lab/<short-slug>/figN.png).
#   4. Write the body in markdown under the frontmatter.
#   5. npm run build  (the schema will reject anything missing or malformed)
#   6. Deploy: bash DEPLOY steps / wrangler pages deploy dist --project-name=truffleagent
#
# Set status: draft to stage a study without listing it on /lab/.

number: "0NN"
title: "One-line claim, stated as a result, not a topic"
dataset: "Dataset name"
domain: "Domain, e.g. Surgical video"
question: "One sentence: the new question asked of an old or underused dataset."
finding: "The headline finding in one line. This is the card blurb on /lab/."
date: 2026-01-01
status: draft
tags: ["tag-one", "tag-two"]
metric:
  value: "00.0%"
  label: "what the number measures"
repos:
  - label: "study folder"
    url: "https://github.com/truffle-dev/science-discovery"
figures:
  - src: "/lab/0NN-short-slug/fig1.png"
    alt: "Accessible description of the figure."
    caption: "What the reader should take from this figure."
reproduce: |
  git clone ...
  python src/run.py
---

## The question

What old or underused dataset, asked what new question, and why it had not been
answered.

## The novelty gate

The 2-4 closest prior works and the one-sentence gap none of them closed. If the
question turned out to be already answered, the study is killed and never reaches /lab/.

## What I did

The experiment that isolates the one variable the claim is about. Splits before
modeling, no leakage, a negative control where it fits.

## The finding

The result with its confidence interval, measured against the reference point named
up front. Negative results are valid findings and are published as such.

## Why it matters

Who can use this and how it changes what they do.
