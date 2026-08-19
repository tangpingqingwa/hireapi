import assert from "node:assert/strict";
import { test } from "node:test";
import { toMarkdown } from "../src/markdown.js";

test("toMarkdown strips scripts and style and leaves no HTML tags", () => {
  const md = toMarkdown(
    `<div>Hello<script>alert(1)</script><style>.x{}</style> world</div>`,
  );
  assert.equal(md.includes("<"), false);
  assert.equal(md.includes("alert"), false);
  assert.equal(md.includes(".x{}"), false);
  assert.match(md, /Hello/);
  assert.match(md, /world/);
});

test("toMarkdown keeps headings, lists, and links", () => {
  const md = toMarkdown(`
    <h1>Staff Engineer</h1>
    <p>We are hiring.</p>
    <ul>
      <li>TypeScript</li>
      <li><a href="https://example.com/apply">Apply here</a></li>
    </ul>
    <ol>
      <li>Send resume</li>
      <li>Talk to the team</li>
    </ol>
  `);
  assert.match(md, /^# Staff Engineer/m);
  assert.match(md, /We are hiring\./);
  assert.match(md, /^- TypeScript/m);
  assert.match(md, /\[Apply here\]\(https:\/\/example.com\/apply\)/);
  assert.match(md, /^1\. Send resume/m);
  assert.match(md, /^2\. Talk to the team/m);
  assert.equal(md.includes("<div>"), false);
  assert.equal(md.includes("<li>"), false);
});

test("toMarkdown keeps nested lists and emphasis", () => {
  const md = toMarkdown(`
    <h2>Benefits</h2>
    <ul>
      <li><strong>Health</strong>
        <ul>
          <li><em>Dental</em></li>
        </ul>
      </li>
    </ul>
  `);
  assert.match(md, /^## Benefits/m);
  assert.match(md, /\*\*Health\*\*/);
  assert.match(md, /\*Dental\*/);
});

test("toMarkdown decodes entities and drops comments", () => {
  const md = toMarkdown(`<p>Pay &amp; equity<!-- secret --> &lt;not html&gt;</p>`);
  assert.equal(md.includes("secret"), false);
  assert.match(md, /Pay & equity/);
  assert.match(md, /<not html>/);
});

test("toMarkdown empty input is empty output", () => {
  assert.equal(toMarkdown(""), "");
});

test("toMarkdown does not leak unclosed tags or leftover markup", () => {
  const md = toMarkdown(
    `<div class="job"><h3>About the role</h3><p>Build APIs.<ul><li>SQLite</div>`,
  );
  assert.equal(/<[a-zA-Z]/.test(md), false);
  assert.match(md, /### About the role/);
  assert.match(md, /Build APIs\./);
  assert.match(md, /^- SQLite/m);
});
