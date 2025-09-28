import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool, withTx } from "./db.js";
import { openai } from "./openai.js";
import { authenticateJWT, optionalAuth, upsertUser, getUserFromAuth0Sub, AuthenticatedRequest } from "./auth.js";

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

// ---- Auth routes
app.post("/auth/profile", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    // Upsert user data from Auth0 token
    const userData = await upsertUser({
      auth0_sub: req.user.sub,
      email: req.user.email,
      email_verified: req.user.email_verified,
      username: req.user.username || undefined
    });

    res.json({
      ok: true,
      user: {
        id: userData.id,
        email: userData.email,
        username: userData.username,
        name: userData.name,
        email_verified: userData.email_verified
      }
    });
  } catch (error) {
    console.error("Profile creation error:", error);
    res.status(500).json({ error: "Failed to create/update profile" });
  }
});

app.get("/auth/me", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    res.json({
      ok: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        username: dbUser.username,
        name: dbUser.name,
        email_verified: dbUser.email_verified
      }
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

// ---- Book routes
app.post("/books", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const data = UpsertBook.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found. Please create your profile first." });
    }

    await pool.query(
      `INSERT INTO books(id, title, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title,
         updated_at=now()`,
      [data.id, data.title, dbUser.id]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Create book error:", error);
    res.status(500).json({ error: "Failed to create book" });
  }
});

app.get("/books", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(
      `SELECT b.id, b.title, b.created_at, b.updated_at,
              COUNT(c.id) as chapter_count
       FROM books b
       LEFT JOIN chapters c ON c.book_id = b.id
       WHERE b.user_id = $1
       GROUP BY b.id, b.title, b.created_at, b.updated_at
       ORDER BY b.updated_at DESC`,
      [dbUser.id]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get books error:", error);
    res.status(500).json({ error: "Failed to get books" });
  }
});

app.post("/chapters", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const data = UpsertChapter.parse(req.body);
    const wordCount = data.text.trim().split(/\s+/).length;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [data.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to add chapters to this book" });
    }

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
  } catch (error) {
    console.error("Create chapter error:", error);
    res.status(500).json({ error: "Failed to create chapter" });
  }
});

// Generate + store a structured summary for a chapter
app.post("/chapters/:id/summary", authenticateJWT, async (req: AuthenticatedRequest, res, next) => {
  try {
    const chapterId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.text, c.book_id, b.title as book_title, b.user_id
         FROM chapters c
         JOIN books b ON c.book_id=b.id
        WHERE c.id=$1`, [chapterId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const chapter = rows[0];

    // Verify user owns the book
    if (chapter.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this chapter" });
    }

    // call OpenAI Chat Completions API with JSON mode
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Use a model that supports JSON mode
      messages: [
        { role: "system", content:
          "You are an expert fiction editor. Produce a tight factual summary (150–250 words), include POV, main characters, and 4–8 bullet beats. No speculation. Return valid JSON only."},
        { role: "user", content:
          `Book: ${chapter.book_title} (${chapter.book_id})\n` +
          `Chapter: ${chapter.id}${chapter.title ? ` — ${chapter.title}` : ""}\n\n` +
          "Return JSON only for this schema: {pov, characters[], beats[], spoilers_ok, summary}\n\n" +
          chapter.text
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }
    const out = JSON.parse(content);

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
app.post("/reviews", authenticateJWT, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { bookId, newChapterId, tone = "fanficnet" } = ReviewReq.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

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

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content:
          `PRIOR CHAPTER SUMMARIES:\n${priorSummariesText}\n\n` +
          `NEW CHAPTER: ${target.id}${target.title ? ` — ${target.title}` : ""}\n${target.text}\n\n` +
          "Write the review now." }
      ],
      temperature: 0.7
    });

    res.json({ ok: true, review: response.choices[0]?.message?.content || "" });
  } catch (e) { next(e); }
});

app.get("/books/:id/chapters", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.id]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    const { rows } = await pool.query(`
      SELECT c.id, c.title, c.word_count,
             CASE WHEN s.chapter_id IS NULL THEN false ELSE true END AS has_summary
        FROM chapters c
        LEFT JOIN chapter_summaries s ON s.chapter_id = c.id
       WHERE c.book_id=$1
       ORDER BY c.id`, [req.params.id]);

    res.json(rows);
  } catch (error) {
    console.error("Get chapters error:", error);
    res.status(500).json({ error: "Failed to get chapters" });
  }
});

app.get("/chapters/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(`
      SELECT c.id, c.book_id, c.title, c.text, c.word_count, c.updated_at,
             s.summary, s.pov, s.characters, s.beats, s.spoilers_ok, b.user_id
        FROM chapters c
        LEFT JOIN chapter_summaries s ON s.chapter_id=c.id
        JOIN books b ON c.book_id = b.id
       WHERE c.id=$1`, [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const chapter = rows[0];

    // Verify user owns the book
    if (chapter.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this chapter" });
    }

    // Remove user_id from response
    const { user_id, ...responseData } = chapter;
    res.json(responseData);
  } catch (error) {
    console.error("Get chapter error:", error);
    res.status(500).json({ error: "Failed to get chapter" });
  }
});

// basic error handler
app.use((err:any, _req:any, res:any, _next:any) => {
  console.error(err);
  res.status(500).json({ error: "Internal error", detail: String(err?.message || err) });
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`AI Beta Reader API listening on http://localhost:${process.env.PORT || 3001}`);
});