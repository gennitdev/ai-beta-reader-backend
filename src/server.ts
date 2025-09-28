import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool, withTx } from "./db";
import { openai } from "./openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---- validators
const UpsertBook = z.object({
  id: z.string().min(1),
  title: z.string().min(1)
});
const UpsertChapter = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  title: z.string().optional(),
  text: z.string().min(1)
});
const ReviewReq = z.object({
  bookId: z.string().min(1),
  newChapterId: z.string().min(1),
  tone: z.enum(["fanficnet","editorial","line-notes"]).optional()
});

// ---- routes
app.post("/books", async (req, res) => {
  const data = UpsertBook.parse(req.body);
  await pool.query(
    `INSERT INTO books(id, title) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`,
    [data.id, data.title]
  );
  res.json({ ok: true });
});

app.post("/chapters", async (req, res) => {
  const data = UpsertChapter.parse(req.body);
  const wordCount = data.text.trim().split(/\s+/).length;

  await pool.query(
    `INSERT INTO chapters(id, book_id, title, text, word_count, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (id) DO UPDATE SET
       book_id=EXCLUDED.book_id,
       title=EXCLUDED.title,
       text=EXCLUDED.text,
       word_count=EXCLUDED.word_count,
       updated_at=now()`,
    [data.id, data.bookId, data.title ?? null, data.text, wordCount]
  );

  res.json({ ok: true, wordCount });
});

// Generate + store a structured summary for a chapter
app.post("/chapters/:id/summary", async (req, res, next) => {
  try {
    const chapterId = req.params.id;
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.text, c.book_id, b.title as book_title
         FROM chapters c JOIN books b ON c.book_id=b.id
        WHERE c.id=$1`, [chapterId]
    );
    if (!rows.length) return res.status(404).json({ error: "Chapter not found" });
    const chapter = rows[0];

    // call Responses API with JSON schema
    const response = await openai.responses.create({
      model: "GPT-5", // or 'gpt-5' depending on casing in your SDK's catalog
      input: [
        { role: "system", content:
          "You are an expert fiction editor. Produce a tight factual summary (150–250 words), include POV, main characters, and 4–8 bullet beats. No speculation."},
        { role: "user", content:
          `Book: ${chapter.book_title} (${chapter.book_id})\n` +
          `Chapter: ${chapter.id}${chapter.title ? ` — ${chapter.title}` : ""}\n\n` +
          "Return JSON only for this schema: {pov, characters[], beats[], spoilers_ok, summary}\n\n" +
          chapter.text
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ChapterSummary",
          schema: {
            type: "object",
            properties: {
              pov: { type: "string" },
              characters: { type: "array", items: { type: "string" } },
              beats: { type: "array", items: { type: "string" }, minItems: 4 },
              spoilers_ok: { type: "boolean" },
              summary: { type: "string" }
            },
            required: ["pov","characters","beats","spoilers_ok","summary"],
            additionalProperties: false
          }
        }
      }
    });

    const out = JSON.parse(response.output_text!);

    await pool.query(
      `INSERT INTO chapter_summaries (chapter_id, pov, characters, beats, spoilers_ok, summary)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (chapter_id) DO UPDATE SET
         pov=EXCLUDED.pov,
         characters=EXCLUDED.characters,
         beats=EXCLUDED.beats,
         spoilers_ok=EXCLUDED.spoilers_ok,
         summary=EXCLUDED.summary,
         created_at=now()`,
      [chapterId, out.pov || null, JSON.stringify(out.characters||[]),
       JSON.stringify(out.beats||[]), !!out.spoilers_ok, out.summary]
    );

    res.json({ ok: true, summary: out });
  } catch (e) { next(e); }
});

// Create a chapter-specific review with all prior summaries
app.post("/reviews", async (req, res, next) => {
  try {
    const { bookId, newChapterId, tone = "fanficnet" } = ReviewReq.parse(req.body);

    const { rows: prior } = await pool.query(`
      SELECT c.id, c.title, s.summary
        FROM chapters c
        JOIN chapter_summaries s ON s.chapter_id=c.id
       WHERE c.book_id=$1 AND c.id <> $2
       ORDER BY c.id`, [bookId, newChapterId]);

    const { rows: targetRows } = await pool.query(`
      SELECT c.id, c.title, c.text
        FROM chapters c
       WHERE c.id=$1 AND c.book_id=$2`, [newChapterId, bookId]);
    if (!targetRows.length) return res.status(404).json({ error: "New chapter not found" });
    const target = targetRows[0];

    const priorSummariesText = prior.map(r => `# ${r.id}${r.title ? ` — ${r.title}`:""}\n${r.summary}`).join("\n\n");

    const system =
      tone === "fanficnet"
        ? "You are a thoughtful, enthusiastic serial reader. React to THIS new chapter in context of prior summaries. 2–5 short paragraphs; warm, specific; reference arcs/payoffs; no spoilers beyond prior summaries."
        : tone === "editorial"
        ? "You are a concise developmental editor. Give specific, actionable notes about structure, character, pacing, and continuity for THIS chapter in context."
        : "You are a line editor. Provide concrete line-level suggestions with examples.";

    const response = await openai.responses.create({
      model: "GPT-5",
      input: [
        { role: "system", content: system },
        { role: "user", content:
          `PRIOR CHAPTER SUMMARIES:\n${priorSummariesText}\n\n` +
          `NEW CHAPTER: ${target.id}${target.title ? ` — ${target.title}` : ""}\n${target.text}\n\n` +
          "Write the review now." }
      ]
    });

    res.json({ ok: true, review: response.output_text });
  } catch (e) { next(e); }
});

app.get("/books/:id/chapters", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.title, c.word_count,
           CASE WHEN s.chapter_id IS NULL THEN false ELSE true END AS has_summary
      FROM chapters c
      LEFT JOIN chapter_summaries s ON s.chapter_id = c.id
     WHERE c.book_id=$1
     ORDER BY c.id`, [req.params.id]);
  res.json(rows);
});

app.get("/chapters/:id", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.book_id, c.title, c.text, c.word_count, c.updated_at,
           s.summary, s.pov, s.characters, s.beats, s.spoilers_ok
      FROM chapters c
      LEFT JOIN chapter_summaries s ON s.chapter_id=c.id
     WHERE c.id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

// basic error handler
app.use((err:any, _req:any, res:any, _next:any) => {
  console.error(err);
  res.status(500).json({ error: "Internal error", detail: String(err?.message || err) });
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`AI Beta Reader API listening on http://localhost:${process.env.PORT || 3001}`);
});